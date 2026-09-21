<script setup lang="ts">
import { t } from '@renderer/utils/translate'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import {
  useMusicBrainzDialog,
  type MusicBrainzDialogProps
} from './composables/useMusicBrainzDialog'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = withDefaults(defineProps<MusicBrainzDialogProps>(), {
  initialQuery: () => ({})
})

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const {
  flashArea,
  query,
  durationSeconds,
  state,
  isTextTab,
  showAcoustIdPanel,
  acoustIdKeyInput,
  acoustIdKeyError,
  savingAcoustIdKey,
  hasAcoustIdKey,
  hasQueryTextInput,
  fingerprintStatusText,
  displayedResults,
  currentSelectedRecordingId,
  currentSuggestion,
  currentSuggestionError,
  currentSuggestionLoading,
  currentErrorMessage,
  shouldShowEmptyState,
  suggestionCoverDataUrl,
  fieldMeta,
  fieldSelections,
  canConfirm,
  searchMusicBrainz,
  openAcoustIdPanelManually,
  saveAcoustIdKey,
  cancelAcoustIdSetup,
  openAcoustIdRegister,
  selectMatch,
  hasMusicBrainzValue,
  getFieldText,
  describeMatchedFields,
  shouldShowDurationDiff,
  durationDiffClass,
  durationDiffText,
  hasIsrcMatch,
  hasLowConfidence,
  getMatchSourceLabel,
  sourceTagClass,
  formatSeconds,
  handleConfirm,
  handleCancel,
  onTabClick
} = useMusicBrainzDialog({
  ...props,
  confirmCallback: (payload) => {
    closeWithAnimation(() => props.confirmCallback(payload))
  },
  cancelCallback: () => {
    closeWithAnimation(() => props.cancelCallback())
  }
})
</script>

