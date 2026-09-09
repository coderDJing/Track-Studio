<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { runCuratedLibrarySyncUi } from '@renderer/composables/runCuratedLibrarySyncUi'
import { useCuratedLibrarySyncStatus } from '@renderer/composables/useCuratedLibrarySyncStatus'
import type { CuratedLibrarySyncOverview } from '../../../shared/curatedLibrarySync'

const emits = defineEmits(['cancel'])
const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const { status, refreshStatus } = useCuratedLibrarySyncStatus()
const engaged = ref(false)
const invoking = ref(false)
const progressTransitionEnabled = ref(true)
const minimumTerminalUpdatedAt = ref(0)
const overview = ref<CuratedLibrarySyncOverview | null>(null)

const cancelDialog = () => closeWithAnimation(() => emits('cancel'))
const syncing = computed(() => engaged.value && status.value.running)
const hasCurrentTerminal = computed(
  () =>
    engaged.value &&
    status.value.terminalStatus !== 'idle' &&
    status.value.updatedAtMs >= minimumTerminalUpdatedAt.value
)

const stages = [
  { key: 'scanning', label: 'cloudSync.curatedLibrary.phases.scanning' },
  { key: 'downloading', label: 'cloudSync.curatedLibrary.phases.downloading' },
  { key: 'uploading', label: 'cloudSync.curatedLibrary.phases.uploading' },
  { key: 'applying', label: 'cloudSync.curatedLibrary.phases.applying' }
] as const

const currentStage = computed(() => {
  if (!engaged.value) return ''
  return status.value.phase === 'waiting-first-snapshot' ? 'downloading' : status.value.phase
})

const progressPercent = computed(() => {
  if (!engaged.value) return 0
  if (!status.value.running) {
    return hasCurrentTerminal.value &&
      (status.value.terminalStatus === 'success' || status.value.terminalStatus === 'up_to_date')
      ? 100
      : 0
  }
  if (status.value.total > 0) {
    return Math.max(0, Math.min(100, Math.round((status.value.now / status.value.total) * 100)))
  }
  if (status.value.phase === 'scanning') return 10
  if (status.value.phase === 'waiting-first-snapshot') return 35
  if (status.value.phase === 'downloading') return 35
  if (status.value.phase === 'uploading') return 65
  if (status.value.phase === 'applying') return 90
  return 0
})

const activityText = computed(() => {
  if (!engaged.value) return ''
  const { phase, now, total } = status.value
  if (phase === 'downloading') {
    return t('cloudSync.curatedLibrary.activityDownloading', { now, total })
  }
  if (phase === 'uploading') {
    return t('cloudSync.curatedLibrary.activityUploading', { now, total })
  }
  if (phase === 'waiting-first-snapshot') {
    return t('cloudSync.curatedLibrary.activityWaitingFirstSnapshot')
  }
  if (phase === 'scanning') return t('cloudSync.curatedLibrary.activityScanning')
  if (phase === 'applying') return t('cloudSync.curatedLibrary.activityApplying')
  return ''
})

const terminalText = computed(() => {
  if (!hasCurrentTerminal.value || status.value.running) return ''
  if (status.value.terminalStatus === 'success') return t('cloudSync.curatedLibrary.syncSuccess')
  if (status.value.terminalStatus === 'up_to_date') {
    return t('cloudSync.curatedLibrary.alreadyLatest')
  }
  if (status.value.terminalStatus === 'cancelled') {
    return t('cloudSync.curatedLibrary.syncCancelled')
  }
  if (status.value.terminalStatus !== 'failed') return ''
  const messageKey =
    status.value.message === 'not_configured'
      ? 'cloudSync.notConfigured'
      : status.value.message === 'busy_library'
        ? 'cloudSync.curatedLibrary.errors.busyLibrary'
        : status.value.message === 'disk_full'
          ? 'cloudSync.curatedLibrary.errors.diskFull'
          : status.value.message === 'paused_offline'
            ? 'cloudSync.errors.cannotConnect'
            : status.value.message || 'cloudSync.curatedLibrary.syncFailed'
  return t(messageKey)
})

const refreshOverview = async () => {
  try {
    overview.value = (await window.electron.ipcRenderer.invoke(
      'curatedLibrarySync/getOverview'
    )) as CuratedLibrarySyncOverview
  } catch {}
}

