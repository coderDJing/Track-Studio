<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { useI18n } from '@renderer/composables/useI18n'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const emits = defineEmits(['cancel'])
const uuid = uuidV4()
const runtime = useRuntimeStore()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const cancelDialog = () => {
  closeWithAnimation(() => emits('cancel'))
}
// 最小化：保留同步状态到底部进度区，仅隐藏对话框
const minimize = () => {
  runtime.setCloudSyncMinimized(true)
  closeWithAnimation(() => emits('cancel'))
}

const { t } = useI18n()

const configured = ref<boolean | null>(null)
const logMsg = ref('')
const completedAlreadyLatest = ref(false)

// 同步状态全部来自 store（单一数据源，最小化后由 App.vue 常驻监听器维护）
const syncing = computed(() => runtime.cloudSync.syncing)
const phase = computed(() => runtime.cloudSync.phase)
const percent = computed(() => runtime.cloudSync.percent)
const progressDetails = computed(() => runtime.cloudSync.details)
const displayPercent = computed(() => (completedAlreadyLatest.value ? 100 : percent.value))

const stages = [
  { key: 'checking', label: 'cloudSync.phases.checking' },
  { key: 'diffing', label: 'cloudSync.phases.diffing' },
  { key: 'analyzing', label: 'cloudSync.phases.analyzing' },
  { key: 'pulling', label: 'cloudSync.phases.pulling' },
  { key: 'committing', label: 'cloudSync.phases.committing' },
  { key: 'finalizing', label: 'cloudSync.phases.finalizing' }
]
const phaseIndexMap: Record<string, number> = stages.reduce(
  (acc, s, i) => {
    acc[s.key] = i
    return acc
  },
  {} as Record<string, number>
)
const currentPhaseIndex = computed(() => phaseIndexMap[phase.value] ?? -1)

const startSync = async () => {
  logMsg.value = ''
  completedAlreadyLatest.value = false
  const res = await window.electron.ipcRenderer.invoke('cloudSync/start')
  if (res === 'not_configured') {
    logMsg.value = t('cloudSync.notConfiguredHint')
    window.setTimeout(() => {
      closeWithAnimation(() => {
        emits('cancel')
        window.setTimeout(() => {
          const evt = new CustomEvent('openDialogFromChild', { detail: 'cloudSync.settings' })
          window.dispatchEvent(evt)
        }, 50)
      })
    }, 300)
    return
  }
  if (res === 'already_latest') {
    completedAlreadyLatest.value = true
    return
  }
  // syncing 状态由主进程回送的 cloudSync/state:'syncing' 驱动（App.vue 常驻监听）
}

onMounted(async () => {
  // 从底部进度区再次打开对话框时回到前台
  runtime.setCloudSyncMinimized(false)
  const cfg = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  configured.value = !!cfg?.userKey
  hotkeys('Esc', uuid, () => cancelDialog())
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="title dialog-title dialog-header">{{ t('cloudSync.syncFingerprints') }}</div>
      <div class="body">
        <div v-if="configured === false" class="hint">{{ t('cloudSync.notConfigured') }}</div>
        <div class="hint hint-secondary">{{ t('cloudSync.syncIncludesCuratedArtists') }}</div>
        <div class="stages">
          <div
            v-for="(s, i) in stages"
            :key="s.key"
            class="stage"
            :class="{ active: i <= currentPhaseIndex, current: i === currentPhaseIndex }"
          >
            <div class="dot"></div>
            <div class="label">{{ t(s.label) }}</div>
          </div>
        </div>
        <div class="progress">
          <div class="bar">
            <div class="fill" :style="{ width: displayPercent + '%' }">
              <div class="gloss"></div>
            </div>
            <div class="percentText">{{ displayPercent }}%</div>
          </div>
          <div class="progress-details">
            <template v-if="completedAlreadyLatest">
              <span>{{ t('cloudSync.alreadyLatest') }}</span>
            </template>
            <template v-else-if="phase === 'checking'">
              <span
                >{{ t('cloudSync.clientCount') }}: {{ progressDetails.clientCount ?? '-' }}</span
              >
              <span class="sep">|</span>
              <span
                >{{ t('cloudSync.serverCount') }}: {{ progressDetails.serverCount ?? '-' }}</span
              >
            </template>
            <template v-else-if="phase === 'diffing'">
              <span>{{ t('cloudSync.toUpload') }}: {{ progressDetails.toAddCount ?? 0 }}</span>
            </template>
            <template v-else-if="phase === 'pulling'">
              <span>{{ t('cloudSync.pulledPages') }}: {{ progressDetails.pulledPages ?? 0 }}</span>
              <span class="sep">/</span>
              <span>{{ t('cloudSync.totalPages') }}: {{ progressDetails.totalPages ?? 0 }}</span>
            </template>
          </div>
        </div>
        <div v-if="logMsg" class="log">{{ logMsg }}</div>
      </div>
      <div class="dialog-footer">
        <div
          class="button"
          :class="{ disabled: syncing }"
          style="width: 90px; text-align: center; height: 25px; line-height: 25px"
          @click="startSync"
        >
          {{ t('cloudSync.startSync') }}
        </div>
        <div
          v-if="syncing"
          class="button"
          style="width: 90px; text-align: center; height: 25px; line-height: 25px"
          @click="minimize"
        >
          {{ t('cloudSync.minimize') }}
        </div>
        <div
          v-if="!syncing"
          class="button"
          style="width: 90px; text-align: center; height: 25px; line-height: 25px"
          @click="cancelDialog()"
        >
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
  flex: 1;
  min-height: 0;
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
.stage .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border);
}
.stage .label {
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
.stage.current .dot {
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
  background: var(--bg-elev);
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.fill {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, #3a7afe, #4da3ff);
  background-size: 200% 100%;
  animation: slideBg 2.2s linear infinite;
  transition: width 0.3s ease-in-out;
}
.fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.12) 0 8px,
    rgba(255, 255, 255, 0.04) 8px 16px
  );
  mix-blend-mode: overlay;
  animation: moveStripes 1.2s linear infinite;
}
.gloss {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.25) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-100%);
  animation: shine 2.8s ease-in-out infinite;
}
.percentText {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--text);
}
@keyframes slideBg {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: -200% 0;
  }
}
@keyframes moveStripes {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: 100px 0;
  }
}
@keyframes shine {
  0% {
    transform: translateX(-100%);
  }
  50% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(100%);
  }
}
.phase {
  text-align: center;
  font-size: 12px;
  color: var(--text-weak);
}
.progress-details {
  text-align: center;
  font-size: 11px;
  color: var(--text-weak);
  height: 16px;
  line-height: 16px;
  white-space: nowrap;
}
.progress-details .sep {
  margin: 0 6px;
  color: var(--text-weak);
}
.disabled {
  opacity: 0.6;
  pointer-events: none;
}
.hint {
  text-align: center;
  color: var(--text);
  font-size: 12px;
}
.hint-secondary {
  color: var(--text-weak);
}
.log {
  text-align: center;
  font-size: 12px;
  color: var(--text-weak);
}
</style>
