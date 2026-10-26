import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import type { Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'

interface UseSongRowEventsOptions {
  songs: Ref<ISongInfo[] | undefined>
  emitSongClick: (e: MouseEvent, song: ISongInfo) => void
  emitSongContextmenu: (e: MouseEvent, song: ISongInfo) => void
  emitSongDblclick: (song: ISongInfo, event: MouseEvent) => void
  shouldSuppressPointerAction?: (event: MouseEvent) => boolean
}

export function useSongRowEvents({
  songs,
  emitSongClick,
  emitSongContextmenu,
  emitSongDblclick,
  shouldSuppressPointerAction
}: UseSongRowEventsOptions) {
  const resolveSongs = () => songs.value ?? []

  const getSongFromTarget = (target: EventTarget | null) => {
    const row = (target as HTMLElement | null)?.closest('.song-row-item') as HTMLElement | null
    if (!row) return null
    const rowKey = row.dataset.rowkey || row.dataset.filepath
    if (!rowKey) return null
    return (
      resolveSongs().find(
        (s) =>
          s.mixtapeItemId === rowKey ||
          s.setItemId === rowKey ||
          sameRendererFilePath(s.filePath, rowKey)
      ) || null
    )
  }

  const onRowsClick = (e: MouseEvent) => {
    const song = getSongFromTarget(e.target)
    if (song) {
      e.stopPropagation()
      if (!shouldSuppressPointerAction?.(e)) emitSongClick(e, song)
    }
  }

  const onRowsContextmenu = (e: MouseEvent) => {
    e.stopPropagation()
    const song = getSongFromTarget(e.target)
    if (song) emitSongContextmenu(e, song)
  }

  const onRowsDblclick = (e: MouseEvent) => {
    e.stopPropagation()
    if (shouldSuppressPointerAction?.(e)) return
    const song = getSongFromTarget(e.target)
    if (song) emitSongDblclick(song, e)
  }

  return {
    onRowsClick,
    onRowsContextmenu,
    onRowsDblclick
  }
}
