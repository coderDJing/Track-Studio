import { describe, expect, it } from 'vitest'
import { createHorizontalBrowseWaveformTilePool } from './horizontalBrowseWaveformTilePool'
import {
  resolveHorizontalBrowseWaveformTileCoverage,
  resolveHorizontalBrowseWaveformTileGrid
} from './horizontalBrowseWaveformTileLayout'

// 块池的三条规则（设计文档已定）：
// 1. timeScale / renderRevision 变化 → 全部块内容失效（改 BPM / 缩放会改变整个波形的时间密度）。
// 2. 仅平移 → 只有缺口方向需要新渲染，其余按几何平移复用。
// 3. 回收优先取距可见区最远的块。
// 见 drafts/大波形分块瓦片渲染设计.md。

const GENERATION = { timeScale: 1, renderRevision: 4 }
const RANGE_DURATION_SEC = 47.5

const grid = resolveHorizontalBrowseWaveformTileGrid({
  renderWidthCssPx: 6756,
  pixelRatio: 1.75
})

const resolveGlobalIndexes = (rangeStartSec: number) =>
  resolveHorizontalBrowseWaveformTileCoverage({
    grid,
    rangeStartSec,
    rangeDurationSec: RANGE_DURATION_SEC
  }).tiles.map((tile) => tile.globalIndex)

const renderAll = (
  pool: ReturnType<typeof createHorizontalBrowseWaveformTilePool>,
  globalIndexes: number[],
  generation = GENERATION
) => {
  const assignments = pool.assign({ globalIndexes, generation })
  for (const assignment of assignments) {
    pool.markRendered(assignment.slotIndex, generation, assignment.globalIndex)
  }
  return assignments
}

