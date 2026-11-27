<script setup lang="ts">
import { computed, inject, reactive, type ComponentPublicInstance } from 'vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { buildAnalysisBpmRangeOptions } from '@renderer/utils/analysisBpmRangeUi'
import {
  normalizeAnalysisBpmRangeId,
  type AnalysisBpmRangePresetId
} from '@shared/analysisBpmRange'
import { ANALYSIS_GRID_MODE_HINT_KEYS } from '@renderer/utils/analysisGridModeUi'
import { useAnalysisGridModeSetting } from './useAnalysisGridModeSetting'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import { useUltraStemModel } from './useUltraStemModel'
import { useAudioExtSettings } from './useAudioExtSettings'
import SettingsPage from './SettingsPage.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'
import BooleanSettingRow from './BooleanSettingRow.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const { runtime, setSetting } = ctx
const hintIcon = hintIconAsset

const analysisBpmRangeModel = computed<AnalysisBpmRangePresetId>({
  get: () => normalizeAnalysisBpmRangeId(runtime.setting.analysisBpmRange),
  set: (value) => {
    runtime.setting.analysisBpmRange = normalizeAnalysisBpmRangeId(value)
  }
})

const analysisBpmRangeOptions = computed(() =>
  buildAnalysisBpmRangeOptions(analysisBpmRangeModel.value)
)

const {
  available: analysisGridModeAvailable,
  model: analysisGridModeModel,
  options: analysisGridModeOptions,
  hint: analysisGridModeHint
} = useAnalysisGridModeSetting(runtime)

const showIdleAnalysisStatusModel = computed<boolean>({
  get: () => runtime.setting.showIdleAnalysisStatus === true,
  set: (value) => {
    runtime.setting.showIdleAnalysisStatus = value
  }
})

const { ultraModelInfo, ultraModelStatusText, removeUltraModel } = useUltraStemModel()
const { allFormats, audioExt, extChange } = useAudioExtSettings(runtime, setSetting)

const autoFillSkipCompletedModel = computed<boolean>({
  get: () => runtime.setting.autoFillSkipCompleted !== false,
  set: (value) => {
    runtime.setting.autoFillSkipCompleted = value
  }
})

const fingerprintModeModel = computed<'pcm' | 'file'>({
  get: () => runtime.setting.fingerprintMode || 'pcm',
  set: (value) => {
    runtime.setting.fingerprintMode = value
  }
})

const fpModeHintRefs = reactive<Record<string, HTMLImageElement | null>>({})
const setFpModeHintRef = (value: string, element: HTMLImageElement | null) => {
  if (element) fpModeHintRefs[value] = element
}
const bindFpModeHintRef =
  (value: string) => (element: Element | ComponentPublicInstance | null) => {
    setFpModeHintRef(value, element instanceof HTMLImageElement ? element : null)
  }

const onFingerprintModeChange = async () => {
  await confirm({
    title: t('fingerprints.mode'),
    content: [t('fingerprints.modeIncompatibleWarning')],
    confirmShow: false
  })
  await setSetting('fingerprintMode')
}
</script>

<template>
  <SettingsPage page="analysis">
    <SettingsGroup title-key="settings.groups.analysis">
      <SettingRow id="analysisBpmRange" inline>
        <BaseSelect
          v-model="analysisBpmRangeModel"
          :options="analysisBpmRangeOptions"
          :width="220"
          :max-height="280"
          @change="setSetting('analysisBpmRange')"
        />
        <template #details>
          <div class="settings-hint">{{ t('settings.analysisBpmRange.settingsHint') }}</div>
          <div class="settings-hint">{{ t('settings.analysisBpmRange.settingsScopeHint') }}</div>
        </template>
      </SettingRow>

      <SettingRow id="analysisGridMode" inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-inline-select"
          :title="
            analysisGridModeAvailable ? '' : t(ANALYSIS_GRID_MODE_HINT_KEYS.productionDisabled)
          "
        >
          <BaseSelect
            v-model="analysisGridModeModel"
            :options="analysisGridModeOptions"
            :width="220"
            :max-height="200"
            @change="setSetting('analysisGridMode')"
          />
        </bubbleBoxTrigger>
        <template #details>
          <div class="settings-hint">{{ analysisGridModeHint }}</div>
          <div v-if="!analysisGridModeAvailable" class="settings-hint settings-hint--warning">
            {{ t(ANALYSIS_GRID_MODE_HINT_KEYS.productionDisabled) }}
          </div>
        </template>
      </SettingRow>

      <BooleanSettingRow
        id="showIdleAnalysisStatus"
        control-id="setting-checkbox-showIdleAnalysisStatus"
        stacked
      >
        <singleCheckbox
          id="setting-checkbox-showIdleAnalysisStatus"
          v-model="showIdleAnalysisStatusModel"
          @change="setSetting('showIdleAnalysisStatus')"
        />
      </BooleanSettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.stemModel">
      <SettingRow id="ultraStemModel" stacked>
        <div class="settings-hint settings-hint--first">
          {{ t('settings.ultraStemModel.desc') }}
        </div>
        <div class="settings-model-status">
          <span>{{ ultraModelStatusText }}</span>
          <span v-if="ultraModelInfo?.alreadyAvailable">
            {{
              t('settings.ultraStemModel.diskUsage', {
                size: formatAnalysisRuntimeBytes(ultraModelInfo.installedSize)
              })
            }}
          </span>
        </div>
        <div v-if="ultraModelInfo?.alreadyAvailable" class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button settings-inline-button--danger"
            @click="removeUltraModel()"
          >
            {{ t('settings.ultraStemModel.removeButton') }}
          </button>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.metadata">
      <BooleanSettingRow
        id="autoFillSkipCompleted"
        control-id="setting-checkbox-autoFillSkipCompleted"
        stacked
      >
        <singleCheckbox
          id="setting-checkbox-autoFillSkipCompleted"
          v-model="autoFillSkipCompletedModel"
          @change="setSetting('autoFillSkipCompleted')"
        />
        <template #details>
          <div class="settings-hint">{{ t('metadata.autoFillSkipCompletedHint') }}</div>
        </template>
      </BooleanSettingRow>

      <SettingRow id="fingerprintMode" stacked>
        <singleRadioGroup
          v-model="fingerprintModeModel"
          name="fpMode"
          :options="[
            { label: t('fingerprints.modePCM'), value: 'pcm' },
            { label: t('fingerprints.modeFile'), value: 'file' }
          ]"
          @change="onFingerprintModeChange()"
        >
          <template #option="{ opt }">
            <span class="label">{{ opt.label }}</span>
            <img
              :ref="bindFpModeHintRef(opt.value)"
              :src="hintIcon"
              class="settings-hint-icon"
              :draggable="false"
            />
            <bubbleBox
              :dom="fpModeHintRefs[opt.value] || null"
              :title="
                opt.value === 'pcm' ? t('fingerprints.modePCMHint') : t('fingerprints.modeFileHint')
              "
              :max-width="360"
            />
          </template>
        </singleRadioGroup>
        <div class="settings-hint">{{ t('fingerprints.modeIncompatibleWarning') }}</div>
      </SettingRow>

      <SettingRow id="scanFormats" stacked>
        <div class="settings-format-list">
          <div v-for="format in allFormats" :key="format" class="settings-format-item">
            <label :for="'setting-checkbox-ext-' + format">.{{ format }}</label>
            <singleCheckbox
              :id="'setting-checkbox-ext-' + format"
              v-model="audioExt[format]"
              @change="extChange()"
            />
          </div>
        </div>
      </SettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>
