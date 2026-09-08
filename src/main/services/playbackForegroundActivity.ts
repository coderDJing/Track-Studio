import { ipcMain } from 'electron'
import path from 'node:path'

type PlaybackForegroundState = 'start' | 'end'

type PlaybackForegroundPayload = {
  state?: PlaybackForegroundState
  source?: string
  filePath?: string
  requestId?: number | string
  reason?: string
}

type PlaybackForegroundEntry = {
  expiresAtMs: number
  filePath: string
}

const PLAYBACK_FOREGROUND_ACTIVITY_CHANNEL = 'player:foreground-activity'
const PLAYBACK_FOREGROUND_STALE_MS = 8000
const PLAYBACK_FOREGROUND_IDLE_GRACE_MS = 300
const BACKGROUND_IO_WAIT_INTERVAL_MS = 60
const BACKGROUND_FILE_IO_MAX_CONCURRENCY = 1

export type FileIoPriority = 'visible' | 'foreground' | 'background' | 'maintenance' | 'prefetch'

type FileIoWaiter = {
  priority: number
  sequence: number
  resolve: () => void
}

const FILE_IO_PRIORITY: Record<FileIoPriority, number> = {
  visible: 0,
  foreground: 1,
  background: 2,
  maintenance: 3,
  prefetch: 4
}

const foregroundEntries = new Map<string, PlaybackForegroundEntry>()
let foregroundGraceUntilMs = 0
let ipcRegistered = false
let backgroundFileIoInFlight = 0
let backgroundFileIoSequence = 0
let backgroundFileIoHandoffScheduled = false
const backgroundFileIoWaiters: FileIoWaiter[] = []

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const normalizeText = (value: unknown): string => String(value || '').trim()

const buildActivityKey = (payload: PlaybackForegroundPayload): string => {
  const source = normalizeText(payload.source) || 'unknown'
  const requestId = normalizeText(payload.requestId) || '0'
  const filePath = normalizeText(payload.filePath)
  return `${source}:${requestId}:${filePath}`
}

const pruneExpiredEntries = (nowMs = Date.now()) => {
  for (const [key, entry] of foregroundEntries) {
    if (entry.expiresAtMs <= nowMs) {
      foregroundEntries.delete(key)
    }
  }
}

const isPlaybackForegroundBusy = (nowMs = Date.now()): boolean => {
  pruneExpiredEntries(nowMs)
  return foregroundEntries.size > 0 || foregroundGraceUntilMs > nowMs
}

export { isPlaybackForegroundBusy }

export const isAbsPathInPlaybackForeground = (absPath: string): boolean => {
  pruneExpiredEntries()
  const target = normalizeText(absPath)
  if (!target) return false
  const targetKey =
    process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target)
  for (const entry of foregroundEntries.values()) {
    const candidate = normalizeText(entry.filePath)
    if (!candidate) continue
    const candidateKey =
      process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate)
    if (candidateKey === targetKey) return true
  }
  return false
}

const acquireBackgroundFileIoSlot = async (priority: FileIoPriority): Promise<() => void> => {
  if (backgroundFileIoInFlight < BACKGROUND_FILE_IO_MAX_CONCURRENCY) {
    backgroundFileIoInFlight += 1
    return releaseBackgroundFileIoSlot
  }

  await new Promise<void>((resolve) => {
    backgroundFileIoWaiters.push({
      priority: FILE_IO_PRIORITY[priority],
      sequence: backgroundFileIoSequence++,
      resolve
    })
  })
  return releaseBackgroundFileIoSlot
}

const releaseBackgroundFileIoSlot = () => {
  if (backgroundFileIoHandoffScheduled) return
  backgroundFileIoHandoffScheduled = true
  // Give timers and incoming higher-priority work a chance to run between queued disk tasks.
  // Resolving the next waiter inline can keep a large deletion batch inside one microtask chain.
  setImmediate(() => {
    backgroundFileIoHandoffScheduled = false
    backgroundFileIoWaiters.sort(
      (left, right) => left.priority - right.priority || left.sequence - right.sequence
    )
    const next = backgroundFileIoWaiters.shift()
    if (next) {
      next.resolve()
      return
    }
    backgroundFileIoInFlight = Math.max(0, backgroundFileIoInFlight - 1)
  })
}

function markPlaybackForegroundActivity(payload: PlaybackForegroundPayload) {
  const state = payload.state
  if (state !== 'start' && state !== 'end') return

  const nowMs = Date.now()
  const key = buildActivityKey(payload)
  if (state === 'start') {
    foregroundEntries.set(key, {
      expiresAtMs: nowMs + PLAYBACK_FOREGROUND_STALE_MS,
      filePath: normalizeText(payload.filePath)
    })
    return
  }

  foregroundEntries.delete(key)
  foregroundGraceUntilMs = Math.max(
    foregroundGraceUntilMs,
    nowMs + PLAYBACK_FOREGROUND_IDLE_GRACE_MS
  )
}

export function registerPlaybackForegroundActivityHandlers() {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.on(PLAYBACK_FOREGROUND_ACTIVITY_CHANNEL, (_event, payload: PlaybackForegroundPayload) => {
    markPlaybackForegroundActivity(payload || {})
  })
}

export async function waitForPlaybackForegroundIdle(
  _context: string,
  _payload: Record<string, unknown> = {}
): Promise<number> {
  const startedAtMs = Date.now()
  while (isPlaybackForegroundBusy()) {
    await delay(BACKGROUND_IO_WAIT_INTERVAL_MS)
  }

  return Date.now() - startedAtMs
}

export async function runPlaybackAwareBackgroundFileIo<T>(
  context: string,
  payload: Record<string, unknown>,
  task: () => Promise<T>,
  options: { priority?: FileIoPriority } = {}
): Promise<T> {
  const priority = options.priority || 'background'
  await waitForPlaybackForegroundIdle(`${context}:before-slot`, payload)
  const releaseSlot = await acquireBackgroundFileIoSlot(priority)
  try {
    await waitForPlaybackForegroundIdle(`${context}:after-slot`, payload)
    return await task()
  } finally {
    releaseSlot()
  }
}
