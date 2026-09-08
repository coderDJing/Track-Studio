import { normalizeFilePathForComparison } from './filePathComparison'

export type PlaybackDeleteAllAboveSong = {
  filePath?: string | null
  setItemId?: string | null
  mixtapeItemId?: string | null
}

export type PlaybackDeleteAllAboveTarget<
  T extends PlaybackDeleteAllAboveSong = PlaybackDeleteAllAboveSong
> = {
  listUuid: string
  playingIndex: number
  songs: T[]
}

const normalizePlaybackFilePath = (
  filePath: string | undefined | null,
  caseInsensitiveFilePath: boolean
) => normalizeFilePathForComparison(filePath, caseInsensitiveFilePath)

export const isPlaybackDeleteAllAboveBlockedLibraryType = (type?: string | null) =>
  type === 'setList' || type === 'mixtapeList'

export const findPlayingSongIndexInList = <T extends PlaybackDeleteAllAboveSong>(
  list: readonly T[],
  playingSong: T | null | undefined,
  caseInsensitiveFilePath = false
) => {
  if (!playingSong || !Array.isArray(list) || list.length === 0) return -1
  const byRef = list.indexOf(playingSong)
  if (byRef !== -1) return byRef
  const setItemId = String(playingSong.setItemId || '')
  if (setItemId) {
    const index = list.findIndex((item) => String(item.setItemId || '') === setItemId)
    if (index !== -1) return index
  }
  const mixtapeItemId = String(playingSong.mixtapeItemId || '')
  if (mixtapeItemId) {
    const index = list.findIndex((item) => String(item.mixtapeItemId || '') === mixtapeItemId)
    if (index !== -1) return index
  }
  const filePath = normalizePlaybackFilePath(playingSong.filePath, caseInsensitiveFilePath)
  if (!filePath) return -1
  return list.findIndex(
    (item) => normalizePlaybackFilePath(item.filePath, caseInsensitiveFilePath) === filePath
  )
}

export const resolvePlaybackDeleteAllAboveTarget = <T extends PlaybackDeleteAllAboveSong>(params: {
  listUuid?: string | null
  listData?: readonly T[] | null
  playingSong?: T | null
  libraryType?: string | null
  caseInsensitiveFilePath: boolean
}): PlaybackDeleteAllAboveTarget<T> | null => {
  const listUuid = String(params.listUuid || '')
  if (!listUuid) return null
  if (isPlaybackDeleteAllAboveBlockedLibraryType(params.libraryType)) return null
  const listData = Array.isArray(params.listData) ? params.listData : []
  const playingIndex = findPlayingSongIndexInList(
    listData,
    params.playingSong || null,
    params.caseInsensitiveFilePath
  )
  if (playingIndex <= 0) return null
  const songs = listData.slice(0, playingIndex)
  if (songs.length === 0) return null
  return { listUuid, playingIndex, songs }
}
