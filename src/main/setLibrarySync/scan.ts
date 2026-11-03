import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'fs-extra'
import store from '../store'
import { getCoreFsDirName } from '../coreLibraries'
import { getLibraryDb } from '../libraryDb'
import { loadLibraryNodes, type LibraryNodeRow } from '../libraryTreeDb'
import { loadSetPlaylistSongs } from '../ipc/setListHandlers'
import { hashFileSha256 } from '../curatedLibrarySync/hashFile'
import { exportTrackWaveforms } from '../services/setPackage/waveformTransfer'
import { stripMachineLocalSongFields } from '../services/setPackage/manifest'
import {
  loadSetSongCacheCandidates,
  readSetSongCacheCandidates,
  setSongCacheLookupKey
} from '../services/setListCachedSongScan'
import {
  SET_SYNC_ROOT,
  emptySetSnapshot,
  stableSetJson,
  type SetSyncAsset,
  type SetSyncSnapshot
} from '../../shared/setLibrarySync'
import { parseSetSnapshot } from './validation'

export type SetLocalItem = {
  id: string
  filePath: string
  originPlaylistUuid: string | null
  originPathSnapshot: string | null
  analysisJson: string | null
}
export type SetLocalScan = {
  snapshot: SetSyncSnapshot
  files: Map<string, string>
  records: Map<string, SetLocalItem>
  nodePaths: Map<string, string>
  nodes: LibraryNodeRow[]
  root: LibraryNodeRow
  rootPath: string
  directory: string
  guard: string
  disk: Map<string, string>
}
const audioHashCache = new Map<string, { signature: string; sha256: string }>()
export function setDiskSignature(source: string): string {
  const stat = fs.statSync(source)
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}
export function assertSetDiskUnchanged(scan: SetLocalScan): void {
  assertSetTreeOnDisk(scan)
  for (const [file, signature] of scan.disk) {
    if (setDiskSignature(file) !== signature) throw new Error('SET_SYNC_LOCAL_CHANGED')
  }
}
export function assertSetTreeOnDisk(tree: ReturnType<typeof readSetTree>): void {
  for (const [id, directory] of tree.nodePaths) {
    const expected = tree.nodes
      .filter((n) => n.parentUuid === id)
      .map((n) => n.dirName)
      .sort()
    const actual = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !(id === tree.root.uuid && entry.name === '__set_custody__')
      )
      .map((entry) => entry.name)
      .sort()
    if (stableSetJson(actual) !== stableSetJson(expected)) throw new Error('SET_SYNC_LOCAL_CHANGED')
  }
}

export function readSetTree() {
  const rows = loadLibraryNodes()
  if (!rows) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  const root = rows.find(
    (r) => r.nodeType === 'library' && r.dirName === getCoreFsDirName('SetLibrary')
  )
  if (!root) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  const rootPath = path.join(store.databaseDir, 'library', root.dirName)
  const nodes: LibraryNodeRow[] = []
  const nodePaths = new Map([[root.uuid, rootPath]])
  const walk = (parent: LibraryNodeRow) => {
    for (const row of rows.filter((r) => r.parentUuid === parent.uuid)) {
      if (row.nodeType !== 'dir' && row.nodeType !== 'setList')
        throw new Error('SET_SYNC_INVALID_NODE_TYPE')
      nodePaths.set(row.uuid, path.join(nodePaths.get(parent.uuid)!, row.dirName))
      nodes.push(row)
      walk(row)
    }
  }
  walk(root)
  return { root, rootPath, nodes, nodePaths }
}

/** Synchronous generation guard used immediately before the final database transaction. */
export function setLocalGuard(): string {
  const db = getLibraryDb()
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  const items = db.prepare<{ file_path: string }>('SELECT * FROM set_items ORDER BY id').all()
  const paths = items.map((i) =>
    path.isAbsolute(i.file_path)
      ? i.file_path
      : path.join(store.databaseDir, 'library', i.file_path)
  )
  return createHash('sha256')
    .update(
      stableSetJson({
        nodes: readSetTree().nodes,
        items,
        // Analysis edits live in song_cache, independently of set_items.
        cache: [...readSetSongCacheCandidates(paths, true)],
        detail: db
          .prepare(
            'SELECT list_root, file_path, updated_at_ms FROM unified_display_waveform_cache ORDER BY list_root, file_path'
          )
          .all(),
        surfaces: db
          .prepare(
            'SELECT list_root, file_path, updated_at_ms FROM waveform_surface_cache ORDER BY list_root, file_path'
          )
          .all()
      })
    )
    .digest('hex')
}

