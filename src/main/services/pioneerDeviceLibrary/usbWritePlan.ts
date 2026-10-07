import type {
  PioneerUsbLibraryType,
  PioneerUsbWriteOperation
} from '../../../shared/pioneerUsbWrite'
import {
  emptyUsbMutation,
  type UsbLibraryMutation,
  type UsbLibrarySnapshot,
  type UsbPlaylistRecord
} from './usbWriteModel'

export type UsbSnapshotMap = Partial<Record<PioneerUsbLibraryType, UsbLibrarySnapshot>>
export type UsbMutationMap = Partial<Record<PioneerUsbLibraryType, UsbLibraryMutation>>

export const usbPathKey = (value: string): string => {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('设备路径包含非法目录')
  return parts.join('/').toLowerCase()
}

const playlistKey = (snapshot: UsbLibrarySnapshot, id: number): string => {
  const segments: string[] = []
  const seen = new Set<number>()
  let current = id
  while (current) {
    if (seen.has(current)) throw new Error('歌单树包含循环引用')
    seen.add(current)
    const node = snapshot.playlists.find((item) => item.id === current)
    if (!node) throw new Error(`找不到歌单 ${current}`)
    segments.unshift(`${node.isFolder ? 'folder' : 'playlist'}:${JSON.stringify(node.name)}`)
    current = node.parentId
  }
  return JSON.stringify(segments)
}

const descendants = (snapshot: UsbLibrarySnapshot, id: number): number[] => {
  const result = [id]
  for (let index = 0; index < result.length; index++) {
    for (const child of snapshot.playlists.filter((node) => node.parentId === result[index])) {
      if (result.includes(child.id)) throw new Error('歌单树包含循环引用')
      result.push(child.id)
    }
  }
  return result
}

const requirePlaylist = (snapshot: UsbLibrarySnapshot, id: number): UsbPlaylistRecord => {
  const node = snapshot.playlists.find((item) => item.id === id)
  if (!node) throw new Error(`找不到歌单 ${id}`)
  return node
}

const mapPlaylist = (source: UsbLibrarySnapshot, target: UsbLibrarySnapshot, id: number) => {
  if (source === target) return requirePlaylist(source, id).id
  const key = playlistKey(source, id)
  const matches = target.playlists.filter((node) => playlistKey(target, node.id) === key)
  if (matches.length !== 1) {
    throw new Error('两套资料库的歌单无法唯一对应，请先用 rekordbox 同步资料库')
  }
  return matches[0].id
}

const mapTrack = (source: UsbLibrarySnapshot, target: UsbLibrarySnapshot, id: number): number => {
  const track = source.tracks.find((item) => item.id === id)
  if (!track?.filePath) throw new Error(`找不到歌曲 ${id} 或音频路径为空`)
  if (source === target) return track.id
  const key = usbPathKey(track.filePath)
  const matches = target.tracks.filter((item) => usbPathKey(item.filePath) === key)
  if (matches.length !== 1) {
    throw new Error('两套资料库的歌曲无法唯一对应，请先用 rekordbox 同步资料库')
  }
  return matches[0].id
}

