import emitter from '@renderer/utils/mitt'

let nextMissingAnalysisScanProgressId = 0

type MissingAnalysisScanProgress = {
  markPlaylistScanned: () => void
  complete: () => void
  dismiss: () => void
}

/**
 * 「分析未分析歌曲」在真正入队前需要完整扫描歌单。把这段耗时工作单独呈现在
 * 底部任务区，避免用户误以为点击没有生效。
 */
export const createMissingAnalysisScanProgress = (
  playlistCount: number
): MissingAnalysisScanProgress => {
  nextMissingAnalysisScanProgressId += 1
  const id = `tracks.missing-analysis-scan.${Date.now()}.${nextMissingAnalysisScanProgressId}`
  const total = Math.max(1, Math.floor(playlistCount))
  let completed = 0
  let dismissed = false

  const emitProgress = () => {
    if (dismissed) return
    emitter.emit('renderer-progressSet', {
      id,
      titleKey: 'tracks.scanningMissingAnalysisPlaylists',
      now: completed,
      total,
      isInitial: completed === 0
    })
  }

  emitProgress()

  return {
    markPlaylistScanned: () => {
      if (dismissed || completed >= total) return
      completed += 1
      emitProgress()
    },
    complete: () => {
      if (dismissed) return
      completed = total
      emitProgress()
    },
    dismiss: () => {
      if (dismissed) return
      dismissed = true
      emitter.emit('renderer-progressSet', { id, dismiss: true })
    }
  }
}
