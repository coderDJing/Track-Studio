<script setup lang="ts">
import { rendererFilePathKey } from '@renderer/utils/filePathComparison'

import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import BottomInfoAreaTotalRow from './BottomInfoAreaTotalRow.vue'
import BpmFixTaskButton from '@renderer/components/BpmFixTaskButton.vue'
import { initializeBpmFix } from '@renderer/utils/bpmFixActions'
initializeBpmFix()
import {
  isAnalysisRuntimeDownloadActiveStatus,
  resolveAnalysisRuntimeDownloadPercent,
  resolveAnalysisRuntimeDownloadText,
  resolveAnalysisRuntimeDownloadTitle
} from '@renderer/utils/analysisRuntimeDownloadUi'
import { useBottomInfoVisibleAnalysisProgress } from './bottomInfoAreaVisibleAnalysis'
import { useBottomInfoTaskProgressMirror } from './useBottomInfoTaskProgressMirror'
import { toIpcCloneablePayload } from '@renderer/utils/ipcCloneablePayload'
const runtime = useRuntimeStore()

const normalizeAnalysisPath = (value: string) => rendererFilePathKey(String(value || ''))
const visibleSongsHaveAnalysisProgress = useBottomInfoVisibleAnalysisProgress()

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

type ProgressPayload = {
  id?: string
  titleKey?: string
  now?: number
  total?: number
  isInitial?: boolean
  dismiss?: boolean
  noProgress?: boolean
  cancelable?: boolean
  cancelChannel?: string
  cancelPayload?: unknown
}

type Task = {
  id: string // group id
  titleKey: string // latest phase key
  title: string
  now: number
  total: number
  noNum: boolean
  noProgress?: boolean
  startedAt: number
  lastUpdateAt: number
  cancelable?: boolean
  cancelChannel?: string
  cancelPayload?: unknown
  canceling?: boolean
  removing?: boolean
  disableProgressTransition?: boolean
}
const tasks = ref<Task[]>([])
const libraryStemTask = ref<LibraryStemTask | null>(null)
let libraryStemRestoreRunning = false
const libraryStemTaskVisible = computed(() => {
  const task = libraryStemTask.value
  return !!task?.minimized && (task.status === 'pending' || task.status === 'running')
})
const libraryStemTaskPercent = computed(() => {
  const task = libraryStemTask.value
  if (!task) return 0
  return Math.max(0, Math.min(100, Math.round(task.percent)))
})
type LibraryStemTaskStatus = 'idle' | 'pending' | 'running' | 'ready' | 'failed'
type LibraryStemTaskStage = 'separating' | 'rendering' | 'validating' | 'saving' | 'cleaning'
type LibraryStemTask = {
  filePath: string
  songTitle: string
  model: string
  status: LibraryStemTaskStatus
  percent: number
  activityConfirmedAt: number | null
  stage: LibraryStemTaskStage | null
  stageCompleted: number | null
  stageTotal: number | null
  minimized: boolean
  errorMessage: string | null
}

const libraryStemTaskText = computed(() => {
  const task = libraryStemTask.value
  if (!task || task.status === 'pending') return t('stemSeparation.pending')
  let text = ''
  if (task.stage === 'rendering' && task.stageCompleted !== null && task.stageTotal !== null) {
    text = t('stemSeparation.rendering', { done: task.stageCompleted, total: task.stageTotal })
  } else if (task.stage === 'validating') {
    text = t('stemSeparation.validating')
  } else if (task.stage === 'saving' && task.stageCompleted !== null && task.stageTotal !== null) {
    text = t('stemSeparation.saving', { done: task.stageCompleted, total: task.stageTotal })
  } else if (task.stage === 'cleaning') {
    text = t('stemSeparation.cleaning')
  } else {
    text = t('stemSeparation.running', { percent: libraryStemTaskPercent.value })
  }
  return task.status === 'running' && task.activityConfirmedAt
    ? `${text} · ${t('stemSeparation.stillProcessing')}`
    : text
})

