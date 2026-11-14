<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'

type DownloadStatus = 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'

type UltraModelDownloadState = {
  status: DownloadStatus
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  message: string
  error: string
}

type UltraModelInfo = {
  version: string
  archiveSize: number
  installedSize: number
  alreadyAvailable: boolean
  error: string
  state: UltraModelDownloadState
}

const props = defineProps<{
  initialInfo?: unknown
}>()

const emit = defineEmits<{
  close: []
  ready: []
}>()

const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition(160)
const info = ref<UltraModelInfo | null>(null)
const starting = ref(false)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const parseState = (value: unknown): UltraModelDownloadState | null => {
  if (!isRecord(value)) return null
  const status = value.status
  if (
    status !== 'idle' &&
    status !== 'available' &&
    status !== 'downloading' &&
    status !== 'extracting' &&
    status !== 'ready' &&
    status !== 'failed'
  ) {
    return null
  }
  return {
    status,
    version: typeof value.version === 'string' ? value.version.trim() : '',
    percent: Math.max(0, Math.min(100, Number(value.percent) || 0)),
    downloadedBytes: Math.max(0, Number(value.downloadedBytes) || 0),
    totalBytes: Math.max(0, Number(value.totalBytes) || 0),
    archiveSize: Math.max(0, Number(value.archiveSize) || 0),
    message: typeof value.message === 'string' ? value.message.trim() : '',
    error: typeof value.error === 'string' ? value.error.trim() : ''
  }
}

const parseInfo = (value: unknown): UltraModelInfo | null => {
  if (!isRecord(value)) return null
  const state = parseState(value.state)
  if (!state) return null
  return {
    version: typeof value.version === 'string' ? value.version.trim() : '',
    archiveSize: Math.max(0, Number(value.archiveSize) || 0),
    installedSize: Math.max(0, Number(value.installedSize) || 0),
    alreadyAvailable: value.alreadyAvailable === true,
    error: typeof value.error === 'string' ? value.error.trim() : '',
    state
  }
}

const initialInfo = parseInfo(props.initialInfo)
if (initialInfo) info.value = initialInfo

const isDownloading = computed(() => {
  const status = info.value?.state.status
  return status === 'downloading' || status === 'extracting'
})
const isReady = computed(
  () => info.value?.alreadyAvailable === true || info.value?.state.status === 'ready'
)
const archiveSize = computed(() => Math.max(0, info.value?.archiveSize || 0))
const showProgress = computed(
  () =>
    starting.value || isDownloading.value || isReady.value || info.value?.state.status === 'failed'
)
const downloadStatusText = computed(() => {
  const state = info.value?.state
  if (!state) return t('stemSeparation.modelChecking')
  if (state.status === 'downloading') {
    return t('stemSeparation.modelDownloadingProgress', {
      downloaded: formatAnalysisRuntimeBytes(state.downloadedBytes),
      total: formatAnalysisRuntimeBytes(state.totalBytes || state.archiveSize),
      percent: Math.round(Number(state.percent) || 0)
    })
  }
  if (state.status === 'extracting') return t('stemSeparation.modelExtracting')
  if (isReady.value) {
    return t('stemSeparation.ultraModelReady', {
      size: formatAnalysisRuntimeBytes(info.value?.installedSize || archiveSize.value)
    })
  }
  if (state.status === 'failed') return state.error || t('stemSeparation.modelDownloadFailed')
  if (info.value?.error) return t('stemSeparation.modelManifestUnavailable')
  return t('stemSeparation.modelChecking')
})
const primaryLabel = computed(() => {
  if (isDownloading.value || starting.value) return t('stemSeparation.modelDownloading')
  return info.value?.state.status === 'failed'
    ? t('stemSeparation.retryModelDownload')
    : t('stemSeparation.ultraDownloadConfirm')
})

const refreshInfo = async () => {
  try {
    const response = await window.electron.ipcRenderer.invoke('demucs-model:get-ultra-status')
    const next = parseInfo(response)
    if (next) info.value = next
  } catch {
    info.value = null
  }
}

