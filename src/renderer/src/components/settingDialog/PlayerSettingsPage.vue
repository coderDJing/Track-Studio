<script setup lang="ts">
import { computed, inject } from 'vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import {
  PLAYBACK_RANGE_SECTION_KINDS,
  PLAYBACK_RANGE_SECTION_LABELS,
  normalizePlaybackRangeSectionKinds,
  type PlaybackRangeMode,
  type PlaybackRangeSectionMatchMode
} from '@shared/playbackRange'
import type { SongStructureSectionKind } from '@shared/songStructure'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import { useAudioOutputDevices } from './useAudioOutputDevices'
import SettingsPage from './SettingsPage.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'
import BooleanSettingRow from './BooleanSettingRow.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const { runtime, setSetting } = ctx

const {
  audioOutputError,
  audioOutputSupported,
  audioOutputSelectOptions,
  isEnumeratingAudioOutputs,
  handleAudioOutputChange
} = useAudioOutputDevices(runtime, setSetting)

const waveformModeOptions = computed(() => [
  { label: t('player.waveformModeHalf'), value: 'half' },
  { label: t('player.waveformModeFull'), value: 'full' }
])

const keyDisplayStyleOptions = computed(() => [
  { label: t('player.keyDisplayStyleClassic'), value: 'Classic' },
  { label: t('player.keyDisplayStyleCamelot'), value: 'Camelot' }
])

const showTitleAudioVisualizerModel = computed<boolean>({
  get: () => runtime.setting.showTitleAudioVisualizer !== false,
  set: (value) => {
    runtime.setting.showTitleAudioVisualizer = value
  }
})

const playbackRangeModeModel = computed<PlaybackRangeMode>({
  get: () => (runtime.setting.playbackRangeMode === 'section' ? 'section' : 'custom'),
  set: (value) => {
    runtime.setting.playbackRangeMode = value
  }
})

const playbackRangeSectionMatchModeModel = computed<PlaybackRangeSectionMatchMode>({
  get: () => {
    const value = runtime.setting.playbackRangeSectionMatchMode
    return value === 'first' || value === 'last' ? value : 'all'
  },
  set: (value) => {
    runtime.setting.playbackRangeSectionMatchMode = value
  }
})

const playbackRangeModeOptions = computed(() => [
  { label: t('player.playbackRangeModeCustom'), value: 'custom' },
  { label: t('player.playbackRangeModeSection'), value: 'section' }
])

const playbackRangeSectionMatchModeOptions = computed(() => [
  { label: t('player.playbackRangeSectionMatchAll'), value: 'all' },
  { label: t('player.playbackRangeSectionMatchFirst'), value: 'first' },
  { label: t('player.playbackRangeSectionMatchLast'), value: 'last' }
])

const playbackRangeSectionKindOptions = computed(() =>
  PLAYBACK_RANGE_SECTION_KINDS.map((kind) => ({
    label: PLAYBACK_RANGE_SECTION_LABELS[kind],
    value: kind
  }))
)

const playbackRangeSelectedSectionKinds = computed(
  () => new Set(normalizePlaybackRangeSectionKinds(runtime.setting.playbackRangeSectionKinds))
)

const togglePlaybackRangeSectionKind = (kind: SongStructureSectionKind, checked: boolean) => {
  const selected = new Set(
    normalizePlaybackRangeSectionKinds(runtime.setting.playbackRangeSectionKinds)
  )
  if (checked) {
    selected.add(kind)
  } else if (selected.size > 1) {
    selected.delete(kind)
  }
  runtime.setting.playbackRangeSectionKinds = PLAYBACK_RANGE_SECTION_KINDS.filter((item) =>
    selected.has(item)
  )
  void setSetting('playbackRangeSectionKinds')
}
</script>

