import { describe, expect, it } from 'vitest'
import { DynamicGridSingleFlight, isDynamicGridHeavyJob } from './dynamicGridScheduler'
import type { KeyAnalysisJob } from './types'

const job = (jobId: number, overrides: Partial<KeyAnalysisJob> = {}): KeyAnalysisJob => ({
  jobId,
  filePath: `D:/music/${jobId}.mp3`,
  normalizedPath: `d:/music/${jobId}.mp3`,
  priority: 'medium',
  fastAnalysis: false,
  source: 'foreground',
  ...overrides
})

describe('dynamic grid single-flight scheduling', () => {
  it('only treats dynamic jobs that may scan the full track as heavy', () => {
    expect(isDynamicGridHeavyJob(job(1, { analysisGridMode: 'dynamic', needsBpm: true }))).toBe(
      true
    )
    expect(
      isDynamicGridHeavyJob(
        job(2, {
          analysisGridMode: 'dynamic',
          needsBpm: false,
          analysisTargets: { key: true, bpm: false }
        })
      )
    ).toBe(false)
    expect(
      isDynamicGridHeavyJob(job(3, { analysisGridMode: 'dynamic', forceAnalysis: true }))
    ).toBe(true)
    expect(isDynamicGridHeavyJob(job(4, { analysisGridMode: 'normal', needsBpm: true }))).toBe(
      false
    )
  })

  it('decides before prepareJob when needsBpm is still undefined', () => {
    // 队列在 prepareJob 之前调度，新 job 的 needsBpm 尚未解析。
    expect(
      isDynamicGridHeavyJob(
        job(5, {
          analysisGridMode: 'dynamic',
          forceAnalysis: true,
          analysisTargets: { key: false, bpm: true }
        })
      )
    ).toBe(true)
    expect(
      isDynamicGridHeavyJob(
        job(6, {
          analysisGridMode: 'dynamic',
          analysisTargets: { key: true, bpm: false }
        })
      )
    ).toBe(false)
    expect(isDynamicGridHeavyJob(job(7, { analysisGridMode: 'dynamic' }))).toBe(true)
  })

  it('starts normal work while one dynamic task runs, and only starts the second after release', () => {
    const scheduler = new DynamicGridSingleFlight()
    // 模拟真实入队：Dynamic 任务在 prepareJob 之前 needsBpm 为 undefined。
    const queue: KeyAnalysisJob[] = [
      job(1, { analysisGridMode: 'normal', needsBpm: true }),
      job(2, { analysisGridMode: 'dynamic', forceAnalysis: true }),
      job(3, { analysisGridMode: 'dynamic', forceAnalysis: true })
    ]
    const started: number[] = []
    const dispatchPass = () => {
      for (const candidate of [...queue]) {
        if (isDynamicGridHeavyJob(candidate) && !scheduler.tryAcquire(candidate.jobId)) continue
        started.push(candidate.jobId)
        queue.splice(queue.indexOf(candidate), 1)
      }
    }

    dispatchPass()
    expect(started).toEqual([1, 2])
    expect(queue.map((item) => item.jobId)).toEqual([3])
    expect(scheduler.getActiveJobId()).toBe(2)

    scheduler.release(2)
    dispatchPass()
    expect(started).toEqual([1, 2, 3])
    expect(scheduler.getActiveJobId()).toBe(3)
  })

  it('releases the slot when the owning job left inFlight (finish/cancel/preempt)', () => {
    const scheduler = new DynamicGridSingleFlight()
    expect(scheduler.tryAcquire(7)).toBe(true)
    scheduler.releaseIfInactive((jobId) => jobId === 7)
    expect(scheduler.getActiveJobId()).toBe(7)

    scheduler.releaseIfInactive(() => false)
    expect(scheduler.getActiveJobId()).toBeNull()
    expect(scheduler.tryAcquire(8)).toBe(true)
  })
})
