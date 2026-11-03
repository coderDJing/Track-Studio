import path from 'node:path'
import fs from 'fs-extra'
import { createHash, randomUUID } from 'node:crypto'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { getLibraryDb } from '../libraryDb'
import { getSetCustodyDirAbs } from '../services/setCustody'
import { findSongListRoot } from '../services/cacheMaintenance'
import {
  loadSetSongCacheCandidates,
  setSongCacheLookupKey
} from '../services/setListCachedSongScan'
import { isPathBusyForRemoteMutation } from '../curatedLibrarySync/busyPaths'
import { notifyTree } from '../curatedLibrarySync/applyUiNotify'
import {
  beginLibraryTreeWatcherBulkOperation,
  waitForLibraryTreeWatcherIdle
} from '../libraryTreeWatcher'
import { acquireLibraryMergeLockAfterMaintenanceIdle } from '../services/libraryMerge/mutationGate'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { stripMachineLocalSongFields } from '../services/setPackage/manifest'
import { decodeSetPackageWaveforms } from '../services/setPackage/waveformCodec'
import {
  prepareUnifiedDisplayWaveformWrite,
  writePreparedUnifiedDisplayWaveform
} from '../libraryCacheDb/unifiedDisplayWaveformCache'
import { writePreparedWaveformSurface } from '../libraryCacheDb/waveformSurfaceCache'
import { buildWaveformSurfaceCacheDataFromUnifiedDisplay } from '../../shared/waveformSurfaceCache'
import { resolveFilePathInput, resolveListRootInput } from '../libraryCacheDb/pathResolvers'
import { normalizeSongCacheInfoForStorage } from '../libraryCacheDb/songCache'
import { markPlaylistViewSnapshotContentStale } from '../libraryCacheDb/playlistViewSnapshot'
import type { ISongInfo } from '../../types/globals'
import {
  SET_SYNC_ROOT,
  sameSetValue,
  type SetSyncAsset,
  type SetSyncItem,
  type SetSyncSnapshot
} from '../../shared/setLibrarySync'
import { hashFileSha256 } from '../curatedLibrarySync/hashFile'
import { downloadBlobFile } from '../curatedLibrarySync/apiClient'
import { commitSetTree } from './treeTransaction'
import { assertSetDiskUnchanged, setLocalGuard, type SetLocalScan } from './scan'
import { writeSetSyncBase } from './state'
import { queueSetSyncCleanup, cleanupSetSyncCustody } from './cleanup'
import { listSetItemsByIds } from '../setListDb'

export async function getSetAsset(
  asset: SetSyncAsset,
  directory: string,
  local: Map<string, string>,
  signal: AbortSignal
): Promise<string> {
  const available = local.get(asset.sha256)
  if (available) return available
  const target = path.join(directory, asset.sha256)
  if (await fs.pathExists(target)) {
    const stat = await fs.stat(target)
    if (stat.size === asset.size && (await hashFileSha256(target)) === asset.sha256) return target
    // The downloader writes partial bytes at this cache path. Preserve short files for Range
    // continuation; complete/corrupt cache entries must be fetched and verified again.
    if (stat.size >= asset.size) await fs.remove(target)
  }
  await downloadBlobFile({
    ...asset,
    scope: 'set',
    expectedSize: asset.size,
    destPath: target,
    signal
  })
  return target
}