const analysisRuntimeTaskVisible = computed(() =>
  isAnalysisRuntimeDownloadActiveStatus(runtime.analysisRuntime.state.status)
)
const analysisRuntimeTaskTitle = computed(() =>
  resolveAnalysisRuntimeDownloadTitle(t, runtime.analysisRuntime.state)
)
const analysisRuntimeTaskText = computed(() =>
  resolveAnalysisRuntimeDownloadText(t, runtime.analysisRuntime.state)
)
const analysisRuntimeTaskPercent = computed(() =>
  resolveAnalysisRuntimeDownloadPercent(runtime.analysisRuntime.state)
)
const analysisRuntimeOverlayMinimized = computed(
  () => runtime.analysisRuntime.downloadOverlayMinimized
)
// 云同步最小化后在底部展示的进度行（仅标题 + 百分比，不可恢复）
const cloudSyncTaskVisible = computed(
  () => runtime.cloudSync.minimized && runtime.cloudSync.syncing
)
const cloudSyncTaskPercent = computed(() =>
  Math.max(0, Math.min(100, Math.round(runtime.cloudSync.percent || 0)))
)
const hasAnyVisibleTask = computed(
  () =>
    analysisRuntimeTaskVisible.value ||
    cloudSyncTaskVisible.value ||
    libraryStemTaskVisible.value ||
    tasks.value.length > 0
)
useBottomInfoTaskProgressMirror({
  runtime,
  analysisRuntimeVisible: analysisRuntimeTaskVisible,
  analysisRuntimePercent: analysisRuntimeTaskPercent,
  cloudSyncVisible: cloudSyncTaskVisible,
  cloudSyncPercent: cloudSyncTaskPercent,
  libraryStemVisible: libraryStemTaskVisible,
  libraryStemPercent: libraryStemTaskPercent,
  tasks
})
const showTotalRow = ref(!hasAnyVisibleTask.value)
const cancelMenuTaskId = ref<string | null>(null)
const backgroundTaskId = 'key-analysis.background'
const BACKGROUND_HIDE_DELAY_MS = 6000
let backgroundHideTimer: ReturnType<typeof setTimeout> | null = null
const progressTransitionRestoreFrames = new Map<string, number>()
// 组件内部通过 CSS 控制显隐（empty => display:none），无需向上层发事件

const clearBackgroundHideTimer = () => {
  if (!backgroundHideTimer) return
  clearTimeout(backgroundHideTimer)
  backgroundHideTimer = null
}

const dismissBackgroundTaskNow = () => {
  clearBackgroundHideTimer()
  if (cancelMenuTaskId.value === backgroundTaskId) {
    cancelMenuTaskId.value = null
  }
  tasks.value = tasks.value.filter((item) => item.id !== backgroundTaskId)
}

const getProgressPercent = (now: number, total: number) => {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (now / total) * 100))
}

const clearProgressTransitionRestoreFrame = (taskId: string) => {
  const frameId = progressTransitionRestoreFrames.get(taskId)
  if (frameId === undefined) return
  cancelAnimationFrame(frameId)
  progressTransitionRestoreFrames.delete(taskId)
}

const scheduleProgressTransitionRestore = (taskId: string) => {
  clearProgressTransitionRestoreFrame(taskId)
  const frameId = requestAnimationFrame(() => {
    progressTransitionRestoreFrames.delete(taskId)
    const task = tasks.value.find((item) => item.id === taskId)
    if (task) task.disableProgressTransition = false
  })
  progressTransitionRestoreFrames.set(taskId, frameId)
}

const updateTaskProgress = (task: Task, nowNum: number, total: number) => {
  const previousPercent = getProgressPercent(task.now, task.total)
  const nextPercent = getProgressPercent(nowNum, total)
  if (nextPercent < previousPercent) {
    task.disableProgressTransition = true
    scheduleProgressTransitionRestore(task.id)
  }
  task.now = nowNum
  task.total = total
}

const getTaskProgressStyle = (task: Task) => ({
  width: `${getProgressPercent(task.now, task.total)}%`,
  transition: task.disableProgressTransition ? 'none' : ''
})

function getGroupId(titleKey: string): string {
  if (typeof titleKey !== 'string') return String(titleKey)
  if (titleKey.startsWith('fingerprints.')) return 'import'
  if (titleKey.startsWith('tracks.')) return 'import'
  return String(titleKey)
}

