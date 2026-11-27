import { shallowRef } from 'vue'
import { icloudOpen, copyIcloudSongs } from './icloudLibrary'
import { isIcloudPlaybackUrl } from '@shared/icloudLibrary'
import type { ISongInfo } from 'src/types/globals'
type Target = 'FilterLibrary' | 'CuratedLibrary'
export const activeCloudListContext = shallowRef<{
  copy: (target: Target) => Promise<unknown>
} | null>(null)
export const isCloudSong = (song: ISongInfo | null | undefined) =>
  Boolean(song?.icloudOrigin || isIcloudPlaybackUrl(song?.filePath || ''))
export const isCloudListActive = () => icloudOpen.value
export const localPlayerActionsAllowed = (song: ISongInfo | null | undefined) =>
  !isCloudListActive() && !isCloudSong(song)
async function copyCloudSong(target: Target, song: ISongInfo | null | undefined) {
  if (isCloudListActive()) {
    await activeCloudListContext.value?.copy(target)
    return
  }
  const origin = song?.icloudOrigin
  if (!origin) return
  const { default: choose } = await import('@renderer/components/selectSongListDialog')
  const result = await choose({ libraryName: target, actionMode: 'copy' })
  if (result !== 'cancel')
    await copyIcloudSongs('to-local', result.uuid, [origin.relativePath], origin.rootToken)
}
// One public action boundary covers buttons, menus, global shortcuts and mini-player events.
export function guardPlayerActions<T extends object>(
  runtime: { playingData: { playingSong: ISongInfo | null } },
  actions: T
): T {
  const mutations = new Set([
    'delSong',
    'delAllAbove',
    'moveToListLibrary',
    'moveToLikeLibrary',
    'moveToSetLibrary',
    'moveToMixtapeLibrary',
    'exportTrack',
    'handleMoveSong'
  ])
  return new Proxy(actions, {
    get(target, key, receiver) {
      const action = Reflect.get(target, key, receiver)
      if (typeof key !== 'string' || !mutations.has(key) || typeof action !== 'function')
        return action
      return (...args: unknown[]) => {
        const song = runtime.playingData.playingSong
        if (localPlayerActionsAllowed(song)) return Reflect.apply(action, target, args)
        if (key === 'moveToListLibrary' || key === 'moveToLikeLibrary')
          return copyCloudSong(
            key === 'moveToListLibrary' ? 'FilterLibrary' : 'CuratedLibrary',
            song
          )
      }
    }
  })
}
