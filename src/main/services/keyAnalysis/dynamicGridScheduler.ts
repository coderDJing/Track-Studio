import type { KeyAnalysisJob } from './types'

/**
 * Dynamic 重任务：全曲扫描 + BPM 网格。用于全局单飞调度，不改变 Normal 并发。
 *
 * 调度发生在 prepareJob 之前，此时 needsBpm 尚未解析，因此同时参考入队时冻结的
 * forceAnalysis / analysisTargets 判断本任务是否真的会跑全曲扫描。
 */
export const isDynamicGridHeavyJob = (
  job: Pick<KeyAnalysisJob, 'analysisGridMode' | 'needsBpm' | 'forceAnalysis' | 'analysisTargets'>
): boolean => {
  if (job.analysisGridMode !== 'dynamic') return false
  if (job.needsBpm === true) return true
  if (job.forceAnalysis === true) return true
  if (job.analysisTargets) {
    return job.analysisTargets.bpm === true || job.analysisTargets.energy === true
  }
  // 未指定分项（后台/可见补缺）可能补全网格，按重任务处理。
  return true
}

/**
 * 全局同一时刻最多一个真正在跑的 Dynamic 重任务。
 *
 * 只负责调度名额：拿到名额后才允许开始（含预解码）；释放发生在任务离开 inFlight 时
 * （完成、失败、取消、抢占、超时），不参与 worker 清理所有权。
 */
export class DynamicGridSingleFlight {
  private activeJobId: number | null = null

  getActiveJobId(): number | null {
    return this.activeJobId
  }

  canStart(jobId: number): boolean {
    return this.activeJobId === null || this.activeJobId === jobId
  }

  tryAcquire(jobId: number): boolean {
    if (!this.canStart(jobId)) return false
    this.activeJobId = jobId
    return true
  }

  release(jobId: number) {
    if (this.activeJobId === jobId) this.activeJobId = null
  }

  /** 任务已不在 inFlight（被 workerPool 清理）时自动释放名额。 */
  releaseIfInactive(isInFlight: (jobId: number) => boolean) {
    if (this.activeJobId !== null && !isInFlight(this.activeJobId)) {
      this.activeJobId = null
    }
  }
}
