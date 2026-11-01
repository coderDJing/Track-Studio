import confirm from '@renderer/components/confirmDialog'
import { loadRekordboxPlaylistTracks } from '@renderer/composables/rekordboxDesktop/useRekordboxTrackLoader'
import { copyPioneerTracksToMixtape } from '@renderer/utils/mixtapePlaylistAppend'
import { t } from '@renderer/utils/translate'
import { getPlaylistNodeDisplayName } from '@renderer/composables/rekordboxDesktop/playlistNodeDisplayName'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'

type RunWithCopyBusy = <T>(task: () => Promise<T>) => Promise<T>

export const copyPioneerPlaylistToMixtape = async ({
  node,
  sourceKind,
  sourceRootPath,
  sourceLibraryType,
  sourceName,
  runWithCopyBusy,
  isBusy
}: {
  node: IPioneerPlaylistTreeNode
  sourceKind: RekordboxSourceKind
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
  sourceName: string
  runWithCopyBusy: RunWithCopyBusy
  isBusy: () => boolean
}) => {
  if (isBusy() || node.isFolder || node.isSmartPlaylist) return
  const playlistId = Number(node.id) || 0
  if (playlistId <= 0) return

  await runWithCopyBusy(async () => {
    try {
      const loadResult = await loadRekordboxPlaylistTracks({
        sourceKind,
        playlistId,
        sourceRootPath,
        sourceLibraryType
      })
      const tracks = Array.isArray(loadResult?.tracks) ? loadResult.tracks : []
      await copyPioneerTracksToMixtape({
        tracks,
        originPathSnapshot: `${sourceName || 'Pioneer'} / ${getPlaylistNodeDisplayName(node) || 'Playlist'}`
      })
    } catch (error: unknown) {
      const messageCode = error instanceof Error ? error.message : String(error || '')
      await confirm({
        title: t('common.error'),
        content: [
          messageCode === 'MIXTAPE_VAULT_UNAVAILABLE'
            ? t('pioneer.mixtapeVaultUnavailable')
            : messageCode === 'MIXTAPE_COPY_TO_VAULT_FAILED'
              ? t('pioneer.copyToMixtapeFailed')
              : messageCode || t('common.unknownError')
        ],
        confirmShow: false
      })
    }
  })
}
