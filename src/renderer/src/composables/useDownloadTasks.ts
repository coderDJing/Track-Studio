import { computed, reactive, ref, watch } from 'vue'
import {
  EMPTY_APP_UPDATE_STATE,
  normalizeAppUpdateState,
  type AppUpdateState
} from '@shared/appUpdate'
import {
  OPTIONAL_COMPONENT_LABEL_KEYS,
  type OptionalComponentDownloadState,
  type OptionalComponentId
} from '@shared/optionalComponentDownloads'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'
import {
  downloadOptionalComponent,
  useOptionalComponentDownloads
} from './useOptionalComponentDownloads'

/**
 * 统一的下载任务视图：组件、分析运行时、超高质量模型、应用更新四类来源
 * 全部收敛成同一张卡片的一行。卡片只消费这里导出的数据，不再各自维护进度 UI。
 */
export type DownloadTaskKind = 'update' | 'runtime' | 'model' | 'component'

export type DownloadTaskStatus =
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'downloaded'
  | 'failed'

export type DownloadTaskActionId =
  'retry' | 'download-update' | 'install-update' | 'release-notes' | 'manual-download' | 'dismiss'

export type DownloadTaskAction = {
  id: DownloadTaskActionId
  label: string
  primary?: boolean
  disabled?: boolean
}

export type DownloadTaskView = {
  id: string
  kind: DownloadTaskKind
  label: string
  status: DownloadTaskStatus
  statusText: string
  percent: number | null
  detail: string
  error: string
  actions: DownloadTaskAction[]
}

export type ModelDownloadState = {
  status: 'idle' | 'downloading' | 'extracting' | 'ready' | 'failed'
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  error: string
  startedInSession: boolean
}

const COLLAPSED_STORAGE_KEY = 'frkb.downloadTasksCollapsed'

const appUpdate = reactive<AppUpdateState>({ ...EMPTY_APP_UPDATE_STATE })
const modelDownload = reactive<ModelDownloadState>({
  status: 'idle',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  error: '',
  startedInSession: false
})

/** 本次运行内被“稍后”掉的任务：不落盘，重启后重新提示。 */
const dismissedIds = reactive(new Set<string>())
const retryingIds = reactive(new Set<string>())

const readCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(readCollapsed())

const clampPercent = (value: unknown) =>
  Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 10) / 10))

const normalizeModelStatus = (value: unknown): ModelDownloadState['status'] => {
  return value === 'downloading' ||
    value === 'extracting' ||
    value === 'ready' ||
    value === 'failed'
    ? value
    : 'idle'
}

const applyAppUpdateState = (payload: unknown) => {
  const next = normalizeAppUpdateState(payload)
  // 用户主动触发的检查要重新展示，即使上一次点了“稍后”。
  if (next.status === 'checking' && !next.silent) dismissedIds.delete('update')
  Object.assign(appUpdate, next)
}

const applyModelDownloadState = (payload: unknown) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  const record = payload as Record<string, unknown>
  const status = normalizeModelStatus(record.status)
  modelDownload.status = status
  modelDownload.percent = clampPercent(record.percent)
  modelDownload.downloadedBytes = Math.max(0, Number(record.downloadedBytes) || 0)
  modelDownload.totalBytes = Math.max(0, Number(record.totalBytes) || 0)
  modelDownload.archiveSize = Math.max(0, Number(record.archiveSize) || 0)
  modelDownload.error = typeof record.error === 'string' ? record.error.slice(0, 300) : ''
  if (status === 'downloading' || status === 'extracting') {
    modelDownload.startedInSession = true
    dismissedIds.delete('model')
  }
  if (status === 'ready') {
    modelDownload.startedInSession = false
  }
}

const invoke = (channel: string, ...args: unknown[]) =>
  window.electron.ipcRenderer.invoke(channel, ...args)

const bindCardEvents = () => {
  if (typeof window === 'undefined' || !window.electron?.ipcRenderer) return
  window.electron.ipcRenderer.on('app-update:state', (_event: unknown, payload: unknown) => {
    applyAppUpdateState(payload)
  })
  window.electron.ipcRenderer.on(
    'demucs-model-download-state',
    (_event: unknown, payload: unknown) => {
      applyModelDownloadState(payload)
    }
  )
}
bindCardEvents()

