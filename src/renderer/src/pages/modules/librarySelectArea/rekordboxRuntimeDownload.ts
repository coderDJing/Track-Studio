import { ref, watch } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import {
  downloadOptionalComponent,
  getOptionalComponentReadyToken,
  reportOptionalComponentFailure,
  sanitizeOptionalComponentErrorMessage
} from '@renderer/composables/useOptionalComponentDownloads'
import { t } from '@renderer/utils/translate'

const RKB_COMPONENT_ID = 'rekordbox-desktop-runtime'

const buildFailureContent = (error: unknown): string[] => {
  const content = [t('optionalComponents.downloadFailedContent')]
  const reason = sanitizeOptionalComponentErrorMessage(error)
  if (reason) content.push(reason)
  return content
}

const REPAIR_ERROR_CODES: readonly string[] = ['PYTHON_RUNTIME_MISSING', 'PYREKORDBOX_UNAVAILABLE']

/** 只有组件缺失/损坏类错误才出现修复入口；平台不支持等保持原行为。 */
export const isRepairableRekordboxRuntimeError = (code: unknown): boolean =>
  typeof code === 'string' && REPAIR_ERROR_CODES.includes(code)

/**
 * Rekordbox 运行时的按需下载流程：只在用户确认后下载，成功后强刷 probe。
 * 失败保留入口供再次重试，不展示任何主进程实现细节。
 */
export const useRekordboxRuntimeDownload = (refresh: () => Promise<void>) => {
  const downloading = ref(false)
  // 初始 ready 快照不触发刷新；同一 updatedAt 的重复同步也不会重复刷新。
  let handledReadyToken = getOptionalComponentReadyToken(RKB_COMPONENT_ID)

  // watch 创建在组件 scope 内，卸载或测试 scope.stop 时自动注销；ready 4s 消失不会重放。
  watch(
    () => getOptionalComponentReadyToken(RKB_COMPONENT_ID),
    (token) => {
      if (!token || token === handledReadyToken) return
      handledReadyToken = token
      // 首次下载路径自身会 refresh，避免与这里重复强刷。
      if (downloading.value) return
      void refresh()
    }
  )

  const download = async (): Promise<boolean> => {
    if (downloading.value) return false
    const confirmed = await confirm({
      title: t('optionalComponents.rekordboxDownloadTitle'),
      content: [t('optionalComponents.rekordboxDownloadContent')],
      confirmText: t('optionalComponents.downloadNow'),
      cancelText: t('common.cancel')
    })
    if (confirmed !== 'confirm') return false

    downloading.value = true
    try {
      const result = await downloadOptionalComponent(RKB_COMPONENT_ID)
      if (!result.ok) {
        reportOptionalComponentFailure(RKB_COMPONENT_ID, result.error)
        await confirm({
          title: t('optionalComponents.downloadFailedTitle'),
          content: buildFailureContent(result.error),
          confirmShow: false
        })
        return false
      }
      const readyToken = getOptionalComponentReadyToken(RKB_COMPONENT_ID)
      if (readyToken) handledReadyToken = readyToken
      await refresh()
      return true
    } catch (error) {
      reportOptionalComponentFailure(RKB_COMPONENT_ID, error)
      await confirm({
        title: t('common.error'),
        content: buildFailureContent(error),
        confirmShow: false
      })
      return false
    } finally {
      downloading.value = false
    }
  }

  return { downloading, download }
}
