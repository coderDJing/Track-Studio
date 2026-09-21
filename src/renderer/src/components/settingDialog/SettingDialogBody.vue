<script setup lang="ts">
import { computed, inject } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import ColorPicker from '@renderer/components/ColorPicker.vue'
import { t } from '@renderer/utils/translate'
import {
  settingDialogContextKey,
  type SettingDialogContext
} from '@renderer/components/settingDialog/context'
import {
  PLAYBACK_RANGE_SECTION_KINDS,
  PLAYBACK_RANGE_SECTION_LABELS,
  normalizePlaybackRangeSectionKinds,
  type PlaybackRangeMode,
  type PlaybackRangeSectionMatchMode
} from '@shared/playbackRange'
import type { SongStructureSectionKind } from '@shared/songStructure'
import { buildAnalysisBpmRangeOptions } from '@renderer/utils/analysisBpmRangeUi'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'
import {
  normalizeAnalysisBpmRangeId,
  type AnalysisBpmRangePresetId
} from '@shared/analysisBpmRange'
import {
  BROWSER_PLAYER_RIGHT_TRACK_INFO_BPM_KEY,
  BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_KEYS,
  BROWSER_PLAYER_RIGHT_TRACK_INFO_COLUMN_LABEL_KEYS,
  normalizeBrowserPlayerRightTrackInfo,
  type BrowserPlayerRightTrackInfoField
} from '@shared/browserPlayerRightTrackInfo'
import { formatSeekPercentModifierSettingValue } from '@shared/playerGlobalShortcuts'
import { DEFAULT_ACCENT_COLOR, normalizeAccentColor } from '@renderer/utils/accentColor'

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
  setSetting()
}

const onAccentColorPick = (value: string) => {
  const color = normalizeAccentColor(value)
  runtime.setting.accentColor = !color || color === DEFAULT_ACCENT_COLOR ? undefined : color
}

const onAccentColorCommit = () => {
  setSetting()
}

const resetAccentColor = () => {
  runtime.setting.accentColor = undefined
  setSetting()
}

const ctx = inject<SettingDialogContext>(settingDialogContextKey)

if (!ctx) {
  throw new Error('settingDialogContext is missing')
}

const {
  dialogVisible,
  runtime,
  cancel,
  setSetting,
  songFingerprintListLength,
  acoustIdKeyValidating,
  acoustIdKeyErrorText,
  isWindowsPlatform,
  curatedArtistFavoritesCount,
  isDevOrPrerelease,
  songListBubbleMode,
  isEnumeratingAudioOutputs,
  audioOutputError,
  audioOutputSupported,
  themeModeOptions,
  languageOptions,
  waveformModeOptions,
  keyDisplayStyleOptions,
  audioOutputSelectOptions,
  handleAudioOutputChange,
  openAcoustIdSite,
  handleAcoustIdKeyBlur,
  updateRecentDialogCacheMaxCount,
  allFormats,
  audioExt,
  extChange,
  clearTracksFingerprintLibrary,
  clearCuratedArtistFavorites,
  openCuratedArtistFavoritesDialog,
  globalCallShortcutHandle,
  playerGlobalShortcutHandle,
  reSelectLibrary,
  chooseRekordboxDesktopTrackStorageDir,
  hintIcon,
  fpModeHintRefs,
  bindFpModeHintRef,
  onFingerprintModeChange,
  clearCloudFingerprints,
  clearLibraryDirtyData,
  clearAnalysisRuntime,
  ultraModelInfo,
  ultraModelStatusText,
  removeUltraModel
} = ctx

const seekPercentModifierDisplay = computed(() => {
  const formatted = formatSeekPercentModifierSettingValue(
    runtime.setting.playerGlobalShortcuts?.seekPercentModifier || ''
  )
  return formatted || t('shortcuts.globalSeekPercentShortcutOff')
})

const fingerprintModeModel = computed<'pcm' | 'file'>({
  get: () => runtime.setting.fingerprintMode || 'pcm',
  set: (value) => {
    runtime.setting.fingerprintMode = value
  }
})