let appUpdateSynced = false
const syncAppUpdateState = async () => {
  if (appUpdateSynced) return
  appUpdateSynced = true
  try {
    applyAppUpdateState(await invoke('app-update:get-state'))
  } catch {
    // 未注册该通道（例如 macOS 仍走更新窗口）时静默跳过。
  }
}

const startUpdateDownload = async () => {
  if (retryingIds.has('update')) return
  retryingIds.add('update')
  try {
    applyAppUpdateState(await invoke('app-update:download'))
  } catch {
    // 失败原因由主进程状态机推送，这里不再重复提示。
  } finally {
    retryingIds.delete('update')
  }
}

const installUpdate = async () => {
  try {
    await invoke('app-update:install')
  } catch {
    // 同上。
  }
}

const startModelDownload = async () => {
  if (retryingIds.has('model')) return
  retryingIds.add('model')
  try {
    await invoke('demucs-model:download-ultra')
  } catch (error) {
    modelDownload.status = 'failed'
    modelDownload.error = error instanceof Error ? error.message : String(error || '')
    modelDownload.startedInSession = true
  } finally {
    retryingIds.delete('model')
  }
}

const retryComponent = async (id: OptionalComponentId) => {
  if (retryingIds.has(id)) return
  retryingIds.add(id)
  try {
    await downloadOptionalComponent(id)
  } finally {
    retryingIds.delete(id)
  }
}

const openReleaseNotes = async () => {
  const { default: openReleaseNotesDialog } =
    await import('@renderer/components/releaseNotesDialog')
  await openReleaseNotesDialog({
    version: appUpdate.version,
    releaseDate: appUpdate.releaseDate,
    channel: appUpdate.channel,
    releaseNotes: appUpdate.releaseNotes,
    loading: appUpdate.releaseNotesLoading
  })
}

const dismissTask = (taskId: string) => {
  dismissedIds.add(taskId)
}

const componentTaskId = (id: OptionalComponentId) => `component:${id}`

const formatBytesPair = (downloaded: number, total: number) => {
  if (total <= 0) return ''
  return `${formatAnalysisRuntimeBytes(downloaded)} / ${formatAnalysisRuntimeBytes(total)}`
}

