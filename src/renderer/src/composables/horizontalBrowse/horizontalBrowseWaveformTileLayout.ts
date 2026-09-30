// detail 大波形分块的几何与时间划分。
//
// 这里是「接缝」这一整类风险的唯一收敛点：块边界必须落在整数物理像素上，相邻块的结束边界
// 必须与下一块起始边界严格相等（几何与波形采样窗口都要），否则高 DPI 下会出现缝隙或 1px 错位。
// 设计与验收见 drafts/大波形分块瓦片渲染设计.md。
//
// 划分方向只有横向（时间轴方向）；纵向不切，高度就是一个 lane 的高度。
//
// ## 全局网格，不是「把当前位图切成 N 份」
//
// 块边界锚定在一条**与当前位图位置无关**的全局网格上：给定时间密度（scaledPxPerSec），第 k 块
// 恒定覆盖全局物理像素 [k*TW, (k+1)*TW)，原点是歌曲 0 秒。位图只是从这条网格上「取一段块」。
//
// 若改成按当前位图宽度切 N 份（各块边界 = round(总宽 * i / N)），块宽会因取整而互不相等
// （例如 11823px / 8 → 1478,1478,1477,1479,...），这个宽度序列不具备平移不变性：平移后新的
// 第 i 块与上一轮任何一块的时间范围都对不上，滚动复用会全部失效——而滚动复用正是分块在平移
// 场景下的主要收益。全局网格下平移只是「换几个 k」，已画块逐位命中。
//
// 代价是位图两端各有一个「不完整块」：渲染范围起点通常落在某块中间。因此块容器的原点取第一块的
// 全局边界，容器自身的 translate 吸收这段不足一块的偏移（见 containerOffsetScaledPx）。容器
// 渲染范围由 resolveHorizontalBrowseRawWaveformRenderViewport 按屏幕上的歌曲 0 秒原点对齐，
// 再配合整数物理像素 translate，确保换帧前后同一采样列的位置一致；只取整 translate 不够。

// 固定块数，而不是固定块宽。
//
// 原因：canvas 通过 transferControlToOffscreen() 把控制权一次性移交给 worker，之后无法追加新
// 画布；worker 侧 buffer 索引也是固定集合。若块宽固定，窗口变宽就需要追加块，正好撞上这个限制。
// 固定块数下，窗口 resize 只改块宽（重建网格并整体失效，与现状 resize 行为一致），块数不变。
//
// 8 块时单块约 0.875 个视口宽，可见区最多跨 2 块 → 必须等的面积从 8/8 降到 2/8。
// 实际取值待阶段 2 真机实测后调整。
export const HORIZONTAL_BROWSE_WAVEFORM_TILE_COUNT = 8

/**
 * 每个 buffer 需要常驻的块画布数量 = 块数 + 1。
 *
 * 「+1」是全局网格两端不完整块带来的那一块：渲染范围起点一般不会正好落在块边界上，因此覆盖一屏
 * 最多需要 块数+1 块。由 tileScaledWidth = ceil(总宽 / 块数) 可证 ceil(总宽 / 块宽) <= 块数，
 * 故该上界与位图宽度、dpr 均无关，是个常量——这正是「DOM 块数量固定」得以成立的前提
 * （canvas 控制权移交是一次性的，运行期无法追加画布）。
 */
export const HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT = HORIZONTAL_BROWSE_WAVEFORM_TILE_COUNT + 1

export type HorizontalBrowseWaveformTileGrid = {
  /** 单块宽度，整数物理像素。全局网格的步长。 */
  tileScaledWidth: number
  tileWidthCssPx: number
  /** 渲染位图总物理像素宽。 */
  totalScaledWidth: number
  pixelRatio: number
  /**
   * 覆盖一次渲染范围最多需要的块数 = tileCount + 1。
   * 「+1」是两端不完整块带来的那一块，块池按此值分配 slot 即可，不会再增长。
   */
  maxTileCount: number
}

