import store from './store'
import { isLibrarySetupActive } from './librarySetupState'
import {
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../shared/cloudSyncAuto'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../shared/cloudSyncDevUserKey'
import { isCuratedLibrarySyncEnabled } from './librarySettingsDb'
import { getCuratedLibraryAbsRoot, isPathInside } from './curatedLibrarySync/paths'
import { enqueueCuratedLibrarySync } from './curatedLibrarySync/queue'
import { isCuratedLibraryTreeSyncSuppressed } from './curatedLibrarySync/treeSyncGuard'
import {
  hasPendingCuratedLibraryJoinPrompt,
  offerCuratedLibraryJoinPrompt
} from './curatedLibrarySync/joinPrompt'
import type { CloudSyncTrigger } from '../types/cloudSync'
import { bindLibraryTreeMutationListener } from './libraryTreeWatcher'
import { log } from './log'

let intervalHandle: ReturnType<typeof setInterval> | null = null
let treeSyncTimer: ReturnType<typeof setTimeout> | null = null
let treeListenerBound = false
let runFingerprintSync: ((trigger: CloudSyncTrigger) => Promise<string>) | null = null
let pendingTickIgnoresSuppress = false

const TREE_SYNC_DEBOUNCE_MS = 2000

export function bindCloudSyncScheduler(run: (trigger: CloudSyncTrigger) => Promise<string>): void {
  runFingerprintSync = run
}

const hasCloudUserKey = (): boolean =>
  resolveDevCloudSyncUserKey(String(store.settingConfig?.cloudSyncUserKey || '').trim(), is.dev)
    .length > 0

function isCloudSyncAutoRunnable(): boolean {
  if (!normalizeCloudSyncAutoEnabled(store.settingConfig?.cloudSyncAutoEnabled)) return false
  if (isLibrarySetupActive()) return false
  if (!store.databaseDir) return false
  return hasCloudUserKey()
}

function canRunCuratedLibrarySyncNow(): boolean {
  if (isLibrarySetupActive()) return false
  if (!store.databaseDir) return false
  if (!isCuratedLibrarySyncEnabled()) return false
  return hasCloudUserKey()
}

export function stopCloudSyncScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  if (treeSyncTimer) {
    clearTimeout(treeSyncTimer)
    treeSyncTimer = null
  }
}

export async function runCuratedLibrarySyncTick(): Promise<void> {
  if (!canRunCuratedLibrarySyncNow()) return
  if (hasPendingCuratedLibraryJoinPrompt()) return
  const result = await enqueueCuratedLibrarySync({ trigger: 'scheduled' })
  offerCuratedLibraryJoinPrompt(result)
}

function queueCuratedLibrarySyncTick(respectSuppress: boolean): void {
  if (!respectSuppress) pendingTickIgnoresSuppress = true
  if (treeSyncTimer) clearTimeout(treeSyncTimer)
  const ignoreSuppress = pendingTickIgnoresSuppress
  treeSyncTimer = setTimeout(() => {
    treeSyncTimer = null
    pendingTickIgnoresSuppress = false
    if (!ignoreSuppress && isCuratedLibraryTreeSyncSuppressed()) return
    void runCuratedLibrarySyncTick()
  }, TREE_SYNC_DEBOUNCE_MS)
}

function scheduleCuratedLibrarySyncAfterTreeChange(): void {
  if (!canRunCuratedLibrarySyncNow()) return
  if (isCuratedLibraryTreeSyncSuppressed()) return
  queueCuratedLibrarySyncTick(true)
}

export function scheduleCuratedLibrarySyncAfterLocalChange(): void {
  if (!canRunCuratedLibrarySyncNow()) return
  queueCuratedLibrarySyncTick(false)
}

/** 只改 cache / 树 DB、没有磁盘事件时，用这个判断是否落在精选库里再排队。 */
export function scheduleCuratedLibrarySyncIfUnderCurated(
  absPaths: Array<string | null | undefined>
): void {
  const root = getCuratedLibraryAbsRoot()
  if (!root) return
  for (const absPath of absPaths) {
    if (absPath && isPathInside(absPath, root)) {
      scheduleCuratedLibrarySyncAfterLocalChange()
      return
    }
  }
}

function ensureLibraryTreeSyncTrigger(): void {
  if (treeListenerBound) return
  treeListenerBound = true
  bindLibraryTreeMutationListener(() => {
    scheduleCuratedLibrarySyncAfterTreeChange()
  })
}

async function runScheduledTick(): Promise<void> {
  const startedAt = Date.now()
  const fingerprintRunnable = isCloudSyncAutoRunnable() && !!runFingerprintSync
  const curatedRunnable = canRunCuratedLibrarySyncNow()
  log.info('[cloud-sync-scheduler] scheduled tick start', {
    fingerprintRunnable,
    curatedRunnable,
    intervalMs: normalizeCloudSyncAutoIntervalMs(store.settingConfig?.cloudSyncAutoIntervalMs)
  })
  let fingerprintResult: string | null = null
  try {
    if (fingerprintRunnable && runFingerprintSync) {
      fingerprintResult = await runFingerprintSync('scheduled')
    }
    await runCuratedLibrarySyncTick()
  } finally {
    log.info('[cloud-sync-scheduler] scheduled tick end', {
      elapsedMs: Date.now() - startedAt,
      fingerprintResult
    })
  }
}

export function restartCloudSyncScheduler(options?: { immediate?: boolean }): void {
  stopCloudSyncScheduler()
  ensureLibraryTreeSyncTrigger()
  const autoRunnable = isCloudSyncAutoRunnable()
  const curatedRunnable = canRunCuratedLibrarySyncNow()
  if (!autoRunnable && !curatedRunnable) return
  if (options?.immediate !== false) {
    void runScheduledTick()
  }
  if (!autoRunnable) return
  const intervalMs = normalizeCloudSyncAutoIntervalMs(store.settingConfig?.cloudSyncAutoIntervalMs)
  intervalHandle = setInterval(() => {
    void runScheduledTick()
  }, intervalMs)
}