<template>
  <SettingsPage page="player">
    <SettingsGroup title-key="settings.groups.playerBehavior">
      <BooleanSettingRow id="autoPlayNextSong" control-id="setting-checkbox-autoPlayNext">
        <singleCheckbox
          id="setting-checkbox-autoPlayNext"
          v-model="runtime.setting.autoPlayNextSong"
          @change="setSetting('autoPlayNextSong')"
        />
      </BooleanSettingRow>

      <SettingRow id="audioOutputDeviceId" inline>
        <BaseSelect
          v-model="runtime.setting.audioOutputDeviceId"
          :options="audioOutputSelectOptions"
          :width="240"
          :disabled="!audioOutputSupported || isEnumeratingAudioOutputs"
          @change="handleAudioOutputChange"
        />
        <template #details>
          <div v-if="audioOutputError" class="settings-error-text">{{ audioOutputError }}</div>
        </template>
      </SettingRow>

      <SettingRow id="fastForwardTime" control-id="setting-input-fastForward" inline>
        <div class="settings-number-row">
          <input
            id="setting-input-fastForward"
            v-model="runtime.setting.fastForwardTime"
            class="settings-number-input"
            type="number"
            min="1"
            step="1"
            @input="
              runtime.setting.fastForwardTime = Math.max(
                1,
                Math.floor(Number(runtime.setting.fastForwardTime || 1))
              )
            "
            @blur="setSetting('fastForwardTime')"
          />
          <span class="settings-unit">{{ t('player.seconds') }}</span>
        </div>
      </SettingRow>

      <SettingRow id="fastBackwardTime" control-id="setting-input-fastBackward" inline>
        <div class="settings-number-row">
          <input
            id="setting-input-fastBackward"
            v-model="runtime.setting.fastBackwardTime"
            class="settings-number-input"
            type="number"
            max="-1"
            step="1"
            @input="
              runtime.setting.fastBackwardTime = Math.min(
                -1,
                Math.floor(Number(runtime.setting.fastBackwardTime || -1))
              )
            "
            @blur="setSetting('fastBackwardTime')"
          />
          <span class="settings-unit">{{ t('player.seconds') }}</span>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.playerDisplay">
      <SettingRow id="waveformMode" inline>
        <BaseSelect
          v-model="runtime.setting.waveformMode"
          :options="waveformModeOptions"
          :width="220"
          @change="setSetting('waveformMode')"
        />
      </SettingRow>

      <SettingRow id="keyDisplayStyle" inline>
        <BaseSelect
          v-model="runtime.setting.keyDisplayStyle"
          :options="keyDisplayStyleOptions"
          :width="220"
          @change="setSetting('keyDisplayStyle')"
        />
      </SettingRow>

      <BooleanSettingRow
        id="hiddenPlayControlArea"
        control-id="setting-checkbox-hideControlsShowWaveform"
      >
        <singleCheckbox
          id="setting-checkbox-hideControlsShowWaveform"
          v-model="runtime.setting.hiddenPlayControlArea"
          @change="setSetting('hiddenPlayControlArea')"
        />
      </BooleanSettingRow>

      <BooleanSettingRow
        id="showTitleAudioVisualizer"
        control-id="setting-checkbox-showTitleAudioVisualizer"
      >
        <singleCheckbox
          id="setting-checkbox-showTitleAudioVisualizer"
          v-model="showTitleAudioVisualizerModel"
          @change="setSetting('showTitleAudioVisualizer')"
        />
      </BooleanSettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.playbackRange">
      <BooleanSettingRow
        id="enablePlaybackRange"
        control-id="setting-checkbox-enablePlaybackRange"
        stacked
      >
        <bubbleBoxTrigger :title="t('horizontalBrowse.playbackRangeKeyboardHint')" shortcut="R">
          <singleCheckbox
            id="setting-checkbox-enablePlaybackRange"
            v-model="runtime.setting.enablePlaybackRange"
            @change="setSetting('enablePlaybackRange')"
          />
        </bubbleBoxTrigger>
      </BooleanSettingRow>

      <template v-if="runtime.setting.enablePlaybackRange">
        <SettingRow id="playbackRangeMode">
          <BaseSelect
            v-model="playbackRangeModeModel"
            :options="playbackRangeModeOptions"
            :width="220"
            @change="setSetting('playbackRangeMode')"
          />
        </SettingRow>

        <template v-if="playbackRangeModeModel === 'section'">
          <SettingRow id="playbackRangeSectionKinds" stacked>
            <div class="settings-checkbox-list">
              <singleCheckbox
                v-for="option in playbackRangeSectionKindOptions"
                :id="`setting-checkbox-playbackRangeSection-${option.value}`"
                :key="option.value"
                class="settings-checkbox-list__item"
                :model-value="playbackRangeSelectedSectionKinds.has(option.value)"
                @change="
                  (checked) => togglePlaybackRangeSectionKind(option.value, Boolean(checked))
                "
              >
                {{ option.label }}
              </singleCheckbox>
            </div>
          </SettingRow>

          <SettingRow id="playbackRangeSectionMatchMode">
            <BaseSelect
              v-model="playbackRangeSectionMatchModeModel"
              :options="playbackRangeSectionMatchModeOptions"
              :width="220"
              @change="setSetting('playbackRangeSectionMatchMode')"
            />
          </SettingRow>
        </template>
      </template>
    </SettingsGroup>
  </SettingsPage>
</template>
