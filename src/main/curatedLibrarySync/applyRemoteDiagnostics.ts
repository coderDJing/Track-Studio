import { log } from '../log'
import { isPackagedRcBuild } from '../services/rcDiagnostics'
import {
  beginMainThreadActivity,
  endMainThreadActivity
} from '../services/mainProcessActivityTraceState'

type DiagnosticValue = string | number | boolean | null
type DiagnosticDetails = Record<string, DiagnosticValue>

type CompletedStep = {
  name: string
  elapsedMs: number
  cpuUserMs: number
  cpuSystemMs: number
  details: DiagnosticDetails
}

const SLOW_APPLY_THRESHOLD_MS = 500
const MAX_SLOWEST_STEPS = 12

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
  const steps: CompletedStep[] = []

  const begin = (name: string, stepDetails: DiagnosticDetails = {}): (() => void) => {
    if (!enabled) return () => undefined
    const stepStartedAtMs = Date.now()
    const stepStartedCpu = process.cpuUsage()
    const activityId = beginMainThreadActivity({
      kind: 'sync',
      name: `curated-apply:${name}`,
      argHint: buildHint(stepDetails)
    })
    return () => {
      endMainThreadActivity(activityId)
      const cpu = process.cpuUsage(stepStartedCpu)
      steps.push({
        name,
        elapsedMs: Date.now() - stepStartedAtMs,
        cpuUserMs: toMs(cpu.user),
        cpuSystemMs: toMs(cpu.system),
        details: stepDetails
      })
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
      slowestSteps: [...steps]
        .sort((left, right) => right.elapsedMs - left.elapsedMs)
        .slice(0, MAX_SLOWEST_STEPS)
    })
  }

  return { begin, measure, finish }
}
