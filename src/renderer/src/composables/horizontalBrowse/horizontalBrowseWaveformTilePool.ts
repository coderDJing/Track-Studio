// detail 大波形分块的块池状态与复用 / 回收判定（纯逻辑，不持有 canvas）。
//
// 前提（设计文档已定）：改 BPM 或缩放会改变整个波形的时间密度，因此不存在「只有部分块需要重画」——
// 那种情况下所有块内容一起失效。分块的收益不来自「少画几块」，而来自「先画看得见的那几块」。
// 真正的块复用只发生在**平移**场景：滚动时大部分块内容不变，只有缺口方向需要新渲染。
//
// 复用的匹配键是 (generation, globalIndex)。globalIndex 来自
// horizontalBrowseWaveformTileLayout 的全局网格，同一密度下唯一标识块内容，且具备平移不变性——
// 平移只是「换几个 globalIndex」，已画块按整数逐位命中，不依赖浮点时间比较。
//
// 见 drafts/大波形分块瓦片渲染设计.md。

/** 内容代际。timeScale（时间密度）或 renderRevision 变化 → 全部块内容失效。 */
export type HorizontalBrowseWaveformTileGeneration = {
  timeScale: number
  renderRevision: number
}

export type HorizontalBrowseWaveformTileSlot = {
  slotIndex: number
  generation: HorizontalBrowseWaveformTileGeneration | null
  globalIndex: number | null
  ready: boolean
}

export type HorizontalBrowseWaveformTileAssignment = {
  globalIndex: number
  slotIndex: number
  /** true = 该 slot 已持有本代同块且 ready，按几何平移直接复用，无需重渲染。 */
  reused: boolean
}

const isSameGeneration = (
  left: HorizontalBrowseWaveformTileGeneration | null,
  right: HorizontalBrowseWaveformTileGeneration
) =>
  !!left &&
  Math.abs(Number(left.timeScale) - Number(right.timeScale)) <= Number.EPSILON &&
  Math.floor(Number(left.renderRevision)) === Math.floor(Number(right.renderRevision))

export const createHorizontalBrowseWaveformTilePool = (slotCount: number) => {
  const safeSlotCount = Math.max(1, Math.floor(Number(slotCount)) || 1)
  const slots: HorizontalBrowseWaveformTileSlot[] = Array.from(
    { length: safeSlotCount },
    (_unused, slotIndex) => ({
      slotIndex,
      generation: null,
      globalIndex: null,
      ready: false
    })
  )

  const resolveSlot = (slotIndex: number) => slots[slotIndex] ?? null

  const releaseSlot = (slot: HorizontalBrowseWaveformTileSlot) => {
    slot.generation = null
    slot.globalIndex = null
    slot.ready = false
  }

  const invalidateAll = () => {
    for (const slot of slots) releaseSlot(slot)
  }

  /** timeScale / renderRevision 变化时调用：本代之外的内容一律不可复用。 */
  const invalidateStaleGenerations = (generation: HorizontalBrowseWaveformTileGeneration) => {
    for (const slot of slots) {
      if (isSameGeneration(slot.generation, generation)) continue
      releaseSlot(slot)
    }
  }

  const markRendered = (
    slotIndex: number,
    generation: HorizontalBrowseWaveformTileGeneration,
    globalIndex: number
  ) => {
    const slot = resolveSlot(slotIndex)
    if (!slot) return false
    slot.generation = { ...generation }
    slot.globalIndex = globalIndex
    slot.ready = true
    return true
  }

  const markRenderedSlots = (
    slotIndexes: number[],
    generation: HorizontalBrowseWaveformTileGeneration,
    plannedTiles: Array<{ slotIndex: number; globalIndex: number }>
  ) => {
    const plannedBySlot = new Map(plannedTiles.map((tile) => [tile.slotIndex, tile.globalIndex]))
    for (const slotIndex of slotIndexes) {
      const globalIndex = plannedBySlot.get(slotIndex)
      if (globalIndex !== undefined) markRendered(slotIndex, generation, globalIndex)
    }
  }

  /**
   * 为本轮需要的全局块分配 slot。
   *
   * 先把「已持有本代同块」的 slot 原位复用（平移场景的核心收益），再把剩余请求分配给可回收 slot。
   * 回收优先取距可见区最远的 slot：`viewportGlobalIndex` 是可见区中心所在的全局块序号，
   * 据它把候选按「离可见区距离」降序排，最远者先被覆盖。
   */
  const assign = ({
    globalIndexes,
    generation,
    viewportGlobalIndex
  }: {
    globalIndexes: number[]
    generation: HorizontalBrowseWaveformTileGeneration
    viewportGlobalIndex?: number
  }): HorizontalBrowseWaveformTileAssignment[] => {
    const assignments: HorizontalBrowseWaveformTileAssignment[] = []
    const takenSlots = new Set<number>()
    const pendingGlobalIndexes: number[] = []

    for (const globalIndex of globalIndexes) {
      const reusableSlot = slots.find(
        (slot) =>
          !takenSlots.has(slot.slotIndex) &&
          slot.ready &&
          slot.globalIndex === globalIndex &&
          isSameGeneration(slot.generation, generation)
      )
      if (!reusableSlot) {
        pendingGlobalIndexes.push(globalIndex)
        continue
      }
      takenSlots.add(reusableSlot.slotIndex)
      assignments.push({ globalIndex, slotIndex: reusableSlot.slotIndex, reused: true })
    }

    // 未 ready 的 slot 先用（覆盖它们不损失任何已画内容），其次是本代之外的旧内容，
    // 最后才动本代仍有效但本轮不需要的内容；同类内按离可见区距离降序，最远者先回收。
    const resolveRecycleRank = (slot: HorizontalBrowseWaveformTileSlot) => {
      if (!slot.ready) return 0
      return isSameGeneration(slot.generation, generation) ? 2 : 1
    }
    const resolveViewportDistance = (slot: HorizontalBrowseWaveformTileSlot) => {
      if (viewportGlobalIndex == null || slot.globalIndex == null) return 0
      return Math.abs(slot.globalIndex - viewportGlobalIndex)
    }
    const recyclableSlots = slots
      .filter((slot) => !takenSlots.has(slot.slotIndex))
      .sort((left, right) => {
        const rankDelta = resolveRecycleRank(left) - resolveRecycleRank(right)
        if (rankDelta !== 0) return rankDelta
        const distanceDelta = resolveViewportDistance(right) - resolveViewportDistance(left)
        if (distanceDelta !== 0) return distanceDelta
        return left.slotIndex - right.slotIndex
      })

    for (const globalIndex of pendingGlobalIndexes) {
      const recycledSlot = recyclableSlots.shift()
      if (!recycledSlot) continue
      takenSlots.add(recycledSlot.slotIndex)
      releaseSlot(recycledSlot)
      assignments.push({ globalIndex, slotIndex: recycledSlot.slotIndex, reused: false })
    }

    return assignments.sort((left, right) => left.globalIndex - right.globalIndex)
  }

  return {
    slotCount: () => safeSlotCount,
    slots: () => slots.map((slot) => ({ ...slot })),
    resolveSlot: (slotIndex: number) => {
      const slot = resolveSlot(slotIndex)
      return slot ? { ...slot } : null
    },
    invalidateAll,
    invalidateStaleGenerations,
    markRendered,
    markRenderedSlots,
    assign
  }
}