<template>
  <div class="dialog musicbrainz-dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ t('metadata.musicbrainzDialogTitle') }}</div>
      <div class="body">
        <OverlayScrollbarsComponent
          :options="{
            scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
            overflow: { x: 'hidden', y: 'scroll' } as const
          }"
          element="div"
          style="height: 100%; width: 100%"
          defer
        >
          <div class="content">
            <div class="tabs">
              <div class="tab" :class="{ active: isTextTab }" @click="onTabClick('text')">
                {{ t('metadata.musicbrainzTabText') }}
              </div>
              <div class="tab" :class="{ active: !isTextTab }" @click="onTabClick('fingerprint')">
                {{ t('metadata.musicbrainzTabFingerprint') }}
              </div>
            </div>

            <div v-if="isTextTab" class="section">
              <div class="section-title">{{ t('metadata.musicbrainzQueryTitle') }}</div>
              <div class="musicbrainz-query-grid">
                <label>{{ t('metadata.title') }}</label>
                <input v-model="query.title" :disabled="state.searching" />
                <label>{{ t('metadata.artist') }}</label>
                <input v-model="query.artist" :disabled="state.searching" />
                <label>{{ t('metadata.album') }}</label>
                <input v-model="query.album" :disabled="state.searching" />
                <label>{{ t('columns.duration') }}</label>
                <div class="musicbrainz-duration">
                  {{ formatSeconds(durationSeconds) }}
                </div>
              </div>
              <div class="musicbrainz-panel-actions">
                <div
                  class="button"
                  :class="{
                    disabled: state.searching || !hasQueryTextInput || state.fingerprintMatching
                  }"
                  @click="
                    state.searching || !hasQueryTextInput || state.fingerprintMatching
                      ? null
                      : searchMusicBrainz()
                  "
                >
                  {{
                    state.searching
                      ? t('metadata.musicbrainzSearching')
                      : t('metadata.musicbrainzSearch')
                  }}
                </div>
              </div>
            </div>

            <div v-else class="section fingerprint-section">
              <div class="section-title">{{ t('metadata.musicbrainzTabFingerprint') }}</div>
              <div class="fingerprint-meta-row">
                <label>{{ t('columns.duration') }}</label>
                <div class="musicbrainz-duration">{{ formatSeconds(durationSeconds) }}</div>
              </div>
              <p class="hint-text">{{ t('metadata.musicbrainzFingerprintIntro') }}</p>
              <div v-if="showAcoustIdPanel" class="acoustid-panel">
                <div class="panel-title">{{ t('metadata.acoustidSetupTitle') }}</div>
                <p>{{ t('metadata.acoustidSettingDesc1') }}</p>
                <p>{{ t('metadata.acoustidSettingDesc2') }}</p>
                <p>{{ t('metadata.acoustidSettingDesc3') }}</p>
                <div class="acoustid-input-row">
                  <input
                    v-model="acoustIdKeyInput"
                    class="flashing-border"
                    :class="{ 'is-flashing': flashArea === 'acoustidKey' }"
                    :placeholder="t('metadata.acoustidKeyPlaceholder')"
                    :disabled="savingAcoustIdKey"
                  />
                  <div class="button secondary" @click="openAcoustIdRegister">
                    {{ t('metadata.acoustidOpenRegister') }}
                  </div>
                </div>
                <div v-if="acoustIdKeyError" class="error-text">{{ acoustIdKeyError }}</div>
                <div class="acoustid-panel-actions">
                  <div
                    class="button"
                    :class="{ disabled: savingAcoustIdKey || !acoustIdKeyInput.trim() }"
                    @click="saveAcoustIdKey"
                  >
                    {{ savingAcoustIdKey ? t('metadata.saving') : t('metadata.acoustidSaveKey') }}
                  </div>
                  <div class="button secondary" @click="cancelAcoustIdSetup">
                    {{ t('common.cancel') }}
                  </div>
                </div>
              </div>
              <div v-else-if="!hasAcoustIdKey" class="hint-text acoustid-inline-hint">
                {{ t('metadata.acoustidMissingHint') }}
                <span class="link-like" @click="openAcoustIdPanelManually">
                  {{ t('metadata.acoustidConfigureNow') }}
                </span>
              </div>
              <div v-else class="hint-text acoustid-inline-hint">
                {{ t('metadata.acoustidSetupDesc3') }}
              </div>
              <div v-if="fingerprintStatusText" class="musicbrainz-fingerprint-status">
                {{ fingerprintStatusText }}
              </div>
            </div>

            <div v-if="displayedResults.length" class="musicbrainz-results">
              <div
                v-for="match in displayedResults"
                :key="match.recordingId"
                class="musicbrainz-result"
                :class="{ active: match.recordingId === currentSelectedRecordingId }"
                @click="selectMatch(match)"
              >
                <div class="result-title-row">
                  <div class="result-title">{{ match.title }}</div>
                  <div class="result-score">
                    {{ t('metadata.musicbrainzScore', { score: match.score }) }}
                  </div>
                </div>
                <div class="result-meta-lines">
                  <div v-if="match.artist" class="result-meta-line">
                    <span class="result-meta-label">{{ t('metadata.artist') }}</span>
                    <span class="result-meta-value">{{ match.artist }}</span>
                  </div>
                  <div v-if="match.releaseTitle" class="result-meta-line">
                    <span class="result-meta-label">{{ t('metadata.album') }}</span>
                    <span class="result-meta-value">{{ match.releaseTitle }}</span>
                  </div>
                  <div v-if="match.durationSeconds" class="result-meta-line">
                    <span class="result-meta-label">{{ t('columns.duration') }}</span>
                    <span class="result-meta-value">
                      {{ formatSeconds(match.durationSeconds) }}
                    </span>
                  </div>
                </div>
                <div v-if="match.releaseDate" class="result-meta small">
                  {{ t('metadata.musicbrainzReleaseDate') }}: {{ match.releaseDate }}
                </div>
                <div v-if="match.matchedFields.length" class="result-meta small">
                  {{
                    t('metadata.musicbrainzMatchedFields', {
                      fields: describeMatchedFields(match.matchedFields)
                    })
                  }}
                </div>
                <div
                  v-if="
                    match.source ||
                    shouldShowDurationDiff(match) ||
                    hasIsrcMatch(match) ||
                    hasLowConfidence(match)
                  "
                  class="result-tags"
                >
                  <span v-if="match.source" class="tag" :class="sourceTagClass(match)">
                    {{ getMatchSourceLabel(match) }}
                  </span>
                  <span v-if="hasLowConfidence(match)" class="tag tag-warn">
                    {{ t('metadata.musicbrainzLowConfidence') }}
                  </span>
                  <span
                    v-if="shouldShowDurationDiff(match)"
                    class="tag"
                    :class="durationDiffClass(match.durationDiffSeconds)"
                  >
                    {{ durationDiffText(match.durationDiffSeconds) }}
                  </span>
                  <span v-if="hasIsrcMatch(match)" class="tag tag-good">
                    {{ t('metadata.musicbrainzIsrcMatch') }}
                  </span>
                </div>
              </div>
            </div>
            <div v-else-if="currentErrorMessage" class="error-text">
              {{ currentErrorMessage }}
            </div>
            <div v-else-if="shouldShowEmptyState" class="musicbrainz-empty">
              {{ t('metadata.musicbrainzNoResult') }}
            </div>

            <div class="musicbrainz-suggestion">
              <div v-if="currentSuggestionLoading" class="musicbrainz-loading">
                {{ t('metadata.musicbrainzLoadingSuggestion') }}
              </div>
              <div v-else-if="currentSuggestionError" class="error-text">
                {{ currentSuggestionError }}
              </div>
              <div v-else-if="currentSuggestion" class="musicbrainz-suggestion-body">
                <div class="musicbrainz-suggestion-meta">
                  <div>
                    {{ t('metadata.musicbrainzChosenRelease') }}：
                    {{ currentSuggestion.releaseTitle || '--' }}
                  </div>
                  <div>
                    {{ t('metadata.musicbrainzReleaseDate') }}：
                    {{ currentSuggestion.releaseDate || '--' }}
                  </div>
                  <div>
                    {{ t('metadata.musicbrainzLabel') }}：
                    {{ currentSuggestion.label || '--' }}
                  </div>
                </div>
                <div class="musicbrainz-suggestion-content">
                  <div class="musicbrainz-cover-preview">
                    <img
                      v-if="suggestionCoverDataUrl"
                      :src="suggestionCoverDataUrl"
                      alt="cover"
                      draggable="false"
                    />
                    <div v-else class="cover-placeholder">
                      {{ t('metadata.noCover') }}
                    </div>
                  </div>
                  <div class="musicbrainz-field-grid">
                    <div
                      v-for="field in fieldMeta"
                      :key="field.key"
                      class="musicbrainz-field-row"
                      :class="{ disabled: !hasMusicBrainzValue(field.key) }"
                    >
                      <singleCheckbox v-model="fieldSelections[field.key]">
                        <div class="field-slot">
                          <span class="field-name">{{ field.label }}</span>
                          <span class="field-value">{{ getFieldText(field.key) }}</span>
                        </div>
                      </singleCheckbox>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </OverlayScrollbarsComponent>
      </div>

      <div class="dialog-footer">
        <div
          class="button"
          :class="{ disabled: !canConfirm }"
          @click="canConfirm ? handleConfirm() : null"
        >
          {{ t('metadata.musicbrainzApplySelection') }}
        </div>
        <div class="button" @click="handleCancel">
          {{ t('common.cancel') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.musicbrainz-dialog .inner {
  width: 720px;
  height: 560px;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.dialog-title {
  font-weight: bold;
  font-size: 14px;
}

.body {
  flex: 1;
  min-height: 0;
}

.content {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-size: 14px;
}

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}

.tab {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary, #888);
  border-bottom: 2px solid transparent;
}

.tab.active {
  color: var(--accent);
  border-color: var(--accent);
}

.section-title {
  font-weight: bold;
  margin-bottom: 8px;
}

.musicbrainz-query-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px 12px;
  align-items: center;
}

.musicbrainz-query-grid input {
  width: 100%;
  box-sizing: border-box;
  min-height: 26px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 14px;
  outline: none;
}

.musicbrainz-query-grid input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.musicbrainz-duration {
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.musicbrainz-panel-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.musicbrainz-panel-actions .button.secondary {
  background-color: transparent;
  border: 1px solid var(--border);
  color: var(--text);
}

.fingerprint-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fingerprint-meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.musicbrainz-fingerprint-status {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.hint-text {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin-top: 6px;
  line-height: 1.4;
}

.acoustid-inline-hint .link-like {
  margin-left: 6px;
}

.link-like {
  color: var(--accent);
  cursor: pointer;
}

.acoustid-panel {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  margin-top: 12px;
  background-color: rgba(0, 0, 0, 0.03);
}

.acoustid-panel .panel-title {
  font-weight: bold;
  margin-bottom: 6px;
}

.acoustid-panel p {
  margin: 4px 0;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.acoustid-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 10px 0;
}

.acoustid-input-row input {
  flex: 1;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 8px;
  background-color: var(--bg);
  color: var(--text);
  outline: none;
}

.acoustid-input-row input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.acoustid-panel-actions {
  margin-top: 8px;
  display: flex;
  gap: 10px;
}

.acoustid-panel .button.secondary {
  background-color: transparent;
  border: 1px solid var(--border);
  color: var(--text);
}

.musicbrainz-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.musicbrainz-result {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.musicbrainz-result.active {
  border-color: var(--accent);
  background-color: color-mix(in srgb, var(--accent) 10%, transparent);
}

.result-title-row {
  display: flex;
  justify-content: space-between;
  font-weight: bold;
}

.result-meta {
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.result-meta.small {
  font-size: 11px;
}

.result-meta-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
}

.result-meta-line {
  display: flex;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.result-meta-label {
  min-width: 52px;
  color: var(--text-secondary, #777);
}

.result-meta-value {
  flex: 1;
  color: var(--text);
}

.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.tag {
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  font-size: 11px;
  line-height: 1.3;
  background-color: var(--bg);
}

.tag-good {
  border-color: var(--accent);
  color: var(--accent);
}

.tag-source-acoustid {
  border-color: var(--accent);
  color: var(--accent);
}

.tag-warn {
  border-color: #be1100;
  color: #be1100;
}

.musicbrainz-suggestion-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.musicbrainz-suggestion-meta {
  font-size: 12px;
  color: var(--text-secondary, #888);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.musicbrainz-suggestion-content {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.musicbrainz-cover-preview {
  width: 160px;
  height: 160px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg);
  flex-shrink: 0;
}

.musicbrainz-cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.musicbrainz-field-grid {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.musicbrainz-field-row {
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}

.musicbrainz-field-row:last-child {
  border-bottom: none;
}

.musicbrainz-field-row.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.musicbrainz-field-grid :deep(.checkBoxContainer) {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
}

.musicbrainz-field-grid :deep(.text) {
  width: 100%;
}

.musicbrainz-field-grid :deep(.field-slot) {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.musicbrainz-field-grid :deep(.field-name) {
  width: 120px;
  font-size: 13px;
}

.musicbrainz-field-grid :deep(.field-value) {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.musicbrainz-empty,
.musicbrainz-loading {
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.error-text {
  color: #e81123;
  font-size: 12px;
  margin-top: 6px;
}
</style>
