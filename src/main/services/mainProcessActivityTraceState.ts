export type MainThreadActivityKind = 'ipc-handle' | 'ipc-on' | 'sync'

export type MainThreadActivityRecord = {
  kind: MainThreadActivityKind
  name: string
  pending: boolean
  startedAtMs: number
  endedAtMs?: number
  durationMs: number
  argCount?: number
  argHint?: string
}

type InternalActivityRecord = {
  id: number
  kind: MainThreadActivityKind
  name: string
  startedAtMs: number
  endedAtMs?: number
  argCount?: number
  argHint?: string
}

const MAX_COMPLETED_RECORDS = 40
const MAX_SNAPSHOT_RECORDS = 12
const MAX_PENDING_SNAPSHOT_RECORDS = 12
const MAX_ARG_HINT_LENGTH = 80

let nextActivityId = 1
const activeRecords = new Map<number, InternalActivityRecord>()
const completedRecords: InternalActivityRecord[] = []

const truncateHint = (value: string): string =>
  value.length <= MAX_ARG_HINT_LENGTH ? value : `${value.slice(0, MAX_ARG_HINT_LENGTH - 1)}…`

const describeUnknown = (value: unknown): string | null => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array:${value.length}`
  if (typeof value === 'string') return `string:${value.length}`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'object') return typeof value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const arrayKey = keys.find((key) => Array.isArray(record[key]))
  if (arrayKey) {
    const items = record[arrayKey]
    return `object:${arrayKey}.length=${Array.isArray(items) ? items.length : 0}`
  }
  if (keys.length === 0) return 'object:empty'
  return `object:${keys.slice(0, 4).join(',')}`
}

export const summarizeIpcArgHint = (args: unknown[]): { argCount: number; argHint?: string } => {
  const argCount = args.length
  if (argCount === 0) return { argCount }
  const hint = describeUnknown(args[0])
  if (!hint) return { argCount }
  return { argCount, argHint: truncateHint(hint) }
}

export const beginMainThreadActivity = (params: {
  kind: MainThreadActivityKind
  name: string
  argCount?: number
  argHint?: string
}): number => {
  const id = nextActivityId
  nextActivityId += 1
  activeRecords.set(id, {
    id,
    kind: params.kind,
    name: params.name,
    startedAtMs: Date.now(),
    argCount: params.argCount,
    argHint: params.argHint
  })
  return id
}

export const endMainThreadActivity = (id: number): void => {
  const record = activeRecords.get(id)
  if (!record) return
  activeRecords.delete(id)
  record.endedAtMs = Date.now()
  completedRecords.push(record)
  if (completedRecords.length > MAX_COMPLETED_RECORDS) {
    completedRecords.splice(0, completedRecords.length - MAX_COMPLETED_RECORDS)
  }
}

export const runTracedSync = <T>(name: string, fn: () => T): T => {
  const id = beginMainThreadActivity({ kind: 'sync', name })
  try {
    return fn()
  } finally {
    endMainThreadActivity(id)
  }
}

const toPublicRecord = (record: InternalActivityRecord, now: number): MainThreadActivityRecord => {
  const endedAtMs = record.endedAtMs
  const pending = endedAtMs === undefined
  return {
    kind: record.kind,
    name: record.name,
    pending,
    startedAtMs: record.startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, (endedAtMs ?? now) - record.startedAtMs),
    argCount: record.argCount,
    argHint: record.argHint
  }
}

const overlapsWindow = (record: InternalActivityRecord, sinceMs: number, now: number): boolean => {
  const endedAtMs = record.endedAtMs ?? now
  return endedAtMs >= sinceMs && record.startedAtMs <= now
}

export const getMainThreadActivitySnapshot = (
  sinceMs: number
): {
  pendingTotal: number
  pending: MainThreadActivityRecord[]
  slowest: MainThreadActivityRecord[]
  longest?: Pick<MainThreadActivityRecord, 'kind' | 'name' | 'durationMs' | 'pending'>
} => {
  const now = Date.now()
  const allPending = [...activeRecords.values()]
    .map((record) => toPublicRecord(record, now))
    .sort((left, right) => right.durationMs - left.durationMs)
  const pending = allPending.slice(0, MAX_PENDING_SNAPSHOT_RECORDS)
  const slowest = completedRecords
    .filter((record) => overlapsWindow(record, sinceMs, now))
    .map((record) => toPublicRecord(record, now))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_SNAPSHOT_RECORDS)
  const longest = [...pending, ...slowest].sort(
    (left, right) => right.durationMs - left.durationMs
  )[0]
  return {
    pendingTotal: allPending.length,
    pending,
    slowest,
    longest: longest
      ? {
          kind: longest.kind,
          name: longest.name,
          durationMs: longest.durationMs,
          pending: longest.pending
        }
      : undefined
  }
}

export const resetMainThreadActivityTraceForTests = (): void => {
  nextActivityId = 1
  activeRecords.clear()
  completedRecords.length = 0
}
