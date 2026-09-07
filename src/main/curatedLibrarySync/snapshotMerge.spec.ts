import { describe, expect, it } from 'vitest'
import { mergeCuratedLibrarySnapshot, parseCuratedLibrarySnapshot } from './snapshotMerge'
import { CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID } from '../../shared/curatedLibrarySync'
import type { CuratedLibrarySyncSnapshot } from '../../shared/curatedLibrarySync'

const base = (): CuratedLibrarySyncSnapshot => ({
  protocolVersion: 1,
  revision: 1,
  snapshotReady: true,
  full: true,
  nodes: [
    {
      uuid: '11111111-1111-4111-8111-111111111111',
      parentUuid: '00000000-0000-4000-8000-000000000000',
      name: 'House',
      nodeType: 'songList',
      sortOrder: 0,
      updatedAtMs: 1,
      revision: 1
    }
  ],
  files: [
    {
      fileId: '22222222-2222-4222-8222-222222222222',
      parentUuid: '11111111-1111-4111-8111-111111111111',
      fileName: 'a.mp3',
      sha256: 'a'.repeat(64),
      size: 10,
      trackNumber: 1,
      addedAtMs: 1,
      updatedAtMs: 1,
      revision: 1
    }
  ],
  tombstones: []
})

describe('mergeCuratedLibrarySnapshot', () => {
  it('完整拉取时替换本地缓存', () => {
    const cached = base()
    const pulled: CuratedLibrarySyncSnapshot = {
      ...base(),
      revision: 2,
      files: [],
      tombstones: [
        {
          kind: 'file',
          id: '22222222-2222-4222-8222-222222222222',
          revision: 2,
          deletedAtMs: 2
        }
      ]
    }
    const merged = mergeCuratedLibrarySnapshot(cached, pulled)
    expect(merged.files).toEqual([])
    expect(merged.tombstones).toHaveLength(1)
  })

  it('增量拉取时合并变更并应用墓碑', () => {
    const cached = base()
    const pulled: CuratedLibrarySyncSnapshot = {
      protocolVersion: 1,
      revision: 2,
      snapshotReady: true,
      full: false,
      nodes: [],
      files: [],
      tombstones: [
        {
          kind: 'file',
          id: '22222222-2222-4222-8222-222222222222',
          revision: 2,
          deletedAtMs: 2
        }
      ]
    }
    const merged = mergeCuratedLibrarySnapshot(cached, pulled)
    expect(merged.files).toEqual([])
    expect(merged.nodes).toHaveLength(1)
    expect(merged.revision).toBe(2)
  })

  it('增量 undelete 会去掉对应墓碑', () => {
    const cached = base()
    cached.files = []
    cached.tombstones = [
      {
        kind: 'file',
        id: '22222222-2222-4222-8222-222222222222',
        revision: 2,
        deletedAtMs: 2
      }
    ]
    const pulled: CuratedLibrarySyncSnapshot = {
      protocolVersion: 1,
      revision: 3,
      snapshotReady: true,
      full: false,
      nodes: [],
      files: base().files.map((file) => ({ ...file, revision: 3 })),
      tombstones: []
    }
    const merged = mergeCuratedLibrarySnapshot(cached, pulled)
    expect(merged.files).toHaveLength(1)
    expect(merged.tombstones).toEqual([])
  })
})

describe('parseCuratedLibrarySnapshot', () => {
  const node = {
    uuid: '11111111-1111-4111-8111-111111111111',
    parentUuid: CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID,
    name: 'List',
    nodeType: 'songList' as const,
    sortOrder: null,
    updatedAtMs: 1
  }

  it('拒绝畸形响应，不能把它当成空云端精选库', () => {
    expect(parseCuratedLibrarySnapshot({ protocolVersion: 1, revision: 2 })).toBeNull()
    expect(
      parseCuratedLibrarySnapshot({
        protocolVersion: 1,
        revision: 2,
        snapshotReady: true,
        nodes: [node],
        files: [{}],
        tombstones: []
      })
    ).toBeNull()
    expect(
      parseCuratedLibrarySnapshot({
        protocolVersion: 1,
        revision: 2,
        snapshotReady: true,
        nodes: [
          {
            uuid: '11111111-1111-4111-8111-111111111111',
            parentUuid: '22222222-2222-4222-8222-222222222222',
            name: 'Orphan',
            nodeType: 'dir',
            sortOrder: null,
            updatedAtMs: 1
          }
        ],
        files: [],
        tombstones: []
      })
    ).toBeNull()
  })

  it('接受完整协议快照', () => {
    expect(
      parseCuratedLibrarySnapshot({
        protocolVersion: 1,
        revision: 2,
        snapshotReady: true,
        full: true,
        nodes: [node],
        files: [],
        tombstones: []
      })
    ).toMatchObject({ protocolVersion: 1, revision: 2, snapshotReady: true, nodes: [node] })
  })

  it('接受省略未变更父节点的增量快照', () => {
    expect(
      parseCuratedLibrarySnapshot({
        protocolVersion: 1,
        revision: 2,
        snapshotReady: true,
        full: false,
        nodes: [
          {
            ...node,
            uuid: '33333333-3333-4333-8333-333333333333',
            parentUuid: '44444444-4444-4444-8444-444444444444',
            revision: 2
          }
        ],
        files: [],
        tombstones: []
      })
    ).not.toBeNull()
  })
})
