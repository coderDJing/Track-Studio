<script setup lang="ts">
import { computed } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t } from '@renderer/utils/translate'
import type { BatchRenameSongListTarget } from './index'
import openPresetManagerDialog from './presetManagerDialog'
import { usePlaylistBatchRenameDialog } from './usePlaylistBatchRenameDialog'
import type { IBatchRenamePreviewResult, IBatchRenameTrackInput } from 'src/types/globals'

const props = defineProps<{
  title: string
  songLists: BatchRenameSongListTarget[]
  tracks?: IBatchRenameTrackInput[]
}>()

const emits = defineEmits<{
  (event: 'close'): void
  (event: 'proceed', payload: IBatchRenamePreviewResult): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const {
  draftChanged,
  formulaSummary,
  generatePreview,
  isTemplateBlank,
  presets,
  reloadPresetState,
  sampleItems,
  sampleLoading,
  scanNow,
  scanTotal,
  scanning,
  scrollbarOptions,
  selectedPresetId,
  selectedPreset,
  switchPreset
} = usePlaylistBatchRenameDialog({
  songLists: props.songLists,
  tracks: props.tracks || []
})

const presetOptions = computed(() =>
  presets.value.map((preset) => ({
    label: preset.name,
    value: preset.id
  }))
)

const handleClose = () => closeWithAnimation(() => emits('close'))

const handleManagePresets = async () => {
  const nextPresetId = await openPresetManagerDialog({
    title: props.title,
    songLists: props.songLists,
    tracks: props.tracks || [],
    selectedPresetId: selectedPresetId.value
  })
  if (nextPresetId) {
    reloadPresetState(nextPresetId)
  }
}

const handleGeneratePreview = async () => {
  const result = await generatePreview()
  if (!result || !Array.isArray(result.items) || result.items.length === 0) return
  closeWithAnimation(() => emits('proceed', result))
}
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ title }}</div>

      <div class="content">
        <div v-if="scanning" class="scan-panel">
          <div class="scan-title">{{ t('batchRename.scanningTitle') }}</div>
          <div class="scan-desc">
            {{ t('batchRename.scanningDescription', { now: scanNow, total: scanTotal }) }}
          </div>
        </div>

        <OverlayScrollbarsComponent
          v-else
          class="body-scroll"
          :options="scrollbarOptions"
          element="div"
          defer
        >
          <div class="body">
            <div class="toolbar">
              <BaseSelect
                :model-value="selectedPresetId"
                :options="presetOptions"
                :width="'220px'"
                @change="(value) => (typeof value === 'string' ? switchPreset(value) : null)"
              />
              <div class="toolbar-actions">
                <div class="button" @click="handleManagePresets">
                  {{ t('batchRename.managePresets') }}
                </div>
              </div>
            </div>

            <div class="status-line">
              <span v-if="draftChanged">{{ t('batchRename.unsaved') }}</span>
            </div>

            <div class="formula-box">
              <div class="formula-name">{{ selectedPreset?.name || '' }}</div>
              <bubbleBoxTrigger tag="div" class="formula-text" :title="formulaSummary || ''">
                {{ formulaSummary || t('batchRename.sampleEmptyTemplate') }}
              </bubbleBoxTrigger>
            </div>

            <div class="sample-box">
              <div class="sample-title">{{ t('batchRename.sampleTitle') }}</div>
              <div v-if="sampleLoading" class="sample-empty">
                {{ t('batchRename.sampleLoading') }}
              </div>
              <div v-else-if="sampleItems.length === 0" class="sample-empty">
                {{
                  isTemplateBlank
                    ? t('batchRename.sampleEmptyTemplate')
                    : t('batchRename.sampleEmpty')
                }}
              </div>
              <div v-else class="sample-list">
                <div v-for="item in sampleItems" :key="item.id" class="sample-row">
                  <div class="sample-line sample-line-source">
                    <span class="sample-label">{{ t('batchRename.sampleOriginalLabel') }}</span>
                    <bubbleBoxTrigger
                      tag="span"
                      class="sample-source"
                      :title="item.originalFileName"
                    >
                      {{ item.originalFileName }}
                    </bubbleBoxTrigger>
                  </div>
                  <div class="sample-line sample-line-target">
                    <span class="sample-label">{{ t('batchRename.sampleTargetLabel') }}</span>
                    <bubbleBoxTrigger tag="span" class="sample-target" :title="item.targetFileName">
                      {{ item.targetFileName }}
                    </bubbleBoxTrigger>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </OverlayScrollbarsComponent>
      </div>

      <div class="dialog-footer">
        <div class="button primary" @click="handleGeneratePreview">
          {{ t('batchRename.generatePreview') }}
        </div>
        <div class="button" @click="handleClose">{{ t('common.close') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: min(900px, calc(100vw - 40px));
  max-width: calc(100vw - 20px);
  height: min(620px, calc(100vh - 40px));
  max-height: calc(100vh - 20px);
  min-height: min(540px, var(--dialog-available-height));
  padding: 0;
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  min-height: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.scan-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.scan-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.scan-desc,
.status-line,
.sample-empty {
  font-size: 12px;
  color: var(--text-weak);
}

.body-scroll {
  flex: 1;
  min-height: 0;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 2px;
}

.toolbar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  min-width: 0;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.status-line {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  min-height: 16px;
}

.formula-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.formula-name {
  font-size: 12px;
  color: var(--text-weak);
}

.formula-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text);
}

.sample-title {
  font-size: 12px;
  color: var(--text-weak);
  margin-bottom: 6px;
}

.sample-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sample-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.sample-line {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}

.sample-line-source {
  grid-template-columns: 52px minmax(0, 1fr);
}

.sample-label,
.sample-source,
.sample-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.sample-label {
  color: var(--text-weak);
}

.sample-source,
.sample-target {
  color: var(--text);
}

.sample-target {
  color: var(--text-weak);
}

.button.primary {
  min-width: 132px;
  text-align: center;
}

.button.danger {
  color: #ff9f9f;
}

@media (max-width: 900px) {
  .toolbar {
    align-items: stretch;
  }

  .toolbar :deep(.base-select) {
    width: 100% !important;
  }

  .sample-line,
  .sample-line-source {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