function upsertTask(titleKey: string, nowNum: number, total: number, noNumFlag?: boolean) {
  const id = getGroupId(titleKey)
  const idx = tasks.value.findIndex((t) => t.id === id)
  if (idx === -1) {
    tasks.value.push({
      id,
      titleKey,
      title: t(titleKey),
      now: nowNum,
      total,
      noNum: !!noNumFlag,
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      disableProgressTransition: false
    })
  } else {
    const task = tasks.value[idx]
    task.titleKey = titleKey
    task.title = t(titleKey)
    updateTaskProgress(task, nowNum, total)
    task.noNum = !!noNumFlag
    task.lastUpdateAt = Date.now()
  }
  // 完成后延迟移除
  if (nowNum >= total && total > 0) {
    const task = tasks.value.find((t) => t.id === id)
    if (task && !task.removing) {
      task.removing = true
      setTimeout(() => {
        tasks.value = tasks.value.filter((t) => t.id !== id)
      }, 500)
    }
  }
}

const applyProgressPayload = (payload: ProgressPayload) => {
  const id = String(payload.id || '')
  const titleKey = String(payload.titleKey || '')
  const nowNum = Number(payload.now || 0)
  const total = Number(payload.total || 0)
  const noNumFlag = !!payload.isInitial
  const dismiss = !!payload.dismiss
  const hasCancelMeta =
    'cancelable' in payload || 'cancelChannel' in payload || 'cancelPayload' in payload
  const cancelable = !!payload.cancelable && typeof payload.cancelChannel === 'string'
  const cancelChannel = cancelable ? String(payload.cancelChannel) : undefined
  const cancelPayload = cancelable ? (payload.cancelPayload ?? id) : undefined
  const hasProgressMeta = 'noProgress' in payload
  const noProgress = !!payload.noProgress

  // 当前列表已有可见行内进度时，闲时提示会误导用户。
  if (
    id === backgroundTaskId &&
    (!runtime.setting?.showIdleAnalysisStatus || visibleSongsHaveAnalysisProgress.value)
  ) {
    return true
  }

  if (id === backgroundTaskId && !dismiss) {
    clearBackgroundHideTimer()
    const existing = tasks.value.find((t) => t.id === id)
    if (existing) existing.removing = false
  }
  if (dismiss && id === backgroundTaskId) {
    if (cancelMenuTaskId.value === id) {
      cancelMenuTaskId.value = null
    }
    clearBackgroundHideTimer()
    const task = tasks.value.find((t) => t.id === id)
    if (!task) return true
    task.removing = true
    backgroundHideTimer = setTimeout(() => {
      tasks.value = tasks.value.filter((t) => t.id !== id)
      backgroundHideTimer = null
    }, BACKGROUND_HIDE_DELAY_MS)
    return true
  }
  if (dismiss && id) {
    tasks.value = tasks.value.filter((t) => t.id !== id)
    if (cancelMenuTaskId.value === id) {
      cancelMenuTaskId.value = null
    }
    return true
  }
  if (!id || !titleKey) return true
  const idx = tasks.value.findIndex((t) => t.id === id)
  if (idx === -1) {
    tasks.value.push({
      id,
      titleKey,
      title: t(titleKey),
      now: nowNum,
      total,
      noNum: noNumFlag,
      noProgress: hasProgressMeta ? noProgress : false,
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      cancelable,
      cancelChannel,
      cancelPayload,
      canceling: false,
      disableProgressTransition: false
    })
  } else {
    const task = tasks.value[idx]
    task.titleKey = titleKey
    task.title = t(titleKey)
    updateTaskProgress(task, nowNum, total)
    task.noNum = noNumFlag
    task.lastUpdateAt = Date.now()
    if (hasProgressMeta) {
      task.noProgress = noProgress
    }
    if (hasCancelMeta) {
      task.cancelable = cancelable
      task.cancelChannel = cancelChannel
      task.cancelPayload = cancelPayload
      if (!cancelable) task.canceling = false
    }
  }
  // 仅对非 import/fingerprint/convert 类任务启用“自动移除”（这些任务有独立完成事件来清理）
  const canAutoRemove = !/^import_|^fingerprints_|^convert_|^bpm_fix_/i.test(id)
  if (canAutoRemove && nowNum >= total && total > 0) {
    const task = tasks.value.find((t) => t.id === id)
    if (task && !task.removing) {
      task.removing = true
      setTimeout(() => {
        tasks.value = tasks.value.filter((t) => t.id !== id)
      }, 1500)
    }
  }
  return true
}

