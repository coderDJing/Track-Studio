<script setup lang="ts">
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useEditMetadataDialog } from './useEditMetadataDialog'
import type { ISongInfo, ITrackMetadataDetail } from 'src/types/globals'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = defineProps<{
  filePath: string
  confirmCallback: (payload: {
    updatedSongInfo: ISongInfo
    detail: ITrackMetadataDetail
    oldFilePath: string
  }) => void
  cancelCallback: () => void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const {
  loading,
  loadError,
  submitting,
  errorMessage,
  currentFilePath,
  fileName,
  fileExtension,
  fileNameError,
  form,
  isWavFile,
  coverDataUrl,
  fileInputRef,
  isRemoveDisabled,
  showRestoreButton,
  isRestoreDisabled,
  flashArea,
  musicBrainzDialogOpening,
  metadataDetail,
  onFileNameInput,
  onOpenMusicBrainzDialog,
  loadMetadata,
  onFileButtonClick,
  onConfirm,
  onCancel,
  onRemoveCover,
  onRestoreCover,
  onCoverSelected
} = useEditMetadataDialog({
  ...props,
  confirmCallback: (payload) => closeWithAnimation(() => props.confirmCallback(payload)),
  cancelCallback: () => closeWithAnimation(() => props.cancelCallback())
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="top-block">
        <div class="dialog-title dialog-header">{{ t('metadata.dialogTitle') }}</div>
        <div class="body">
          <OverlayScrollbarsComponent
            :options="{
              scrollbars: {
                autoHide: 'leave' as const,
                autoHideDelay: 50,
                clickScroll: true
              } as const,
              overflow: {
                x: 'hidden',
                y: 'scroll'
              } as const
            }"
            element="div"
            style="height: 100%; width: 100%"
            defer
          >
            <div class="content">
              <div class="section">
                <div class="section-title">{{ t('metadata.fileName') }}</div>
                <div class="filename-row">
                  <div class="filename-input-wrapper">
                    <input
                      v-model="fileName"
                      class="myInput flashing-border"
                      :class="{
                        myInputRedBorder: fileNameError,
                        'is-flashing-error': flashArea === 'fileName'
                      }"
                      :disabled="submitting"
                      @input="onFileNameInput"
                      @keydown.enter.prevent="onConfirm"
                    />
                    <div v-if="fileNameError" class="myInputHint">
                      <div>{{ fileNameError }}</div>
                    </div>
                  </div>
                  <span class="filename-extension">{{ fileExtension }}</span>
                </div>
              </div>

              <div class="path-row">
                <label>{{ t('metadata.filePath') }}</label>
                <bubbleBoxTrigger tag="div" class="path-value" :title="currentFilePath">
                  {{ currentFilePath }}
                </bubbleBoxTrigger>
              </div>

              <div v-if="loading" class="loading">{{ t('metadata.loading') }}</div>
              <div v-else-if="loadError" class="error-block">
                <span>{{ loadError }}</span>
                <div class="button text-button" @click="loadMetadata">{{ t('common.retry') }}</div>
              </div>
              <div v-else class="form-body">
                <div class="section">
                  <div class="section-title">{{ t('metadata.musicbrainzTitle') }}</div>
                  <div class="musicbrainz-launch-row">
                    <div class="musicbrainz-hint">{{ t('metadata.musicbrainzHint') }}</div>
                    <div
                      class="button"
                      :class="{
                        disabled:
                          loading || submitting || musicBrainzDialogOpening || !metadataDetail
                      }"
                      @click="
                        loading || submitting || musicBrainzDialogOpening || !metadataDetail
                          ? null
                          : onOpenMusicBrainzDialog()
                      "
                    >
                      {{ t('metadata.musicbrainzOpenDialog') }}
                    </div>
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.basicInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.title') }}</label>
                    <input v-model="form.title" :disabled="submitting" />

                    <label>{{ t('metadata.artist') }}</label>
                    <input v-model="form.artist" :disabled="submitting" />

                    <label>{{ t('metadata.genre') }}</label>
                    <input v-model="form.genre" :disabled="submitting" />

                    <label>{{ t('metadata.year') }}</label>
                    <input v-model="form.year" :disabled="submitting" />
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.albumInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.album') }}</label>
                    <input v-model="form.album" :disabled="submitting" />

                    <label>{{ t('metadata.albumArtist') }}</label>
                    <input v-model="form.albumArtist" :disabled="submitting" />

                    <label>{{ t('metadata.trackNo') }}</label>
                    <input v-model="form.trackNo" :disabled="submitting" />

                    <label>{{ t('metadata.trackTotal') }}</label>
                    <input v-model="form.trackTotal" :disabled="submitting" />

                    <label>{{ t('metadata.discNo') }}</label>
                    <input v-model="form.discNo" :disabled="submitting" />

                    <label>{{ t('metadata.discTotal') }}</label>
                    <input v-model="form.discTotal" :disabled="submitting" />
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.peopleInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.composer') }}</label>
                    <input v-model="form.composer" :disabled="submitting" />

                    <label>{{ t('metadata.lyricist') }}</label>
                    <input v-model="form.lyricist" :disabled="submitting" />

                    <label>{{ t('metadata.label') }}</label>
                    <input v-model="form.label" :disabled="submitting" />

                    <label>{{ t('metadata.isrc') }}</label>
                    <input v-model="form.isrc" :disabled="submitting" />
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.otherInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.comment') }}</label>
                    <textarea v-model="form.comment" rows="2" :disabled="submitting"></textarea>

                    <label>{{ t('metadata.lyrics') }}</label>
                    <textarea v-model="form.lyrics" rows="4" :disabled="submitting"></textarea>
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.cover') }}</div>
                  <div class="cover-row">
                    <div class="cover-preview">
                      <img v-if="coverDataUrl" :src="coverDataUrl" alt="cover" />
                      <div v-else class="cover-placeholder">{{ t('metadata.noCover') }}</div>
                    </div>
                    <div class="cover-actions">
                      <div
                        class="button"
                        :class="{ disabled: submitting || isWavFile }"
                        @click="submitting || isWavFile ? null : onFileButtonClick()"
                      >
                        {{ t('metadata.chooseCover') }}
                      </div>
                      <div
                        class="button"
                        :class="{ disabled: isRemoveDisabled || isWavFile }"
                        @click="isRemoveDisabled || isWavFile ? null : onRemoveCover()"
                      >
                        {{ t('metadata.removeCover') }}
                      </div>
                      <div
                        v-if="showRestoreButton"
                        class="button"
                        :class="{ disabled: isRestoreDisabled || isWavFile }"
                        @click="isRestoreDisabled || isWavFile ? null : onRestoreCover()"
                      >
                        {{ t('metadata.restoreCover') }}
                      </div>
                    </div>
                  </div>
                  <div class="cover-hint">
                    {{ isWavFile ? t('metadata.coverHintWav') : t('metadata.coverHint') }}
                  </div>
                </div>
              </div>

              <div v-if="errorMessage" class="error-text">{{ errorMessage }}</div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
      </div>

      <div class="dialog-footer">
        <div
          class="button"
          :class="{ disabled: loading || submitting }"
          @click="loading || submitting ? null : onConfirm()"
        >
          {{ submitting ? t('metadata.saving') : t('common.save') }} (E)
        </div>
        <div
          class="button"
          :class="{ disabled: submitting }"
          @click="submitting ? null : onCancel()"
        >
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>

    <input
      ref="fileInputRef"
      class="hidden-input"
      type="file"
      accept="image/*"
      @change="onCoverSelected"
    />
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  height: 520px;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.top-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dialog-title {
  font-weight: bold;
}

