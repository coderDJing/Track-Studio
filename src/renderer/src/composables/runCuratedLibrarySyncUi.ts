import confirm from '@renderer/components/confirmDialog'
import curatedLibrarySyncJoinDialog from '@renderer/components/curatedLibrarySyncJoinDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import type {
  CuratedLibrarySyncStartPayload,
  CuratedLibrarySyncStartResult
} from '../../../shared/curatedLibrarySync'

const persistCuratedLibrarySyncEnabled = async (enabled: boolean) => {
  const runtime = useRuntimeStore()
  runtime.setting.curatedLibrarySyncEnabled = enabled
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const disableCuratedLibrarySyncAfterJoinCancel = async () => {
  await persistCuratedLibrarySyncEnabled(false)
}

const startCuratedLibrarySyncIpc = async (payload?: CuratedLibrarySyncStartPayload) =>
  (await window.electron.ipcRenderer.invoke(
    'curatedLibrarySync/start',
    payload
  )) as CuratedLibrarySyncStartResult

const promptJoinChoice = async (result: { localFileCount: number; cloudFileCount: number }) =>
  curatedLibrarySyncJoinDialog({
    title: t('cloudSync.curatedLibrary.joinTitle'),
    intro: t('cloudSync.curatedLibrary.joinIntro'),
    localCountLabel: t('cloudSync.curatedLibrary.joinSideLocal'),
    cloudCountLabel: t('cloudSync.curatedLibrary.joinSideCloud'),
    localCount: result.localFileCount,
    cloudCount: result.cloudFileCount,
    countUnit: t('cloudSync.curatedLibrary.joinCountUnit'),
    mergeLabel: t('cloudSync.curatedLibrary.joinMerge'),
    mergeHint: t('cloudSync.curatedLibrary.joinMergeHint'),
    mergeBadge: t('cloudSync.curatedLibrary.joinRecommended'),
    cloudWinsLabel: t('cloudSync.curatedLibrary.joinCloud'),
    cloudWinsHint: t('cloudSync.curatedLibrary.joinCloudHint'),
    localWinsLabel: t('cloudSync.curatedLibrary.joinLocal'),
    localWinsHint: t('cloudSync.curatedLibrary.joinLocalHint'),
    cancelLabel: t('common.cancel')
  })

const showTerminalError = async (result: CuratedLibrarySyncStartResult) => {
  if (
    result.status === 'success' ||
    result.status === 'already_running' ||
    result.status === 'cancelled' ||
    result.status === 'needs_join_choice' ||
    result.status === 'needs_overwrite_cloud_confirm'
  ) {
    return
  }
  const messageKey =
    result.status === 'failed'
      ? result.message
      : result.status === 'not_enabled'
        ? 'cloudSync.curatedLibrary.errors.notEnabled'
        : result.status === 'not_configured'
          ? 'cloudSync.notConfigured'
          : result.status === 'busy_library'
            ? 'cloudSync.curatedLibrary.errors.busyLibrary'
            : result.status === 'disk_full'
              ? 'cloudSync.curatedLibrary.errors.diskFull'
              : result.status === 'paused_offline'
                ? 'cloudSync.errors.cannotConnect'
                : 'cloudSync.curatedLibrary.errors.failed'
  await confirm({
    title: t('common.error'),
    content: [t(messageKey)],
    confirmShow: false
  })
}

type ContinueOptions = {
  quietTerminal?: boolean
  allowWhenDisabled?: boolean
}

export const continueCuratedLibrarySyncUi = async (
  result: CuratedLibrarySyncStartResult,
  options?: ContinueOptions
): Promise<void> => {
  // 「第一次对齐」「覆盖云端」的二次确认会带参数重跑，用循环接续而不是再走一次入口，
  // 避免重复触发入口的重入保护。
  let current = result
  for (;;) {
    if (current.status === 'needs_join_choice') {
      const choice = await promptJoinChoice(current)
      if (choice === 'cancel') {
        await disableCuratedLibrarySyncAfterJoinCancel()
        return
      }
      current = await startCuratedLibrarySyncIpc({
        trigger: 'manual',
        joinMode: choice,
        confirmOverwriteCloud: choice === 'local-wins',
        allowWhenDisabled: options?.allowWhenDisabled
      })
      continue
    }
    if (current.status === 'needs_overwrite_cloud_confirm') {
      const confirmed = await confirm({
        title: t('cloudSync.curatedLibrary.overwriteTitle'),
        content: [
          t('cloudSync.curatedLibrary.overwriteWarning', {
            local: current.localFileCount,
            cloud: current.cloudFileCount
          }),
          t('cloudSync.curatedLibrary.overwriteConfirmHint')
        ],
        confirmText: t('cloudSync.curatedLibrary.overwriteConfirm'),
        cancelText: t('common.cancel'),
        innerHeight: 260
      })
      if (confirmed !== 'confirm') {
        await disableCuratedLibrarySyncAfterJoinCancel()
        return
      }
      current = await startCuratedLibrarySyncIpc({
        trigger: 'manual',
        joinMode: 'local-wins',
        confirmOverwriteCloud: true,
        allowWhenDisabled: options?.allowWhenDisabled
      })
      continue
    }
    break
  }
  if (options?.quietTerminal) return
  await showTerminalError(current)
}

let flowRunning = false

export const runCuratedLibrarySyncUi = async (
  extra?: CuratedLibrarySyncStartPayload
): Promise<void> => {
  // 连点菜单时只保留一条链路：后来的调用直接忽略，避免连弹多个提示框。
  if (flowRunning) return
  flowRunning = true
  try {
    const result = await startCuratedLibrarySyncIpc({
      trigger: 'manual',
      ...extra
    })
    await continueCuratedLibrarySyncUi(result, {
      allowWhenDisabled: extra?.allowWhenDisabled
    })
  } finally {
    flowRunning = false
  }
}
