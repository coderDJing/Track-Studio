import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginMainThreadActivity,
  endMainThreadActivity,
  getMainThreadActivitySnapshot,
  resetMainThreadActivityTraceForTests,
  runTracedSync,
  summarizeIpcArgHint
} from './mainProcessActivityTraceState'

afterEach(() => {
  resetMainThreadActivityTraceForTests()
  vi.useRealTimers()
})

describe('summarizeIpcArgHint', () => {
  it('只记录数组长度，不写入内容', () => {
    expect(summarizeIpcArgHint([['secret.mp3', 'other.wav']])).toEqual({
      argCount: 1,
      argHint: 'array:2'
    })
  })

  it('只记录对象里第一个数组字段的长度', () => {
    expect(
      summarizeIpcArgHint([
        {
          title: 'ignored',
          filePaths: ['a', 'b', 'c']
        }
      ])
    ).toEqual({
      argCount: 1,
      argHint: 'object:filePaths.length=3'
    })
  })

  it('字符串只记录长度', () => {
    const filePath = 'D:/music/track.mp3'
    expect(summarizeIpcArgHint([filePath])).toEqual({
      argCount: 1,
      argHint: `string:${filePath.length}`
    })
  })
})

describe('getMainThreadActivitySnapshot', () => {
  it('把仍在进行的任务标成 pending，并按耗时排序', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    beginMainThreadActivity({ kind: 'sync', name: 'sqlite:wal_checkpoint' })
    vi.setSystemTime(3_000)
    beginMainThreadActivity({ kind: 'ipc-handle', name: 'fast' })
    vi.setSystemTime(4_000)
    const snapshot = getMainThreadActivitySnapshot(1_000)
    expect(snapshot.pendingTotal).toBe(2)
    expect(snapshot.pending.map((item) => item.name)).toEqual(['sqlite:wal_checkpoint', 'fast'])
    expect(snapshot.longest).toEqual({
      kind: 'sync',
      name: 'sqlite:wal_checkpoint',
      durationMs: 3_000,
      pending: true
    })
  })

  it('只保留与卡顿窗口重叠的已完成任务', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const oldId = beginMainThreadActivity({ kind: 'ipc-handle', name: 'old' })
    vi.setSystemTime(1_050)
    endMainThreadActivity(oldId)
    vi.setSystemTime(5_000)
    const stallId = beginMainThreadActivity({
      kind: 'ipc-handle',
      name: 'songList:scan',
      argCount: 1,
      argHint: 'object:scanPathCount'
    })
    vi.setSystemTime(27_000)
    endMainThreadActivity(stallId)
    const snapshot = getMainThreadActivitySnapshot(5_000)
    expect(snapshot.slowest.map((item) => item.name)).toEqual(['songList:scan'])
    expect(snapshot.slowest[0]?.durationMs).toBe(22_000)
    expect(snapshot.pending).toEqual([])
    expect(snapshot.pendingTotal).toBe(0)
  })

  it('runTracedSync 结束后能读到耗时', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    runTracedSync('sqlite:createDatabase', () => {
      vi.setSystemTime(13_400)
      return 1
    })
    const snapshot = getMainThreadActivitySnapshot(10_000)
    expect(snapshot.slowest[0]).toMatchObject({
      kind: 'sync',
      name: 'sqlite:createDatabase',
      durationMs: 3_400,
      pending: false
    })
  })

  it('待处理任务很多时保留总数并限制快照体积', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    for (let index = 0; index < 20; index += 1) {
      beginMainThreadActivity({ kind: 'ipc-handle', name: `pending-${index}` })
    }
    vi.setSystemTime(2_000)
    const snapshot = getMainThreadActivitySnapshot(1_000)
    expect(snapshot.pendingTotal).toBe(20)
    expect(snapshot.pending).toHaveLength(12)
  })
})