/** Build concrete mutations from fresh disk snapshots, never from a view cache. */
export const planUsbWrite = (
  snapshots: UsbSnapshotMap,
  sourceType: PioneerUsbLibraryType,
  operation: PioneerUsbWriteOperation
): UsbMutationMap => {
  const source = snapshots[sourceType]
  if (!source) throw new Error('所选资料库不存在')
  const result: UsbMutationMap = {}
  const candidatePaths = new Set<string>()
  if ('trackIds' in operation) {
    if (
      !operation.trackIds.length ||
      new Set(operation.trackIds).size !== operation.trackIds.length
    ) {
      throw new Error('歌曲选择为空或包含重复歌曲')
    }
    operation.trackIds.forEach((id) => mapTrack(source, source, id))
    if (operation.kind === 'delete-tracks') {
      for (const id of operation.trackIds) {
        candidatePaths.add(usbPathKey(source.tracks.find((track) => track.id === id)!.filePath))
      }
    }
  }
  if ('trackId' in operation) mapTrack(source, source, operation.trackId)
  if ('playlistId' in operation) {
    const node = requirePlaylist(source, operation.playlistId)
    if (node.isFolder && operation.kind !== 'delete-playlist') throw new Error('请选择普通歌单')
  }
  for (const type of Object.keys(snapshots) as PioneerUsbLibraryType[]) {
    const snapshot = snapshots[type]!
    const mutation = emptyUsbMutation()
    const trackIds =
      'trackIds' in operation && operation.kind !== 'delete-tracks'
        ? operation.trackIds.map((id) => mapTrack(source, snapshot, id))
        : []
    const playlistId =
      'playlistId' in operation ? mapPlaylist(source, snapshot, operation.playlistId) : 0
    switch (operation.kind) {
      case 'reorder': {
        const entries = snapshot.entries.filter((item) => item.playlistId === playlistId)
        if (
          entries.length !== trackIds.length ||
          entries.some((item) => !trackIds.includes(item.trackId))
        ) {
          throw new Error('歌单内容已变化或两套库的成员不一致，请刷新后重试')
        }
        mutation.reorders.push({ playlistId, trackIds })
        break
      }
      case 'add-to-playlist':
        mutation.additions.push({ playlistId, trackIds })
        break
      case 'remove-from-playlist':
        if (
          trackIds.some(
            (id) =>
              !snapshot.entries.some(
                (entry) => entry.playlistId === playlistId && entry.trackId === id
              )
          )
        ) {
          throw new Error('所选歌曲已不在歌单中，请刷新后重试')
        }
        mutation.removals.push({ playlistId, trackIds })
        break
      case 'delete-tracks':
        // The final path-based pass removes duplicate rows in either library too.
        break
      case 'delete-playlist': {
        mutation.deletePlaylistIds = descendants(snapshot, playlistId)
        if (operation.deleteExclusiveTracks) {
          for (const entry of snapshot.entries.filter((item) =>
            mutation.deletePlaylistIds.includes(item.playlistId)
          )) {
            const track = snapshot.tracks.find((item) => item.id === entry.trackId)
            if (!track) throw new Error('歌单包含失效歌曲引用')
            candidatePaths.add(usbPathKey(track.filePath))
          }
        }
        break
      }
      case 'set-cues':
        mutation.cueUpdates.push({
          trackId: mapTrack(source, snapshot, operation.trackId),
          hotCues: operation.hotCues,
          memoryCues: operation.memoryCues
        })
        break
      case 'shift-grid':
        mutation.gridUpdates.push({
          trackId: mapTrack(source, snapshot, operation.trackId),
          offsetMs: operation.offsetMs
        })
        break
    }
    result[type] = mutation
  }
  if (candidatePaths.size) {
    for (const key of candidatePaths) {
      const referenced = Object.entries(snapshots).some(([type, snapshot]) => {
        const deletedPlaylists = result[type as PioneerUsbLibraryType]!.deletePlaylistIds
        return (
          snapshot!.tracks.some(
            (track) =>
              snapshot!.protectedTrackIds?.includes(track.id) && usbPathKey(track.filePath) === key
          ) ||
          snapshot!.entries.some(
            (entry) =>
              !deletedPlaylists.includes(entry.playlistId) &&
              snapshot!.tracks.some(
                (track) => track.id === entry.trackId && usbPathKey(track.filePath) === key
              )
          )
        )
      })
      if (operation.kind === 'delete-playlist' && referenced) continue
      for (const type of Object.keys(snapshots) as PioneerUsbLibraryType[]) {
        result[type]!.deleteTrackIds.push(
          ...snapshots[type]!.tracks.filter((track) => usbPathKey(track.filePath) === key).map(
            (track) => track.id
          )
        )
      }
    }
  }
  return result
}