const syncKeyAnalysisBackgroundStatus = async () => {
  try {
    const status = await window.electron.ipcRenderer.invoke('key-analysis:background-status')
    if (visibleSongsHaveAnalysisProgress.value) {
      dismissBackgroundTaskNow()
      return
    }
    if (status?.active) {
      applyProgressPayload({
        id: backgroundTaskId,
        titleKey: 'keyAnalysis.backgroundAnalyzing',
        now: 0,
        total: 0,
        isInitial: true,
        noProgress: true,
        cancelable: true,
        cancelChannel: 'key-analysis:cancel-background'
      })
    } else if (status && typeof status === 'object') {
      applyProgressPayload({
        id: backgroundTaskId,
        dismiss: true
      })
    }
  } catch (error) {
    console.error('sync key-analysis background status failed', error)
  }
}
void syncKeyAnalysisBackgroundStatus()

const handleProgressSet = (
  _event: unknown,
  arg1: unknown,
  arg2: unknown,
  arg3: unknown,
  arg4: unknown
) => {
  if (isRecord(arg1)) {
    if (applyProgressPayload(arg1 as unknown as ProgressPayload)) return
  }
  // 兼容旧签名
  const titleKey = arg1
  const nowNum = arg2
  const total = arg3
  const noNumFlag = arg4
  upsertTask(String(titleKey), Number(nowNum) || 0, Number(total) || 0, !!noNumFlag)
}
window.electron.ipcRenderer.on('progressSet', handleProgressSet)

const handleRendererProgressSet = (payload: unknown) => {
  if (isRecord(payload)) {
    applyProgressPayload(payload as ProgressPayload)
  }
}
emitter.on('renderer-progressSet', handleRendererProgressSet)

watch(hasAnyVisibleTask, (visible) => {
  if (visible) {
    showTotalRow.value = false
  }
})

watch(
  () => runtime.setting?.showIdleAnalysisStatus,
  (enabled) => {
    if (enabled === false) {
      dismissBackgroundTaskNow()
      return
    }
    if (enabled === true) {
      void syncKeyAnalysisBackgroundStatus()
    }
  }
)

watch(visibleSongsHaveAnalysisProgress, (hasVisibleProgress) => {
  if (hasVisibleProgress) {
    dismissBackgroundTaskNow()
    return
  }
  if (runtime.setting?.showIdleAnalysisStatus === true) {
    void syncKeyAnalysisBackgroundStatus()
  }
})

const handleAfterLeave = () => {
  if (!hasAnyVisibleTask.value) {
    showTotalRow.value = true
  }
}

const restoreAnalysisRuntimeOverlay = () => {
  runtime.setAnalysisRuntimeDownloadOverlayMinimized(false)
}

const cancelTask = async (task: Task) => {
  if (!task.cancelable || task.canceling) return
  task.canceling = true
  const channel = task.cancelChannel
  if (!channel) {
    task.canceling = false
    return
  }
  try {
    const payload = toIpcCloneablePayload(task.cancelPayload ?? task.id)
    await window.electron.ipcRenderer.invoke(channel, payload)
  } catch (error) {
    console.error('cancel task failed', error)
    task.canceling = false
  }
}

const pauseKeyAnalysisBackground = async (mode: '1h' | '3h' | 'until-restart') => {
  dismissBackgroundTaskNow()
  try {
    await window.electron.ipcRenderer.invoke('key-analysis:cancel-background', { mode })
  } catch (error) {
    console.error('pause key-analysis background failed', error)
  }
}

const handleCancelClick = async (task: Task) => {
  if (task.id === backgroundTaskId) {
    if (task.canceling) return
    cancelMenuTaskId.value = cancelMenuTaskId.value === task.id ? null : task.id
    return
  }
  if (cancelMenuTaskId.value) {
    cancelMenuTaskId.value = null
  }
  await cancelTask(task)
}

