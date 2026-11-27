import { expect, it } from 'vitest'
import { createSongBeatGridMapV2FromClips } from '@shared/songBeatGridMapV2'
import {
  icloudAnalysisItemForPath,
  icloudListKeyForAnalysisPath,
  mergeIcloudAnalysis,
  rememberIcloudAnalysisPath
} from './icloudAnalysisRows'

it('maps a deck-local analysis path back to the list row before bind returns', () => {
  const paths = new Map<string, string>()
  rememberIcloudAnalysisPath(paths, '/tmp/Library/Track.wav', 'Library/Track.wav')
  const grid = createSongBeatGridMapV2FromClips(
    [{ startSec: 0, anchorSec: 0, bpm: 128, downbeatBeatOffset: 0 }],
    'analysis',
    { allowSingleClip: true }
  )
  const item = icloudAnalysisItemForPath(paths, '/tmp/Library/Track.wav', { beatGridMap: grid })
  const merged = mergeIcloudAnalysis({}, paths, item ? [item] : [])
  expect(merged['Library/Track.wav']?.bpm).toBe(128)
  expect(icloudListKeyForAnalysisPath(paths, '/tmp/Library/Track.wav')).toBe(
    'icloud-song:Library/Track.wav'
  )
  expect(icloudAnalysisItemForPath(paths, '/tmp/other.wav', { beatGridMap: grid })).toBeNull()
})
