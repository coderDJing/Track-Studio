import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { IDir, ISongsAreaColumn } from 'src/types/globals'
import type { SongsAreaColumnMode } from './runtime'
import {
  cloneSongColumns,
  normalizeSongColumns,
  readSharedSongColumns,
  songColumnStorageKey
} from '@renderer/pages/modules/songsArea/composables/songColumnStorage'

interface PlaylistViewSettings {
  enabled: boolean
  mode: SongsAreaColumnMode
  columns: ISongsAreaColumn[]
  compatibleKeyOnly: boolean
}

const storageKey = (libraryUuid: string) => `playlistViewSettings:v1:${libraryUuid}`
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export const isPlaylistViewNode = (node: IDir | null | undefined): boolean =>
  node?.type === 'songList' || node?.type === 'setList' || node?.type === 'mixtapeList'

export const usePlaylistViewSettingsStore = defineStore('playlistViewSettings', () => {
  // 公共列配置沿用原存储键；所有面板共享同一会话快照，避免旧面板缓存覆盖新设置。
  const sharedColumns = reactive<Partial<Record<SongsAreaColumnMode, ISongsAreaColumn[]>>>({})
  const libraries = reactive<Record<string, Record<string, PlaylistViewSettings>>>({})

  const getSharedColumns = (mode: SongsAreaColumnMode, persistFilters: boolean) => {
    if (!sharedColumns[mode]) sharedColumns[mode] = readSharedSongColumns(mode, persistFilters)
    return sharedColumns[mode]!
  }

  const loadLibrary = (libraryUuid: string, persistFilters: boolean) => {
    if (Object.hasOwn(libraries, libraryUuid)) return libraries[libraryUuid]
    const settings: Record<string, PlaylistViewSettings> = Object.create(null)
    if (libraryUuid) {
      try {
        const raw = localStorage.getItem(storageKey(libraryUuid))
        const parsed: unknown = raw ? JSON.parse(raw) : null
        if (isRecord(parsed)) {
          for (const [uuid, entry] of Object.entries(parsed)) {
            if (!isRecord(entry) || !Array.isArray(entry.columns)) continue
            if (entry.mode !== 'default' && entry.mode !== 'mixtape') continue
            settings[uuid] = {
              enabled: entry.enabled === true,
              mode: entry.mode,
              columns: normalizeSongColumns(entry.columns, entry.mode, persistFilters),
              compatibleKeyOnly: entry.compatibleKeyOnly === true
            }
          }
        }
      } catch (error) {
        console.error('读取歌单独立列表设置失败:', error)
      }
    }
    libraries[libraryUuid] = settings
    return libraries[libraryUuid]
  }

  const persistLibrary = (libraryUuid: string) => {
    if (!libraryUuid) return
    const settings = libraries[libraryUuid]
    if (settings && Object.keys(settings).length) {
      localStorage.setItem(storageKey(libraryUuid), JSON.stringify(settings))
    } else {
      localStorage.removeItem(storageKey(libraryUuid))
    }
  }

  const getPlaylist = (libraryUuid: string, uuid: string, persistFilters: boolean) =>
    loadLibrary(libraryUuid, persistFilters)[uuid]

  const setIndependent = (
    libraryUuid: string,
    uuid: string,
    mode: SongsAreaColumnMode,
    enabled: boolean,
    compatibleKeyOnly: boolean,
    persistFilters: boolean
  ) => {
    if (!libraryUuid || !uuid) return
    const settings = loadLibrary(libraryUuid, persistFilters)
    if (!settings[uuid]) {
      if (!enabled) return
      settings[uuid] = {
        enabled,
        mode,
        columns: cloneSongColumns(getSharedColumns(mode, persistFilters)),
        compatibleKeyOnly
      }
    } else {
      settings[uuid].enabled = enabled
    }
    persistLibrary(libraryUuid)
  }

  const updateSharedColumns = (mode: SongsAreaColumnMode, columns: ISongsAreaColumn[]) => {
    if (JSON.stringify(sharedColumns[mode]) !== JSON.stringify(columns)) {
      sharedColumns[mode] = cloneSongColumns(columns)
    }
    localStorage.setItem(songColumnStorageKey(mode), JSON.stringify(columns))
  }

  const updatePlaylist = (
    libraryUuid: string,
    uuid: string,
    columns: ISongsAreaColumn[],
    compatibleKeyOnly: boolean
  ) => {
    const settings = libraries[libraryUuid]?.[uuid]
    // 删除后不得由仍在关闭中的面板重新创建配置。
    if (!settings?.enabled) return
    if (JSON.stringify(settings.columns) !== JSON.stringify(columns)) {
      settings.columns = cloneSongColumns(columns)
    }
    settings.compatibleKeyOnly = compatibleKeyOnly
    persistLibrary(libraryUuid)
  }

  const resetPlaylist = (
    libraryUuid: string,
    uuid: string,
    persistFilters: boolean,
    compatibleKeyOnly: boolean
  ) => {
    const settings = libraries[libraryUuid]?.[uuid]
    if (!settings?.enabled) return
    settings.columns = cloneSongColumns(getSharedColumns(settings.mode, persistFilters))
    settings.compatibleKeyOnly = compatibleKeyOnly
    persistLibrary(libraryUuid)
  }

  const removePlaylists = (
    libraryUuid: string,
    uuids: Iterable<string>,
    persistFilters: boolean
  ) => {
    const settings = loadLibrary(libraryUuid, persistFilters)
    let changed = false
    for (const uuid of uuids) {
      if (!Object.hasOwn(settings, uuid)) continue
      delete settings[uuid]
      changed = true
    }
    if (changed) persistLibrary(libraryUuid)
  }

  // 只对主进程确认的完整库树调用；绝不能根据删除中的乐观树清理。
  const pruneDeletedPlaylists = (tree: IDir, persistFilters: boolean) => {
    if (!tree.uuid || tree.type !== 'root' || !Array.isArray(tree.children)) return
    const settings = loadLibrary(tree.uuid, persistFilters)
    const keep = new Set<string>()
    const walk = (node: IDir) => {
      if (isPlaylistViewNode(node)) keep.add(node.uuid)
      node.children?.forEach(walk)
    }
    walk(tree)
    removePlaylists(
      tree.uuid,
      Object.keys(settings).filter((uuid) => !keep.has(uuid)),
      persistFilters
    )
  }

  return {
    getSharedColumns,
    getPlaylist,
    setIndependent,
    updateSharedColumns,
    updatePlaylist,
    resetPlaylist,
    removePlaylists,
    pruneDeletedPlaylists
  }
})
