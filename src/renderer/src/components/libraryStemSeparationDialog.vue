<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useDemucsUltraModel, type StemProfile } from '@renderer/composables/useDemucsUltraModel'
import StemWaveformPreview from '@renderer/components/StemWaveformPreview.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import confirm from '@renderer/components/confirmDialog'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

type StemId = 'vocal' | 'inst' | 'bass' | 'drums'
type StemStatus = 'idle' | 'pending' | 'running' | 'ready' | 'failed'
type StemProgressStage = 'separating' | 'rendering' | 'validating' | 'saving' | 'cleaning'
type LibraryStemStatusSnapshot = {
  filePath: string
  model: string
  status: StemStatus
  errorMessage: string | null
  vocalPath: string | null
  instPath: string | null
  bassPath: string | null
  drumsPath: string | null
  percent: number | null
  activityConfirmedAt: number | null
  device: string | null
  stage: StemProgressStage | null
  stageCompleted: number | null
  stageTotal: number | null
}
const STEM_MODEL_BY_PROFILE: Record<StemProfile, string> = {
  quality: 'htdemucs@quality',
  ultra: 'htdemucs_ft@ultra'
}

const props = defineProps<{
  filePath: string
  songTitle?: string
  initialSnapshot?: unknown
}>()

const emit = defineEmits<{
  close: []
  minimize: [snapshot: LibraryStemStatusSnapshot]
}>()