export async function scanSetLibrary(signal: AbortSignal): Promise<SetLocalScan> {
  const directory = await fs.mkdtemp(path.join(await ensureCacheRoot(), 'scan-'))
  try {
    const tree = readSetTree()
    assertSetTreeOnDisk(tree)
    const guardBefore = setLocalGuard()
    const snapshot = emptySetSnapshot()
    const files = new Map<string, string>()
    const records = new Map<string, SetLocalItem>()
    const disk = new Map<string, string>()
    snapshot.nodes = tree.nodes.map((n) => ({
      id: n.uuid,
      parentId: n.parentUuid === tree.root.uuid ? SET_SYNC_ROOT : n.parentUuid!,
      name: n.dirName,
      type: n.nodeType as 'dir' | 'setList',
      order: n.order
    }))
    const db = getLibraryDb()
    if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
    const audioByPath = new Map<string, SetSyncAsset>()
    const waveformByPath = new Map<string, SetSyncAsset | null>()
    for (const node of tree.nodes.filter((n) => n.nodeType === 'setList')) {
      signal.throwIfAborted()
      // The loader stats every file and only accepts caches matching the current disk identity.
      const { scanData } = await loadSetPlaylistSongs(node.uuid, false)
      const cacheCandidates = await loadSetSongCacheCandidates(
        scanData.map((song) => song.filePath)
      )
      const rows = db
        .prepare<{
          id: string
          file_path: string
          origin_playlist_uuid: string | null
          origin_path_snapshot: string | null
          analysis_json: string | null
          sort_order: number
          created_at_ms: number
        }>('SELECT * FROM set_items WHERE playlist_uuid = ? ORDER BY sort_order, created_at_ms, id')
        .all(node.uuid)
      if (rows.length !== scanData.length) throw new Error('SET_SYNC_LOCAL_CHANGED')
      for (const row of rows) {
        signal.throwIfAborted()
        const song = scanData.find((s) => s.setItemId === row.id)
        if (!song || song.fileMissing) throw new Error('SET_SYNC_MISSING_AUDIO')
        const source = path.isAbsolute(row.file_path)
          ? row.file_path
          : path.join(store.databaseDir, 'library', row.file_path)
        const stat = await fs.stat(source)
        if (!stat.isFile() || stat.size <= 0) throw new Error('SET_SYNC_MISSING_AUDIO')
        let audio = audioByPath.get(source)
        if (!audio) {
          const signature = setDiskSignature(source)
          const cachedHash = audioHashCache.get(source)
          const sha256 =
            cachedHash?.signature === signature ? cachedHash.sha256 : await hashFileSha256(source)
          audioHashCache.set(source, { signature, sha256 })
          disk.set(source, signature)
          audio = { sha256, size: stat.size }
          audioByPath.set(source, audio)
          files.set(audio.sha256, source)
          const waveform = await exportTrackWaveforms({
            filePath: source,
            stat,
            rootHints: [
              song.waveformPreviewListRoot || '',
              ...(cacheCandidates.get(setSongCacheLookupKey(source)) || [])
                .filter((c) => c.size === stat.size && Math.abs(c.mtimeMs - stat.mtimeMs) <= 1)
                .map((c) => c.listRoot)
            ],
            packageDir: directory,
            fileId: randomUUID(),
            audioSha256: audio.sha256
          })
          waveformByPath.set(
            source,
            waveform ? { sha256: waveform.sha256, size: waveform.size } : null
          )
          if (waveform)
            files.set(waveform.sha256, path.join(directory, ...waveform.path.split('/')))
        }
        const after = await fs.stat(source)
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          throw new Error('SET_SYNC_LOCAL_CHANGED')
        const data = Buffer.from(stableSetJson(stripMachineLocalSongFields(song)))
        const analysis = {
          sha256: createHash('sha256').update(data).digest('hex'),
          size: data.byteLength
        }
        const metadataPath = path.join(directory, analysis.sha256)
        await fs.writeFile(metadataPath, data)
        files.set(analysis.sha256, metadataPath)
        records.set(row.id, {
          id: row.id,
          filePath: row.file_path,
          originPlaylistUuid: row.origin_playlist_uuid,
          originPathSnapshot: row.origin_path_snapshot,
          analysisJson: row.analysis_json
        })
        snapshot.items.push({
          id: row.id,
          playlistId: node.uuid,
          order: row.sort_order,
          createdAtMs: row.created_at_ms,
          fileName: path.basename(song.fileName || source),
          audio,
          analysis,
          waveform: waveformByPath.get(source) || null
        })
      }
    }
    snapshot.nodes.sort((a, b) => a.id.localeCompare(b.id))
    snapshot.items.sort((a, b) => a.id.localeCompare(b.id))
    parseSetSnapshot(snapshot)
    const guard = setLocalGuard()
    if (guard !== guardBefore) throw new Error('SET_SYNC_LOCAL_CHANGED')
    const result = { ...tree, snapshot, files, records, directory, guard, disk }
    assertSetDiskUnchanged(result)
    return result
  } catch (error) {
    await fs.remove(directory)
    throw error
  }
}

export async function ensureCacheRoot(): Promise<string> {
  const root = path.join(store.databaseDir, '.set-sync-cache')
  await fs.ensureDir(root)
  return root
}
