import { describe, expect, it } from 'vitest'
import {
  emptySetSnapshot,
  mergeSetSnapshots,
  SET_SYNC_ROOT,
  type SetSyncItem,
  type SetSyncNode
} from './setLibrarySync'
import { parseSetSnapshot } from '../main/setLibrarySync/validation'

const folder = '11111111-1111-4111-8111-111111111111'
const list = '22222222-2222-4222-8222-222222222222'
const row = '33333333-3333-4333-8333-333333333333'
const second = '44444444-4444-4444-8444-444444444444'
const asset = { sha256: 'a'.repeat(64), size: 10 }
const node = (
  id = list,
  parentId = SET_SYNC_ROOT,
  type: 'dir' | 'setList' = 'setList'
): SetSyncNode => ({ id, parentId, name: 'SET', type, order: 1 })
const item = (id = row): SetSyncItem => ({
  id,
  playlistId: list,
  order: 1,
  createdAtMs: 10,
  fileName: 'a.mp3',
  audio: asset,
  analysis: asset,
  waveform: null
})
const snapshot = (nodes = [node()], items = [item()]) => ({ ...emptySetSnapshot(), nodes, items })

describe('SET library three-way sync', () => {
  it('preserves duplicate rows while sharing the same audio', () => {
    const local = snapshot([node()], [item(), { ...item(second), order: 2 }])
    const merged = mergeSetSnapshots(emptySetSnapshot(), local, emptySetSnapshot())
    expect(merged.snapshot.items.map((i) => i.id)).toEqual([row, second])
    expect(merged.conflicts).toEqual([])
  })
  it('combines an independent reorder with remote analysis edits', () => {
    const base = snapshot()
    const local = snapshot([node()], [{ ...item(), order: 3 }])
    const cloud = snapshot(
      [node()],
      [{ ...item(), analysis: { ...asset, sha256: 'b'.repeat(64) } }]
    )
    const result = mergeSetSnapshots(base, local, cloud)
    expect(result.conflicts).toEqual([])
    expect(result.snapshot.items[0]).toMatchObject({ order: 3, analysis: cloud.items[0].analysis })
  })
  it('detects delete versus edit without silently dropping the local version', () => {
    const result = mergeSetSnapshots(
      snapshot(),
      snapshot([node()], []),
      snapshot([node()], [{ ...item(), order: 3 }])
    )
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].local).toBeNull()
    const resolved = mergeSetSnapshots(
      snapshot(),
      snapshot([node()], []),
      snapshot([node()], [{ ...item(), order: 3 }]),
      'local'
    )
    expect(resolved.snapshot.items).toEqual([])
  })
  it('applies a remote deletion after the local copy has joined', () => {
    const result = mergeSetSnapshots(snapshot(), snapshot(), emptySetSnapshot())
    expect(result.conflicts).toEqual([])
    expect(result.snapshot.items).toEqual([])
    expect(result.snapshot.nodes).toEqual([])
  })
  it('preserves independently created same-name playlists with stable names', () => {
    const a = mergeSetSnapshots(
      emptySetSnapshot(),
      snapshot([node()], []),
      snapshot([node(second)], [])
    )
    const b = mergeSetSnapshots(
      emptySetSnapshot(),
      snapshot([node(second)], []),
      snapshot([node()], [])
    )
    expect(a.snapshot).toEqual(b.snapshot)
    expect(new Set(a.snapshot.nodes.map((n) => n.name)).size).toBe(2)
    expect(() => parseSetSnapshot(a.snapshot)).not.toThrow()
  })
  it('requires a choice when an ancestor deletion races with a child addition', () => {
    const base = snapshot([node(folder, SET_SYNC_ROOT, 'dir')], [])
    const cloud = snapshot([node(folder, SET_SYNC_ROOT, 'dir'), node(list, folder)], [item()])
    const result = mergeSetSnapshots(base, emptySetSnapshot(), cloud)
    expect(result.conflicts.some((c) => c.field === 'children')).toBe(true)
    expect(() => parseSetSnapshot(result.snapshot)).not.toThrow()
    const deleted = mergeSetSnapshots(base, emptySetSnapshot(), cloud, 'local')
    expect(() => parseSetSnapshot(deleted.snapshot)).not.toThrow()
    expect(deleted.snapshot.items).toEqual([])
  })
  it('rejects traversal, cycles and unsafe cloud names before filesystem writes', () => {
    expect(() => parseSetSnapshot(snapshot([{ ...node(), name: '..' }]))).toThrow()
    expect(() => parseSetSnapshot(snapshot([{ ...node(), parentId: list }]))).toThrow()
    expect(() => parseSetSnapshot(snapshot([{ ...node(), name: 'CON.mp3' }]))).toThrow()
  })
  it('detects cycles formed by independent moves on two devices', () => {
    const base = snapshot(
      [
        node(folder, SET_SYNC_ROOT, 'dir'),
        { ...node(second, SET_SYNC_ROOT, 'dir'), name: 'Other' }
      ],
      []
    )
    const local = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === folder ? { ...n, parentId: second } : n))
    }
    const cloud = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === second ? { ...n, parentId: folder } : n))
    }
    expect(mergeSetSnapshots(base, local, cloud).conflicts).toHaveLength(2)
    expect(() =>
      parseSetSnapshot(mergeSetSnapshots(base, local, cloud, 'local').snapshot)
    ).not.toThrow()
    expect(() =>
      parseSetSnapshot(mergeSetSnapshots(base, local, cloud, 'cloud').snapshot)
    ).not.toThrow()
  })
})