const showIdleAnalysisStatusModel = computed<boolean>({
  get: () => runtime.setting.showIdleAnalysisStatus === true,
  set: (value) => {
    runtime.setting.showIdleAnalysisStatus = value
  }
})

const analysisBpmRangeModel = computed<AnalysisBpmRangePresetId>({
  get: () => normalizeAnalysisBpmRangeId(runtime.setting.analysisBpmRange),
  set: (value) => {
    runtime.setting.analysisBpmRange = normalizeAnalysisBpmRangeId(value)
  }
})

const analysisBpmRangeOptions = computed(() =>
  buildAnalysisBpmRangeOptions(analysisBpmRangeModel.value)
)

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

const autoFillSkipCompletedModel = computed<boolean>({
  get: () => runtime.setting.autoFillSkipCompleted !== false,
  set: (value) => {
    runtime.setting.autoFillSkipCompleted = value
  }
})

const enableExplorerContextMenuModel = computed<boolean>({
  get: () => runtime.setting.enableExplorerContextMenu === true,
  set: (value) => {
    runtime.setting.enableExplorerContextMenu = value
  }
})

const rekordboxUserMode = computed({
  get: () => runtime.setting.userGuideAudience || 'general',
  set: (value: string) => {
    if (value === 'rekordbox' || value === 'general' || value === 'veteran') {
      runtime.setting.userGuideAudience = value
    }
  }
})
const rekordboxUserModeOptions = computed(() => [
  { label: t('userGuide.identity.rekordbox'), value: 'rekordbox' },
  { label: t('userGuide.identity.general'), value: 'general' },
  { label: t('userGuide.identity.veteran'), value: 'veteran' }
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
  const current = normalizePlaybackRangeSectionKinds(runtime.setting.playbackRangeSectionKinds)
  const selected = new Set(current)
  if (checked) {
    selected.add(kind)
  } else if (selected.size > 1) {
    selected.delete(kind)
  }
  runtime.setting.playbackRangeSectionKinds = PLAYBACK_RANGE_SECTION_KINDS.filter((item) =>
    selected.has(item)
  )
  setSetting()
}

const currentLibraryPathText = computed(
  () => runtime.setting.databaseUrl || t('database.notConfigured')
)

const openCurrentLibraryInExplorer = () => {
  window.electron.ipcRenderer.send('open-current-library-root-in-explorer')
}

const rekordboxDesktopTrackStorageDirText = computed(
  () =>
    runtime.setting.rekordboxDesktopTrackStorageDir ||
    t('settings.rekordboxDesktopTrackStorageDir.notConfigured')
)
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">
        <span>{{ t('common.setting') }}</span>
      </div>
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
        class="dialog-scroll"
        defer
      >
        <div class="dialog-content">
          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionCommonTitle') }}</div>

            <div class="setting-block">{{ t('theme.mode') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.themeMode"
                :options="themeModeOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('theme.accentColor') }}：</div>
            <div class="setting-control accent-color-control">
              <div class="accent-swatches">
                <button
                  v-for="preset in accentColorPresets"
                  :key="preset"
                  type="button"
                  class="accent-swatch"
                  :class="{ 'accent-swatch--active': currentAccentColor === preset }"
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
              <span class="accent-reset" @click="resetAccentColor">{{
                t('theme.accentDefault')
              }}</span>
            </div>

            <div class="setting-block">{{ t('common.language') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.language"
                :options="languageOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('player.browserPlayerRightTrackInfo') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="browserPlayerRightTrackInfoModel"
                :options="browserPlayerRightTrackInfoOptions"
                :width="220"
                :max-height="280"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('player.audioOutputDevice') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.audioOutputDeviceId"
                :options="audioOutputSelectOptions"
                :width="280"
                :disabled="!audioOutputSupported || isEnumeratingAudioOutputs"
                @change="handleAudioOutputChange"
              />
              <div v-if="audioOutputError" class="error-text">{{ audioOutputError }}</div>
            </div>

            <div class="setting-block">{{ t('shortcuts.globalCallShortcut') }}：</div>
            <div class="setting-control">
              <bubbleBoxTrigger
                tag="div"
                class="chooseDirDiv"
                :title="runtime.setting.globalCallShortcut"
                @click="globalCallShortcutHandle()"
              >
                {{ runtime.setting.globalCallShortcut }}
              </bubbleBoxTrigger>
            </div>

            <label class="setting-block" for="setting-checkbox-autoPlayNext"
              >{{ t('player.autoPlayNext') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-autoPlayNext"
                v-model="runtime.setting.autoPlayNextSong"
                @change="setSetting()"
              />
            </div>

            <label class="setting-block" for="setting-checkbox-autoCenterSong"
              >{{ t('player.autoCenterSong') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-autoCenterSong"
                v-model="runtime.setting.autoScrollToCurrentSong"
                @change="setSetting()"
              />
            </div>

            <div class="setting-block">{{ t('player.recentPlaylistCache') }}：</div>
            <div class="setting-control">
              <input
                v-model="runtime.setting.recentDialogSelectedSongListMaxCount"
                class="myInput"
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
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionPlaybackRangeTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-enablePlaybackRange"
              >{{ t('player.enablePlaybackRange') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-enablePlaybackRange"
                v-model="runtime.setting.enablePlaybackRange"
                @change="setSetting()"
              />
            </div>

            <template v-if="runtime.setting.enablePlaybackRange">
              <div class="setting-block">{{ t('player.playbackRangeMode') }}：</div>
              <div class="setting-control">
                <BaseSelect
                  v-model="playbackRangeModeModel"
                  :options="playbackRangeModeOptions"
                  :width="220"
                  @change="setSetting"
                />
              </div>

              <template v-if="playbackRangeModeModel === 'section'">
                <div class="setting-block">{{ t('player.playbackRangeSectionKinds') }}：</div>
                <div class="setting-control section-kind-list">
                  <singleCheckbox
                    v-for="option in playbackRangeSectionKindOptions"
                    :id="`setting-checkbox-playbackRangeSection-${option.value}`"
                    :key="option.value"
                    class="section-kind-item"
                    :model-value="playbackRangeSelectedSectionKinds.has(option.value)"
                    @change="
                      (checked) => togglePlaybackRangeSectionKind(option.value, Boolean(checked))
                    "
                  >
                    {{ option.label }}
                  </singleCheckbox>
                </div>

                <div class="setting-block">{{ t('player.playbackRangeSectionMatchMode') }}：</div>
                <div class="setting-control">
                  <BaseSelect
                    v-model="playbackRangeSectionMatchModeModel"
                    :options="playbackRangeSectionMatchModeOptions"
                    :width="220"
                    @change="setSetting"
                  />
                </div>
              </template>
            </template>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionLibraryTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-curatedArtistTracking"
              >{{ t('settings.curatedArtistTracking.title') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-curatedArtistTracking"
                v-model="runtime.setting.enableCuratedArtistTracking"
                @change="setSetting()"
              />
              <div class="setting-hint">{{ t('settings.curatedArtistTracking.desc') }}</div>
              <div class="setting-hint">
                {{
                  t('settings.curatedArtistTracking.clearDesc', {
                    count: curatedArtistFavoritesCount
                  })
                }}
              </div>
              <div class="buttonRow">
                <div
                  class="button settings-inline-button"
                  @click="openCuratedArtistFavoritesDialog()"
                >
                  {{ t('settings.curatedArtistTracking.managerButton') }}
                </div>
                <div
                  class="dangerButton settings-inline-button"
                  @click="clearCuratedArtistFavorites()"
                >
                  {{ t('settings.curatedArtistTracking.clearButton') }}
                </div>
              </div>
            </div>

            <label class="setting-block" for="setting-checkbox-persistFiltersAfterRestart"
              >{{ t('filters.persistFiltersAfterRestart') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-persistFiltersAfterRestart"
                v-model="runtime.setting.persistSongFilters"
                @change="setSetting()"
              />
            </div>

            <label class="setting-block" for="setting-checkbox-showPlaylistTrackCount"
              >{{ t('settings.showPlaylistTrackCount') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-showPlaylistTrackCount"
                v-model="runtime.setting.showPlaylistTrackCount"
                @change="setSetting()"
              />
            </div>

            <template v-if="isWindowsPlatform">
              <label class="setting-block" for="setting-checkbox-enableExplorerContextMenu"
                >{{ t('settings.enableExplorerContextMenu') }}：</label
              >
              <div class="setting-control">
                <singleCheckbox
                  id="setting-checkbox-enableExplorerContextMenu"
                  v-model="enableExplorerContextMenuModel"
                  @change="setSetting()"
                />
              </div>
            </template>

            <div class="setting-block">{{ t('settings.songListBubble.title') }}：</div>
            <div class="setting-control">
              <singleRadioGroup
                v-model="songListBubbleMode"
                name="songListBubble"
                :options="[
                  { label: t('settings.songListBubble.overflowOnly'), value: 'overflowOnly' },
                  { label: t('settings.songListBubble.always'), value: 'always' }
                ]"
                :option-font-size="12"
                @change="setSetting()"
              >
                <template #option="{ opt }">
                  <span class="label">{{ opt.label }}</span>
                </template>
              </singleRadioGroup>
              <div class="setting-hint">{{ t('settings.songListBubble.hint') }}</div>
            </div>

            <div class="setting-block">{{ t('settings.currentLibraryPath') }}：</div>
            <div class="setting-control">
              <bubbleBoxTrigger tag="div" class="path-display" :title="currentLibraryPathText">
                {{ currentLibraryPathText }}
              </bubbleBoxTrigger>
              <div class="setting-hint">{{ t('settings.currentLibraryPathHint') }}</div>
              <div class="buttonRow">
                <div class="button settings-inline-button" @click="openCurrentLibraryInExplorer()">
                  {{ t('settings.openCurrentLibraryInExplorer') }}
                </div>
              </div>
            </div>

            <div class="setting-block">{{ t('database.reselectLocation') }}：</div>
            <div class="setting-control">
              <div class="button settings-inline-button" @click="reSelectLibrary()">
                {{ t('dialog.reselect') }}
              </div>
            </div>

            <div class="setting-block">
              {{ t('settings.rekordboxDesktopTrackStorageDir.title') }}：
            </div>
            <div class="setting-control">
              <bubbleBoxTrigger
                tag="div"
                class="path-display"
                :title="rekordboxDesktopTrackStorageDirText"
              >
                {{ rekordboxDesktopTrackStorageDirText }}
              </bubbleBoxTrigger>
              <div class="setting-hint">
                {{ t('settings.rekordboxDesktopTrackStorageDir.hint') }}
              </div>
              <div class="buttonRow">
                <div
                  class="button settings-inline-button"
                  @click="chooseRekordboxDesktopTrackStorageDir()"
                >
                  {{ t('settings.rekordboxDesktopTrackStorageDir.chooseButton') }}
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionPlaybackTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-hideControlsShowWaveform"
              >{{ t('player.hideControlsShowWaveform') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-hideControlsShowWaveform"
                v-model="runtime.setting.hiddenPlayControlArea"
                @change="setSetting()"
              />
            </div>

            <div class="setting-block">{{ t('player.waveformMode') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.waveformMode"
                :options="waveformModeOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('player.keyDisplayStyle') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.keyDisplayStyle"
                :options="keyDisplayStyleOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <label class="setting-block" for="setting-checkbox-showTitleAudioVisualizer"
              >{{ t('player.showTitleAudioVisualizer') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-showTitleAudioVisualizer"
                v-model="showTitleAudioVisualizerModel"
                @change="setSetting()"
              />
            </div>

            <div class="setting-block">{{ t('shortcuts.playerGlobalShortcuts') }}：</div>
            <div class="setting-control">
              <div class="playerShortcutList">
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">
                    {{ t('shortcuts.globalPlayPauseShortcut') }}
                  </div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.togglePlayPause"
                    @click="playerGlobalShortcutHandle('togglePlayPause')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.togglePlayPause }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">
                    {{ t('shortcuts.globalFastForwardShortcut') }}
                  </div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.fastForward"
                    @click="playerGlobalShortcutHandle('fastForward')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.fastForward }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">
                    {{ t('shortcuts.globalFastBackwardShortcut') }}
                  </div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.fastBackward"
                    @click="playerGlobalShortcutHandle('fastBackward')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.fastBackward }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">{{ t('shortcuts.globalNextShortcut') }}</div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.nextSong"
                    @click="playerGlobalShortcutHandle('nextSong')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.nextSong }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">{{ t('shortcuts.globalPreviousShortcut') }}</div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.previousSong"
                    @click="playerGlobalShortcutHandle('previousSong')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.previousSong }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">
                    {{ t('shortcuts.globalSeekPercentShortcut') }}
                  </div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="seekPercentModifierDisplay"
                    @click="playerGlobalShortcutHandle('seekPercentModifier')"
                  >
                    {{ seekPercentModifierDisplay }}
                  </bubbleBoxTrigger>
                </div>
              </div>
              <div class="playerShortcutHint">{{ t('shortcuts.playerGlobalShortcutsHint') }}</div>
              <div class="playerShortcutHint">
                {{ t('shortcuts.globalSeekPercentShortcutHint') }}
              </div>
            </div>

            <div class="setting-block">{{ t('player.fastForwardTime') }}：</div>
            <div class="setting-control number-row">
              <input
                v-model="runtime.setting.fastForwardTime"
                class="myInput"
                type="number"
                min="1"
                step="1"
                @input="
                  runtime.setting.fastForwardTime = Math.max(
                    1,
                    Math.floor(Number(runtime.setting.fastForwardTime || 1))
                  )
                "
                @blur="setSetting()"
              />
              <span>{{ t('player.seconds') }}</span>
            </div>

            <div class="setting-block">{{ t('player.fastBackwardTime') }}：</div>
            <div class="setting-control number-row">
              <input
                v-model="runtime.setting.fastBackwardTime"
                class="myInput"
                type="number"
                max="-1"
                step="1"
                @input="
                  runtime.setting.fastBackwardTime = Math.min(
                    -1,
                    Math.floor(Number(runtime.setting.fastBackwardTime || -1))
                  )
                "
                @blur="setSetting()"
              />
              <span>{{ t('player.seconds') }}</span>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionAnalysisTitle') }}</div>

            <div class="setting-block">{{ t('settings.analysisBpmRange.label') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="analysisBpmRangeModel"
                :options="analysisBpmRangeOptions"
                :width="220"
                :max-height="280"
                @change="setSetting"
              />
              <div class="setting-hint">{{ t('settings.analysisBpmRange.settingsHint') }}</div>
              <div class="setting-hint">
                {{ t('settings.analysisBpmRange.settingsScopeHint') }}
              </div>
            </div>

            <label class="setting-block" for="setting-checkbox-showIdleAnalysisStatus"
              >{{ t('player.showIdleAnalysisStatus') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-showIdleAnalysisStatus"
                v-model="showIdleAnalysisStatusModel"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('settings.ultraStemModel.title') }}：</div>
            <div class="setting-control">
              <div class="setting-hint">{{ t('settings.ultraStemModel.desc') }}</div>
              <div class="model-manager-row">
                <span>{{ ultraModelStatusText }}</span>
                <span v-if="ultraModelInfo?.alreadyAvailable">
                  {{
                    t('settings.ultraStemModel.diskUsage', {
                      size: formatAnalysisRuntimeBytes(ultraModelInfo.installedSize)
                    })
                  }}
                </span>
              </div>
              <div v-if="ultraModelInfo?.alreadyAvailable" class="actionRow">
                <div class="dangerButton settings-inline-button" @click="removeUltraModel()">
                  {{ t('settings.ultraStemModel.removeButton') }}
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionMetadataTitle') }}</div>

            <div class="setting-block">{{ t('metadata.acoustidSettingTitle') }}：</div>
            <div class="setting-control">
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc1') }}</div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc2') }}</div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc3') }}</div>
              <div class="acoustid-row">
                <input
                  v-model="runtime.setting.acoustIdClientKey"
                  class="acoustid-input"
                  :class="{ invalid: acoustIdKeyErrorText }"
                  :placeholder="t('metadata.acoustidSettingPlaceholder')"
                  :disabled="acoustIdKeyValidating"
                  @blur="handleAcoustIdKeyBlur"
                />
                <div class="button settings-inline-button" @click="openAcoustIdSite">
                  {{ t('metadata.acoustidSettingOpenLink') }}
                </div>
              </div>
              <div v-if="acoustIdKeyValidating" class="setting-hint">
                {{ t('metadata.acoustidKeyValidating') }}
              </div>
              <div v-else-if="acoustIdKeyErrorText" class="error-text">
                {{ acoustIdKeyErrorText }}
              </div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingRateHint') }}</div>
            </div>

            <label class="setting-block" for="setting-checkbox-autoFillSkipCompleted"
              >{{ t('metadata.autoFillSkipCompleted') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-autoFillSkipCompleted"
                v-model="autoFillSkipCompletedModel"
                @change="setSetting()"
              />
              <div class="setting-hint">{{ t('metadata.autoFillSkipCompletedHint') }}</div>
            </div>

            <div class="setting-block">{{ t('fingerprints.mode') }}：</div>
            <div class="setting-control">
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
                    style="width: 14px; height: 14px; margin-left: 6px"
                    :draggable="false"
                  />
                  <bubbleBox
                    :dom="fpModeHintRefs[opt.value] || null"
                    :title="
                      opt.value === 'pcm'
                        ? t('fingerprints.modePCMHint')
                        : t('fingerprints.modeFileHint')
                    "
                    :max-width="360"
                  />
                </template>
              </singleRadioGroup>
              <div class="setting-hint">{{ t('fingerprints.modeIncompatibleWarning') }}</div>
            </div>

            <div class="setting-block">{{ t('fingerprints.scanFormats') }}：</div>
            <div class="setting-control">
              <div class="formatList">
                <template v-for="fmt in allFormats" :key="fmt">
                  <div class="formatItem">
                    <label :for="'setting-checkbox-ext-' + fmt" style="user-select: none"
                      >.{{ fmt }}</label
                    >
                    <singleCheckbox
                      :id="'setting-checkbox-ext-' + fmt"
                      v-model="audioExt[fmt]"
                      @change="extChange()"
                    />
                  </div>
                </template>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionUserGuideTitle') }}</div>

            <div class="setting-block">{{ t('userGuide.settingTitle') }}：</div>
            <div class="setting-control">
              <singleRadioGroup
                v-model="rekordboxUserMode"
                name="userGuideIdentity"
                :options="rekordboxUserModeOptions"
                :option-font-size="12"
                @change="setSetting()"
              />
              <div class="setting-hint">{{ t('userGuide.settingHint') }}</div>
            </div>
          </div>

          <div class="settings-section settings-section--danger">
            <div class="section-title">{{ t('settings.layout.sectionSafetyTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-enableErrorReport"
              >{{ t('errorReport.enable') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-enableErrorReport"
                v-model="runtime.setting.enableErrorReport"
                @change="setSetting()"
              />
              <div class="setting-hint">{{ t('errorReport.hint') }}</div>
            </div>

            <div class="setting-block">{{ t('fingerprints.clear') }}：</div>
            <div class="setting-control">
              <div class="setting-hint">
                {{ t('fingerprints.currentCount', { count: songFingerprintListLength }) }}
              </div>
              <div class="actionRow">
                <div
                  class="dangerButton settings-inline-button"
                  @click="clearTracksFingerprintLibrary()"
                >
                  {{ t('fingerprints.clearShort') }}
                </div>
              </div>
            </div>

            <div class="setting-block">{{ t('cloudSync.reset.sectionTitle') }}：</div>
            <div class="setting-control">
              <div class="setting-hint">{{ t('cloudSync.reset.description') }}</div>
              <div class="actionRow">
                <div class="dangerButton settings-inline-button" @click="clearCloudFingerprints()">
                  {{ t('cloudSync.reset.short') }}
                </div>
              </div>
            </div>

            <template v-if="isDevOrPrerelease">
              <div class="setting-block">{{ t('settings.clearDirtyData.title') }}：</div>
              <div class="setting-control">
                <div class="setting-hint">{{ t('settings.clearDirtyData.desc') }}</div>
                <div class="actionRow">
                  <div class="dangerButton settings-inline-button" @click="clearLibraryDirtyData()">
                    {{ t('settings.clearDirtyData.button') }}
                  </div>
                </div>
              </div>

              <div class="setting-block">{{ t('settings.clearAnalysisRuntime.title') }}：</div>
              <div class="setting-control">
                <div class="setting-hint">{{ t('settings.clearAnalysisRuntime.desc') }}</div>
                <div class="actionRow">
                  <div class="dangerButton settings-inline-button" @click="clearAnalysisRuntime()">
                    {{ t('settings.clearAnalysisRuntime.button') }}
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </OverlayScrollbarsComponent>
      <div class="dialog-footer">
        <div class="button" @click="cancel">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.inner {
  width: 60vw;
  height: 70vh;
  display: flex;
  flex-direction: column;
}

.dialog-scroll {
  height: 100%;
  width: 100%;
}

.dialog-content {
  padding: 20px;
  font-size: 14px;
  flex-grow: 1;
}

.settings-section {
  padding-top: 2px;
  margin-top: 30px;
}

.settings-section:first-child {
  margin-top: 0;
}

.settings-section--danger {
  margin-top: 34px;
}

.section-title {
  position: relative;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  padding-left: 12px;
  margin-bottom: 4px;
}

.section-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 4px;
  height: 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 52%, transparent);
  transform: translateY(-50%);
}

.settings-section--danger .section-title {
  color: var(--text);
}

.settings-section--danger .section-title::before {
  background: rgba(232, 17, 35, 0.5);
}

.setting-block {
  margin-top: 20px;
}

label.setting-block {
  display: block;
  user-select: none;
}

.setting-control {
  margin-top: 10px;
  max-width: 100%;
}

.accent-color-control {
  display: flex;
  align-items: center;
  gap: 14px;
}

.accent-swatches {
  display: flex;
  align-items: center;
  gap: 8px;
}

.accent-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
  cursor: pointer;
}

.accent-swatch--active {
  border-color: var(--text);
}

.accent-reset {
  color: var(--accent);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.number-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.buttonRow {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.actionRow {
  margin-top: 10px;
}

.formatList {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.formatItem {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 82px;
}

.section-kind-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  max-width: 360px;
}

.section-kind-item {
  min-width: 86px;
}

.myInput {
  width: 72px;
  height: 26px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 3px;
  padding: 0 6px;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.dangerButton {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  border: 1px solid var(--border);
  font-size: 14px;

  &:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}

.chooseDirDiv {
  height: 25px;
  line-height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 14px;
  padding-left: 5px;
  box-sizing: border-box;
  width: 220px;
  max-width: 100%;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.path-display {
  width: min(520px, 100%);
  max-width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  white-space: normal;
  word-break: break-all;
  user-select: text;
}

.setting-hint {
  font-size: 12px;
  color: var(--text-secondary, #8c8c8c);
  margin-top: 8px;
  line-height: 1.5;
}

.model-manager-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 8px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}

.model-manager-row span + span {
  color: var(--text-secondary, #8c8c8c);
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

.acoustid-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}

.acoustid-input {
  width: 280px;
  max-width: 100%;
  height: 25px;
  border: 1px solid var(--border);
  background-color: var(--bg-elev);
  color: var(--text);
  border-radius: 3px;
  padding: 0 8px;
  outline: none;
}

.acoustid-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.acoustid-input.invalid {
  border-color: #e81123;
}

.error-text {
  color: #e81123;
  font-size: 12px;
  margin-top: 6px;
}

.playerShortcutList {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.playerShortcutRow {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.playerShortcutLabel {
  min-width: 130px;
  font-size: 13px;
  color: var(--text-weak);
}

.playerShortcutHint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-weak);
}

@media (max-width: 900px) {
  .inner {
    width: 90vw;
    height: 84vh;
  }

  .settings-section {
    margin-top: 26px;
  }

  .playerShortcutRow {
    flex-direction: column;
    align-items: stretch;
  }

  .playerShortcutLabel {
    min-width: 0;
  }

  .acoustid-row {
    flex-direction: column;
    align-items: stretch;
  }

  .chooseDirDiv,
  .acoustid-input {
    width: 100%;
  }
}
</style>
