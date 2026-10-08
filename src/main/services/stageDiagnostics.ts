import { performance } from 'node:perf_hooks'
import { log } from '../log'
import { isPackagedRcMainProcess } from './rcDiagnosticEnvironment'
import { beginMainThreadActivity, endMainThreadActivity } from './mainProcessActivityTraceState'

type StageDetails = Record<string, string | number | boolean | null | undefined>

/**
 * 用户要求保留的开发/RC 分阶段诊断：正常阶段只在内存中记活动，超阈值才进入 log.txt。
 * elapsedMs 是墙钟耗时（异步阶段包含等待），CPU 是进程级差值，均不能单独证明主线程阻塞。
 * 确认复现的阻塞点已经修复、连续复测无慢阶段后，删除对应调用点及本模块。
 */
export const createStageDiagnostics = (
  scope: string,
  details: StageDetails = {},
  asyncThresholdMs = 3000
) => {
  // 本模块也会被缓存迁移 worker 导入，不能静态依赖 Electron 或在 worker 中落盘。
  const enabled =
    isPackagedRcMainProcess() ||
    (process.type === 'browser' && process.env.FRKB_APP_PACKAGED === '0')
  const begin = (stage: string, synchronous: boolean, thresholdMs: number) => {
    if (!enabled) return () => undefined
    const startedAt = performance.now()
    const startedCpu = process.cpuUsage()
    const id = beginMainThreadActivity({
      kind: synchronous ? 'sync' : 'async-phase',
      name: `${scope}:${stage}`,
      argHint: Object.entries(details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(',')
        .slice(0, 240)
    })
    return (outcome: 'completed' | 'threw' = 'completed') => {
      endMainThreadActivity(id)
      const elapsedMs = Math.round(performance.now() - startedAt)
      if (elapsedMs < thresholdMs) return
      const cpu = process.cpuUsage(startedCpu)
      log.warn(`[${scope}] slow stage`, {
        ...details,
        stage,
        synchronous,
        elapsedMs,
        thresholdMs,
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        outcome
      })
    }
  }

  return {
    measure: async <T>(
      stage: string,
      task: () => Promise<T>,
      thresholdMs = asyncThresholdMs
    ): Promise<T> => {
      const finish = begin(stage, false, thresholdMs)
      let outcome: 'completed' | 'threw' = 'threw'
      try {
        const result = await task()
        outcome = 'completed'
        return result
      } finally {
        finish(outcome)
      }
    },
    measureSync: <T>(stage: string, task: () => T, thresholdMs = 800): T => {
      const finish = begin(stage, true, thresholdMs)
      let outcome: 'completed' | 'threw' = 'threw'
      try {
        const result = task()
        outcome = 'completed'
        return result
      } finally {
        finish(outcome)
      }
    }
  }
}