const startDownload = async () => {
  if (isReady.value) {
    closeWithAnimation(() => {
      emit('ready')
      emit('close')
    })
    return
  }
  if (isDownloading.value || starting.value) return
  starting.value = true
  try {
    await window.electron.ipcRenderer.invoke('demucs-model:download-ultra')
    await refreshInfo()
    if (isReady.value) {
      emit('ready')
      closeWithAnimation(() => emit('close'))
      return
    }
    // 下载进度统一进右下角下载卡片，弹窗只负责确认与状态说明。
    closeWithAnimation(() => emit('close'))
  } catch {
    await refreshInfo()
  } finally {
    starting.value = false
  }
}

const closeDialog = () => {
  // 下载进度已经交给右下角卡片，弹窗随时可以关。
  if (starting.value) return
  closeWithAnimation(() => emit('close'))
}

const handleDownloadState = (_event: unknown, payload: unknown) => {
  const state = parseState(payload)
  if (!state) return
  info.value = {
    version: state.version || info.value?.version || '',
    archiveSize: state.archiveSize || info.value?.archiveSize || 0,
    installedSize: state.status === 'ready' ? state.archiveSize : info.value?.installedSize || 0,
    alreadyAvailable: state.status === 'ready',
    error: state.error,
    state
  }
  if (state.status === 'ready') {
    emit('ready')
    void refreshInfo()
  }
}

onMounted(() => {
  window.electron.ipcRenderer.on('demucs-model-download-state', handleDownloadState)
  hotkeys('Esc', uuid, closeDialog)
  utils.setHotkeysScpoe(uuid)
  void refreshInfo()
})

onUnmounted(() => {
  window.electron.ipcRenderer.removeListener('demucs-model-download-state', handleDownloadState)
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner demucs-ultra-download-dialog__inner">
      <div class="dialog-title dialog-header">
        <span>{{ t('stemSeparation.ultraDownloadDialogTitle') }}</span>
      </div>
      <div class="demucs-ultra-download-dialog__body">
        <section class="demucs-ultra-download-dialog__summary">
          <strong>HTDemucs FT</strong>
          <span v-if="archiveSize">· {{ formatAnalysisRuntimeBytes(archiveSize) }}</span>
        </section>
        <div class="demucs-ultra-download-dialog__hint">
          {{ t('stemSeparation.ultraDownloadCompactHint') }}
        </div>

        <section
          v-if="showProgress"
          class="demucs-ultra-download-dialog__progress"
          :class="{
            'is-active': isDownloading,
            'is-ready': isReady,
            'is-failed': info?.state.status === 'failed'
          }"
        >
          <div class="demucs-ultra-download-dialog__progress-head">
            <span>{{ downloadStatusText }}</span>
          </div>
        </section>
      </div>
      <div class="dialog-footer demucs-ultra-download-dialog__footer">
        <div
          v-if="!isReady"
          class="button"
          :class="{ disabled: isDownloading || starting }"
          @click="startDownload"
        >
          {{ primaryLabel }}
        </div>
        <div class="button" :class="{ disabled: starting }" @click="closeDialog">
          {{ t('common.close') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.demucs-ultra-download-dialog__inner {
  display: flex;
  width: min(460px, calc(100vw - 32px));
  max-height: min(360px, calc(100vh - 32px));
  flex-direction: column;
}

.demucs-ultra-download-dialog__body {
  min-height: 0;
  padding: 18px 20px 16px;
  flex: 1;
  overflow: auto;
}

.demucs-ultra-download-dialog__summary {
  color: var(--text);
  font-size: 14px;
  line-height: 20px;
}

.demucs-ultra-download-dialog__summary span,
.demucs-ultra-download-dialog__hint {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.demucs-ultra-download-dialog__hint {
  margin-top: 3px;
}

.demucs-ultra-download-dialog__progress {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--waveform-bg-elev);
}

.demucs-ultra-download-dialog__progress.is-ready {
  border-color: color-mix(in srgb, var(--success, #107c10) 46%, var(--border));
}

.demucs-ultra-download-dialog__progress.is-failed {
  border-color: color-mix(in srgb, var(--error, #f56c6c) 46%, var(--border));
}

.demucs-ultra-download-dialog__progress-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  line-height: 17px;
}

.demucs-ultra-download-dialog__progress-head span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.button.disabled {
  opacity: 0.46;
  pointer-events: none;
}

.demucs-ultra-download-dialog__footer {
  flex-shrink: 0;
}

@media (max-width: 520px) {
  .demucs-ultra-download-dialog__inner {
    min-height: 0;
  }

  .demucs-ultra-download-dialog__body {
    padding: 14px 12px;
  }
}
</style>