describe('createHorizontalBrowseWaveformTilePool 复用与失效', () => {
  it('worker 回报只登记本轮计划中实际画好的块', () => {
    const pool = createHorizontalBrowseWaveformTilePool(3)
    pool.markRenderedSlots([0, 2], GENERATION, [
      { slotIndex: 0, globalIndex: 12 },
      { slotIndex: 1, globalIndex: 13 }
    ])
    expect(pool.resolveSlot(0)).toMatchObject({ ready: true, globalIndex: 12 })
    expect(pool.resolveSlot(1)).toMatchObject({ ready: false, globalIndex: null })
    expect(pool.resolveSlot(2)).toMatchObject({ ready: false, globalIndex: null })
  })

  it('首轮全部是新渲染，每块拿到互不重复的 slot', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(grid.maxTileCount)
    const assignments = renderAll(pool, globalIndexes)
    expect(assignments).toHaveLength(globalIndexes.length)
    expect(assignments.every((assignment) => !assignment.reused)).toBe(true)
    expect(new Set(assignments.map((assignment) => assignment.slotIndex)).size).toBe(
      globalIndexes.length
    )
  })

  it('同代同块再次请求时全部原位复用，不重渲染', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(grid.maxTileCount)
    renderAll(pool, globalIndexes)
    const secondAssignments = pool.assign({ globalIndexes, generation: GENERATION })
    expect(secondAssignments.every((assignment) => assignment.reused)).toBe(true)
  })

  it('timeScale 变化让所有块失效——密度变了没有任何块内容可留', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(grid.maxTileCount)
    renderAll(pool, globalIndexes)
    const assignments = pool.assign({
      globalIndexes,
      generation: { timeScale: 1.06, renderRevision: 4 }
    })
    expect(assignments.every((assignment) => !assignment.reused)).toBe(true)
  })

  it('renderRevision 变化让所有块失效', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(grid.maxTileCount)
    renderAll(pool, globalIndexes)
    const assignments = pool.assign({
      globalIndexes,
      generation: { timeScale: 1, renderRevision: 5 }
    })
    expect(assignments.every((assignment) => !assignment.reused)).toBe(true)
  })

  // 这是分块在平移场景下的主要收益，也是全局网格存在的理由。
  it('平移后只有缺口方向需要新渲染，重叠部分按几何平移复用', () => {
    const baseGlobalIndexes = resolveGlobalIndexes(30)
    // 池子留出余量，模拟「可见区 + 前向池 + 后向池」大于单屏块数的常驻结构。
    const pool = createHorizontalBrowseWaveformTilePool(grid.maxTileCount + 2)
    renderAll(pool, baseGlobalIndexes)

    // 向前平移整两块：新块集合与上一轮只差首尾两块。
    const shiftedGlobalIndexes = baseGlobalIndexes.map((globalIndex) => globalIndex + 2)
    const assignments = pool.assign({
      globalIndexes: shiftedGlobalIndexes,
      generation: GENERATION
    })
    const expectedReusedCount = shiftedGlobalIndexes.filter((globalIndex) =>
      baseGlobalIndexes.includes(globalIndex)
    ).length
    const reusedCount = assignments.filter((assignment) => assignment.reused).length
    expect(reusedCount).toBe(expectedReusedCount)
    expect(reusedCount).toBe(baseGlobalIndexes.length - 2)
    expect(assignments.length - reusedCount).toBe(2)
  })

  it('逐块连续滚动时每轮只需渲染一块', () => {
    let globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(grid.maxTileCount + 2)
    renderAll(pool, globalIndexes)
    for (let step = 0; step < 5; step += 1) {
      globalIndexes = globalIndexes.map((globalIndex) => globalIndex + 1)
      const assignments = pool.assign({ globalIndexes, generation: GENERATION })
      const freshCount = assignments.filter((assignment) => !assignment.reused).length
      expect(freshCount).toBe(1)
      for (const assignment of assignments) {
        pool.markRendered(assignment.slotIndex, GENERATION, assignment.globalIndex)
      }
    }
  })

  it('回收优先取距可见区最远的 slot', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(globalIndexes.length)
    renderAll(pool, globalIndexes)

    // 只请求一块全新内容，并声明可见区在最后一块附近：
    // 应回收离它最远的那一块（首块），而不是紧邻的块。
    const viewportGlobalIndex = globalIndexes[globalIndexes.length - 1]
    const farthestSlot = pool.slots().find((slot) => slot.globalIndex === globalIndexes[0])
    const assignments = pool.assign({
      globalIndexes: [globalIndexes[globalIndexes.length - 1] + 50],
      generation: GENERATION,
      viewportGlobalIndex
    })
    expect(assignments).toHaveLength(1)
    expect(assignments[0].reused).toBe(false)
    expect(assignments[0].slotIndex).toBe(farthestSlot!.slotIndex)
  })

  it('未 ready 的 slot 先于已画内容被回收', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(globalIndexes.length)
    const assignments = pool.assign({ globalIndexes, generation: GENERATION })
    // 只提交前两块的渲染结果，其余 slot 仍是未 ready 状态。
    for (const assignment of assignments.slice(0, 2)) {
      pool.markRendered(assignment.slotIndex, GENERATION, assignment.globalIndex)
    }
    const readySlotIndexes = new Set(
      assignments.slice(0, 2).map((assignment) => assignment.slotIndex)
    )
    const freshAssignments = pool.assign({
      globalIndexes: [globalIndexes[globalIndexes.length - 1] + 50],
      generation: GENERATION
    })
    expect(readySlotIndexes.has(freshAssignments[0].slotIndex)).toBe(false)
  })

  it('本代之外的旧内容先于本代有效内容被回收', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(globalIndexes.length)
    // 前两块画成旧代内容，其余画成本代内容。
    const staleGeneration = { timeScale: 0.94, renderRevision: 3 }
    const assignments = pool.assign({ globalIndexes, generation: GENERATION })
    assignments.forEach((assignment, order) => {
      pool.markRendered(
        assignment.slotIndex,
        order < 2 ? staleGeneration : GENERATION,
        assignment.globalIndex
      )
    })
    const staleSlotIndexes = new Set(
      assignments.slice(0, 2).map((assignment) => assignment.slotIndex)
    )
    const freshAssignments = pool.assign({
      globalIndexes: [globalIndexes[globalIndexes.length - 1] + 50],
      generation: GENERATION
    })
    expect(staleSlotIndexes.has(freshAssignments[0].slotIndex)).toBe(true)
  })

  it('invalidateStaleGenerations 只清非本代内容，保留本代已画块', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(globalIndexes.length)
    renderAll(pool, globalIndexes)
    pool.invalidateStaleGenerations(GENERATION)
    expect(pool.slots().every((slot) => slot.ready)).toBe(true)

    pool.invalidateStaleGenerations({ timeScale: 1.06, renderRevision: 4 })
    expect(pool.slots().every((slot) => !slot.ready)).toBe(true)
    expect(pool.slots().every((slot) => slot.generation === null)).toBe(true)
  })

  it('invalidateAll 清空全部 slot 状态', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(globalIndexes.length)
    renderAll(pool, globalIndexes)
    pool.invalidateAll()
    for (const slot of pool.slots()) {
      expect(slot.ready).toBe(false)
      expect(slot.generation).toBeNull()
      expect(slot.globalIndex).toBeNull()
    }
  })

  it('请求数超过 slot 数时不越界，多余请求不分配', () => {
    const globalIndexes = resolveGlobalIndexes(30)
    const pool = createHorizontalBrowseWaveformTilePool(3)
    const assignments = pool.assign({ globalIndexes, generation: GENERATION })
    expect(assignments).toHaveLength(3)
    expect(new Set(assignments.map((assignment) => assignment.slotIndex)).size).toBe(3)
  })

  it('负块序号（歌曲起点前）同样可复用', () => {
    const globalIndexes = resolveGlobalIndexes(-12.5)
    expect(globalIndexes[0]).toBeLessThan(0)
    const pool = createHorizontalBrowseWaveformTilePool(grid.maxTileCount)
    renderAll(pool, globalIndexes)
    const assignments = pool.assign({ globalIndexes, generation: GENERATION })
    expect(assignments.every((assignment) => assignment.reused)).toBe(true)
  })

  it('slots() 返回快照，外部改动不影响池内状态', () => {
    const pool = createHorizontalBrowseWaveformTilePool(2)
    const snapshot = pool.slots()
    snapshot[0].ready = true
    expect(pool.slots()[0].ready).toBe(false)
  })
})
