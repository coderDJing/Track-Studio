import fs from 'fs-extra'
import { powerMonitor } from 'electron'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { log } from '../log'
import { enqueueCloudWork } from '../curatedLibrarySync/queue'
import { uploadBlobWithResume } from '../curatedLibrarySync/blobTransfer'
import {
  isLibraryMergeMutationLocked,
  tryBeginLibraryMaintenanceMutation
} from '../services/libraryMerge/mutationGate'
import {
  mergeSetSnapshots,
  sameSetValue,
  type SetSyncResolution,
  type SetSyncStatus
} from '../../shared/setLibrarySync'
import { assertSetDiskUnchanged, scanSetLibrary, setLocalGuard, type SetLocalScan } from './scan'
import { setSyncRequest, setSyncUserKey } from './api'
import { isSetLibrarySyncEnabled, readSetSyncBase } from './state'
import { applySetSnapshot } from './apply'
import { parseSetSnapshot } from './validation'
import { recoverSetTreeTransaction } from './treeTransaction'

let controller: AbortController | null = null
let flight: Promise<SetSyncStatus> | null = null
let timer: NodeJS.Timeout | null = null
let cache: { library: string; key: string; scan: SetLocalScan; stats: Map<string, string> } | null =
  null
let suspended = false
const idle = (): SetSyncStatus => ({
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  result: 'idle',
  error: '',
  conflicts: [],
  lastSuccessAt: 0
})
let status = idle()
let statusLibrary = ''
export function getSetLibrarySyncStatus(): SetSyncStatus {
  if (statusLibrary !== store.databaseDir && !flight) {
    status = idle()
    statusLibrary = store.databaseDir
  }
  return status
}
const update = (patch: Partial<SetSyncStatus>) => {
  status = { ...status, ...patch }
  const win = mainWindow.instance
  if (win && !win.isDestroyed()) win.webContents.send('setLibrarySync/status', status)
}
export function cancelSetLibrarySync(): void {
  controller?.abort()
}
const statKey = (p: string) => {
  const s = fs.statSync(p)
  return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`
}
const cacheCurrent = (): boolean => {
  if (!cache || cache.library !== store.databaseDir || cache.key !== setSyncUserKey()) return false
  if (setLocalGuard() !== cache.scan.guard) return false
  try {
    assertSetDiskUnchanged(cache.scan)
    return [...cache.stats].every(([file, stat]) => statKey(file) === stat)
  } catch {
    return false
  }
}

export function enqueueSetLibrarySync(
  resolution?: SetSyncResolution,
  automatic = false
): Promise<SetSyncStatus> {
  if (flight) return flight
  if (
    !isSetLibrarySyncEnabled() ||
    !setSyncUserKey() ||
    suspended ||
    isLibraryMergeMutationLocked()
  )
    return Promise.resolve(getSetLibrarySyncStatus())
  if (automatic && status.result === 'conflicts') return Promise.resolve(status)
  flight = enqueueCloudWork(async () => {
    if (!isSetLibrarySyncEnabled() || !setSyncUserKey()) return getSetLibrarySyncStatus()
    const library = store.databaseDir
    const key = setSyncUserKey()
    statusLibrary = library
    controller = new AbortController()
    const signal = controller.signal
    let releaseMaintenance: (() => void) | null = null
    const assertContext = () => {
      signal.throwIfAborted()
      if (store.databaseDir !== library || setSyncUserKey() !== key || !isSetLibrarySyncEnabled())
        throw new Error('SET_SYNC_CONTEXT_CHANGED')
    }
    update({
      running: true,
      phase: 'scanning',
      result: 'idle',
      error: '',
      conflicts: [],
      done: 0,
      total: 0
    })
    try {
      releaseMaintenance = tryBeginLibraryMaintenanceMutation()
      if (!releaseMaintenance) throw new Error('SET_SYNC_BUSY_LIBRARY')
      await recoverSetTreeTransaction()
      assertContext()
      let scan: SetLocalScan
      if (cacheCurrent()) scan = cache!.scan
      else {
        if (cache && cache.library === library) await fs.remove(cache.scan.directory)
        cache = null
        try {
          scan = await scanSetLibrary(signal)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'SET_SYNC_LOCAL_CHANGED') throw error
          scan = await scanSetLibrary(signal)
        }
        cache = {
          library,
          key,
          scan,
          stats: new Map([...scan.files.values()].map((p) => [p, statKey(p)]))
        }
      }
      assertContext()
      const base = readSetSyncBase(key)
      let cloud = await setSyncRequest('pull', {}, signal)
      if (cloud.revision < base.revision) throw new Error('SET_SYNC_CLOUD_HISTORY_CHANGED')
      for (let attempt = 0; attempt < 4; attempt++) {
        assertContext()
        const merged = mergeSetSnapshots(base, scan.snapshot, cloud, resolution)
        if (merged.conflicts.length && !resolution) {
          update({ result: 'conflicts', conflicts: merged.conflicts })
          return status
        }
        const target = parseSetSnapshot(merged.snapshot)
        const content = (s: typeof target) => ({ nodes: s.nodes, items: s.items })
        const upload = !sameSetValue(content(target), content(cloud))
        const localChange = !sameSetValue(content(target), content(scan.snapshot))
        if (upload) {
          const required = new Map(
            target.items.flatMap((i) =>
              [i.audio, i.analysis, i.waveform]
                .filter((a) => a !== null)
                .map((a) => [a.sha256, a] as const)
            )
          )
          const cloudAssets = new Set(
            cloud.items.flatMap((i) =>
              [i.audio, i.analysis, i.waveform].filter((a) => a !== null).map((a) => a.sha256)
            )
          )
          const assets = [...required.values()].filter((a) => !cloudAssets.has(a.sha256))
          update({ phase: 'uploading', done: 0, total: assets.length })
          for (const [index, asset] of assets.entries()) {
            assertContext()
            const source = scan.files.get(asset.sha256)
            if (!source) throw new Error('SET_SYNC_LOCAL_ASSET_MISSING')
            if (cache?.stats.get(source) !== statKey(source))
              throw new Error('SET_SYNC_LOCAL_CHANGED')
            await uploadBlobWithResume({ ...asset, filePath: source, scope: 'set', signal })
            update({ done: index + 1 })
          }
          if (!cacheCurrent()) throw new Error('SET_SYNC_LOCAL_CHANGED')
          try {
            cloud = await setSyncRequest(
              'push',
              { ...target, baseRevision: cloud.revision },
              signal
            )
          } catch (error) {
            if (error instanceof Error && error.message === 'SET_SYNC_REVISION_CONFLICT') {
              cloud = await setSyncRequest('pull', {}, signal)
              if (cloud.revision < base.revision) throw new Error('SET_SYNC_CLOUD_HISTORY_CHANGED')
              continue
            }
            throw error
          }
        }
        assertContext()
        update({ phase: 'downloading', done: 0, total: target.items.length })
        releaseMaintenance()
        releaseMaintenance = null
        await applySetSnapshot(scan, upload ? cloud : target, key, signal, (done, total) =>
          update({ done, total })
        )
        update({
          result: upload || localChange ? 'success' : 'unchanged',
          lastSuccessAt: Date.now()
        })
        return status
      }
      throw new Error('SET_SYNC_REVISION_CONFLICT')
    } catch (error) {
      if (signal.aborted) update({ result: 'cancelled', error: '' })
      else {
        const message = error instanceof Error ? error.message : String(error)
        update({ result: 'failed', error: message })
        log.error('[setLibrarySync] sync failed', error)
      }
      return status
    } finally {
      releaseMaintenance?.()
      controller = null
      update({ running: false, phase: 'idle' })
    }
  })
  flight = flight
    .then(() => getSetLibrarySyncStatus())
    .finally(() => {
      flight = null
    })
  return flight
}

export function startSetLibrarySync(): void {
  if (timer) return
  timer = setInterval(() => {
    void enqueueSetLibrarySync(undefined, true)
  }, 15_000)
  timer.unref()
  powerMonitor.on('suspend', () => {
    suspended = true
    cancelSetLibrarySync()
  })
  powerMonitor.on('resume', () => {
    suspended = false
    void enqueueSetLibrarySync(undefined, true)
  })
}
export function stopSetLibrarySync(): void {
  cancelSetLibrarySync()
  if (timer) clearInterval(timer)
  timer = null
}