const handleDocumentClick = () => {
  if (cancelMenuTaskId.value) {
    cancelMenuTaskId.value = null
  }
}

const handleKeyAnalysisStageUpdate = (
  _event: unknown,
  payload?: { filePath?: string; stage?: string }
) => {
  const stage = String(payload?.stage || '')
  if (stage !== 'job-done' && stage !== 'job-error') return
  const normalizedDonePath = normalizeAnalysisPath(String(payload?.filePath || ''))
  if (!normalizedDonePath) return
  const nextPending = runtime.manualKeyAnalysisPendingFilePaths.filter(
    (filePath) => normalizeAnalysisPath(filePath) !== normalizedDonePath
  )
  if (nextPending.length !== runtime.manualKeyAnalysisPendingFilePaths.length) {
    runtime.manualKeyAnalysisPendingFilePaths = nextPending
  }
}
window.electron.ipcRenderer.on('key-analysis:stage-update', handleKeyAnalysisStageUpdate)

const handleManualKeyAnalysisBatchStart = (_event: unknown, payload?: { filePaths?: string[] }) => {
  const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
  if (!filePaths.length) return
  const nextPending = new Set(runtime.manualKeyAnalysisPendingFilePaths)
  for (const filePath of filePaths) {
    if (normalizeAnalysisPath(filePath)) nextPending.add(filePath)
  }
  runtime.manualKeyAnalysisPendingFilePaths = Array.from(nextPending)
}
window.electron.ipcRenderer.on('key-analysis:manual-batch-start', handleManualKeyAnalysisBatchStart)

const normalizeLibraryStemTaskStatus = (value: unknown): LibraryStemTaskStatus | null => {
  if (
    value === 'idle' ||
    value === 'pending' ||
    value === 'running' ||
    value === 'ready' ||
    value === 'failed'
  ) {
    return value
  }
  return null
}

const normalizeLibraryStemTaskStage = (value: unknown): LibraryStemTaskStage | null => {
  if (
    value === 'separating' ||
    value === 'rendering' ||
    value === 'validating' ||
    value === 'saving' ||
    value === 'cleaning'
  ) {
    return value
  }
  return null
}

const restoreLibraryStemTask = async () => {
  const task = libraryStemTask.value
  if (!task || libraryStemRestoreRunning || !task.filePath) return
  libraryStemRestoreRunning = true
  libraryStemTask.value = { ...task, minimized: false }
  try {
    const { default: openLibraryStemSeparationDialog } =
      await import('@renderer/components/libraryStemSeparationDialog')
    await openLibraryStemSeparationDialog({
      filePath: task.filePath,
      songTitle: task.songTitle,
      initialSnapshot: {
        filePath: task.filePath,
        model: task.model,
        status: task.status,
        percent: task.percent,
        activityConfirmedAt: task.activityConfirmedAt,
        stage: task.stage,
        stageCompleted: task.stageCompleted,
        stageTotal: task.stageTotal,
        errorMessage: task.errorMessage
      }
    })
  } finally {
    libraryStemRestoreRunning = false
  }
}

const applyLibraryStemTaskSnapshot = (payload: unknown) => {
  if (!isRecord(payload)) return
  const filePath = typeof payload.filePath === 'string' ? payload.filePath.trim() : ''
  const task = libraryStemTask.value
  if (!task || !task.minimized || !filePath) return
  if (normalizeAnalysisPath(task.filePath) !== normalizeAnalysisPath(filePath)) return
  const status = normalizeLibraryStemTaskStatus(payload.status)
  if (!status) return
  if (status === 'idle') {
    if (task.status === 'pending' || task.status === 'running') {
      libraryStemTask.value = null
    }
    return
  }
  const stage = normalizeLibraryStemTaskStage(payload.stage)
  const nextPercent = Math.max(0, Math.min(100, Math.round(Number(payload.percent) || 0)))
  const previousStatus = task.status
  task.status = status
  task.percent =
    status === 'ready'
      ? 100
      : previousStatus === 'running' && status === 'running'
        ? Math.max(task.percent, nextPercent)
        : nextPercent
  task.activityConfirmedAt =
    status === 'running' && Number.isFinite(Number(payload.activityConfirmedAt))
      ? Number(payload.activityConfirmedAt)
      : null
  task.stage = stage
  task.stageCompleted = Number.isFinite(Number(payload.stageCompleted))
    ? Number(payload.stageCompleted)
    : null
  task.stageTotal = Number.isFinite(Number(payload.stageTotal)) ? Number(payload.stageTotal) : null
  task.errorMessage =
    typeof payload.errorMessage === 'string' ? payload.errorMessage.trim() || null : null
  if (status === 'ready' || status === 'failed') void restoreLibraryStemTask()
}

