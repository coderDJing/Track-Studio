import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import emitter from './mitt'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { icloudInvoke, icloudState } from './icloudLibrary'
export type CloudPlaybackState = {
  state: 'waiting' | 'downloading' | 'ready' | 'failed'
  requestId: string
  error?: string
  url?: string
  percent?: number
}
export const cloudPlaybackStates = ref<Record<string, CloudPlaybackState>>({})
let epoch = 0,
  pending = '',
  pendingKey = ''
export function cancelCloudPlayback(key?: string) {
  epoch++
  if (pending) void icloudInvoke('icloud:cancel', pending).catch(() => {})
  if (pendingKey)
    cloudPlaybackStates.value[pendingKey] = {
      state: 'failed',
      requestId: pending,
      error: 'cancelled'
    }
  pending = ''
  pendingKey = ''
  if (key) cloudPlaybackStates.value[key] = { state: 'failed', requestId: '', error: 'cancelled' }
}
/** 双击装上轨，按住 Shift 装下轨。编辑模式与其它曲库一样只装上轨。 */
export function icloudDeckForBrowseMode(mode: string, shiftKey = false): 'top' | 'bottom' | null {
  if (mode === 'edit') return 'top'
  if (mode === 'horizontal') return shiftKey ? 'bottom' : 'top'
  return null
}

export function localPathFromIcloudTicket(url: string) {
  try {
    return new URL(url).searchParams.get('path')?.trim() || ''
  } catch {
    return ''
  }
}

export function buildIcloudDeckLoad(ready: ISongInfo, queue: ISongInfo[], clickedKey: string) {
  const filePath = localPathFromIcloudTicket(ready.filePath)
  if (!filePath) return null
  const song = { ...ready, filePath }
  return {
    song,
    filePath,
    queue: queue.map((row) => (sameRendererFilePath(row.filePath, clickedKey) ? song : row))
  }
}

/** 队列里还是逻辑地址时，装轨前必须先拿到本机文件。已经是本机路径的不再下载。 */
export function icloudDeckFileNeedsLocalCopy(song: ISongInfo) {
  const filePath = String(song.filePath || '')
  return (
    Boolean(song.icloudOrigin) &&
    (filePath.startsWith('icloud-song:') || filePath.startsWith('frkb-preview://icloud/'))
  )
}

export async function materializeIcloudDeckSong(song: ISongInfo): Promise<ISongInfo | null> {
  if (!icloudDeckFileNeedsLocalCopy(song)) return song
  const ready = await prepareCloudPlayback(song, 'edit')
  if (!ready) return null
  const filePath = localPathFromIcloudTicket(ready.filePath)
  if (!filePath) {
    const key = song.icloudOrigin?.key
    if (key) cloudPlaybackStates.value[key] = { state: 'failed', requestId: '', error: 'failed' }
    return null
  }
  return { ...ready, filePath }
}

export function icloudDeckQueueIndex(queue: ISongInfo[], song: ISongInfo) {
  const key = song.icloudOrigin?.key
  const token = song.icloudOrigin?.rootToken
  if (!key) return -1
  return queue.findIndex(
    (row) => row.icloudOrigin?.key === key && (!token || row.icloudOrigin?.rootToken === token)
  )
}

let onDeckLocalized: ((relative: string, filePath: string) => void) | null = null
export function setIcloudDeckLocalizedHandler(
  handler: ((relative: string, filePath: string) => void) | null
) {
  onDeckLocalized = handler
}
export function notifyIcloudDeckLocalized(relative: string, filePath: string) {
  if (relative && filePath) onDeckLocalized?.(relative, filePath)
}

/** Only this explicit transition localizes a file. Logical queue rows never reach the decoder. */
export async function prepareCloudPlayback(
  song: ISongInfo,
  mode = 'browser'
): Promise<ISongInfo | null> {
  const source = song.icloudOrigin
  if (!source || source.rootToken !== icloudState.value?.rootToken) {
    if (source)
      cloudPlaybackStates.value[source.key] = { state: 'failed', requestId: '', error: 'boundary' }
    return null
  }
  if (mode !== 'browser' && mode !== 'horizontal' && mode !== 'edit') {
    cloudPlaybackStates.value[source.key] = {
      state: 'failed',
      requestId: '',
      error: 'playbackMode'
    }
    return null
  }
  cancelCloudPlayback()
  const version = epoch,
    id = crypto.randomUUID()
  pending = id
  pendingKey = source.key
  cloudPlaybackStates.value[source.key] = { state: 'waiting', requestId: id }
  try {
    const url = await icloudInvoke<string>('icloud:prepare-play', source.relativePath, {
      rootToken: source.rootToken,
      requestId: id
    })
    if (version !== epoch || source.rootToken !== icloudState.value?.rootToken) return null
    cloudPlaybackStates.value[source.key] = { state: 'ready', requestId: id, url }
    return { ...song, filePath: url }
  } catch (reason) {
    if (version === epoch)
      cloudPlaybackStates.value[source.key] = {
        state: 'failed',
        requestId: id,
        error: reason instanceof Error ? reason.message : 'failed'
      }
    return null
  } finally {
    if (pending === id) {
      pending = ''
      pendingKey = ''
    }
  }
}

watch(
  () => icloudState.value?.rootToken,
  (next, old) => {
    if (old && next !== old) {
      cancelCloudPlayback()
      cloudPlaybackStates.value = {}
    }
  },
  { flush: 'sync' }
)

/** A new local playback intent cancels a pending cloud transition, even if its pane is gone. */
export async function prepareCloudTransition(
  runtime: ReturnType<typeof useRuntimeStore>,
  song: ISongInfo
) {
  const previous = runtime.playingData.playingSong
  const stop = watch(
    () => runtime.playingData.playingSong,
    (next) => {
      if (next !== previous) cancelCloudPlayback()
    },
    { flush: 'sync' }
  )
  try {
    const ready = await prepareCloudPlayback(song, runtime.mainWindowBrowseMode)
    return runtime.playingData.playingSong === previous ? ready : null
  } finally {
    stop()
  }
}
/** Playback intent belongs to the player, not to a mounted directory pane. */
export async function playCloudDirectory(
  runtime: ReturnType<typeof useRuntimeStore>,
  song: ISongInfo,
  queue: ISongInfo[]
) {
  const previous = runtime.playingData.playingSong
  const ready = await prepareCloudTransition(runtime, song)
  if (
    !ready ||
    runtime.playingData.playingSong !== previous ||
    ready.icloudOrigin?.rootToken !== icloudState.value?.rootToken
  )
    return null
  runtime.playingData.playingSongListUUID = 'icloud-music'
  runtime.playingData.playingSongListData = queue.map((row) =>
    row.icloudOrigin?.key === ready.icloudOrigin?.key ? ready : row
  )
  runtime.playingData.playingSong = ready
  return ready
}
emitter.on('icloud/playback-error', (data?: { url?: string }) => {
  for (const state of Object.values(cloudPlaybackStates.value))
    if (state.url === data?.url) {
      state.state = 'failed'
      state.error = 'playback'
    }
})
