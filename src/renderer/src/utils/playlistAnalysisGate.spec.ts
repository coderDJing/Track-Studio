import { describe, expect, it } from 'vitest'
import {
  buildMainPlayerPlayingAnalysisPayload,
  resolveBrowserMainPlayerAnalysisIntent
} from './playlistAnalysisGate'

const createRuntime = (mode: string) => ({
  mainWindowBrowseMode: mode,
  playingData: {
    playingSongListUUID: 'list-a'
  },
  playlistAnalysisPromptDismissedSongListUUIDs: ['list-a']
})

describe('browser main player analysis gate', () => {
  it('does not create a new analysis job from browser playback', () => {
    expect(resolveBrowserMainPlayerAnalysisIntent(createRuntime('browser'))).toBe(
      'promote-if-queued'
    )
    expect(
      buildMainPlayerPlayingAnalysisPayload('D:\\music\\track.wav', createRuntime('browser'))
    ).toEqual({
      analysisAuthority: 'frkb',
      filePath: 'D:\\music\\track.wav',
      focusSlot: 'main-player',
      onlyIfQueued: true
    })
  })

  it('keeps immediate analysis when leaving browser mode', () => {
    expect(resolveBrowserMainPlayerAnalysisIntent(createRuntime('horizontal'))).toBe('immediate')
    expect(resolveBrowserMainPlayerAnalysisIntent(createRuntime('edit'))).toBe('immediate')
    expect(
      buildMainPlayerPlayingAnalysisPayload('D:\\music\\track.wav', createRuntime('horizontal'))
    ).toEqual({
      analysisAuthority: 'frkb',
      filePath: 'D:\\music\\track.wav',
      focusSlot: 'main-player',
      onlyIfQueued: false
    })
  })

  it('does not send guarded iCloud playback tickets to local file analysis', () => {
    expect(
      buildMainPlayerPlayingAnalysisPayload(
        'frkb-preview://icloud/?path=%2Ffixture%2Fsong.mp3&ticket=selected',
        createRuntime('edit')
      )
    ).toBeNull()
  })

  it('ignores empty playback paths', () => {
    expect(buildMainPlayerPlayingAnalysisPayload('', createRuntime('browser'))).toBeNull()
  })

  it('does not enqueue NetEase preview or pending placeholder paths', () => {
    expect(
      buildMainPlayerPlayingAnalysisPayload('frkb-preview://?netease=123456', createRuntime('edit'))
    ).toBeNull()
    expect(
      buildMainPlayerPlayingAnalysisPayload('netease-pending:123456', createRuntime('horizontal'))
    ).toBeNull()
  })
})