const handleLibraryStemMinimized = (event: Event) => {
  const detail = event instanceof CustomEvent && isRecord(event.detail) ? event.detail : null
  const filePath = typeof detail?.filePath === 'string' ? detail.filePath.trim() : ''
  if (!filePath) return
  const minimizedSnapshot = isRecord(detail?.snapshot) ? detail.snapshot : null
  const snapshotStatus = normalizeLibraryStemTaskStatus(minimizedSnapshot?.status)
  const snapshotModel =
    typeof minimizedSnapshot?.model === 'string' ? minimizedSnapshot.model.trim() : ''
  const snapshotPercent = Math.max(
    0,
    Math.min(100, Math.round(Number(minimizedSnapshot?.percent) || 0))
  )
  libraryStemTask.value = {
    filePath,
    songTitle: typeof detail?.songTitle === 'string' ? detail.songTitle.trim() : '',
    model: snapshotModel,
    status: snapshotStatus === 'running' ? 'running' : 'pending',
    percent: snapshotPercent,
    activityConfirmedAt: Number.isFinite(Number(minimizedSnapshot?.activityConfirmedAt))
      ? Number(minimizedSnapshot?.activityConfirmedAt)
      : null,
    stage: normalizeLibraryStemTaskStage(minimizedSnapshot?.stage),
    stageCompleted: Number.isFinite(Number(minimizedSnapshot?.stageCompleted))
      ? Number(minimizedSnapshot?.stageCompleted)
      : null,
    stageTotal: Number.isFinite(Number(minimizedSnapshot?.stageTotal))
      ? Number(minimizedSnapshot?.stageTotal)
      : null,
    minimized: true,
    errorMessage:
      typeof minimizedSnapshot?.errorMessage === 'string'
        ? minimizedSnapshot.errorMessage.trim() || null
        : null
  }
  void window.electron.ipcRenderer
    .invoke('library-stem:get-status', { filePath, model: snapshotModel || undefined })
    .then(applyLibraryStemTaskSnapshot)
    .catch(() => {})
}

const handleLibraryStemStatusUpdated = (_event: unknown, payload: unknown) => {
  applyLibraryStemTaskSnapshot(payload)
}

window.addEventListener('library-stem:minimized', handleLibraryStemMinimized)
window.electron.ipcRenderer.on('library-stem-status-updated', handleLibraryStemStatusUpdated)

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

const handleImportFinished = async (
  _event: unknown,
  _songListUUID: unknown,
  importSummary: unknown,
  progressId?: string
) => {
  runtime.isProgressing = false
  runtime.importingSongListUUID = ''
  // 有 progressId 则按 id 清理；否则清理整组 import
  if (progressId) {
    tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
  } else {
    tasks.value = tasks.value.filter((t) => t.id !== 'import')
  }
  const openImportSummary = (await import('@renderer/components/importFinishedSummaryDialog'))
    .default
  if (isRecord(importSummary)) {
    await openImportSummary(
      importSummary as unknown as import('@renderer/components/importFinishedSummaryDialog').ImportSummary
    )
  }
}
window.electron.ipcRenderer.on('importFinished', handleImportFinished)

const handleAddSongFingerprintFinished = async (
  _event: unknown,
  fingerprintSummary: unknown,
  progressId?: string
) => {
  runtime.isProgressing = false
  // 清理导入/指纹相关进度行
  if (progressId) {
    tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
  } else {
    tasks.value = tasks.value.filter((t) => t.id !== 'import')
  }
  const openFingerprintSummary = (
    await import('@renderer/components/addSongFingerprintFinishedDialog')
  ).default
  if (isRecord(fingerprintSummary)) {
    await openFingerprintSummary(
      fingerprintSummary as unknown as import('@renderer/components/addSongFingerprintFinishedDialog').FingerprintSummary
    )
  }
}
window.electron.ipcRenderer.on('addSongFingerprintFinished', handleAddSongFingerprintFinished)

