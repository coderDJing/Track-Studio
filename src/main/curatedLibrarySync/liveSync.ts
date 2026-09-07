import store from '../store'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../../shared/cloudSyncDevUserKey'
import {
  isCuratedLibrarySyncEnabled,
  getCuratedLibrarySyncLastAppliedRevision
} from '../librarySettingsDb'
import { openCuratedLibraryEventStream } from './apiClient'
import { enqueueCuratedLibrarySync } from './queue'
import { offerCuratedLibraryJoinPrompt } from './joinPrompt'

let abortController: AbortController | null = null
let loopRunning = false
let connected = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) {
      clearTimeout(timer)
      reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

const enqueueJoinAlignment = () => {
  void (async () => {
    const result = await enqueueCuratedLibrarySync({ trigger: 'scheduled' })
    offerCuratedLibraryJoinPrompt(result)
  })()
}

const scheduleCloudChange = (revision: number, snapshotReady: boolean) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!isCuratedLibrarySyncEnabled()) return
    const lastNow = getCuratedLibrarySyncLastAppliedRevision()
    if (lastNow === null) return
    if (!snapshotReady || revision < lastNow) {
      if (snapshotReady && revision < lastNow) {
        void enqueueCuratedLibrarySync({ trigger: 'scheduled', joinMode: 'cloud-wins' })
        return
      }
      enqueueJoinAlignment()
      return
    }
    if (revision === lastNow) return
    void enqueueCuratedLibrarySync({ trigger: 'realtime' })
  }, 2000)
}

const shouldRun = () =>
  isCuratedLibrarySyncEnabled() &&
  resolveDevCloudSyncUserKey(String(store.settingConfig?.cloudSyncUserKey || '').trim(), is.dev)
    .length > 0

const runLoop = async (token: number) => {
  let backoffMs = 2000
  while (loopRunning && token === generation) {
    if (!shouldRun()) break
    abortController = new AbortController()
    try {
      await openCuratedLibraryEventStream({
        signal: abortController.signal,
        onEvent: (event, data) => {
          if (event !== 'revision' && event !== 'snapshot') return
          connected = true
          backoffMs = 2000
          const revision = Number(data.revision)
          if (!Number.isSafeInteger(revision) || revision < 0) return
          const snapshotReady = data.snapshotReady === true
          scheduleCloudChange(revision, snapshotReady)
        }
      })
      connected = false
    } catch {
      connected = false
    }
    if (!loopRunning || token !== generation || !shouldRun()) break
    const signal = abortController?.signal
    if (!signal || signal.aborted) break
    try {
      await delay(backoffMs, signal)
    } catch {
      break
    }
    backoffMs = Math.min(60_000, backoffMs * 2)
  }
  if (token === generation) connected = false
}

export const isCuratedLibraryLiveConnected = (): boolean => connected && shouldRun()

export const stopCuratedLibraryLiveSync = (): void => {
  generation += 1
  loopRunning = false
  connected = false
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  abortController?.abort()
  abortController = null
}

export const syncCuratedLibraryLiveSync = (): void => {
  stopCuratedLibraryLiveSync()
  if (!shouldRun()) return
  const token = generation
  loopRunning = true
  void runLoop(token)
}
