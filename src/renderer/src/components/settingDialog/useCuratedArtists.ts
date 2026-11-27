import { computed } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import curatedArtistLibraryDialog from '@renderer/components/curatedArtistLibraryDialog'
import { t } from '@renderer/utils/translate'
import type { SettingDialogRuntimeStore } from './context'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '')

export const useCuratedArtists = (runtime: SettingDialogRuntimeStore) => {
  const count = computed(() => runtime.curatedArtistFavorites.length)

  const clear = async () => {
    if (count.value <= 0) {
      await confirm({
        title: t('common.setting'),
        content: [t('settings.curatedArtistTracking.emptyHint')],
        confirmShow: false
      })
      return
    }

    const result = await confirm({
      title: t('common.warning'),
      content: [
        t('settings.curatedArtistTracking.clearConfirmLine1'),
        t('settings.curatedArtistTracking.clearConfirmLine2')
      ]
    })
    if (result !== 'confirm') return

    try {
      const response = await window.electron.ipcRenderer.invoke('curatedArtists:clear')
      runtime.curatedArtistFavorites = Array.isArray(response?.items) ? response.items : []
      await confirm({
        title: t('common.success'),
        content: [t('settings.curatedArtistTracking.clearSuccess')],
        confirmShow: false
      })
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [t('settings.curatedArtistTracking.clearFailed'), getErrorMessage(error)],
        confirmShow: false
      })
    }
  }

  const openManager = async () => {
    const result = await curatedArtistLibraryDialog(
      runtime.curatedArtistFavorites.map((item) => ({ ...item }))
    )
    if (result === 'cancel') return

    try {
      const snapshot = await window.electron.ipcRenderer.invoke('curatedArtists:setAll', result)
      runtime.curatedArtistFavorites = Array.isArray(snapshot?.items) ? snapshot.items : []
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [t('settings.curatedArtistTracking.managerSaveFailed'), getErrorMessage(error)],
        confirmShow: false
      })
    }
  }

  return {
    curatedArtistFavoritesCount: count,
    clearCuratedArtistFavorites: clear,
    openCuratedArtistFavoritesDialog: openManager
  }
}
