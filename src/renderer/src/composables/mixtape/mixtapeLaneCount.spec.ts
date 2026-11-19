import { describe, expect, it } from 'vitest'
import { normalizeMixtapeLaneCount, resolveMixtapeStoredLaneIndex } from './constants'
import { buildMixtapeDisplayLaneMap } from './mixtapeLaneCount'

describe('resolveMixtapeStoredLaneIndex', () => {
  it('保留 0..3 的原始值，不按可见泳道数夹取', () => {
    expect(resolveMixtapeStoredLaneIndex(3)).toBe(3)
    expect(resolveMixtapeStoredLaneIndex(2)).toBe(2)
    expect(resolveMixtapeStoredLaneIndex(7)).toBe(3)
    expect(resolveMixtapeStoredLaneIndex(-2)).toBe(0)
  })

  it('没有持久化值时按双轨交替兜底', () => {
    expect(resolveMixtapeStoredLaneIndex(undefined, 0)).toBe(0)
    expect(resolveMixtapeStoredLaneIndex(undefined, 1)).toBe(1)
    expect(resolveMixtapeStoredLaneIndex(undefined, 2)).toBe(0)
  })
})

describe('normalizeMixtapeLaneCount', () => {
  it('只接受 2 与 4，其余一律回落到 2', () => {
    expect(normalizeMixtapeLaneCount(4)).toBe(4)
    expect(normalizeMixtapeLaneCount(2)).toBe(2)
    expect(normalizeMixtapeLaneCount(3)).toBe(2)
    expect(normalizeMixtapeLaneCount('4')).toBe(4)
    expect(normalizeMixtapeLaneCount(undefined)).toBe(2)
    expect(normalizeMixtapeLaneCount(null)).toBe(2)
    expect(normalizeMixtapeLaneCount(9)).toBe(4)
  })
})

describe('buildMixtapeDisplayLaneMap', () => {
  it('四轨时按存入的泳道原样显示', () => {
    const map = buildMixtapeDisplayLaneMap(
      [
        { id: 'a', laneIndex: 0, startSec: 0, endSec: 100 },
        { id: 'b', laneIndex: 1, startSec: 50, endSec: 150 },
        { id: 'c', laneIndex: 2, startSec: 60, endSec: 160 },
        { id: 'd', laneIndex: 3, startSec: 70, endSec: 170 }
      ],
      4
    )
    expect([...map.entries()]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3]
    ])
  })

  it('收起成双轨时第 3/4 轨只在显示上折回，不写回数据', () => {
    const items = [
      { id: 'a', laneIndex: 0, startSec: 0, endSec: 100 },
      { id: 'b', laneIndex: 1, startSec: 50, endSec: 150 },
      { id: 'c', laneIndex: 2, startSec: 200, endSec: 300 }
    ]
    const map = buildMixtapeDisplayLaneMap(items, 2)
    expect(map.get('a')).toBe(0)
    expect(map.get('b')).toBe(1)
    expect(map.get('c')).toBe(0)
    // 输入原样未动，展开回 4 轨时还能回到第 3 轨
    expect(items[2].laneIndex).toBe(2)
  })

  it('两条可见轨道都被占用时选总重叠最短的一条', () => {
    const map = buildMixtapeDisplayLaneMap(
      [
        { id: 'a', laneIndex: 0, startSec: 0, endSec: 100 },
        { id: 'b', laneIndex: 1, startSec: 90, endSec: 200 },
        { id: 'c', laneIndex: 2, startSec: 95, endSec: 100 }
      ],
      2
    )
    // 与 a 重叠 5 秒，与 b 重叠 5 秒 -> 并列时取更小的轨号
    expect(map.get('c')).toBe(0)
  })

  it('折回后的曲目会占用轨道，后续曲目避让', () => {
    const map = buildMixtapeDisplayLaneMap(
      [
        { id: 'a', laneIndex: 0, startSec: 0, endSec: 100 },
        { id: 'b', laneIndex: 1, startSec: 0, endSec: 100 },
        { id: 'c', laneIndex: 3, startSec: 0, endSec: 100 },
        { id: 'd', laneIndex: 2, startSec: 0, endSec: 100 }
      ],
      2
    )
    expect(map.get('c')).toBe(0)
    expect(map.get('d')).toBe(1)
  })

  it('没有持久化泳道的曲目按第 1 轨显示', () => {
    const map = buildMixtapeDisplayLaneMap(
      [
        { id: 'a', laneIndex: undefined, startSec: 0, endSec: 100 },
        { id: 'b', laneIndex: 3, startSec: 100, endSec: 200 }
      ],
      2
    )
    expect(map.get('a')).toBe(0)
    expect(map.get('b')).toBe(0)
  })
})