const handleFingerprintsAddExistingFinished = async (
  _event: unknown,
  summary: unknown,
  progressId?: string
) => {
  runtime.isProgressing = false
  if (progressId) {
    tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
  } else {
    tasks.value = tasks.value.filter((t) => t.id !== 'import')
  }
  const openImportSummary = (await import('@renderer/components/importFinishedSummaryDialog'))
    .default
  if (isRecord(summary)) {
    await openImportSummary(
      summary as unknown as import('@renderer/components/importFinishedSummaryDialog').ImportSummary
    )
  }
}
window.electron.ipcRenderer.on(
  'fingerprints:addExistingFinished',
  handleFingerprintsAddExistingFinished
)
const handleNoAudioFileWasScanned = async (_event: unknown, progressId?: string) => {
  runtime.isProgressing = false
  runtime.importingSongListUUID = ''
  if (progressId) tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
  await confirm({
    title: t('common.finished'),
    content: [t('fingerprints.noAudioFilesFound')],
    textAlign: 'center',
    innerHeight: 250,
    innerWidth: 400,
    confirmShow: false
  })
}
window.electron.ipcRenderer.on('noAudioFileWasScanned', handleNoAudioFileWasScanned)

// 音频转换完成摘要弹窗（简要）
const handleAudioConvertDone = async (
  _e: unknown,
  payload: { jobId?: string; summary?: unknown; errors?: unknown[] }
) => {
  // 清理转换进度行
  const doneId = String(payload?.jobId || '')
  const scheduleRemoval = (id: string) => {
    if (!id) return
    const task = tasks.value.find((t) => t.id === id)
    if (task && !task.removing) {
      task.removing = true
      setTimeout(() => {
        tasks.value = tasks.value.filter((t) => t.id !== id)
      }, 500)
    } else if (!task) {
      tasks.value = tasks.value.filter((t) => t.id !== id)
    }
  }
  if (doneId) {
    scheduleRemoval(doneId)
  } else {
    scheduleRemoval('audio.convert')
  }
  const openSummary = (await import('@renderer/components/conversionFinishedSummaryDialog')).default
  await openSummary(payload?.summary || null, payload?.errors || [])
}
window.electron.ipcRenderer.on('audio:convert:done', handleAudioConvertDone)

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  clearBackgroundHideTimer()
  for (const frameId of progressTransitionRestoreFrames.values()) {
    cancelAnimationFrame(frameId)
  }
  progressTransitionRestoreFrames.clear()

  // 清理 IPC 监听器
  window.electron?.ipcRenderer?.removeListener('progressSet', handleProgressSet)
  emitter.off('renderer-progressSet', handleRendererProgressSet)
  window.electron?.ipcRenderer?.removeListener('importFinished', handleImportFinished)
  window.electron?.ipcRenderer?.removeListener(
    'addSongFingerprintFinished',
    handleAddSongFingerprintFinished
  )
  window.electron?.ipcRenderer?.removeListener(
    'fingerprints:addExistingFinished',
    handleFingerprintsAddExistingFinished
  )
  window.electron?.ipcRenderer?.removeListener('noAudioFileWasScanned', handleNoAudioFileWasScanned)
  window.electron?.ipcRenderer?.removeListener('audio:convert:done', handleAudioConvertDone)
  window.electron?.ipcRenderer?.removeListener(
    'key-analysis:stage-update',
    handleKeyAnalysisStageUpdate
  )
  window.electron?.ipcRenderer?.removeListener(
    'key-analysis:manual-batch-start',
    handleManualKeyAnalysisBatchStart
  )
  window.removeEventListener('library-stem:minimized', handleLibraryStemMinimized)
  window.electron?.ipcRenderer?.removeListener(
    'library-stem-status-updated',
    handleLibraryStemStatusUpdated
  )
})
</script>
<template>
  <div class="bottom-info-area" :class="{ empty: !hasAnyVisibleTask }">
    <div v-if="analysisRuntimeTaskVisible" class="task-row task-row--analysis-runtime">
      <div class="spinner">
        <div class="loading">
          <div></div>
          <div></div>
          <div></div>
          <div></div>
          <div></div>
        </div>
      </div>
      <div class="label label--stacked">
        <span class="label__title">{{ analysisRuntimeTaskTitle }}</span>
        <span class="label__detail">{{ analysisRuntimeTaskText }}</span>
      </div>
      <div class="container">
        <div class="progress">
          <div class="progress-bar" :style="{ width: `${analysisRuntimeTaskPercent}%` }" />
        </div>
      </div>
      <div v-if="analysisRuntimeOverlayMinimized" class="actions">
        <button class="task-btn" type="button" @click="restoreAnalysisRuntimeOverlay">
          {{ t('analysisRuntime.restoreOverlay') }}
        </button>
      </div>
    </div>
    <div v-if="cloudSyncTaskVisible" class="task-row task-row--cloud-sync">
      <div class="spinner">
        <div class="loading">
          <div></div>
          <div></div>
          <div></div>
          <div></div>
          <div></div>
        </div>
      </div>
      <div class="label">{{ t('cloudSync.minimizedTitle') }}</div>
      <div class="container">
        <div class="progress">
          <div class="progress-bar" :style="{ width: `${cloudSyncTaskPercent}%` }" />
        </div>
      </div>
    </div>
    <div v-if="libraryStemTaskVisible" class="task-row task-row--library-stem">
      <div class="spinner">
        <div class="loading">
          <div></div>
          <div></div>
          <div></div>
          <div></div>
          <div></div>
        </div>
      </div>
      <div class="label">
        {{ libraryStemTaskText }}
        <span>{{ libraryStemTaskPercent }}%</span>
      </div>
      <div class="container">
        <div class="progress">
          <div class="progress-bar" :style="{ width: `${libraryStemTaskPercent}%` }" />
        </div>
      </div>
      <div class="actions">
        <button class="task-btn" type="button" @click="restoreLibraryStemTask">
          {{ t('stemSeparation.restore') }}
        </button>
      </div>
    </div>
    <TransitionGroup
      name="progress-fade"
      tag="div"
      class="task-list"
      @after-leave="handleAfterLeave"
    >
      <div v-for="task in tasks" :key="task.id" class="task-row">
        <div class="spinner">
          <div class="loading">
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
          </div>
        </div>
        <div class="label">
          {{ task.title }}
          <span v-show="!task.noNum">{{ task.now }} / {{ task.total }}</span>
        </div>
        <div class="container">
          <div v-if="!task.noProgress" class="progress">
            <div class="progress-bar" :style="getTaskProgressStyle(task)" />
          </div>
        </div>
        <BpmFixTaskButton v-if="task.id.startsWith('bpm_fix_')" />
        <div v-if="task.cancelable" class="actions">
          <button
            class="cancel-btn"
            :disabled="task.canceling"
            @click.stop="handleCancelClick(task)"
          >
            {{ t('common.cancel') }}
          </button>
          <div
            v-if="task.id === backgroundTaskId && cancelMenuTaskId === task.id"
            class="cancel-menu"
            @click.stop
          >
            <button
              class="cancel-menu-item"
              :disabled="task.canceling"
              @click.stop="pauseKeyAnalysisBackground('1h')"
            >
              {{ t('keyAnalysis.pause1h') }}
            </button>
            <button
              class="cancel-menu-item"
              :disabled="task.canceling"
              @click.stop="pauseKeyAnalysisBackground('3h')"
            >
              {{ t('keyAnalysis.pause3h') }}
            </button>
            <button
              class="cancel-menu-item"
              :disabled="task.canceling"
              @click.stop="pauseKeyAnalysisBackground('until-restart')"
            >
              {{ t('keyAnalysis.pauseUntilRestart') }}
            </button>
          </div>
        </div>
      </div>
    </TransitionGroup>
    <BottomInfoAreaTotalRow v-if="showTotalRow" />
  </div>
</template>
<style lang="scss" scoped src="./bottomInfoAreaTasks.scss"></style>
<style lang="scss" scoped src="./bottomInfoAreaFooter.scss"></style>
