type PlaylistAnalysisGateRuntime = {
  mainWindowBrowseMode?: string
  playingData?: {
    playingSongListUUID?: string
  }
  playlistAnalysisPromptDismissedSongListUUIDs?: string[]
}

export type BrowserMainPlayerAnalysisIntent = 'immediate' | 'promote-if-queued'

export type MainPlayerPlayingAnalysisPayload = {
  analysisAuthority: 'frkb'
  filePath: string
  focusSlot: 'main-player'
  onlyIfQueued: boolean
}

export const resolveBrowserMainPlayerAnalysisIntent = (
  runtime: PlaylistAnalysisGateRuntime
): BrowserMainPlayerAnalysisIntent => {
  // 浏览器模式播放不新建分析，只把已在队列里的歌提升为立即分析。
  if (runtime.mainWindowBrowseMode === 'browser') return 'promote-if-queued'
  return 'immediate'
}

export const buildMainPlayerPlayingAnalysisPayload = (
  filePath: string,
  runtime: PlaylistAnalysisGateRuntime
): MainPlayerPlayingAnalysisPayload | null => {
  const trimmed = String(filePath || '').trim()
  if (!trimmed) return null
  const intent = resolveBrowserMainPlayerAnalysisIntent(runtime)
  return {
    analysisAuthority: 'frkb',
    filePath: trimmed,
    focusSlot: 'main-player',
    onlyIfQueued: intent === 'promote-if-queued'
  }
}

export const queueMainPlayerPlayingAnalysis = (
  runtime: PlaylistAnalysisGateRuntime,
  filePath: string
) => {
  const payload = buildMainPlayerPlayingAnalysisPayload(filePath, runtime)
  if (!payload) return
  try {
    window.electron.ipcRenderer.send('key-analysis:queue-playing', payload)
  } catch {}
}
