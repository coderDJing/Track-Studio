import { icloudInvoke, icloudState } from './icloudLibrary'
import { cloudPlaybackStates, type CloudPlaybackState } from './icloudPlayback'
import type { ISongInfo } from 'src/types/globals'

export type IcloudLocalFile = { relative: string; filePath: string }

let epoch = 0
let pending = ''
let pendingKey = ''

const songKey = (song: ISongInfo) => song.icloudOrigin?.key || song.filePath

const setState = (key: string, next: CloudPlaybackState) => {
  const current = cloudPlaybackStates.value[key]
  cloudPlaybackStates.value[key] = {
    ...next,
    ...(next.state === 'ready' && current?.url ? { url: current.url } : {})
  }
}

export function isIcloudLocalActionPending(key?: string) {
  if (!pending) return false
  return !key || pendingKey === key
}

/** Cancel only the in-flight localize-for-action; do not stop an unrelated playing track. */
export function cancelIcloudLocalAction(key?: string) {
  if (!pending && !pendingKey) return false
  if (key && pendingKey && pendingKey !== key) return false
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
  return true
}

export function icloudLocalActionError(songs: ISongInfo[]) {
  for (const song of songs) {
    const state = cloudPlaybackStates.value[songKey(song)]
    if (state?.state === 'failed' && state.error && state.error !== 'cancelled') return state.error
  }
  return ''
}

/** Localize only the selected songs, one at a time, then return real local paths. Cancel aborts the batch. */
export async function prepareIcloudSongsForLocalAction(
  songs: ISongInfo[]
): Promise<ISongInfo[] | null> {
  const list = (songs || []).filter((song) => song?.icloudOrigin)
  if (!list.length) return null
  const batch = ++epoch
  const prepared: ISongInfo[] = []
  for (const song of list) {
    const source = song.icloudOrigin
    const token = icloudState.value?.rootToken
    if (!source || source.rootToken !== token) {
      setState(source?.key || song.filePath, { state: 'failed', requestId: '', error: 'boundary' })
      return null
    }
    if (batch !== epoch) return null
    const id = crypto.randomUUID()
    pending = id
    pendingKey = source.key
    setState(source.key, { state: 'waiting', requestId: id })
    try {
      const result = await icloudInvoke<IcloudLocalFile>(
        'icloud:prepare-local',
        source.relativePath,
        {
          rootToken: source.rootToken,
          requestId: id
        }
      )
      if (batch !== epoch || source.rootToken !== icloudState.value?.rootToken) return null
      const filePath = String(result?.filePath || '').trim()
      if (!filePath) {
        setState(source.key, { state: 'failed', requestId: id, error: 'failed' })
        return null
      }
      setState(source.key, { state: 'ready', requestId: id })
      prepared.push({ ...song, filePath })
    } catch (reason) {
      if (batch === epoch)
        setState(source.key, {
          state: 'failed',
          requestId: id,
          error: reason instanceof Error ? reason.message : 'failed'
        })
      return null
    } finally {
      if (pending === id) {
        pending = ''
        pendingKey = ''
      }
    }
  }
  return prepared
}