export type HorizontalBrowseWaveformTile = {
  /** 全局网格块序号。同一密度下它唯一标识块内容，是滚动复用的匹配键。 */
  globalIndex: number
  /** 块起始边界，整数物理像素，相对块容器原点。 */
  scaledLeft: number
  /** 块宽度，整数物理像素，恒等于 tileScaledWidth。 */
  scaledWidth: number
  /** 块起始边界的 CSS px，恒落在整数物理像素上。 */
  leftCssPx: number
  widthCssPx: number
  rangeStartSec: number
  /** 块结束时间。与下一块的 rangeStartSec 严格相等（同一表达式求得）。 */
  rangeEndSec: number
  rangeDurationSec: number
}

export type HorizontalBrowseWaveformTileCoverage = {
  grid: HorizontalBrowseWaveformTileGrid
  /** 时间密度：每秒对应多少物理像素。同一密度下全局网格不变。 */
  scaledPxPerSec: number
  /**
   * 块容器原点相对渲染范围起点的偏移，整数物理像素之外的部分由此吸收。
   * 值域 [0, tileScaledWidth)：渲染范围起点落在第一块内部这么深的位置，
   * 因此容器应放在 -containerOffsetScaledPx 处。
   */
  containerOffsetScaledPx: number
  containerOffsetCssPx: number
  tiles: HorizontalBrowseWaveformTile[]
}

/** P0=可见区（必须全齐才切可见面）；P1=播放方向前向 overscan；P2=后向 overscan。 */
export const HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE = 0
export const HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD = 1
export const HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_BACKWARD = 2

export type HorizontalBrowseWaveformTilePriority = 0 | 1 | 2

const TILE_VISIBLE_OVERLAP_EPSILON_CSS_PX = 0.001

const resolveSafePixelRatio = (pixelRatio: number) => {
  const numeric = Number(pixelRatio)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1
}

const resolveSafeTileCount = (tileCount: number | undefined) => {
  const numeric = Math.floor(Number(tileCount))
  if (!Number.isFinite(numeric) || numeric < 1) return HORIZONTAL_BROWSE_WAVEFORM_TILE_COUNT
  return numeric
}

// 与 worker 侧 resolveCanvasScaleMetrics 的物理像素换算保持一致：
// CSS 宽保留三位小数后 round(cssWidth * pixelRatio)。两侧必须同式，否则块边界与实际位图错开。
const resolveTotalScaledWidth = (renderWidthCssPx: number, pixelRatio: number) => {
  const numeric = Number(renderWidthCssPx)
  const safeCssWidth =
    !Number.isFinite(numeric) || numeric <= 0 ? 1 : Math.max(1, Math.round(numeric * 1000) / 1000)
  return Math.max(1, Math.round(safeCssWidth * pixelRatio))
}

export const resolveHorizontalBrowseWaveformTileGrid = ({
  renderWidthCssPx,
  pixelRatio,
  tileCount
}: {
  renderWidthCssPx: number
  pixelRatio: number
  tileCount?: number
}): HorizontalBrowseWaveformTileGrid => {
  const safePixelRatio = resolveSafePixelRatio(pixelRatio)
  const totalScaledWidth = resolveTotalScaledWidth(renderWidthCssPx, safePixelRatio)
  const safeTileCount = resolveSafeTileCount(tileCount)
  // 向上取整：保证 ceil(总宽 / 块宽) <= 块数，从而覆盖一次渲染范围最多用 块数+1 块。
  const tileScaledWidth = Math.max(1, Math.ceil(totalScaledWidth / safeTileCount))
  return {
    tileScaledWidth,
    tileWidthCssPx: tileScaledWidth / safePixelRatio,
    totalScaledWidth,
    pixelRatio: safePixelRatio,
    maxTileCount: Math.ceil(totalScaledWidth / tileScaledWidth) + 1
  }
}

/**
 * 求覆盖给定渲染范围所需的全局块。
 *
 * 块的时间边界由 `globalIndex * tileScaledWidth / scaledPxPerSec` 求得，相邻块共用同一表达式，
 * 因此 tile[i].rangeEndSec 与 tile[i+1].rangeStartSec 严格相等——这是波形采样窗口无缝衔接的
 * 前提。若各块各自向内取整，边界处会少画或重画一列，形成比几何错位更隐蔽的接缝。
 */