const formatReleaseDate = (value: string): string => {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return ''
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const buildUpdateTask = (
  appUpdate: AppUpdateState,
  dismissed: ReadonlySet<string>
): DownloadTaskView[] => {
  const status = appUpdate.status
  if (status === 'idle') return []
  // 启动静默检查的中间态与“已是最新”不打扰用户。
  if (appUpdate.silent && (status === 'checking' || status === 'latest')) return []
  if (dismissed.has('update')) return []

  const base = {
    id: 'update',
    kind: 'update' as const,
    label: t('downloadTasks.appUpdate')
  }

  if (status === 'checking') {
    return [
      {
        ...base,
        status: 'checking',
        statusText: t('downloadTasks.updateChecking'),
        percent: null,
        detail: '',
        error: '',
        actions: []
      }
    ]
  }

  if (status === 'latest') {
    return [
      {
        ...base,
        status: 'latest',
        statusText: t('downloadTasks.updateLatest', { version: appUpdate.version }),
        percent: null,
        detail: '',
        error: '',
        actions: [{ id: 'dismiss', label: t('downloadTasks.dismiss') }]
      }
    ]
  }

  if (status === 'available') {
    return [
      {
        ...base,
        status: 'available',
        statusText: t('downloadTasks.updateAvailable', { version: appUpdate.version }),
        percent: null,
        detail: formatReleaseDate(appUpdate.releaseDate),
        error: '',
        actions: [
          { id: 'download-update', label: t('downloadTasks.download'), primary: true },
          {
            id: 'release-notes',
            label: t('downloadTasks.viewReleaseNotes'),
            disabled: appUpdate.releaseNotesLoading
          },
          { id: 'dismiss', label: t('downloadTasks.later') }
        ]
      }
    ]
  }

  if (status === 'downloading') {
    return [
      {
        ...base,
        status: 'downloading',
        statusText: t('downloadTasks.updateDownloading', {
          percent: Math.round(appUpdate.percent)
        }),
        percent: appUpdate.percent,
        detail: formatBytesPair(appUpdate.transferredBytes, appUpdate.totalBytes),
        error: '',
        actions: []
      }
    ]
  }

  if (status === 'downloaded') {
    return [
      {
        ...base,
        status: 'downloaded',
        statusText: t('downloadTasks.updateDownloaded'),
        percent: 100,
        detail: appUpdate.version ? `v${appUpdate.version}` : '',
        error: '',
        actions: [
          { id: 'install-update', label: t('downloadTasks.installNow'), primary: true },
          {
            id: 'release-notes',
            label: t('downloadTasks.viewReleaseNotes'),
            disabled: appUpdate.releaseNotesLoading
          },
          { id: 'dismiss', label: t('downloadTasks.later') }
        ]
      }
    ]
  }

  return [
    {
      ...base,
      status: 'failed',
      statusText:
        appUpdate.errorKind === 'network'
          ? t('downloadTasks.updateNetworkFailed')
          : t('downloadTasks.updateFailed'),
      percent: null,
      detail: '',
      error: appUpdate.error,
      actions: [
        { id: 'retry', label: t('downloadTasks.retry'), primary: true },
        { id: 'manual-download', label: t('downloadTasks.manualDownload') },
        { id: 'dismiss', label: t('downloadTasks.later') }
      ]
    }
  ]
}

export type RuntimeDownloadStateLike = {
  status: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
}

const buildRuntimeTask = (state: RuntimeDownloadStateLike): DownloadTaskView[] => {
  if (state.status === 'downloading') {
    const total = Math.max(state.totalBytes, state.archiveSize)
    return [
      {
        id: 'runtime',
        kind: 'runtime',
        label: t('downloadTasks.analysisRuntime'),
        status: 'downloading',
        statusText: t('downloadTasks.statusDownloading', { percent: Math.round(state.percent) }),
        percent: clampPercent(state.percent),
        detail: formatBytesPair(state.downloadedBytes, total),
        error: '',
        actions: []
      }
    ]
  }
  if (state.status === 'extracting') {
    return [
      {
        id: 'runtime',
        kind: 'runtime',
        label: t('downloadTasks.analysisRuntime'),
        status: 'installing',
        statusText: t('downloadTasks.statusExtracting'),
        percent: null,
        detail: state.title,
        error: '',
        actions: []
      }
    ]
  }
  return []
}

const buildModelTask = (
  modelDownload: ModelDownloadState,
  dismissed: ReadonlySet<string>
): DownloadTaskView[] => {
  const status = modelDownload.status
  const visible =
    status === 'downloading' ||
    status === 'extracting' ||
    (status === 'failed' && modelDownload.startedInSession)
  if (!visible || dismissed.has('model')) return []

  const label = t('downloadTasks.ultraModel')
  if (status === 'failed') {
    return [
      {
        id: 'model',
        kind: 'model',
        label,
        status: 'failed',
        statusText: t('downloadTasks.statusFailed'),
        percent: null,
        detail: '',
        error: modelDownload.error,
        actions: [
          { id: 'retry', label: t('downloadTasks.retry'), primary: true },
          { id: 'dismiss', label: t('downloadTasks.later') }
        ]
      }
    ]
  }
  const total = Math.max(modelDownload.totalBytes, modelDownload.archiveSize)
  return [
    {
      id: 'model',
      kind: 'model',
      label,
      status: status === 'extracting' ? 'installing' : 'downloading',
      statusText:
        status === 'extracting'
          ? t('downloadTasks.statusExtracting')
          : t('downloadTasks.statusDownloading', { percent: Math.round(modelDownload.percent) }),
      percent: status === 'extracting' ? null : clampPercent(modelDownload.percent),
      detail: status === 'extracting' ? '' : formatBytesPair(modelDownload.downloadedBytes, total),
      error: '',
      actions: []
    }
  ]
}

const buildComponentTasks = (components: OptionalComponentDownloadState[]): DownloadTaskView[] =>
  components.map((state) => {
    const id = componentTaskId(state.id)
    const label = t(OPTIONAL_COMPONENT_LABEL_KEYS[state.id])
    const percent = clampPercent(state.percent)
    const status: DownloadTaskStatus =
      state.status === 'installing'
        ? 'installing'
        : state.status === 'ready'
          ? 'ready'
          : state.status === 'failed'
            ? 'failed'
            : 'downloading'
    const statusText =
      state.status === 'downloading'
        ? t('downloadTasks.statusDownloading', { percent: Math.round(percent) })
        : state.status === 'installing'
          ? t('downloadTasks.statusInstalling')
          : state.status === 'ready'
            ? t('downloadTasks.statusReady')
            : t('downloadTasks.statusFailed')
    return {
      id,
      kind: 'component' as const,
      label,
      status,
      statusText,
      percent: state.status === 'downloading' ? percent : state.status === 'ready' ? 100 : null,
      detail:
        state.status === 'downloading'
          ? formatBytesPair(state.downloadedBytes, state.totalBytes)
          : '',
      error: state.status === 'failed' ? state.error : '',
      actions:
        state.status === 'failed'
          ? [{ id: 'retry' as const, label: t('downloadTasks.retry'), primary: true }]
          : []
    }
  })

/** 纯函数版聚合器：输入四类下载源，输出卡片行；便于单测直接覆盖。 */
export const composeDownloadTasks = (params: {
  appUpdate: AppUpdateState
  runtimeState: RuntimeDownloadStateLike
  model: ModelDownloadState
  components: OptionalComponentDownloadState[]
  dismissed: ReadonlySet<string>
}): DownloadTaskView[] => [
  ...buildUpdateTask(params.appUpdate, params.dismissed),
  ...buildRuntimeTask(params.runtimeState),
  ...buildModelTask(params.model, params.dismissed),
  ...buildComponentTasks(params.components)
]

export function useDownloadTasks() {
  const runtime = useRuntimeStore()
  const componentDownloads = useOptionalComponentDownloads()

  if (runtime.setting.platform === 'win32') {
    void syncAppUpdateState()
  }

  const tasks = computed<DownloadTaskView[]>(() =>
    composeDownloadTasks({
      appUpdate,
      runtimeState: runtime.analysisRuntime.state,
      model: modelDownload,
      components: componentDownloads.entries.value,
      dismissed: dismissedIds
    })
  )

  // 新任务出现时自动展开一次；用户主动最小化后，后续同类进度不再强行弹开。
  const seenTaskIds = new Set<string>()
  let seenInitialized = false
  watch(
    () => tasks.value.map((task) => task.id),
    (ids) => {
      if (!seenInitialized) {
        ids.forEach((id) => seenTaskIds.add(id))
        seenInitialized = true
        return
      }
      const hasNewTask = ids.some((id) => !seenTaskIds.has(id))
      ids.forEach((id) => seenTaskIds.add(id))
      if (hasNewTask && collapsed.value) expand()
    }
  )

  const activeCount = computed(
    () => tasks.value.filter((task) => task.status !== 'ready' && task.status !== 'latest').length
  )
  const hasTasks = computed(() => tasks.value.length > 0)

  const minimize = () => {
    collapsed.value = true
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, '1')
    } catch {
      // 隐私模式下写不进去也不影响收起。
    }
  }

  const expand = () => {
    collapsed.value = false
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, '0')
    } catch {
      // 同上。
    }
  }

  const runAction = async (task: DownloadTaskView, actionId: DownloadTaskActionId) => {
    switch (actionId) {
      case 'retry':
        if (task.kind === 'component') {
          await retryComponent(task.id.slice('component:'.length) as OptionalComponentId)
        } else if (task.kind === 'model') {
          await startModelDownload()
        } else if (task.kind === 'update') {
          await startUpdateDownload()
        }
        return
      case 'download-update':
        await startUpdateDownload()
        return
      case 'install-update':
        await installUpdate()
        return
      case 'release-notes':
        await openReleaseNotes()
        return
      case 'manual-download':
        await invoke('app-update:open-manual-download').catch(() => {})
        return
      case 'dismiss':
        dismissTask(task.id)
        return
    }
  }

  return {
    tasks,
    hasTasks,
    activeCount,
    collapsed,
    minimize,
    expand,
    isRetrying: (taskId: string) => retryingIds.has(taskId),
    runAction
  }
}

/** 仅测试使用：清空模块级卡片状态。 */
export const resetDownloadTasksForTests = () => {
  Object.assign(appUpdate, EMPTY_APP_UPDATE_STATE)
  Object.assign(modelDownload, {
    status: 'idle',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    archiveSize: 0,
    error: '',
    startedInSession: false
  })
  dismissedIds.clear()
  retryingIds.clear()
  appUpdateSynced = false
  collapsed.value = false
}