const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition(160)
const starting = ref(false)
const closing = ref(false)
const exportingStem = ref<'all' | StemId | ''>('')
const exportMessage = ref('')
type StemWaveformPreviewController = { pause: () => void }
const stemPreviewById = new Map<StemId, StemWaveformPreviewController>()
const stemWaveforms = ref<Partial<Record<StemId, number[]>>>({})
const loadingStemWaveforms = ref(false)
let stemWaveformRequest = 0
const selectedProfile = ref<StemProfile>('quality')
const {
  ultraModelInfo,
  ultraModelReady,
  modelDownloadBusy,
  refreshUltraModelInfo,
  handleUltraModelDownloadState
} = useDemucsUltraModel(selectedProfile)
const selectedModel = computed(() => STEM_MODEL_BY_PROFILE[selectedProfile.value])
const snapshot = ref<LibraryStemStatusSnapshot>({
  filePath: props.filePath,
  model: STEM_MODEL_BY_PROFILE.quality,
  status: 'idle',
  errorMessage: null,
  vocalPath: null,
  instPath: null,
  bassPath: null,
  drumsPath: null,
  percent: null,
  activityConfirmedAt: null,
  device: null,
  stage: null,
  stageCompleted: null,
  stageTotal: null
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const normalizeStatus = (value: unknown): StemStatus => {
  if (value === 'pending' || value === 'running' || value === 'ready' || value === 'failed') {
    return value
  }
  return 'idle'
}

const normalizeOptionalText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const normalizeStemModel = (value: unknown) => {
  if (typeof value !== 'string') return STEM_MODEL_BY_PROFILE.quality
  const normalized = value.trim()
  return normalized === STEM_MODEL_BY_PROFILE.ultra
    ? STEM_MODEL_BY_PROFILE.ultra
    : STEM_MODEL_BY_PROFILE.quality
}

const resolveStemProfile = (model: string): StemProfile =>
  model === STEM_MODEL_BY_PROFILE.ultra ? 'ultra' : 'quality'

const normalizeOptionalNumber = (value: unknown) => {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

const normalizeProgressStage = (value: unknown): StemProgressStage | null => {
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

const parseSnapshot = (value: unknown): LibraryStemStatusSnapshot | null => {
  if (!isRecord(value)) return null
  const filePath = normalizeOptionalText(value.filePath)
  if (!filePath) return null
  return {
    filePath,
    model: normalizeStemModel(value.model),
    status: normalizeStatus(value.status),
    errorMessage: normalizeOptionalText(value.errorMessage),
    vocalPath: normalizeOptionalText(value.vocalPath),
    instPath: normalizeOptionalText(value.instPath),
    bassPath: normalizeOptionalText(value.bassPath),
    drumsPath: normalizeOptionalText(value.drumsPath),
    percent: normalizeOptionalNumber(value.percent),
    activityConfirmedAt: normalizeOptionalNumber(value.activityConfirmedAt),
    device: normalizeOptionalText(value.device),
    stage: normalizeProgressStage(value.stage),
    stageCompleted: normalizeOptionalNumber(value.stageCompleted),
    stageTotal: normalizeOptionalNumber(value.stageTotal)
  }
}

const normalizePathKey = (value: string) =>
  normalizeFilePathForComparison(value, isCurrentRendererWindowsPathPlatform())
const isCurrentSong = (value: string) =>
  normalizePathKey(value) === normalizePathKey(props.filePath)

const initialSnapshot = parseSnapshot(props.initialSnapshot)
if (initialSnapshot && isCurrentSong(initialSnapshot.filePath)) {
  selectedProfile.value = resolveStemProfile(initialSnapshot.model)
  snapshot.value = initialSnapshot
}

const applySnapshot = (value: unknown) => {
  const parsed = parseSnapshot(value)
  if (!parsed || !isCurrentSong(parsed.filePath) || parsed.model !== selectedModel.value)
    return false
  const previous = snapshot.value
  if (previous.status === 'running') {
    if (parsed.status === 'pending') return true
    if (parsed.status === 'running') {
      const previousPercent = previous.percent
      const nextPercent = parsed.percent
      if (previousPercent !== null && (nextPercent === null || nextPercent < previousPercent)) {
        return true
      }
    }
  }
  snapshot.value = parsed
  return true
}

const isSeparating = computed(
  () => snapshot.value.status === 'pending' || snapshot.value.status === 'running'
)
const selectedProfileLabel = computed(() =>
  selectedProfile.value === 'ultra'
    ? t('stemSeparation.ultraProfile')
    : t('stemSeparation.qualityProfile')
)

const stemRows = computed(() => {
  const state = snapshot.value.status
  const resolveState = (filePath: string | null) => {
    if (state === 'ready' && filePath) return 'ready' as const
    if (state === 'failed') return 'failed' as const
    if (isSeparating.value) return 'processing' as const
    return 'waiting' as const
  }
  return [
    { id: 'vocal' as const, label: t('stemSeparation.vocal'), path: snapshot.value.vocalPath },
    { id: 'inst' as const, label: t('stemSeparation.inst'), path: snapshot.value.instPath },
    { id: 'bass' as const, label: t('stemSeparation.bass'), path: snapshot.value.bassPath },
    { id: 'drums' as const, label: t('stemSeparation.drums'), path: snapshot.value.drumsPath }
  ].map((stem) => ({ ...stem, state: resolveState(stem.path) }))
})

const hasReadyStems = computed(
  () => snapshot.value.status === 'ready' && stemRows.value.every((stem) => !!stem.path)
)
const progressPercent = computed(() =>
  Math.max(0, Math.min(100, Math.round(snapshot.value.percent || 0)))
)
const progressMetaText = computed(() => {
  const deviceText = snapshot.value.device
    ? t('stemSeparation.device', { device: snapshot.value.device })
    : ''
  const activityText =
    snapshot.value.status === 'running' && snapshot.value.activityConfirmedAt
      ? t('stemSeparation.stillProcessing')
      : ''
  return [deviceText, activityText].filter(Boolean).join(' · ')
})
const canStart = computed(
  () =>
    !starting.value &&
    !closing.value &&
    !isSeparating.value &&
    !modelDownloadBusy.value &&
    ultraModelReady.value
)
const statusText = computed(() => {
  switch (snapshot.value.status) {
    case 'pending':
      return t('stemSeparation.pending')
    case 'running':
      if (snapshot.value.stage === 'validating') return t('stemSeparation.validating')
      if (snapshot.value.stage === 'rendering') {
        const { stageCompleted, stageTotal } = snapshot.value
        if (stageCompleted !== null && stageTotal !== null) {
          return t('stemSeparation.rendering', { done: stageCompleted, total: stageTotal })
        }
      }
      if (snapshot.value.stage === 'saving') {
        const { stageCompleted, stageTotal } = snapshot.value
        if (stageCompleted !== null && stageTotal !== null) {
          return t('stemSeparation.saving', { done: stageCompleted, total: stageTotal })
        }
      }
      if (snapshot.value.stage === 'cleaning') {
        const { stageCompleted, stageTotal } = snapshot.value
        if (stageCompleted !== null && stageTotal !== null) {
          return t('stemSeparation.cleaning', { done: stageCompleted, total: stageTotal })
        }
      }
      return progressPercent.value >= 94
        ? t('stemSeparation.inferenceFinishing')
        : t('stemSeparation.running', { percent: progressPercent.value })
    case 'ready':
      return t('stemSeparation.ready')
    case 'failed':
      return snapshot.value.errorMessage || t('stemSeparation.failed')
    default:
      return selectedProfileLabel.value
  }
})
const primaryActionLabel = computed(() => {
  if (selectedProfile.value === 'ultra' && !ultraModelReady.value) {
    if (modelDownloadBusy.value) return t('stemSeparation.modelDownloading')
    return ultraModelInfo.value?.state.status === 'failed'
      ? t('stemSeparation.retryModelDownload')
      : t('stemSeparation.downloadUltraModel')
  }
  if (isSeparating.value) return statusText.value
  if (hasReadyStems.value) return t('stemSeparation.exportAll')
  if (snapshot.value.status === 'failed') return t('stemSeparation.retry')
  return t('stemSeparation.start')
})
const primaryActionDisabled = computed(
  () =>
    isSeparating.value ||
    starting.value ||
    closing.value ||
    !!exportingStem.value ||
    modelDownloadBusy.value
)

const stemStateText = (state: 'waiting' | 'processing' | 'ready' | 'failed') =>
  t(`stemSeparation.stem${state.slice(0, 1).toUpperCase()}${state.slice(1)}`)

const previewUrl = (filePath: string | null) =>
  filePath ? `frkb-preview://local/?path=${encodeURIComponent(filePath)}` : ''

const parseStemWaveformPeaks = (value: unknown): number[] | null => {
  if (!isRecord(value) || !Array.isArray(value.peaks) || value.peaks.length < 8) return null
  const peaks = value.peaks
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.max(0, Math.min(1, item)))
  return peaks.length >= 8 ? peaks : null
}

const loadStemWaveforms = async () => {
  if (!hasReadyStems.value) {
    stemWaveformRequest += 1
    loadingStemWaveforms.value = false
    stemWaveforms.value = {}
    return
  }
  const request = stemWaveformRequest + 1
  stemWaveformRequest = request
  loadingStemWaveforms.value = true
  try {
    const response = await window.electron.ipcRenderer.invoke('library-stem:preview-waveforms', {
      filePath: props.filePath,
      model: selectedModel.value
    })
    if (request !== stemWaveformRequest || !isRecord(response) || !isRecord(response.stems)) return
    const next: Partial<Record<StemId, number[]>> = {}
    for (const stemId of ['vocal', 'inst', 'bass', 'drums'] as const) {
      const peaks = parseStemWaveformPeaks(response.stems[stemId])
      if (peaks) next[stemId] = peaks
    }
    stemWaveforms.value = next
  } catch {
    if (request === stemWaveformRequest) stemWaveforms.value = {}
  } finally {
    if (request === stemWaveformRequest) loadingStemWaveforms.value = false
  }
}

const refreshStatus = async () => {
  try {
    const next = await window.electron.ipcRenderer.invoke('library-stem:get-status', {
      filePath: props.filePath,
      model: selectedModel.value
    })
    applySnapshot(next)
  } catch (error) {
    snapshot.value = {
      ...snapshot.value,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : t('common.unknownError')
    }
  }
}

const startSeparation = async () => {
  if (!canStart.value) return
  starting.value = true
  exportMessage.value = ''
  try {
    const next = await window.electron.ipcRenderer.invoke('library-stem:start', {
      filePath: props.filePath,
      model: selectedModel.value
    })
    applySnapshot(next)
  } catch (error) {
    snapshot.value = {
      ...snapshot.value,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : t('common.unknownError')
    }
  } finally {
    starting.value = false
  }
}

const setStemPreviewRef = (stemId: StemId, value: unknown) => {
  if (isRecord(value) && typeof value.pause === 'function') {
    const pause = value.pause
    stemPreviewById.set(stemId, { pause: () => pause() })
  } else {
    stemPreviewById.delete(stemId)
  }
}

const handlePreviewPlay = (stemId: StemId) => {
  for (const [otherStemId, preview] of stemPreviewById.entries()) {
    if (otherStemId !== stemId) preview.pause()
  }
}

const exportStems = async (stem: 'all' | StemId) => {
  if (!hasReadyStems.value || exportingStem.value || isSeparating.value) return
  exportingStem.value = stem
  exportMessage.value = ''
  try {
    const result = await window.electron.ipcRenderer.invoke('library-stem:export', {
      filePath: props.filePath,
      model: selectedModel.value,
      stem
    })
    const exportedPaths =
      isRecord(result) && Array.isArray(result.exportedPaths) ? result.exportedPaths : []
    if (exportedPaths.length > 0) {
      exportMessage.value = t('stemSeparation.exported', { count: exportedPaths.length })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : t('common.unknownError')
    exportMessage.value = t('stemSeparation.exportFailed', { message })
  } finally {
    exportingStem.value = ''
  }
}

const runPrimaryAction = async () => {
  if (primaryActionDisabled.value) return
  if (selectedProfile.value === 'ultra' && !ultraModelReady.value) {
    await openUltraModelDownloadDialog()
    return
  }
  if (hasReadyStems.value) {
    await exportStems('all')
    return
  }
  await startSeparation()
}

const openUltraModelDownloadDialog = async () => {
  if (starting.value) return
  starting.value = true
  try {
    const { default: openDemucsUltraModelDownloadDialog } =
      await import('./demucsUltraModelDownloadDialog')
    await openDemucsUltraModelDownloadDialog({ initialInfo: ultraModelInfo.value })
  } finally {
    await Promise.all([refreshUltraModelInfo(), refreshStatus()])
    starting.value = false
  }
}

const selectProfile = async (profile: StemProfile) => {
  if (profile === selectedProfile.value || isSeparating.value || starting.value || closing.value)
    return
  selectedProfile.value = profile
  stemWaveformRequest += 1
  loadingStemWaveforms.value = false
  stemWaveforms.value = {}
  for (const preview of stemPreviewById.values()) preview.pause()
  snapshot.value = {
    filePath: props.filePath,
    model: selectedModel.value,
    status: 'idle',
    errorMessage: null,
    vocalPath: null,
    instPath: null,
    bassPath: null,
    drumsPath: null,
    percent: null,
    activityConfirmedAt: null,
    device: null,
    stage: null,
    stageCompleted: null,
    stageTotal: null
  }
  if (profile === 'ultra') {
    void refreshStatus()
    if (!ultraModelReady.value) await openUltraModelDownloadDialog()
    return
  }
  await Promise.all([refreshStatus(), refreshUltraModelInfo()])
}

const closeDialog = async () => {
  if (closing.value) return
  if (isSeparating.value) {
    const result = await confirm({
      title: t('stemSeparation.cancelConfirmTitle'),
      content: [t('stemSeparation.cancelConfirmContent')],
      confirmText: t('stemSeparation.cancelConfirmAction'),
      cancelText: t('stemSeparation.cancelConfirmStay')
    })
    if (result !== 'confirm') return
    closing.value = true
    try {
      await window.electron.ipcRenderer.invoke('library-stem:cancel', {
        filePath: props.filePath,
        model: selectedModel.value
      })
    } catch (error) {
      closing.value = false
      snapshot.value = {
        ...snapshot.value,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : t('common.unknownError')
      }
      return
    }
  }
  closeWithAnimation(() => emit('close'))
}

const minimizeDialog = () => {
  if (!isSeparating.value || closing.value) return
  const minimizedSnapshot = { ...snapshot.value }
  closeWithAnimation(() => emit('minimize', minimizedSnapshot))
}

const handleStemStatusUpdated = (_event: unknown, payload: unknown) => {
  applySnapshot(payload)
}

watch(
  () => stemRows.value.map((stem) => stem.path || '').join('\u0000'),
  () => void loadStemWaveforms()
)

onMounted(() => {
  window.electron.ipcRenderer.on('library-stem-status-updated', handleStemStatusUpdated)
  window.electron.ipcRenderer.on('demucs-model-download-state', handleUltraModelDownloadState)
  hotkeys('Esc', uuid, () => {
    void closeDialog()
  })
  utils.setHotkeysScpoe(uuid)
  void Promise.all([refreshStatus(), refreshUltraModelInfo()])
})

onUnmounted(() => {
  window.electron.ipcRenderer.removeListener('library-stem-status-updated', handleStemStatusUpdated)
  window.electron.ipcRenderer.removeListener(
    'demucs-model-download-state',
    handleUltraModelDownloadState
  )
  stemWaveformRequest += 1
  for (const preview of stemPreviewById.values()) preview.pause()
  stemPreviewById.clear()
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner library-stem-dialog__inner">
      <div class="dialog-title dialog-header">
        <span>{{ t('stemSeparation.dialogTitle') }}</span>
      </div>
      <div class="library-stem-dialog__body">
        <section class="library-stem-dialog__summary">
          <div class="library-stem-dialog__song-title">
            {{ props.songTitle || t('tracks.unknownTrack') }}
          </div>
          <div
            class="library-stem-dialog__profile-picker"
            :aria-label="t('stemSeparation.profileLabel')"
          >
            <button
              class="library-stem-dialog__profile-option"
              type="button"
              :class="{ 'is-selected': selectedProfile === 'quality' }"
              :disabled="isSeparating || starting || closing"
              @click="selectProfile('quality')"
            >
              {{ t('stemSeparation.qualityProfile') }}
            </button>
            <button
              class="library-stem-dialog__profile-option"
              type="button"
              :class="{ 'is-selected': selectedProfile === 'ultra' }"
              :disabled="isSeparating || starting || closing"
              @click="selectProfile('ultra')"
            >
              {{ t('stemSeparation.ultraProfile') }}
            </button>
          </div>
        </section>

        <section class="library-stem-dialog__progress-card" :class="`is-${snapshot.status}`">
          <div class="library-stem-dialog__progress-header" role="status">
            <bubbleBoxTrigger
              tag="span"
              class="library-stem-dialog__progress-status"
              :title="statusText"
            >
              {{ statusText }}
            </bubbleBoxTrigger>
            <span v-if="snapshot.status === 'running'" class="library-stem-dialog__progress-number">
              {{ progressPercent }}%
            </span>
          </div>
          <bubbleBoxTrigger
            tag="span"
            class="status-device"
            :class="{ 'is-hidden': !progressMetaText }"
            :title="progressMetaText"
          >
            {{ progressMetaText || '—' }}
          </bubbleBoxTrigger>
          <div
            class="library-stem-dialog__progress-track"
            :class="{
              'is-indeterminate': snapshot.status === 'pending',
              'is-complete': snapshot.status === 'ready'
            }"
          >
            <div
              class="library-stem-dialog__progress-fill"
              :style="{
                width:
                  snapshot.status === 'running'
                    ? `${progressPercent}%`
                    : snapshot.status === 'ready'
                      ? '100%'
                      : undefined
              }"
            />
          </div>
        </section>

        <section class="library-stem-dialog__stems">
          <div
            v-for="stem in stemRows"
            :key="stem.id"
            class="library-stem-dialog__stem-row"
            :class="`is-${stem.state}`"
          >
            <div class="library-stem-dialog__stem-meta">
              <div class="library-stem-dialog__stem-name">{{ stem.label }}</div>
              <div class="library-stem-dialog__stem-state">{{ stemStateText(stem.state) }}</div>
            </div>
            <div class="library-stem-dialog__preview-slot">
              <StemWaveformPreview
                v-if="stem.state === 'ready' && stem.path"
                :ref="(element) => setStemPreviewRef(stem.id, element)"
                class="library-stem-dialog__waveform"
                :src="previewUrl(stem.path)"
                :peaks="stemWaveforms[stem.id] || null"
                :loading="loadingStemWaveforms"
                :stem-label="stem.label"
                @play="handlePreviewPlay(stem.id)"
              />
              <div
                v-else
                class="library-stem-dialog__preview-placeholder"
                :class="{ 'is-processing': stem.state === 'processing' }"
                aria-hidden="true"
              />
            </div>
            <button
              class="button library-stem-dialog__button library-stem-dialog__export-one"
              type="button"
              :class="{ 'is-disabled': stem.state !== 'ready' || !!exportingStem }"
              :disabled="stem.state !== 'ready' || !!exportingStem"
              @click="exportStems(stem.id)"
            >
              {{ exportingStem === stem.id ? t('common.loading') : t('stemSeparation.exportOne') }}
            </button>
          </div>
        </section>
        <div class="library-stem-dialog__export-message" :class="{ 'is-visible': exportMessage }">
          {{ exportMessage }}
        </div>
      </div>
      <div class="dialog-footer library-stem-dialog__footer">
        <div
          class="button library-stem-dialog__footer-button library-stem-dialog__footer-primary"
          :class="{ disabled: primaryActionDisabled }"
          @click="runPrimaryAction"
        >
          {{ starting || exportingStem === 'all' ? t('common.loading') : primaryActionLabel }}
        </div>
        <div
          v-if="isSeparating && !closing"
          class="button library-stem-dialog__footer-button"
          @click="minimizeDialog"
        >
          {{ t('stemSeparation.minimize') }}
        </div>
        <div
          class="button library-stem-dialog__footer-button"
          :class="{ disabled: closing }"
          @click="closeDialog"
        >
          {{ closing ? t('common.loading') : `${t('common.close')} (Esc)` }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.library-stem-dialog__inner {
  display: flex;
  width: min(780px, calc(100vw - 32px));
  max-height: min(600px, calc(100vh - 32px));
  flex-direction: column;
}

.library-stem-dialog__body {
  min-height: 0;
  flex: 1 1 auto;
  padding: 16px 20px 12px;
  overflow: auto;
}

.library-stem-dialog__summary {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.library-stem-dialog__song-title {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-stem-dialog__profile-picker {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.library-stem-dialog__profile-option {
  display: flex;
  min-height: 26px;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  appearance: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  text-align: center;
  transition:
    border-color 140ms ease,
    background 140ms ease,
    box-shadow 140ms ease;
}

.library-stem-dialog__profile-option:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
  background: color-mix(in srgb, var(--accent) 6%, var(--waveform-bg-elev));
  color: var(--text);
}

.library-stem-dialog__profile-option.is-selected {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 9%, var(--waveform-bg-elev));
  color: var(--text);
}

.library-stem-dialog__profile-option:disabled {
  cursor: default;
}

.library-stem-dialog__profile-option:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
  outline-offset: 2px;
}

.library-stem-dialog__progress-card {
  height: 66px;
  box-sizing: border-box;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--waveform-bg-elev);
  color: var(--text-secondary);
}

.library-stem-dialog__progress-card.is-ready {
  border-color: color-mix(in srgb, var(--success, #107c10) 42%, var(--border));
  color: var(--success, #107c10);
}

.library-stem-dialog__progress-card.is-failed {
  border-color: color-mix(in srgb, var(--error, #f56c6c) 42%, var(--border));
  color: var(--error, #f56c6c);
}

.library-stem-dialog__progress-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  font-weight: 650;
  line-height: 16px;
}

.library-stem-dialog__progress-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-stem-dialog__progress-number,
.status-device {
  display: block;
  min-height: 14px;
  margin-top: 2px;
  font-size: 11px;
  line-height: 14px;
}

.status-device.is-hidden {
  visibility: hidden;
}

.status-device {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-stem-dialog__progress-track {
  height: 5px;
  margin-top: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-elev);
}

.library-stem-dialog__progress-fill {
  width: 0;
  min-width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 120ms linear;
}

.library-stem-dialog__progress-track.is-complete .library-stem-dialog__progress-fill {
  background: var(--success, #107c10);
}

.library-stem-dialog__progress-track.is-indeterminate .library-stem-dialog__progress-fill {
  width: 34%;
  min-width: 34%;
  opacity: 0.7;
  animation: library-stem-dialog-pending-pulse 1.65s ease-in-out infinite;
}

.library-stem-dialog__stems {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.library-stem-dialog__stem-row {
  display: grid;
  height: 70px;
  box-sizing: border-box;
  grid-template-columns: 104px minmax(0, 1fr) 72px;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--waveform-bg-elev);
  transition:
    border-color 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease;
}

.library-stem-dialog__stem-row.is-processing {
  border-color: color-mix(in srgb, var(--accent) 52%, var(--border));
}

.library-stem-dialog__stem-row.is-ready {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}

.library-stem-dialog__stem-row.is-failed {
  border-color: color-mix(in srgb, var(--error, #f56c6c) 52%, var(--border));
}

.library-stem-dialog__stem-name {
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
}

.library-stem-dialog__stem-state {
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 14px;
}

.library-stem-dialog__preview-slot {
  height: 36px;
  min-width: 0;
}

.library-stem-dialog__waveform {
  width: 100%;
  min-width: 0;
}

.library-stem-dialog__preview-placeholder {
  position: relative;
  height: 36px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--waveform-bg);
}

.library-stem-dialog__preview-placeholder::before {
  position: absolute;
  inset: 7px 10px;
  content: '';
  background: repeating-linear-gradient(
    90deg,
    color-mix(in srgb, var(--text-secondary) 34%, transparent) 0 1px,
    transparent 1px 4px
  );
  mask-image: linear-gradient(90deg, transparent 0, #000 4%, #000 96%, transparent 100%);
  opacity: 0.42;
}
.library-stem-dialog__preview-placeholder.is-processing::after {
  position: absolute;
  top: 5px;
  bottom: 5px;
  left: -32%;
  width: 26%;
  content: '';
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 34%, transparent),
    transparent
  );
  opacity: 0.72;
  pointer-events: none;
  transform: translateX(0);
  animation: library-stem-dialog-waveform-marquee 1.8s ease-in-out infinite;
}

.library-stem-dialog__button {
  min-width: 72px;
  height: 32px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  appearance: none;
  background: var(--hover);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 30px;
  text-align: center;
  transition:
    border-color 140ms ease,
    background 140ms ease,
    color 140ms ease,
    opacity 140ms ease,
    box-shadow 140ms ease,
    transform 140ms ease;
}

.library-stem-dialog__button:hover:not(:disabled) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--hover));
  color: var(--text);
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 12%, transparent);
  transform: translateY(-1px);
}

.library-stem-dialog__button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
  outline-offset: 2px;
}

.library-stem-dialog__button:disabled,
.library-stem-dialog__button.is-disabled {
  opacity: 0.44;
  cursor: default;
}

.library-stem-dialog__button:disabled:hover,
.library-stem-dialog__button.is-disabled:hover {
  border-color: var(--border);
  background: var(--hover);
  color: var(--text);
}

.library-stem-dialog__export-one {
  min-width: 64px;
}

.library-stem-dialog__export-message {
  height: 18px;
  margin-top: 8px;
  overflow: hidden;
  color: var(--success, #107c10);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  visibility: hidden;
  white-space: nowrap;
}

.library-stem-dialog__export-message.is-visible {
  visibility: visible;
}

.library-stem-dialog__footer {
  flex-shrink: 0;
}
.library-stem-dialog__footer-button {
  width: 96px;
  text-align: center;
  white-space: nowrap;
}
.library-stem-dialog__footer-primary {
  width: 124px;
}
.library-stem-dialog__footer-button.disabled {
  opacity: 0.44;
  pointer-events: none;
}

@keyframes library-stem-dialog-waveform-marquee {
  to {
    transform: translateX(510%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .library-stem-dialog__preview-placeholder.is-processing::after {
    animation: none;
  }
  .library-stem-dialog__button {
    transition: none;
  }
}
@media (max-width: 560px) {
  .library-stem-dialog__inner {
    max-height: min(600px, calc(100vh - 24px));
  }

  .library-stem-dialog__body {
    padding: 14px 12px 10px;
  }

  .library-stem-dialog__profile-picker {
    gap: 1px;
  }

  .library-stem-dialog__profile-option {
    min-height: 24px;
    padding: 0 5px;
    font-size: 10px;
  }

  .library-stem-dialog__stem-row {
    grid-template-columns: 82px minmax(0, 1fr) 62px;
    gap: 8px;
    padding: 8px;
  }

  .library-stem-dialog__button {
    min-width: 62px;
    padding: 0 6px;
  }
}
</style>
