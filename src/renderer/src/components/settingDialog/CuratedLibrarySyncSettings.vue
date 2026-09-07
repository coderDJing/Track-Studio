<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { runCuratedLibrarySyncUi } from '@renderer/composables/runCuratedLibrarySyncUi'
import type {
  CuratedLibrarySyncActivity,
  CuratedLibrarySyncConflictItem,
  CuratedLibrarySyncConflictKind,
  CuratedLibrarySyncFailureItem,
  CuratedLibrarySyncOverview
} from '../../../../shared/curatedLibrarySync'

const runtime = useRuntimeStore()

const persistSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const CONFLICT_KIND_KEYS: Record<CuratedLibrarySyncConflictKind, string> = {
  'file-move-lost': 'cloudSync.curatedLibrary.conflictKinds.fileMoveLost',
  'file-rename-lost': 'cloudSync.curatedLibrary.conflictKinds.fileRenameLost',
  'file-content-lost': 'cloudSync.curatedLibrary.conflictKinds.fileContentLost',
  'file-delete-lost': 'cloudSync.curatedLibrary.conflictKinds.fileDeleteLost',
  'file-undelete-lost': 'cloudSync.curatedLibrary.conflictKinds.fileUndeleteLost',
  'file-order-lost': 'cloudSync.curatedLibrary.conflictKinds.fileOrderLost',
  'node-change-lost': 'cloudSync.curatedLibrary.conflictKinds.nodeChangeLost',
  'node-delete-lost': 'cloudSync.curatedLibrary.conflictKinds.nodeDeleteLost'
}

const emptyActivity = (): CuratedLibrarySyncActivity => ({
  running: false,
  phase: 'idle',
  now: 0,
  total: 0
})

const emptyOverview = (): CuratedLibrarySyncOverview => ({
  liveConnected: false,
  snapshotReady: false,
  revision: 0,
  fileCount: 0,
  quotaUsedBytes: 0,
  quotaBytes: 0,
  conflicts: [],
  failures: [],
  activity: emptyActivity()
})

const overview = ref<CuratedLibrarySyncOverview>(emptyOverview())
const syncing = ref(false)
const MAX_VISIBLE_FAILURES = 8
let liveTimer: ReturnType<typeof setInterval> | null = null

const enabledModel = computed<boolean>({
  get: () => runtime.setting.curatedLibrarySyncEnabled === true,
  set: (value) => {
    runtime.setting.curatedLibrarySyncEnabled = value === true
  }
})

const quotaPercent = computed(() => {
  const limit = overview.value.quotaBytes
  if (limit <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((overview.value.quotaUsedBytes / limit) * 100)))
})

const quotaNearFull = computed(() => overview.value.quotaBytes > 0 && quotaPercent.value >= 90)

const visibleFailures = computed(() => overview.value.failures.slice(0, MAX_VISIBLE_FAILURES))

const extraFailureCount = computed(() =>
  Math.max(0, overview.value.failures.length - visibleFailures.value.length)
)

const activity = computed(() => overview.value.activity || emptyActivity())

const activityVisible = computed(
  () => activity.value.running === true && activity.value.phase !== 'idle'
)

const activityPercent = computed(() => {
  const total = activity.value.total
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((activity.value.now / total) * 100)))
})

const activityText = computed(() => {
  const { phase, now, total } = activity.value
  if (phase === 'scanning') {
    return t('cloudSync.curatedLibrary.activityScanning', { now, total })
  }
  if (phase === 'downloading') {
    return t('cloudSync.curatedLibrary.activityDownloading', { now, total })
  }
  if (phase === 'uploading') {
    return t('cloudSync.curatedLibrary.activityUploading', { now, total })
  }
  if (phase === 'waiting-first-snapshot') {
    return t('cloudSync.curatedLibrary.activityWaitingFirstSnapshot')
  }
  if (phase === 'applying') {
    return t('cloudSync.curatedLibrary.activityApplying')
  }
  return ''
})

const showFirstSnapshotHint = computed(
  () => activityVisible.value && overview.value.snapshotReady !== true
)

const refreshOverview = async () => {
  try {
    const next = (await window.electron.ipcRenderer.invoke(
      'curatedLibrarySync/getOverview'
    )) as CuratedLibrarySyncOverview
    overview.value = {
      ...next,
      activity: next.activity || emptyActivity()
    }
  } catch {
    overview.value = {
      ...emptyOverview(),
      conflicts: overview.value.conflicts,
      failures: overview.value.failures
    }
  }
}