const waitForPaint = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })

const startSync = async () => {
  if (invoking.value || syncing.value) return
  invoking.value = true
  try {
    // 先无动画清掉上一次的 100%，避免新任务从旧结果反向过渡到初始阶段。
    progressTransitionEnabled.value = false
    engaged.value = false
    overview.value = null
    await nextTick()
    await refreshStatus()
    minimumTerminalUpdatedAt.value = status.value.running ? 0 : status.value.updatedAtMs + 1
    engaged.value = true
    await nextTick()
    await waitForPaint()
    progressTransitionEnabled.value = true

    // 如果自动同步正在执行，此时直接显示它的当前进度并复用该任务。
    await runCuratedLibrarySyncUi({ trigger: 'manual', allowWhenDisabled: true })
  } finally {
    progressTransitionEnabled.value = true
    await refreshStatus()
    await refreshOverview()
    invoking.value = false
  }
}

watch(
  () => status.value.terminalStatus,
  (terminalStatus) => {
    if (hasCurrentTerminal.value && terminalStatus !== 'idle') void refreshOverview()
  }
)

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancelDialog()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => utils.delHotkeysScope(uuid))
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="title dialog-title dialog-header">{{ t('cloudSync.syncCuratedLibrary') }}</div>
      <div class="body">
        <div class="hint">{{ t('cloudSync.curatedLibrary.manualHint') }}</div>
        <div class="stages">
          <div
            v-for="stage in stages"
            :key="stage.key"
            class="stage"
            :class="{ active: currentStage === stage.key }"
          >
            <div class="dot" />
            <div class="label">{{ t(stage.label) }}</div>
          </div>
        </div>
        <div class="progress">
          <div class="bar">
            <div
              class="fill"
              :class="{
                running: syncing && status.total <= 0,
                'with-transition': progressTransitionEnabled
              }"
              :style="{ width: `${progressPercent}%` }"
            />
            <div class="percent-text">{{ progressPercent }}%</div>
          </div>
          <div class="progress-details">{{ syncing ? activityText : terminalText }}</div>
        </div>
        <div
          v-if="
            engaged &&
            !syncing &&
            overview &&
            (overview.conflicts.length || overview.failures.length)
          "
          class="result-details"
        >
          <span>
            {{
              t('cloudSync.curatedLibrary.conflictsCountShort', {
                count: overview.conflicts.length
              })
            }}
          </span>
          <span>
            {{
              t('cloudSync.curatedLibrary.failuresCountShort', {
                count: overview.failures.length
              })
            }}
          </span>
        </div>
      </div>
      <div class="dialog-footer">
        <div
          class="button action-button"
          :class="{ disabled: invoking || syncing }"
          @click="void startSync()"
        >
          {{ t('cloudSync.startSync') }}
        </div>
        <div class="button action-button" @click="cancelDialog()">
          {{ t('common.close') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.title {
  color: var(--text);
}

.body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hint,
.progress-details,
.result-details {
  text-align: center;
  font-size: 12px;
  color: var(--text-weak);
}

.stages {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.stage {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.6;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border);
}

.label {
  font-size: 11px;
  color: var(--text-weak);
  white-space: nowrap;
}

.stage.active {
  opacity: 1;
}

.stage.active .dot {
  background: var(--accent);
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bar {
  position: relative;
  height: 10px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
}

.fill {
  height: 100%;
  background: var(--accent);
}

.fill.with-transition {
  transition: width 0.3s ease-in-out;
}

.fill.running {
  background-image: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.16) 0 8px,
    rgba(255, 255, 255, 0.04) 8px 16px
  );
  animation: move-stripes 1.2s linear infinite;
}

.percent-text {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--text);
}

.progress-details {
  min-height: 16px;
  line-height: 16px;
}

.result-details {
  display: flex;
  justify-content: center;
  gap: 18px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

.action-button {
  width: 90px;
  height: 25px;
  line-height: 25px;
  text-align: center;
}

.disabled {
  opacity: 0.6;
  pointer-events: none;
}

@keyframes move-stripes {
  from {
    background-position: 0 0;
  }
  to {
    background-position: 100px 0;
  }
}
</style>
