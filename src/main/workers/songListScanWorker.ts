import { parentPort } from 'node:worker_threads'
import store from '../store'
import { scanSongList } from '../services/scanSongs'

type WorkerRequest = {
  requestId?: number
  mode?: 'scan' | 'verify'
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
    const result = await scanSongList(
      payload?.scanPath || '',
      Array.isArray(payload?.audioExt) ? payload.audioExt : [],
      String(payload?.songListUUID || '').trim(),
      {
        enablePostScanTasks: false,
        verifiedOnly
      }
    )
    parentPort?.postMessage({ requestId, result })
  } catch (error) {
    parentPort?.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error || 'scanSongList worker failed')
    })
  }
})
