import { parentPort } from 'node:worker_threads'
import store from '../store'
import { loadMissingWaveformFilePaths, scanSongList } from '../services/scanSongs'

type WorkerRequest = {
  requestId?: number
  mode?: 'scan' | 'verify'
  deferCacheWrite?: boolean
  deferWaveformAvailability?: boolean
  scanPath: string | string[]
  audioExt: string[]
  songListUUID: string
  databaseDir: string
}

parentPort?.on('message', async (payload: WorkerRequest) => {
  const requestId = Number(payload?.requestId)
  try {
    store.databaseDir = String(payload?.databaseDir || '').trim()
    const verifiedOnly = payload?.mode === 'verify'
    const deferredCacheWrite = { task: null as (() => Promise<void>) | null }
    const result = await scanSongList(
      payload?.scanPath || '',
      Array.isArray(payload?.audioExt) ? payload.audioExt : [],
      String(payload?.songListUUID || '').trim(),
      {
        enablePostScanTasks: false,
        verifiedOnly,
        enqueueDeferredSongCacheWrite: payload?.deferCacheWrite
          ? (write) => {
              deferredCacheWrite.task = write
            }
          : undefined,
        deferWaveformAvailabilityCheck: payload?.deferWaveformAvailability === true
      }
    )
    const deferredWaveformAvailabilityCheck = result.deferredWaveformAvailabilityCheck
    const { deferredWaveformAvailabilityCheck: _deferredCheck, ...resultForRenderer } = result
    const pendingCacheWrite = deferredCacheWrite.task
    parentPort?.postMessage({
      type: 'scan-result',
      requestId,
      result: resultForRenderer,
      cacheWritePending: pendingCacheWrite !== null,
      waveformAvailabilityPending: !!deferredWaveformAvailabilityCheck
    })
    if (pendingCacheWrite) {
      await pendingCacheWrite()
      parentPort?.postMessage({ type: 'cache-write-complete', requestId })
    }
    if (deferredWaveformAvailabilityCheck) {
      let missingWaveformFilePaths: string[] = []
      try {
        missingWaveformFilePaths = loadMissingWaveformFilePaths(deferredWaveformAvailabilityCheck)
      } catch {}
      parentPort?.postMessage({
        type: 'waveform-availability-complete',
        requestId,
        waveformAvailability: {
          songListUUID: result.songListUUID,
          identityDigest: result.identityDigest,
          listRoot: deferredWaveformAvailabilityCheck.cacheRoot,
          missingWaveformFilePaths
        }
      })
    }
  } catch (error) {
    parentPort?.postMessage({
      type: 'scan-result',
      requestId,
      error: error instanceof Error ? error.message : String(error || 'scanSongList worker failed')
    })
  }
})
