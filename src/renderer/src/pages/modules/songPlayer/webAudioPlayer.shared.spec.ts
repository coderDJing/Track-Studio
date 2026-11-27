import { canPlayHtmlAudio as canPlayGuardedCloudAudio, toPreviewUrl } from './webAudioPlayer.shared'
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

describe('guarded cloud playback routing', () => {
  it('uses the existing HTML/protocol route instead of passing ticket URLs to local decoders', () => {
    expect(
      canPlayGuardedCloudAudio('frkb-preview://icloud/?path=%2Ffixture%2Fsong.mp3&ticket=selected')
    ).toBe(true)
  })
})

describe('toPreviewUrl', () => {
  it('does not treat iCloud logical keys as local preview files', () => {
    expect(toPreviewUrl('icloud-song:Folder/track.wav')).toBe('')
  })

  it('keeps iCloud ticket URLs on the existing protocol route', () => {
    const ticket = 'frkb-preview://icloud/?path=Folder%2Ftrack.wav&ticket=selected'
    expect(toPreviewUrl(ticket)).toBe(ticket)
  })
})
