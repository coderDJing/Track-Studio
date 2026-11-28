import { EventEmitter } from 'node:events'

/** 启动包只保留这份内存状态。下载、校验、解压留在 mixtapeStemRuntimeDownload，用到时再加载。 */
export type StemRuntimeProfileName = 'cuda' | 'xpu' | 'directml' | 'cpu' | 'mps' | 'rocm'

export type MixtapeStemRuntimeDownloadState = {
  status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
  profile: StemRuntimeProfileName | ''
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}

export type MixtapeStemRuntimeDownloadInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  localRuntimePresent: boolean
  profile: StemRuntimeProfileName | ''
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  error: string
  state: MixtapeStemRuntimeDownloadState
}

const createIdleStemRuntimeDownloadState = (): MixtapeStemRuntimeDownloadState => ({
  status: 'idle',
  profile: '',
  runtimeKey: '',
  version: '',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  title: '',
  message: '',
  error: '',
  updatedAt: Date.now()
})

let runtimeDownloadState = createIdleStemRuntimeDownloadState()

export const stemRuntimeDownloadEvents = new EventEmitter()

export const emitStemRuntimeDownloadState = () => {
  try {
    stemRuntimeDownloadEvents.emit('state', { ...runtimeDownloadState })
  } catch {
    // 订阅方抛错不能打断下载状态更新。
  }
}

export const getStemRuntimeDownloadState = (): MixtapeStemRuntimeDownloadState => ({
  ...runtimeDownloadState
})

export const updateRuntimeDownloadState = (
  patch: Partial<MixtapeStemRuntimeDownloadState>
): MixtapeStemRuntimeDownloadState => {
  runtimeDownloadState = {
    ...runtimeDownloadState,
    ...patch,
    updatedAt: Date.now()
  }
  emitStemRuntimeDownloadState()
  return runtimeDownloadState
}

export const assignStemRuntimeDownloadState = (next: MixtapeStemRuntimeDownloadState) => {
  runtimeDownloadState = next
}
