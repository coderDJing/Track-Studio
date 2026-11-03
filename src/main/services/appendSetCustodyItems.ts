import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import store from '../store'
import { loadLibraryNodes } from '../libraryTreeDb'
import { appendSetItems } from '../setListDb'
import { removeSongCacheEntry, upsertSongCacheEntry } from '../libraryCacheDb'
import { scanSongList } from './scanSongs'
import { buildSetAnalysisSnapshot } from './setAnalysisSnapshot'
import { getSetCustodyDirAbs } from './setCustody'
import { mainFilePathKey } from '../filePathComparison'
import type { SetCustodyAppendPayload } from '../../shared/setCustody'

/** 复制外部音频到现有 SET 托管区，全部就绪后一次性加入歌单。 */
export async function appendSetCustodyItems(
  payload: SetCustodyAppendPayload,
  onProgress?: (done: number, total: number) => void
) {
  if (!store.databaseDir) throw new Error('音乐库尚未就绪')
  const node = (loadLibraryNodes() || []).find((row) => row.uuid === payload?.playlistUuid)
  if (node?.nodeType !== 'setList') throw new Error('目标 SET 歌单不存在')
  if (!Array.isArray(payload.items) || !payload.items.length) return []

  const custodyRoot = getSetCustodyDirAbs()
  const batchDir = path.join(custodyRoot, `external_${uuidV4()}`)
  const copies = new Map<string, { filePath: string; size: number; mtimeMs: number }>()
  try {
    onProgress?.(0, payload.items.length)
    // 独立子目录保留文件名；同一文件的重复歌单行共用一份托管音频。
    for (const { song } of payload.items) {
      const sourcePath = String(song?.filePath || '').trim()
      if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error('音频路径无效')
      const key = mainFilePathKey(sourcePath)
      if (copies.has(key)) continue
      const before = await fs.stat(sourcePath)
      if (!before.isFile()) throw new Error(`音频文件不存在：${sourcePath}`)
      const targetPath = path.join(batchDir, String(copies.size + 1), path.basename(sourcePath))
      await fs.ensureDir(path.dirname(targetPath))
      await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      const [after, copied] = await Promise.all([fs.stat(sourcePath), fs.stat(targetPath)])
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        copied.size !== before.size
      )
        throw new Error(`复制期间音频文件发生变化：${sourcePath}`)
      copies.set(key, { filePath: targetPath, size: copied.size, mtimeMs: copied.mtimeMs })
      onProgress?.(copies.size, payload.items.length)
    }

    // 从实际复制文件读取标签，不将 U 盘运行时身份或路径写进本地歌曲缓存。
    const scanned = await scanSongList(
      [...copies.values()].map((entry) => entry.filePath),
      store.settingConfig?.audioExt || [],
      payload.playlistUuid,
      { enablePostScanTasks: false }
    )
    const scannedByPath = new Map(
      scanned.scanData.map((song) => [mainFilePathKey(song.filePath), song])
    )
    for (const [sourceKey, copied] of copies) {
      const source = payload.items.find(
        (item) => mainFilePathKey(item.song.filePath) === sourceKey
      )!.song
      const scannedSong = scannedByPath.get(mainFilePathKey(copied.filePath))
      if (!scannedSong) throw new Error(`读取托管音频失败：${copied.filePath}`)
      const info = {
        ...scannedSong,
        ...buildSetAnalysisSnapshot(source),
        bpm: source.bpm,
        beatGridMap: source.beatGridMap,
        beatGridSource: source.beatGridSource,
        beatGridStatus: source.beatGridStatus,
        beatGridAlgorithmVersion: source.beatGridAlgorithmVersion,
        rekordboxGridEntries: source.rekordboxGridEntries,
        timeBasisOffsetMs: source.timeBasisOffsetMs,
        timeBasisOffsetAlgorithmVersion: source.timeBasisOffsetAlgorithmVersion,
        hotCues: source.hotCues || [],
        memoryCues: source.memoryCues || []
      }
      const saved = await upsertSongCacheEntry(custodyRoot, copied.filePath, {
        size: copied.size,
        mtimeMs: copied.mtimeMs,
        info
      })
      if (!saved) throw new Error('写入托管歌曲缓存失败')
    }
    const inserted = appendSetItems(
      payload.playlistUuid,
      payload.items.map(({ song, originPathSnapshot }) => ({
        filePath: copies.get(mainFilePathKey(song.filePath))!.filePath,
        originPathSnapshot,
        analysis: buildSetAnalysisSnapshot(song)
      }))
    )
    if (inserted.length !== payload.items.length) throw new Error('加入 SET 歌单失败')
    return inserted
  } catch (error) {
    for (const copied of copies.values()) {
      await removeSongCacheEntry(custodyRoot, copied.filePath).catch(() => false)
    }
    await fs.remove(batchDir)
    throw error
  }
}
