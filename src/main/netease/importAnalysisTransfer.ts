import path from 'node:path'
import { log } from '../log'
import { findSongListRoot, transferTrackCaches } from '../services/cacheMaintenance'

export type CopiedTrackAnalysisPair = {
  sourcePath: string
  destPath: string
}

/**
 * 把源文件上已有的分析结果（key / BPM / 波形 / 能量等 path-keyed 缓存）复制到新副本。
 * 源文件没有可用缓存时，transferTrackCaches 会安静跳过，目标曲目稍后按未分析处理。
 */
export async function transferCopiedTrackAnalysisCaches(
  pairs: CopiedTrackAnalysisPair[]
): Promise<{ attempted: number; failed: number }> {
  const list = Array.isArray(pairs) ? pairs : []
  let attempted = 0
  let failed = 0
  for (const pair of list) {
    const sourcePath = String(pair?.sourcePath || '').trim()
    const destPath = String(pair?.destPath || '').trim()
    if (!sourcePath || !destPath) continue
    attempted += 1
    try {
      const fromRoot = await findSongListRoot(path.dirname(sourcePath))
      const toRoot = await findSongListRoot(path.dirname(destPath))
      await transferTrackCaches({
        fromRoot,
        toRoot,
        fromPath: sourcePath,
        toPath: destPath,
        mode: 'copy'
      })
    } catch (error) {
      failed += 1
      log.warn('[netease] 复制分析结果失败，目标曲目将按未分析处理', {
        sourcePath,
        destPath,
        error
      })
    }
  }
  return { attempted, failed }
}