const handleEnabledChange = async () => {
  await persistSetting()
}

watch(
  () => runtime.setting.curatedLibrarySyncEnabled,
  () => {
    window.setTimeout(() => {
      void refreshOverview()
    }, 400)
  }
)

const retryFailures = async () => {
  if (syncing.value || !enabledModel.value) return
  syncing.value = true
  try {
    await runCuratedLibrarySyncUi({ trigger: 'manual' })
    await refreshOverview()
  } finally {
    syncing.value = false
  }
}

const conflictLine = (item: CuratedLibrarySyncConflictItem) => {
  const kind = t(CONFLICT_KIND_KEYS[item.kind])
  if (item.otherName) {
    return t('cloudSync.curatedLibrary.conflictLineNamed', {
      kind,
      name: item.name,
      otherName: item.otherName
    })
  }
  return t('cloudSync.curatedLibrary.conflictLine', { kind, name: item.name })
}

const showConflicts = async () => {
  const items = overview.value.conflicts
  if (items.length === 0) return
  await confirm({
    title: t('cloudSync.curatedLibrary.conflictsTitle'),
    content: items.map((item) => conflictLine(item)),
    confirmShow: false,
    innerHeight: 320
  })
}

const clearConflicts = async () => {
  await window.electron.ipcRenderer.invoke('curatedLibrarySync/clearConflicts')
  await refreshOverview()
}

const clearFailures = async () => {
  await window.electron.ipcRenderer.invoke('curatedLibrarySync/clearFailures')
  await refreshOverview()
}

const failureText = (item: CuratedLibrarySyncFailureItem) => {
  const direction =
    item.direction === 'upload'
      ? t('cloudSync.curatedLibrary.uploadFailed')
      : t('cloudSync.curatedLibrary.downloadFailed')
  return `${direction} · ${t(item.errorKey)}`
}

defineExpose({ refreshOverview })

const handleNotice = () => {
  void refreshOverview()
}

onMounted(() => {
  window.electron.ipcRenderer.on('curatedLibrarySync/notice', handleNotice)
  void refreshOverview()
  liveTimer = setInterval(() => {
    void refreshOverview()
  }, 1000)
})

onBeforeUnmount(() => {
  window.electron.ipcRenderer.removeListener('curatedLibrarySync/notice', handleNotice)
  if (liveTimer != null) {
    clearInterval(liveTimer)
    liveTimer = null
  }
})
</script>

