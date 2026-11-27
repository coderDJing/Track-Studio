<script setup lang="ts">
import { computed, inject } from 'vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import ColorPicker from '@renderer/components/ColorPicker.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import { t } from '@renderer/utils/translate'
import { DEFAULT_ACCENT_COLOR, normalizeAccentColor } from '@renderer/utils/accentColor'
import {
  BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY,
  BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_KEYS,
  BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_LABEL_KEYS,
  normalizeBrowserPlayerRightTrackInfo,
  type BrowserPlayerRightTrackInfoField
} from '@shared/browserPlayerRightTrackInfo'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import SettingsPage from './SettingsPage.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const { runtime, setSetting } = ctx

const accentColorPresets = [
  '#0078d4',
  '#7c3aed',
  '#c026d3',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0d9488'
]

const currentAccentColor = computed(
  () => normalizeAccentColor(runtime.setting.accentColor) || DEFAULT_ACCENT_COLOR
)

const isCustomAccentColor = computed(() => {
  const color = normalizeAccentColor(runtime.setting.accentColor)
  return !!color && !accentColorPresets.includes(color)
})

const selectAccentColor = (color: string) => {
  runtime.setting.accentColor = color === DEFAULT_ACCENT_COLOR ? undefined : color
  void setSetting('accentColor')
}

const onAccentColorPick = (value: string) => {
  const color = normalizeAccentColor(value)
  runtime.setting.accentColor = !color || color === DEFAULT_ACCENT_COLOR ? undefined : color
}

const onAccentColorCommit = () => {
  void setSetting('accentColor')
}

const resetAccentColor = () => {
  runtime.setting.accentColor = undefined
  void setSetting('accentColor')
}

const themeModeOptions = computed(() => [
  { label: t('theme.system'), value: 'system' },
  { label: t('theme.light'), value: 'light' },
  { label: t('theme.dark'), value: 'dark' }
])

const languageOptions = computed(() => [
  { label: '简体中文', value: 'zhCN' },
  { label: 'English', value: 'enUS' }
])

const browserPlayerRightTrackInfoModel = computed<BrowserPlayerRightTrackInfoField>({
  get: () => normalizeBrowserPlayerRightTrackInfo(runtime.setting.browserPlayerRightTrackInfo),
  set: (value) => {
    runtime.setting.browserPlayerRightTrackInfo = normalizeBrowserPlayerRightTrackInfo(value)
  }
})

const browserPlayerRightTrackInfoOptions = computed(() => [
  {
    label: `${t('columns.bpm')}/${t('columns.key')}`,
    value: BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY
  },
  ...BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_KEYS.map((key) => ({
    label: t(BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_LABEL_KEYS[key]),
    value: key
  }))
])

const userGuideAudience = computed({
  get: () => runtime.setting.userGuideAudience || 'general',
  set: (value: string) => {
    if (value === 'rekordbox' || value === 'general' || value === 'veteran') {
      runtime.setting.userGuideAudience = value
    }
  }
})

const userGuideAudienceOptions = computed(() => [
  { label: t('userGuide.identity.rekordbox'), value: 'rekordbox' },
  { label: t('userGuide.identity.general'), value: 'general' },
  { label: t('userGuide.identity.veteran'), value: 'veteran' }
])

// 更新“最近使用歌单缓存数量”并按需截断本地缓存
const updateRecentDialogCacheMaxCount = async () => {
  runtime.setting.recentDialogSelectedSongListMaxCount = Math.max(
    0,
    Math.floor(Number(runtime.setting.recentDialogSelectedSongListMaxCount || 0))
  )
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount
  const keys = ['FilterLibrary', 'CuratedLibrary', 'MixtapeLibrary']
  for (const name of keys) {
    const key = 'recentDialogSelectedSongListUUID' + name
    const raw = localStorage.getItem(key)
    if (!raw) continue
    try {
      let arr: string[] = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length > maxCount) {
        arr = arr.slice(0, maxCount)
        localStorage.setItem(key, JSON.stringify(arr))
      }
    } catch {
      // ignore broken cache
    }
  }
  await setSetting('recentDialogSelectedSongListMaxCount')
}
</script>

<template>
  <SettingsPage page="general">
    <SettingsGroup title-key="settings.groups.appearance">
      <SettingRow id="themeMode" control-id="setting-select-themeMode" stacked inline>
        <BaseSelect
          id="setting-select-themeMode"
          v-model="runtime.setting.themeMode"
          :options="themeModeOptions"
          :width="220"
          @change="setSetting('themeMode')"
        />
      </SettingRow>

      <SettingRow id="accentColor" stacked>
        <div class="settings-accent-control">
          <div class="settings-accent-swatches">
            <button
              v-for="preset in accentColorPresets"
              :key="preset"
              type="button"
              class="settings-accent-swatch"
              :class="{ 'settings-accent-swatch--active': currentAccentColor === preset }"
              :style="{ backgroundColor: preset }"
              @click="selectAccentColor(preset)"
            />
            <ColorPicker
              :model-value="currentAccentColor"
              :active="isCustomAccentColor"
              @update:model-value="onAccentColorPick"
              @change="onAccentColorCommit"
            />
          </div>
          <button type="button" class="settings-link-button" @click="resetAccentColor">
            {{ t('theme.accentDefault') }}
          </button>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.interface">
      <SettingRow id="language" inline>
        <BaseSelect
          v-model="runtime.setting.language"
          :options="languageOptions"
          :width="220"
          @change="setSetting('language')"
        />
      </SettingRow>

      <SettingRow id="browserPlayerRightTrackInfo" inline>
        <BaseSelect
          v-model="browserPlayerRightTrackInfoModel"
          :options="browserPlayerRightTrackInfoOptions"
          :width="150"
          :max-height="280"
          @change="setSetting('browserPlayerRightTrackInfo')"
        />
      </SettingRow>

      <SettingRow
        id="recentDialogSelectedSongListMaxCount"
        control-id="setting-input-recentSongListCache"
        stacked
        inline
      >
        <input
          id="setting-input-recentSongListCache"
          v-model="runtime.setting.recentDialogSelectedSongListMaxCount"
          class="settings-number-input"
          type="number"
          min="0"
          step="1"
          @input="
            runtime.setting.recentDialogSelectedSongListMaxCount = Math.max(
              0,
              Math.floor(Number(runtime.setting.recentDialogSelectedSongListMaxCount || 0))
            )
          "
          @blur="updateRecentDialogCacheMaxCount()"
        />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.userGuide">
      <SettingRow id="userGuideAudience" stacked>
        <singleRadioGroup
          v-model="userGuideAudience"
          name="userGuideIdentity"
          :options="userGuideAudienceOptions"
          :option-font-size="12"
          @change="setSetting('userGuideAudience')"
        />
        <div class="settings-hint">{{ t('userGuide.settingHint') }}</div>
      </SettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>
