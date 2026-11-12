/**
 * Dynamic 网格进度的跨进程公开契约。
 *
 * worker / workerPool 只允许把这里定义的字段发给 renderer；
 * sidecar PID、窗口内部结构等实现细节必须在主进程归一化时剥离。
 */

export type DynamicGridPublicPhase = 'scan' | 'refine' | 'fit' | 'persist'

export type DynamicGridPublicProgress = {
  phase: DynamicGridPublicPhase
  completedWindows?: number
  totalWindows?: number
  coveredAudioSec?: number
}

export const DYNAMIC_GRID_PUBLIC_PHASES: readonly DynamicGridPublicPhase[] = [
  'scan',
  'refine',
  'fit',
  'persist'
]

export const DYNAMIC_GRID_PHASE_LABEL_KEYS: Record<DynamicGridPublicPhase, string> = {
  scan: 'tracks.dynamicAnalysisPhaseScan',
  refine: 'tracks.dynamicAnalysisPhaseRefine',
  fit: 'tracks.dynamicAnalysisPhaseFit',
  persist: 'tracks.dynamicAnalysisPhasePersist'
}

const isPublicPhase = (value: unknown): value is DynamicGridPublicPhase =>
  value === 'scan' || value === 'refine' || value === 'fit' || value === 'persist'

const readCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

const readSeconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * 严格校验并只复制公开字段：绝不透传 sidecarPid 或任何其它内部实现字段。
 * 非法/缺失 phase 返回 undefined，让调用方回退到旧行为而不是显示假进度。
 */
export const normalizeDynamicGridPublicProgress = (
  value: unknown
): DynamicGridPublicProgress | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!isPublicPhase(record.phase)) return undefined

  const progress: DynamicGridPublicProgress = { phase: record.phase }
  const completedWindows = readCount(record.completedWindows)
  const totalWindows = readCount(record.totalWindows)
  // 两者都存在但 completed > total 属非法计数：保留 phase，丢弃这对计数。
  const countsConsistent =
    completedWindows === undefined || totalWindows === undefined || completedWindows <= totalWindows
  if (countsConsistent && completedWindows !== undefined) {
    progress.completedWindows = completedWindows
  }
  if (countsConsistent && totalWindows !== undefined) {
    progress.totalWindows = totalWindows
  }
  const coveredAudioSec = readSeconds(record.coveredAudioSec)
  if (coveredAudioSec !== undefined) progress.coveredAudioSec = coveredAudioSec
  return progress
}