export const resolveHorizontalBrowseWaveformTileCoverage = ({
  grid,
  rangeStartSec,
  rangeDurationSec
}: {
  grid: HorizontalBrowseWaveformTileGrid
  rangeStartSec: number
  rangeDurationSec: number
}): HorizontalBrowseWaveformTileCoverage => {
  const safeRangeStartSec = Number.isFinite(Number(rangeStartSec)) ? Number(rangeStartSec) : 0
  const safeRangeDurationSec = Math.max(0.0001, Number(rangeDurationSec) || 0.0001)
  const scaledPxPerSec = grid.totalScaledWidth / safeRangeDurationSec
  const rangeStartScaledPx = safeRangeStartSec * scaledPxPerSec
  const rangeEndScaledPx = rangeStartScaledPx + grid.totalScaledWidth
  const firstGlobalIndex = Math.floor(rangeStartScaledPx / grid.tileScaledWidth)
  const endGlobalIndex = Math.ceil(rangeEndScaledPx / grid.tileScaledWidth)
  const containerOffsetScaledPx = rangeStartScaledPx - firstGlobalIndex * grid.tileScaledWidth

  const resolveTileBoundarySec = (globalIndex: number) =>
    (globalIndex * grid.tileScaledWidth) / scaledPxPerSec

  const tiles: HorizontalBrowseWaveformTile[] = []
  for (let globalIndex = firstGlobalIndex; globalIndex < endGlobalIndex; globalIndex += 1) {
    const tileRangeStartSec = resolveTileBoundarySec(globalIndex)
    const tileRangeEndSec = resolveTileBoundarySec(globalIndex + 1)
    const scaledLeft = (globalIndex - firstGlobalIndex) * grid.tileScaledWidth
    tiles.push({
      globalIndex,
      scaledLeft,
      scaledWidth: grid.tileScaledWidth,
      leftCssPx: scaledLeft / grid.pixelRatio,
      widthCssPx: grid.tileWidthCssPx,
      rangeStartSec: tileRangeStartSec,
      rangeEndSec: tileRangeEndSec,
      rangeDurationSec: tileRangeEndSec - tileRangeStartSec
    })
  }

  return {
    grid,
    scaledPxPerSec,
    containerOffsetScaledPx,
    containerOffsetCssPx: containerOffsetScaledPx / grid.pixelRatio,
    tiles
  }
}

/**
 * 渲染优先级分档。
 *
 * P0 是与可见区有任何重叠的块——它们必须全部 ready 才允许切换可见面（架构标准一票否决项禁止
 * 可见区出现不可解释空白）。屏幕外允许缺块，因此 P1 / P2 只决定补齐顺序。
 *
 * 播放只朝一个方向推进，因此前向 overscan（未来时间）比后向（已播过）更值得先补。
 * `forward = false` 用于用户反向拖动时把两档互换。
 *
 * `viewportStartCssPx` 是可见区左边缘在**块容器坐标**下的位置（与 tile.leftCssPx 同系），
 * 即渲染范围内的可见区偏移再加上 containerOffsetCssPx。
 */
export const resolveHorizontalBrowseWaveformTilePriorities = ({
  tiles,
  viewportStartCssPx,
  viewportWidthCssPx,
  forward = true
}: {
  tiles: HorizontalBrowseWaveformTile[]
  viewportStartCssPx: number
  viewportWidthCssPx: number
  forward?: boolean
}): HorizontalBrowseWaveformTilePriority[] => {
  const safeViewportStartCssPx = Number.isFinite(Number(viewportStartCssPx))
    ? Number(viewportStartCssPx)
    : 0
  const safeViewportWidthCssPx = Math.max(0, Number(viewportWidthCssPx) || 0)
  const viewportEndCssPx = safeViewportStartCssPx + safeViewportWidthCssPx
  const aheadPriority = forward
    ? HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD
    : HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_BACKWARD
  const behindPriority = forward
    ? HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_BACKWARD
    : HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD
  return tiles.map((tile) => {
    const tileStartCssPx = tile.leftCssPx
    const tileEndCssPx = tile.leftCssPx + tile.widthCssPx
    const overlapCssPx =
      Math.min(tileEndCssPx, viewportEndCssPx) - Math.max(tileStartCssPx, safeViewportStartCssPx)
    if (overlapCssPx > TILE_VISIBLE_OVERLAP_EPSILON_CSS_PX) {
      return HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE
    }
    return tileStartCssPx >= viewportEndCssPx ? aheadPriority : behindPriority
  })
}
