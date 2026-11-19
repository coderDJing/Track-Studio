import {
  DEFAULT_LANE_COUNT,
  MAX_LANE_COUNT,
  normalizeMixtapeLaneCount,
  normalizeMixtapeLaneIndex
} from '@renderer/composables/mixtape/constants'

const LANE_OVERLAP_EPSILON_SEC = 0.0001

export type MixtapeLaneDisplayItem = {
  id: string
  laneIndex?: number | null
  startSec: number
  endSec: number
}

const resolveSpanOverlapSec = (
  left: { startSec: number; endSec: number },
  right: { startSec: number; endSec: number }
) => {
  const start = Math.max(left.startSec, right.startSec)
  const end = Math.min(left.endSec, right.endSec)
  return Math.max(0, end - start)
}

/**
 * 计算每首曲目在**当前泳道数**下应该画在哪条泳道上。
 *
 * 收起成 2 轨只是视图收窄，不写回数据：停在第 3/4 轨的曲目只在显示时折回前两轨，
 * 再展开回 4 轨时仍按存入的 laneIndex 回到原位。
 *
 * 折叠规则：按时间顺序，优先放进当前没有任何重叠的轨道；都被占用时选总重叠最短的那条；
 * 并列时取更小的轨号。已经在可见轨道里的曲目一律保持原位。
 */
export const buildMixtapeDisplayLaneMap = (
  items: MixtapeLaneDisplayItem[],
  laneCount: number = DEFAULT_LANE_COUNT
): Map<string, number> => {
  const targetLaneCount = normalizeMixtapeLaneCount(laneCount)
  const displayLaneById = new Map<string, number>()
  const normalizedItems = (Array.isArray(items) ? items : [])
    .filter((item) => !!item && typeof item.id === 'string' && item.id.trim())
    .map((item) => ({
      id: item.id,
      laneIndex: normalizeMixtapeLaneIndex(item.laneIndex),
      startSec: Math.max(0, Number(item.startSec) || 0),
      endSec: Math.max(0, Number(item.endSec) || 0)
    }))

  for (const item of normalizedItems) {
    displayLaneById.set(item.id, normalizeMixtapeLaneIndex(item.laneIndex, 0, targetLaneCount))
  }
  if (targetLaneCount >= MAX_LANE_COUNT) return displayLaneById

  const occupiedByLane = new Map<number, Array<{ startSec: number; endSec: number }>>()
  for (let laneIndex = 0; laneIndex < targetLaneCount; laneIndex += 1) {
    occupiedByLane.set(laneIndex, [])
  }
  const orderedItems = [...normalizedItems].sort((left, right) => {
    if (Math.abs(left.startSec - right.startSec) > LANE_OVERLAP_EPSILON_SEC) {
      return left.startSec - right.startSec
    }
    return left.id.localeCompare(right.id)
  })

  for (const item of orderedItems) {
    const span = { startSec: item.startSec, endSec: item.endSec }
    if (item.laneIndex < targetLaneCount) {
      occupiedByLane.get(item.laneIndex)?.push(span)
      continue
    }
    let bestLaneIndex = 0
    let bestOverlapSec = Number.POSITIVE_INFINITY
    for (let laneIndex = 0; laneIndex < targetLaneCount; laneIndex += 1) {
      const occupied = occupiedByLane.get(laneIndex) || []
      const overlapSec = occupied.reduce(
        (total, existing) => total + resolveSpanOverlapSec(span, existing),
        0
      )
      if (overlapSec < bestOverlapSec - LANE_OVERLAP_EPSILON_SEC) {
        bestOverlapSec = overlapSec
        bestLaneIndex = laneIndex
      }
    }
    occupiedByLane.get(bestLaneIndex)?.push(span)
    displayLaneById.set(item.id, bestLaneIndex)
  }
  return displayLaneById
}

export const persistMixtapeProjectLaneCount = async (
  playlistId: string,
  laneCount: number
): Promise<number> => {
  const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
  const resolvedLaneCount = normalizeMixtapeLaneCount(laneCount)
  if (!normalizedPlaylistId || !window?.electron?.ipcRenderer?.invoke) return resolvedLaneCount
  const result = (await window.electron.ipcRenderer.invoke('mixtape:project:set-lane-count', {
    playlistId: normalizedPlaylistId,
    laneCount: resolvedLaneCount
  })) as { laneCount?: unknown } | null
  return normalizeMixtapeLaneCount(result?.laneCount ?? resolvedLaneCount)
}
