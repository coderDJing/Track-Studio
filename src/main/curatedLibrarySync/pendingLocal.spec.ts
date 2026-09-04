import { describe, expect, it } from 'vitest'
import { CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID } from '../../shared/curatedLibrarySync'
import { localFilePendingSinceLast, localNodePendingSinceLast, sameSortOrder } from './pendingLocal'

const curatedUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const lastNodeIds = new Set([curatedUuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])

describe('pendingLocal', () => {
  it('sameSortOrder 把旧服务端的 0 和 null 当成一样', () => {
    expect(sameSortOrder(null, 0)).toBe(true)
    expect(sameSortOrder(1, 2)).toBe(false)
  })

  it('本机改了歌单序号就算 pending', () => {
    const last = {
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      parentUuid: CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID,
      name: 'house',
      nodeType: 'songList' as const,
      sortOrder: 0,
      updatedAtMs: 1
    }
    const local = {
      uuid: last.uuid,
      parentUuid: CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID,
      name: 'house',
      nodeType: 'songList' as const,
      sortOrder: 3,
      updatedAtMs: 2
    }
    expect(localNodePendingSinceLast(local, last, curatedUuid, lastNodeIds)).toBe(true)
    expect(
      localNodePendingSinceLast({ ...local, sortOrder: 0 }, last, curatedUuid, lastNodeIds)
    ).toBe(false)
  })

  it('本机改了歌单内曲序就算 pending', () => {
    const last = {
      fileId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      parentUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      fileName: 'a.mp3',
      sha256: 'd'.repeat(64),
      size: 1,
      trackNumber: 1,
      addedAtMs: 10,
      updatedAtMs: 1
    }
    expect(
      localFilePendingSinceLast(
        {
          parentUuid: last.parentUuid,
          fileName: last.fileName,
          contentSha256: last.sha256,
          trackNumber: 2,
          addedAtMs: 10
        },
        last,
        curatedUuid,
        lastNodeIds
      )
    ).toBe(true)
  })
})
