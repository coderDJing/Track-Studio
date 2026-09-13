import { log } from '../log'
import { performance } from 'node:perf_hooks'
import { isPackagedRcBuild } from '../services/rcDiagnostics'
import {
  beginMainThreadActivity,
  endMainThreadActivity
} from '../services/mainProcessActivityTraceState'

type DiagnosticValue = string | number | boolean | null
type DiagnosticDetails = Record<string, DiagnosticValue>

type CompletedStepSummary = {
  name: string
  count: number
  totalElapsedMs: number
  maxElapsedMs: number
  details: DiagnosticDetails
}

const SLOW_APPLY_THRESHOLD_MS = 500
const MAX_SLOWEST_STEPS = 12
const TRACED_ACTIVITY_NAMES = new Set([
  'nodes',
  'nodes-ready',
  'live-cache-before-files',
  'files',
  'file-tombstones',
  'node-tombstones',
  'delete-extras',
  'live-cache-before-track-numbers',
  'track-numbers'
])

const toMs = (microseconds: number): number => Math.round(microseconds / 1000)

const buildHint = (details: DiagnosticDetails): string =>
  Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',')

export type CuratedApplyDiagnostics = {
  begin: (name: string, details?: DiagnosticDetails) => () => void
  measure: <T>(name: string, details: DiagnosticDetails, task: () => Promise<T>) => Promise<T>
  finish: (details: DiagnosticDetails) => void
}

export const createCuratedApplyDiagnostics = (
  details: DiagnosticDetails
): CuratedApplyDiagnostics => {
  const enabled = isPackagedRcBuild()
  const startedAtMs = Date.now()
  const startedCpu = process.cpuUsage()
  const stepSummaries = new Map<string, CompletedStepSummary>()

  const begin = (name: string, stepDetails: DiagnosticDetails = {}): (() => void) => {
    if (!enabled) return () => undefined
    const stepStartedAtMs = performance.now()
    const activityId = TRACED_ACTIVITY_NAMES.has(name)
      ? beginMainThreadActivity({
          kind: 'sync',
          name: `curated-apply:${name}`,
          argHint: buildHint(stepDetails)
        })
      : null
    return () => {
      if (activityId !== null) endMainThreadActivity(activityId)
      const elapsedMs = performance.now() - stepStartedAtMs
      const summary = stepSummaries.get(name)
      if (!summary) {
        stepSummaries.set(name, {
          name,
          count: 1,
          totalElapsedMs: elapsedMs,
          maxElapsedMs: elapsedMs,
          details: stepDetails
        })
        return
      }
      summary.count += 1
      summary.totalElapsedMs += elapsedMs
      if (elapsedMs > summary.maxElapsedMs) {
        summary.maxElapsedMs = elapsedMs
        summary.details = stepDetails
      }
    }
  }

  const measure = async <T>(
    name: string,
    stepDetails: DiagnosticDetails,
    task: () => Promise<T>
  ): Promise<T> => {
    const end = begin(name, stepDetails)
    try {
      return await task()
    } finally {
      end()
    }
  }

  const finish = (finishDetails: DiagnosticDetails): void => {
    if (!enabled) return
    const elapsedMs = Date.now() - startedAtMs
    if (elapsedMs < SLOW_APPLY_THRESHOLD_MS) return
    const cpu = process.cpuUsage(startedCpu)
    log.info('[curated-library-sync] slow remote apply', {
      elapsedMs,
      cpuUserMs: toMs(cpu.user),
      cpuSystemMs: toMs(cpu.system),
      ...details,
      ...finishDetails,
      slowestSteps: [...stepSummaries.values()]
        .sort((left, right) => right.totalElapsedMs - left.totalElapsedMs)
        .slice(0, MAX_SLOWEST_STEPS)
        .map((step) => ({
          name: step.name,
          count: step.count,
          elapsedMs: Math.round(step.totalElapsedMs),
          maxElapsedMs: Math.round(step.maxElapsedMs * 10) / 10,
          details: step.details
        }))
    })
  }

  return { begin, measure, finish }
}