<template>
  <div class="curated-sync">
    <label class="setting-block" for="setting-checkbox-curatedLibrarySync">
      {{ t('cloudSync.curatedLibrary.enabled') }}
    </label>
    <div class="setting-control">
      <singleCheckbox
        id="setting-checkbox-curatedLibrarySync"
        v-model="enabledModel"
        @change="handleEnabledChange()"
      />
      <div class="setting-hint">{{ t('cloudSync.curatedLibrary.enabledHint') }}</div>
      <div class="setting-hint">{{ t('cloudSync.curatedLibrary.scopeHint') }}</div>
    </div>

    <div class="setting-block">{{ t('cloudSync.curatedLibrary.liveStatus') }}</div>
    <div class="setting-control">
      <div class="status-value" :class="{ on: overview.liveConnected }">
        {{
          overview.liveConnected
            ? t('cloudSync.curatedLibrary.liveConnected')
            : t('cloudSync.curatedLibrary.liveDisconnected')
        }}
      </div>
      <div class="setting-hint">{{ t('cloudSync.curatedLibrary.liveHint') }}</div>
    </div>

    <template v-if="activityVisible">
      <div class="setting-block">{{ t('cloudSync.curatedLibrary.activityTitle') }}</div>
      <div class="setting-control">
        <div class="status-value on">{{ activityText }}</div>
        <div v-if="activity.total > 0" class="quota-bar">
          <div class="quota-bar-fill" :style="{ width: `${activityPercent}%` }" />
        </div>
        <div v-if="showFirstSnapshotHint" class="setting-hint">
          {{ t('cloudSync.curatedLibrary.activityFirstSnapshotHint') }}
        </div>
      </div>
    </template>

    <div class="setting-block">{{ t('cloudSync.curatedLibrary.quota') }}</div>
    <div class="setting-control">
      <div class="status-value" :class="{ warn: quotaNearFull }">
        {{
          overview.quotaBytes > 0
            ? t('cloudSync.curatedLibrary.quotaValue', {
                used: formatAnalysisRuntimeBytes(overview.quotaUsedBytes),
                limit: formatAnalysisRuntimeBytes(overview.quotaBytes),
                count: overview.fileCount
              })
            : t('cloudSync.curatedLibrary.quotaUnknown', {
                used: formatAnalysisRuntimeBytes(overview.quotaUsedBytes)
              })
        }}
      </div>
      <div v-if="overview.quotaBytes > 0" class="quota-bar" :class="{ warn: quotaNearFull }">
        <div class="quota-bar-fill" :style="{ width: `${quotaPercent}%` }" />
      </div>
      <div v-if="quotaNearFull" class="setting-hint warn-hint">
        {{ t('cloudSync.curatedLibrary.quotaNearFull') }}
      </div>
    </div>

    <template v-if="overview.conflicts.length > 0">
      <div class="setting-block">{{ t('cloudSync.curatedLibrary.conflictsTitle') }}</div>
      <div class="setting-control">
        <div class="status-value warn">
          {{ t('cloudSync.curatedLibrary.conflictsCount', { count: overview.conflicts.length }) }}
        </div>
        <div class="buttonRow">
          <div class="button settings-inline-button" @click="void showConflicts()">
            {{ t('cloudSync.curatedLibrary.viewConflicts') }}
          </div>
          <div class="button settings-inline-button" @click="void clearConflicts()">
            {{ t('cloudSync.curatedLibrary.clearConflicts') }}
          </div>
        </div>
      </div>
    </template>

    <template v-if="overview.failures.length > 0">
      <div class="setting-block">{{ t('cloudSync.curatedLibrary.failuresTitle') }}</div>
      <div class="setting-control">
        <div class="status-value warn">{{ overview.failures.length }}</div>
        <div class="failure-list">
          <div
            v-for="(item, index) in visibleFailures"
            :key="`${item.atMs}-${item.name}-${index}`"
            class="failure-row"
          >
            <bubbleBoxTrigger tag="div" class="failure-name" :title="item.name" only-when-overflow>
              {{ item.name }}
            </bubbleBoxTrigger>
            <bubbleBoxTrigger
              tag="div"
              class="failure-meta"
              :title="failureText(item)"
              only-when-overflow
            >
              {{ failureText(item) }}
            </bubbleBoxTrigger>
          </div>
        </div>
        <div v-if="extraFailureCount > 0" class="setting-hint">
          {{ t('cloudSync.curatedLibrary.failuresMore', { count: extraFailureCount }) }}
        </div>
        <div class="buttonRow">
          <bubbleBoxTrigger
            tag="div"
            class="button-anchor"
            :title="enabledModel ? '' : t('cloudSync.curatedLibrary.errors.notEnabled')"
          >
            <div
              class="button settings-inline-button"
              :class="{ disabled: !enabledModel || syncing }"
              @click="enabledModel ? void retryFailures() : undefined"
            >
              {{ t('cloudSync.curatedLibrary.retryAll') }}
            </div>
          </bubbleBoxTrigger>
          <div class="button settings-inline-button" @click="void clearFailures()">
            {{ t('cloudSync.curatedLibrary.clearFailures') }}
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.curated-sync {
  display: flex;
  flex-direction: column;
}

.setting-block {
  margin-top: 18px;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  line-height: 1.4;
}

.setting-block:first-child {
  margin-top: 18px;
}

label.setting-block {
  display: block;
  user-select: none;
}

.setting-control {
  margin-top: 10px;
  max-width: 100%;
}

.setting-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 8px;
  line-height: 1.5;
  text-align: left;
}

.buttonRow {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.button-anchor {
  width: fit-content;
}

.settings-inline-button {
  width: fit-content;
  min-width: 110px;
  text-align: center;
}

.settings-inline-button.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.status-value {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}

.status-value.on {
  color: var(--accent);
}

.status-value.warn,
.warn-hint {
  color: #e81123;
}

.quota-bar {
  margin-top: 8px;
  width: min(360px, 100%);
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--border);
}

.quota-bar-fill {
  height: 100%;
  background: var(--accent);
}

.quota-bar.warn .quota-bar-fill {
  background: #e81123;
}

.failure-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(520px, 100%);
}

.failure-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr);
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
}

.failure-name,
.failure-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.5;
}

.failure-name {
  color: var(--text);
}

.failure-meta {
  color: var(--text-secondary);
}
</style>
