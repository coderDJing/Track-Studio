import { describe, expect, it } from 'vitest'
import { canPlayHtmlAudio } from './webAudioPlayer.shared'

describe('canPlayHtmlAudio', () => {
  it.each(['track.aif', 'track.aiff'])('routes %s through PCM playback', (filePath) => {
    expect(canPlayHtmlAudio(filePath)).toBe(false)
  })

  it('plays NetEase preview URLs through HTML audio, including the legacy host-less form', () => {
    expect(canPlayHtmlAudio('frkb-preview://netease/?netease=1901371647')).toBe(true)
    expect(canPlayHtmlAudio('frkb-preview://?netease=1901371647')).toBe(true)
  })
})
