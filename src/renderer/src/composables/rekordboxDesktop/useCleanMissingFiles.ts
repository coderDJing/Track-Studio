import type { Ref, ComputedRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import { clearRekordboxSourceCachesByKind } from '@renderer/utils/rekordboxLibraryCache'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { RekordboxDesktopRemovePlaylistTracksResponse } from '@shared/rekordboxDesktopPlaylist'
import type { IPioneerPlaylistTrack, IPioneerPlaylistTreeNode } from '../../../../types/globals'
import { t } from '@renderer/utils/translate'

export const useCleanMissingFiles = (params: {
  isDesktopSource: ComputedRef<boolean>
  dialogWriting: Ref<boolean>
  runWithDialogWriting: <T>(task: () => Promise<T>) => Promise<T>
  refreshTree: (preferredPlaylistId?: number) => Promise<void>
  showFailureDialog: (message: string, logPath?: string) => Promise<void>
}) => {
  const cleanMissingFilesFromPlaylist = async (node: IPioneerPlaylistTreeNode) => {
    if (!params.isDesktopSource.value || params.dialogWriting.value) return
    const playlistId = Number(node.id) || 0
    if (playlistId <= 0) return

    await params.runWithDialogWriting(async () => {
      try {
        const loadResult = (await window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('desktop', 'load-playlist-tracks'),
          playlistId
        )) as { tracks?: IPioneerPlaylistTrack[] }
        const tracks = Array.isArray(loadResult?.tracks) ? loadResult.tracks : []
        const missingTracks = tracks.filter((track) => track.fileMissing)
        if (!missingTracks.length) {
          await confirm({
            title: t('pioneer.cleanMissingFilesFinished'),
            content: [t('pioneer.cleanMissingFilesNone')],
            confirmShow: false
          })
          return
        }
        const confirmResult = await confirm({
          title: t('pioneer.cleanMissingFilesConfirmTitle'),
          content: [t('pioneer.cleanMissingFilesConfirm', { count: missingTracks.length })]
        })
        if (confirmResult !== 'confirm') return
        if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return
        const rowKeys = missingTracks
          .map((track) => String(track.rowKey || '').trim())
          .filter(Boolean)
        const response = (await window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('desktop', 'remove-playlist-tracks'),
          { playlistId, rowKeys }
        )) as RekordboxDesktopRemovePlaylistTracksResponse
        if (!response.ok) {
          await params.showFailureDialog(response.summary.errorMessage, response.summary.logPath)
          return
        }
        clearRekordboxSourceCachesByKind('desktop')
        await params.refreshTree(playlistId)
        await confirm({
          title: t('pioneer.cleanMissingFilesFinished'),
          content: [t('pioneer.cleanMissingFilesRemovedCount', { count: rowKeys.length })],
          confirmShow: false
        })
      } catch (error: unknown) {
        await confirm({
          title: t('common.error'),
          content: [error instanceof Error ? error.message : String(error)],
          confirmShow: false
        })
      }
    })
  }

  return { cleanMissingFilesFromPlaylist }
}
