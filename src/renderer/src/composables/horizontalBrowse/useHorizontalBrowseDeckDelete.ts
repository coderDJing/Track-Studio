import type { ISongInfo } from 'src/types/globals'
import confirm from '@renderer/components/confirmDialog'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { isEditablePioneerUsbSong, deletePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'
import { usePioneerUsbPlaybackDeletion } from '@renderer/composables/rekordboxDesktop/usePioneerUsbPlaybackDeletion'
import libraryUtils from '@renderer/utils/libraryUtils'
import { t } from '@renderer/utils/translate'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import {
  delSongsViaSend,
  permanentlyDelSongsViaSend,
  type DeleteSummary
} from '@renderer/utils/recycleBinActions'

type UseHorizontalBrowseDeckDeleteParams = {
  runtime: ReturnType<typeof useRuntimeStore>
  getDeckSong: (deck: HorizontalBrowseDeckKey) => ISongInfo | null
  ejectDeckSong: (deck: HorizontalBrowseDeckKey) => Promise<unknown>
}

const normalizePath = (value: string | null | undefined) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

export const useHorizontalBrowseDeckDelete = (params: UseHorizontalBrowseDeckDeleteParams) => {
  const deletingDecks = new Set<HorizontalBrowseDeckKey>()
  usePioneerUsbPlaybackDeletion({
    runtime: params.runtime,
    onDeckDeleted: async (deck, song) => {
      if (!deletingDecks.has(deck) && params.getDeckSong(deck)?.filePath === song.filePath)
        await params.ejectDeckSong(deck)
    }
  })

  const showDeleteSummaryIfNeeded = async (summary: DeleteSummary) => {
    const total = Number(summary.total || 0)
    const success = Number(summary.success || 0)
    const failed = Number(summary.failed || 0)
    if (total <= 1 && failed === 0) return

    const content: string[] = [t('recycleBin.deleteSummarySuccess', { count: success })]
    if (failed > 0) {
      content.push(t('recycleBin.deleteSummaryFailed', { count: failed }))
    }

    await confirm({
      title: t('recycleBin.deleteSummaryTitle'),
      content,
      confirmShow: false
    })
  }

  const deleteDeckSong = async (deck: HorizontalBrowseDeckKey) => {
    const song = params.getDeckSong(deck)
    const filePath = String(song?.filePath || '').trim()
    if (!filePath || deletingDecks.has(deck)) return
    if (song && isEditablePioneerUsbSong(song)) {
      deletingDecks.add(deck)
      try {
        if (await deletePioneerUsbSong(song)) {
          if (params.getDeckSong(deck)?.filePath === filePath) await params.ejectDeckSong(deck)
        }
      } finally {
        deletingDecks.delete(deck)
      }
      return
    }

    if (isRekordboxExternalPlaybackSource('', song)) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('tracks.readOnlySourceDeleteNotAllowed')],
        confirmShow: false
      })
      return
    }

    deletingDecks.add(deck)
    try {
      const currentSongsAreaListUuid = params.runtime.songsArea.songListUUID
      const currentSongsAreaContainsSong = params.runtime.songsArea.songInfoArr.some(
        (item) => normalizePath(item.filePath) === normalizePath(filePath)
      )
      const sourceResolution = (await window.electron.ipcRenderer.invoke(
        'songList:resolve-by-file-path',
        filePath
      )) as { songListUuid?: string } | null
      const resolvedSongListUuid = String(sourceResolution?.songListUuid || '')
      const effectiveListUuid =
        resolvedSongListUuid || (currentSongsAreaContainsSong ? currentSongsAreaListUuid : '')

      const isInRecycleBin = effectiveListUuid === RECYCLE_BIN_UUID
      let permanently = false

      if (isInRecycleBin) {
        const result = await confirm({
          title: t('common.delete'),
          content: [t('tracks.confirmDelete'), t('tracks.deleteHint')]
        })
        if (result !== 'confirm') return
        permanently = true
      }

      const summary = permanently
        ? await permanentlyDelSongsViaSend([filePath])
        : await delSongsViaSend(
            effectiveListUuid === EXTERNAL_PLAYLIST_UUID
              ? { filePaths: [filePath], sourceType: 'external' }
              : (() => {
                  const songListPath = effectiveListUuid
                    ? libraryUtils.findDirPathByUuid(effectiveListUuid)
                    : ''
                  return songListPath ? { filePaths: [filePath], songListPath } : [filePath]
                })()
          )

      const removedPaths =
        summary.removedPaths && summary.removedPaths.length > 0
          ? summary.removedPaths
          : summary.success && summary.success > 0
            ? [filePath]
            : []
      const didDelete =
        removedPaths.some((item) => normalizePath(item) === normalizePath(filePath)) ||
        Number(summary.success || 0) > 0

      if (!didDelete) {
        await showDeleteSummaryIfNeeded(summary)
        return
      }

      const eventListUuid =
        effectiveListUuid || (currentSongsAreaContainsSong ? currentSongsAreaListUuid : '')
      if (eventListUuid && removedPaths.length > 0) {
        emitter.emit('songsRemoved', {
          listUUID: eventListUuid,
          paths: removedPaths
        })
      }
      if (eventListUuid) {
        emitter.emit('playlistContentChanged', { uuids: [eventListUuid] })
      }

      await params.ejectDeckSong(deck)
      await showDeleteSummaryIfNeeded(summary)
    } catch (error) {
      console.error('[horizontal-browse] delete deck song failed', error)
    } finally {
      deletingDecks.delete(deck)
    }
  }

  return {
    deleteDeckSong
  }
}