.body {
  flex: 1;
  min-height: 0;
}

.content {
  padding: 18px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-size: 14px;
}

.path-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.filename-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.filename-extension {
  font-size: 14px;
  color: var(--text-secondary, #888);
  min-width: 60px;
}

.filename-input-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.myInput {
  width: 100%;
  min-height: 26px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  padding: 4px 8px;
  border-radius: 3px;
  font-size: 14px;
  box-sizing: border-box;
}

.myInput:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.myInputRedBorder {
  border: 1px solid #be1100;
  box-shadow: 0 0 0 2px rgba(190, 17, 0, 0.2);
}

.myInputHint {
  margin-top: 4px;
  div {
    width: 100%;
    min-height: 25px;
    line-height: 25px;
    background-color: #5a1d1d;
    border: 1px solid #be1100;
    color: #ffffff;
    font-size: 12px;
    padding: 0 8px;
    border-radius: 4px;
    box-sizing: border-box;
  }
}

.is-flashing-error {
  animation: flash-error 0.5s linear infinite;
}

@keyframes flash-error {
  0%,
  100% {
    box-shadow: 0 0 0 1px transparent;
  }

  33.33%,
  66.66% {
    box-shadow: inset 0 0 0 1px #be1100;
  }
}

.path-value {
  background-color: var(--bg);
  padding: 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  word-break: break-all;
}

.loading {
  font-size: 14px;
}

.error-block {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--accent);
}

.error-block .text-button {
  padding: 0 12px;
  min-width: 80px;
}

.form-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  font-weight: bold;
  font-size: 14px;
}

.form-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px 12px;
  align-items: center;
}

.form-grid label {
  font-size: 13px;
  color: var(--text-secondary, #aaa);
}

.form-grid input,
.form-grid textarea {
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

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.form-grid textarea {
  resize: vertical;
  min-height: 60px;
}

.filename-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.filename-extension {
  font-size: 14px;
  color: var(--text-secondary, #888);
  min-width: 60px;
}

.cover-row {
  display: flex;
  gap: 16px;
  align-items: center;
}

.cover-preview {
  width: 140px;
  height: 140px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg);
}

.cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.cover-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.error-text {
  margin-top: 8px;
  color: var(--accent);
  font-size: 13px;
}

.hidden-input {
  display: none;
}

.button.disabled {
  opacity: 0.6;
  pointer-events: none;
}

.cover-hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.musicbrainz-launch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.musicbrainz-hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
  flex: 1;
}
</style>
