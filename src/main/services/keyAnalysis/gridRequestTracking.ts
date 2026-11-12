import type { KeyAnalysisJob } from './types'
import type { AnalysisGridMode } from '../../../shared/analysisGridMode'

type FrozenGridModeSnapshot = {
  mode: AnalysisGridMode
  manualBatchIds: string[]
}

/**
 * 路径级网格请求代次与“抢占后模式恢复”状态。
 *
 * - 代次：每次为同一路径创建新的网格请求都递增，旧代次结果不得提交。
 * - 恢复快照：workerPool 的抢占重入队不会回传 analysisGridMode；这里只为同一批次的
 *   重入队保存一份一次性快照，正常结束/取消时清除，避免影响后续独立请求的默认语义。
 */
export class KeyAnalysisGridRequestTracker {
  private generationByPath = new Map<string, number>()
  private restoreByPath = new Map<string, FrozenGridModeSnapshot>()

  nextGeneration(normalizedPath: string): number {
    const next = (this.generationByPath.get(normalizedPath) || 0) + 1
    this.generationByPath.set(normalizedPath, next)
    return next
  }

  getGeneration(normalizedPath: string): number {
    return this.generationByPath.get(normalizedPath) || 0
  }

  isCurrent(job: Pick<KeyAnalysisJob, 'normalizedPath' | 'gridRequestGeneration'>): boolean {
    return (
      typeof job.gridRequestGeneration === 'number' &&
      job.gridRequestGeneration === this.getGeneration(job.normalizedPath)
    )
  }

  rememberFrozenMode(normalizedPath: string, mode: AnalysisGridMode, manualBatchIds: string[]) {
    if (manualBatchIds.length === 0) return
    this.restoreByPath.set(normalizedPath, { mode, manualBatchIds: [...manualBatchIds] })
  }

  /** 只在该路径的重入队携带同一批次时返回冻结模式，并立即消费快照。 */
  consumeFrozenMode(
    normalizedPath: string,
    manualBatchIds: string[]
  ): AnalysisGridMode | undefined {
    const snapshot = this.restoreByPath.get(normalizedPath)
    if (!snapshot) return undefined
    if (!manualBatchIds.some((batchId) => snapshot.manualBatchIds.includes(batchId)))
      return undefined
    this.restoreByPath.delete(normalizedPath)
    return snapshot.mode
  }

  clearRestore(normalizedPath: string) {
    this.restoreByPath.delete(normalizedPath)
  }

  forget(normalizedPath: string) {
    this.generationByPath.delete(normalizedPath)
    this.restoreByPath.delete(normalizedPath)
  }

  remap(fromNormalizedPath: string, toNormalizedPath: string) {
    const generation = this.generationByPath.get(fromNormalizedPath)
    if (generation !== undefined) {
      this.generationByPath.delete(fromNormalizedPath)
      this.generationByPath.set(toNormalizedPath, generation)
    }
    const snapshot = this.restoreByPath.get(fromNormalizedPath)
    if (snapshot) {
      this.restoreByPath.delete(fromNormalizedPath)
      this.restoreByPath.set(toNormalizedPath, snapshot)
    }
  }
}
