export const NETEASE_REMOVE_PLAYLIST_LOCAL_FILES_PREFS = ['ask', 'delete', 'keep'] as const

export type NeteaseRemovePlaylistLocalFilesPref =
  (typeof NETEASE_REMOVE_PLAYLIST_LOCAL_FILES_PREFS)[number]

export const DEFAULT_NETEASE_REMOVE_PLAYLIST_LOCAL_FILES_PREF: NeteaseRemovePlaylistLocalFilesPref =
  'ask'

export function normalizeNeteaseRemovePlaylistLocalFilesPref(
  value: unknown
): NeteaseRemovePlaylistLocalFilesPref {
  return value === 'delete' || value === 'keep' ? value : 'ask'
}

export function shouldAskNeteaseRemovePlaylistLocalFiles(input: {
  pref: unknown
  downloadedCount: number
}): boolean {
  return (
    normalizeNeteaseRemovePlaylistLocalFilesPref(input.pref) === 'ask' &&
    Number(input.downloadedCount) > 0
  )
}

export function resolveNeteaseRemovePlaylistLocalFilesDecision(input: {
  pref: unknown
  downloadedCount: number
  alsoDeleteLocal?: boolean
  remember?: boolean
}): {
  deleteLocal: boolean
  nextPref: NeteaseRemovePlaylistLocalFilesPref | null
} {
  const downloadedCount = Number(input.downloadedCount) || 0
  const pref = normalizeNeteaseRemovePlaylistLocalFilesPref(input.pref)
  if (downloadedCount <= 0) {
    return { deleteLocal: false, nextPref: null }
  }
  if (pref === 'delete') {
    return { deleteLocal: true, nextPref: null }
  }
  if (pref === 'keep') {
    return { deleteLocal: false, nextPref: null }
  }
  const deleteLocal = input.alsoDeleteLocal === true
  return {
    deleteLocal,
    nextPref: input.remember ? (deleteLocal ? 'delete' : 'keep') : null
  }
}