export async function applySetSnapshot(
  local: SetLocalScan,
  target: SetSyncSnapshot,
  userKey: string,
  signal: AbortSignal,
  progress: (done: number, total: number) => void
): Promise<void> {
  const db = getLibraryDb()
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  const before = new Map(local.snapshot.items.map((i) => [i.id, i]))
  const changed = target.items.filter((i) => !sameSetValue(before.get(i.id), i))
  const removed = local.snapshot.items.filter((i) => !target.items.some((t) => t.id === i.id))
  const custody = getSetCustodyDirAbs()
  const cleanupItems = listSetItemsByIds([...removed, ...changed].map((i) => i.id))
  const prepared: Array<{
    item: SetSyncItem
    filePath: string
    stat: { size: number; mtimeMs: number }
    root: string
    info: ISongInfo
    wave: Awaited<ReturnType<typeof decodeSetPackageWaveforms>> | null
    detail: Buffer | null
  }> = []
  for (const [index, item] of changed.entries()) {
    signal.throwIfAborted()
    assertSetDiskUnchanged(local)
    const audio = await getSetAsset(item.audio, local.directory, local.files, signal)
    const record = local.records.get(item.id)
    const old = before.get(item.id)
    let filePath =
      record && old?.audio.sha256 === item.audio.sha256
        ? path.isAbsolute(record.filePath)
          ? record.filePath
          : path.join(store.databaseDir, 'library', record.filePath)
        : ''
    if (!filePath) {
      filePath = path.join(custody, 'cloud', item.audio.sha256, item.fileName)
      if (!(await fs.pathExists(filePath))) {
        await fs.ensureDir(path.dirname(filePath))
        // Publish a complete verified file; partial downloads never become playable SET entries.
        const temporary = `${filePath}.${randomUUID()}.part`
        try {
          await fs.copyFile(audio, temporary, fs.constants.COPYFILE_EXCL)
          if (
            (await fs.stat(temporary)).size !== item.audio.size ||
            (await hashFileSha256(temporary)) !== item.audio.sha256
          )
            throw new Error('SET_SYNC_HASH_MISMATCH')
          await fs.rename(temporary, filePath)
        } finally {
          await fs.remove(temporary)
        }
      }
      if (
        (await fs.stat(filePath)).size !== item.audio.size ||
        (await hashFileSha256(filePath)) !== item.audio.sha256
      )
        throw new Error('SET_SYNC_HASH_MISMATCH')
    }
    if (isPathBusyForRemoteMutation(filePath)) throw new Error('SET_SYNC_BUSY_TRACK')
    const rawPath = await getSetAsset(item.analysis, local.directory, local.files, signal)
    const payload = await fs.readFile(rawPath)
    if (
      payload.byteLength !== item.analysis.size ||
      createHash('sha256').update(payload).digest('hex') !== item.analysis.sha256
    )
      throw new Error('SET_SYNC_HASH_MISMATCH')
    const raw: unknown = JSON.parse(payload.toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('SET_SYNC_INVALID_ANALYSIS')
    const info = {
      ...stripMachineLocalSongFields(raw as Partial<ISongInfo>),
      fileName: item.fileName,
      filePath,
      cover: null
    } as ISongInfo
    const stat = await fs.stat(filePath)
    let root = filePath.startsWith(custody + path.sep)
      ? custody
      : await findSongListRoot(path.dirname(filePath))
    if (!root) {
      const candidates = await loadSetSongCacheCandidates([filePath])
      root =
        (candidates.get(setSongCacheLookupKey(filePath)) || []).find(
          (c) => c.size === stat.size && Math.abs(c.mtimeMs - stat.mtimeMs) <= 1
        )?.listRoot || null
    }
    if (!root) throw new Error('SET_SYNC_CACHE_ROOT_MISSING')
    let wave: Awaited<ReturnType<typeof decodeSetPackageWaveforms>> | null = null
    if (item.waveform) {
      const bytes = await fs.readFile(
        await getSetAsset(item.waveform, local.directory, local.files, signal)
      )
      if (
        bytes.byteLength !== item.waveform.size ||
        createHash('sha256').update(bytes).digest('hex') !== item.waveform.sha256
      )
        throw new Error('SET_SYNC_HASH_MISMATCH')
      wave = await decodeSetPackageWaveforms(bytes, item.audio.sha256)
    }
    const detail = wave?.detail ? await prepareUnifiedDisplayWaveformWrite(wave.detail) : null
    prepared.push({ item, filePath, stat, root, info, wave, detail })
    progress(index + 1, changed.length)
  }
  if (!(await waitForLibraryTreeWatcherIdle())) throw new Error('SET_SYNC_BUSY_LIBRARY')
  const release = await acquireLibraryMergeLockAfterMaintenanceIdle()
  const releaseWatcher = beginLibraryTreeWatcherBulkOperation()
  try {
    signal.throwIfAborted()
    assertSetDiskUnchanged(local)
    if (
      store.databaseDir !== path.dirname(path.dirname(local.directory)) ||
      setLocalGuard() !== local.guard
    )
      throw new Error('SET_SYNC_LOCAL_CHANGED')
    for (const entry of prepared) {
      const stat = fs.statSync(entry.filePath)
      if (
        stat.size !== entry.stat.size ||
        stat.mtimeMs !== entry.stat.mtimeMs ||
        isPathBusyForRemoteMutation(entry.filePath)
      )
        throw new Error('SET_SYNC_LOCAL_CHANGED')
    }
    const oldNodes = new Map(local.snapshot.nodes.map((n) => [n.id, n]))
    const existing = new Set(
      db
        .prepare<{ uuid: string }>('SELECT uuid FROM library_nodes')
        .all()
        .map((r) => r.uuid)
    )
    for (const n of target.nodes) {
      if (existing.has(n.id) && !oldNodes.has(n.id)) throw new Error('SET_SYNC_ID_COLLISION')
    }
    const upsertNode =
      db.prepare(`INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET parent_uuid=excluded.parent_uuid,
      dir_name=excluded.dir_name, node_type=excluded.node_type, sort_order=excluded.sort_order`)
    const upsertItem = db.prepare(`INSERT INTO set_items
      (id, playlist_uuid, file_path, sort_order, origin_playlist_uuid, origin_path_snapshot, analysis_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET playlist_uuid=excluded.playlist_uuid,
      file_path=excluded.file_path, sort_order=excluded.sort_order, analysis_json=excluded.analysis_json,
      origin_playlist_uuid=excluded.origin_playlist_uuid, origin_path_snapshot=excluded.origin_path_snapshot,
      created_at_ms=excluded.created_at_ms`)
    const upsertCache =
      db.prepare(`INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET
      size=excluded.size, mtime_ms=excluded.mtime_ms, info_json=excluded.info_json`)
    commitSetTree(local, target, () => {
      for (const n of target.nodes) {
        if (!sameSetValue(oldNodes.get(n.id), n))
          upsertNode.run(
            n.id,
            n.parentId === SET_SYNC_ROOT ? local.root.uuid : n.parentId,
            n.name,
            n.type,
            n.order
          )
      }
      for (const old of removed) db.prepare('DELETE FROM set_items WHERE id = ?').run(old.id)
      for (const p of prepared) {
        const previous = local.records.get(p.item.id)
        const keepOrigin = before.get(p.item.id)?.audio.sha256 === p.item.audio.sha256
        upsertItem.run(
          p.item.id,
          p.item.playlistId,
          p.filePath,
          p.item.order,
          keepOrigin ? previous?.originPlaylistUuid || null : null,
          keepOrigin ? previous?.originPathSnapshot || null : null,
          JSON.stringify(stripMachineLocalSongFields(p.info)),
          p.item.createdAtMs
        )
        const rootKey = resolveListRootInput(p.root)
        const fileKey = rootKey ? resolveFilePathInput(rootKey.abs, p.filePath) : null
        if (!rootKey || !fileKey) throw new Error('SET_SYNC_CACHE_ROOT_MISSING')
        upsertCache.run(
          rootKey.key,
          fileKey.key,
          p.stat.size,
          p.stat.mtimeMs,
          JSON.stringify(normalizeSongCacheInfoForStorage(p.info, p.filePath))
        )
        markPlaylistViewSnapshotContentStale(rootKey.key)
        if (
          p.wave?.detail &&
          p.detail &&
          !writePreparedUnifiedDisplayWaveform(p.root, p.filePath, p.stat, p.wave.detail, p.detail)
        )
          throw new Error('SET_SYNC_WAVEFORM_WRITE_FAILED')
        const surfaces =
          p.wave?.surfaces ||
          (p.wave?.detail && buildWaveformSurfaceCacheDataFromUnifiedDisplay(p.wave.detail))
        if (surfaces && !writePreparedWaveformSurface(p.root, p.filePath, p.stat, surfaces))
          throw new Error('SET_SYNC_WAVEFORM_WRITE_FAILED')
      }
      for (const n of local.snapshot.nodes) {
        if (!target.nodes.some((next) => next.id === n.id))
          db.prepare('DELETE FROM library_nodes WHERE uuid = ?').run(n.id)
      }
      writeSetSyncBase(userKey, target)
      queueSetSyncCleanup(cleanupItems)
    })
  } finally {
    releaseWatcher()
    release()
  }
  const affected = new Set([...changed, ...removed].map((i) => i.playlistId))
  for (const i of changed) {
    const old = before.get(i.id)
    if (old) affected.add(old.playlistId)
  }
  if (!sameSetValue(local.snapshot.nodes, target.nodes)) await notifyTree()
  if (affected.size) {
    markGlobalSongSearchDirty('setLibrarySync')
    const win = mainWindow.instance
    if (win && !win.isDestroyed())
      win.webContents.send('setLibrarySync/itemsChanged', { uuids: [...affected] })
  }
  await cleanupSetSyncCustody()
}
