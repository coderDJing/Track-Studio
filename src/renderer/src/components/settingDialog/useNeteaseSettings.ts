import { computed, onMounted, ref } from 'vue'
import { t } from '@renderer/utils/translate'
import {
  normalizeNeteaseRemovePlaylistLocalFilesPref,
  type NeteaseRemovePlaylistLocalFilesPref
} from '@shared/neteaseRemovePlaylistLocalFiles'
import type { SettingDialogRuntimeStore, SettingPersist } from './context'

const NETEASE_CACHE_PRESETS: Array<{ label: string; value: number }> = [
  { label: '2 GB', value: 2 * 1024 ** 3 },
  { label: '5 GB', value: 5 * 1024 ** 3 },
  { label: '10 GB', value: 10 * 1024 ** 3 },
  { label: '20 GB', value: 20 * 1024 ** 3 }
]

const formatCacheLimitLabel = (bytes: number): string => {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

export const useNeteaseSettings = (runtime: SettingDialogRuntimeStore, persist: SettingPersist) => {
  const qualityOptions = computed(() => [
    { label: t('netease.settings.qualityLossless'), value: 'lossless' },
    { label: t('netease.settings.qualityJymaster'), value: 'jymaster' },
    { label: t('netease.settings.qualityExhigh'), value: 'exhigh' },
    { label: t('netease.settings.qualityStandard'), value: 'standard' }
  ])

  const level = computed({
    get: () => runtime.setting.neteaseLevel || 'lossless',
    set: (value: string) => {
      runtime.setting.neteaseLevel = value as 'jymaster' | 'lossless' | 'exhigh' | 'standard'
    }
  })

  const removePlaylistLocalFilesOptions = computed(() => [
    { label: t('netease.settings.removePlaylistLocalFilesAsk'), value: 'ask' },
    { label: t('netease.settings.removePlaylistLocalFilesDelete'), value: 'delete' },
    { label: t('netease.settings.removePlaylistLocalFilesKeep'), value: 'keep' }
  ])

  const removePlaylistLocalFiles = computed({
    get: () =>
      normalizeNeteaseRemovePlaylistLocalFilesPref(runtime.setting.neteaseRemovePlaylistLocalFiles),
    set: (value: string) => {
      runtime.setting.neteaseRemovePlaylistLocalFiles =
        normalizeNeteaseRemovePlaylistLocalFilesPref(value) as NeteaseRemovePlaylistLocalFilesPref
    }
  })

  const showLibraryIcon = computed({
    get: () => runtime.setting.showNeteaseLibraryIcon !== false,
    set: (value: boolean) => {
      runtime.setting.showNeteaseLibraryIcon = value
    }
  })

  const cacheOptions = computed(() => {
    const presets = NETEASE_CACHE_PRESETS.map((item) => ({ ...item }))
    const value = Number(runtime.setting.neteasePreviewCacheBytes || 0)
    if (value > 0 && !presets.some((item) => item.value === value)) {
      presets.push({
        label: t('netease.settings.cacheCustom', { size: formatCacheLimitLabel(value) }),
        value
      })
    }
    return presets
  })

  const cacheModel = computed({
    get: () => {
      const value = Number(runtime.setting.neteasePreviewCacheBytes || 0)
      return value > 0 ? value : 10 * 1024 ** 3
    },
    set: (value: number) => {
      runtime.setting.neteasePreviewCacheBytes = Number(value) || 10 * 1024 ** 3
    }
  })

  const cacheUsage = ref<{ count: number; bytes: number } | null>(null)

  const cacheUsageText = computed(() => {
    const bytes = cacheUsage.value?.bytes || 0
    return formatCacheLimitLabel(bytes)
  })

  const refreshCacheUsage = async () => {
    try {
      cacheUsage.value = (await window.electron.ipcRenderer.invoke(
        'netease:preview-cache-usage'
      )) as { count: number; bytes: number }
    } catch {
      cacheUsage.value = null
    }
  }

  const handleCacheLimitChange = async () => {
    await persist('neteaseCache')
    try {
      await window.electron.ipcRenderer.invoke('netease:enforce-preview-cache')
    } catch {}
    await refreshCacheUsage()
  }

  const clearPreviewCache = async () => {
    try {
      await window.electron.ipcRenderer.invoke('netease:clear-preview-cache')
    } catch {}
    await refreshCacheUsage()
  }

  onMounted(() => {
    void refreshCacheUsage()
  })

  return {
    neteaseQualityOptions: qualityOptions,
    neteaseLevelModel: level,
    neteaseRemovePlaylistLocalFilesOptions: removePlaylistLocalFilesOptions,
    neteaseRemovePlaylistLocalFilesModel: removePlaylistLocalFiles,
    showNeteaseLibraryIconModel: showLibraryIcon,
    neteaseCacheOptions: cacheOptions,
    neteaseCacheModel: cacheModel,
    neteaseCacheUsage: cacheUsage,
    neteaseCacheUsageText: cacheUsageText,
    handleNeteaseCacheLimitChange: handleCacheLimitChange,
    clearNeteasePreviewCache: clearPreviewCache
  }
}
