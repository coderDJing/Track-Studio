import { describe, expect, it } from 'vitest'
import type { CuratedLibrarySyncCloudFile } from '../../shared/curatedLibrarySync'
import type { CuratedLocalFile } from './scan'
import { collectPendingTrackParentUuids } from './applyRemoteTrackNumbers'

const fileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const parentUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const sha256 = 'c'.repeat(64)
const absPath = 'C:\\library\\house\\track.mp3'

const lastFile: CuratedLibrarySyncCloudFile = {
  fileId,
  parentUuid,
  fileName: 'track.mp3',
  sha256,
  size: 1,
  trackNumber: 1,
  addedAtMs: 10,
  updatedAtMs: 1
}

const scannedFile: CuratedLocalFile = {
  fileId,
  relativePath: 'house/track.mp3',
  parentUuid,
  fileName: 'track.mp3',
  contentSha256: sha256,
  contentSize: 1,
  mtimeMs: 1,
  trackNumber: 1,
  addedAtMs: 10,
  updatedAtMs: 1,
  location: 'curated',
  locationPath: 'house/track.mp3',
  absPath
}

describe('collectPendingTrackParentUuids', () => {
  it('扫描后才拖动的曲序会阻止云端旧曲序落地', () => {
    const result = collectPendingTrackParentUuids({
      localFiles: [scannedFile],
      lastAppliedFiles: new Map([[fileId, lastFile]]),
      liveCacheByPath: new Map([[absPath, { trackNumber: 2, addedAtMs: 10 }]]),
      scope: { curatedUuid: 'curated', snapshotNodeIds: new Set([parentUuid]) }
    })

    expect(result).toEqual(new Set([parentUuid]))
  })

  it('实时曲序未变化时允许云端曲序正常落地', () => {
    const result = collectPendingTrackParentUuids({
      localFiles: [scannedFile],
      lastAppliedFiles: new Map([[fileId, lastFile]]),
      liveCacheByPath: new Map([[absPath, { trackNumber: 1, addedAtMs: 10 }]]),
      scope: { curatedUuid: 'curated', snapshotNodeIds: new Set([parentUuid]) }
    })

    expect(result.size).toBe(0)
  })
})
