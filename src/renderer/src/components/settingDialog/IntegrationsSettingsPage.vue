<script setup lang="ts">
import { computed, inject } from 'vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import { useNeteaseSettings } from './useNeteaseSettings'
import { useAcoustIdKey } from './useAcoustIdKey'
import { useDjStorageDirs } from './useDjStorageDirs'
import SettingsPage from './SettingsPage.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'
import BooleanSettingRow from './BooleanSettingRow.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const { runtime, setSetting, isWindowsPlatform } = ctx

const {
  neteaseQualityOptions,
  neteaseLevelModel,
  neteaseRemovePlaylistLocalFilesOptions,
  neteaseRemovePlaylistLocalFilesModel,
  showNeteaseLibraryIconModel,
  neteaseCacheOptions,
  neteaseCacheModel,
  neteaseCacheUsage,
  neteaseCacheUsageText,
  handleNeteaseCacheLimitChange,
  clearNeteasePreviewCache
} = useNeteaseSettings(runtime, setSetting)

const { acoustIdKeyValidating, acoustIdKeyErrorText, openAcoustIdSite, handleAcoustIdKeyBlur } =
  useAcoustIdKey(runtime, setSetting)

const {
  rekordboxDesktopTrackStorageDirText,
  seratoTrackStorageDirText,
  traktorTrackStorageDirText,
  chooseRekordboxDesktopTrackStorageDir,
  chooseSeratoTrackStorageDir,
  chooseTraktorTrackStorageDir
} = useDjStorageDirs(runtime, setSetting)

const enableExplorerContextMenuModel = computed<boolean>({
  get: () => runtime.setting.enableExplorerContextMenu === true,
  set: (value) => {
    runtime.setting.enableExplorerContextMenu = value
  }
})
</script>

<template>
  <SettingsPage page="integrations">
    <SettingsGroup title-key="settings.groups.netease">
      <BooleanSettingRow
        id="neteaseLibraryIcon"
        control-id="setting-checkbox-showNeteaseLibraryIcon"
      >
        <singleCheckbox
          id="setting-checkbox-showNeteaseLibraryIcon"
          v-model="showNeteaseLibraryIconModel"
          @change="setSetting('neteaseLibraryIcon')"
        />
        <template #details>
          <div class="settings-hint">{{ t('netease.settings.showLibraryIconHint') }}</div>
        </template>
      </BooleanSettingRow>

      <SettingRow id="neteaseQuality" inline>
        <BaseSelect
          v-model="neteaseLevelModel"
          :options="neteaseQualityOptions"
          :width="260"
          @change="setSetting('neteaseQuality')"
        />
        <template #details>
          <div class="settings-hint">{{ t('netease.settings.qualityHint') }}</div>
        </template>
      </SettingRow>

      <SettingRow id="neteaseCache" inline stacked>
        <BaseSelect
          v-model="neteaseCacheModel"
          :options="neteaseCacheOptions"
          :width="260"
          @change="handleNeteaseCacheLimitChange()"
        />
        <template #details>
          <div class="settings-hint">
            {{ t('netease.settings.cacheHint') }}
            <template v-if="neteaseCacheUsage">
              {{ t('netease.settings.cacheUsage', { size: neteaseCacheUsageText }) }}
            </template>
          </div>
          <div class="settings-button-row">
            <button
              type="button"
              class="settings-inline-button"
              @click="clearNeteasePreviewCache()"
            >
              {{ t('netease.settings.clearCache') }}
            </button>
          </div>
        </template>
      </SettingRow>

      <SettingRow id="neteaseRemovePlaylistLocalFiles" inline stacked>
        <BaseSelect
          v-model="neteaseRemovePlaylistLocalFilesModel"
          :options="neteaseRemovePlaylistLocalFilesOptions"
          :width="150"
          @change="setSetting('neteaseRemovePlaylistLocalFiles')"
        />
        <template #details>
          <div class="settings-hint">{{ t('netease.settings.removePlaylistLocalFilesHint') }}</div>
        </template>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.metadataRecognition">
      <SettingRow id="acoustIdClientKey" stacked>
        <div class="settings-hint settings-hint--first">
          {{ t('metadata.acoustidSettingDesc1') }}
        </div>
        <div class="settings-hint">{{ t('metadata.acoustidSettingDesc2') }}</div>
        <div class="settings-hint">{{ t('metadata.acoustidSettingDesc3') }}</div>
        <div class="settings-acoustid-row">
          <input
            v-model="runtime.setting.acoustIdClientKey"
            class="settings-text-input"
            :class="{ 'settings-text-input--invalid': acoustIdKeyErrorText }"
            :placeholder="t('metadata.acoustidSettingPlaceholder')"
            :disabled="acoustIdKeyValidating"
            @blur="handleAcoustIdKeyBlur"
          />
          <button type="button" class="settings-inline-button" @click="openAcoustIdSite">
            {{ t('metadata.acoustidSettingOpenLink') }}
          </button>
        </div>
        <div v-if="acoustIdKeyValidating" class="settings-hint">
          {{ t('metadata.acoustidKeyValidating') }}
        </div>
        <div v-else-if="acoustIdKeyErrorText" class="settings-error-text">
          {{ acoustIdKeyErrorText }}
        </div>
        <div class="settings-hint">{{ t('metadata.acoustidSettingRateHint') }}</div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.djLibraries">
      <SettingRow id="rekordboxDesktopTrackStorageDir">
        <bubbleBoxTrigger
          tag="div"
          class="settings-path-display"
          :title="rekordboxDesktopTrackStorageDirText"
        >
          {{ rekordboxDesktopTrackStorageDirText }}
        </bubbleBoxTrigger>
        <div class="settings-hint">{{ t('settings.rekordboxDesktopTrackStorageDir.hint') }}</div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button"
            @click="chooseRekordboxDesktopTrackStorageDir()"
          >
            {{ t('settings.rekordboxDesktopTrackStorageDir.chooseButton') }}
          </button>
        </div>
      </SettingRow>

      <SettingRow id="seratoTrackStorageDir">
        <bubbleBoxTrigger
          tag="div"
          class="settings-path-display"
          :title="seratoTrackStorageDirText"
        >
          {{ seratoTrackStorageDirText }}
        </bubbleBoxTrigger>
        <div class="settings-hint">{{ t('settings.seratoTrackStorageDir.hint') }}</div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button"
            @click="chooseSeratoTrackStorageDir()"
          >
            {{ t('settings.seratoTrackStorageDir.chooseButton') }}
          </button>
        </div>
      </SettingRow>

      <SettingRow id="traktorTrackStorageDir">
        <bubbleBoxTrigger
          tag="div"
          class="settings-path-display"
          :title="traktorTrackStorageDirText"
        >
          {{ traktorTrackStorageDirText }}
        </bubbleBoxTrigger>
        <div class="settings-hint">{{ t('settings.traktorTrackStorageDir.hint') }}</div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button"
            @click="chooseTraktorTrackStorageDir()"
          >
            {{ t('settings.traktorTrackStorageDir.chooseButton') }}
          </button>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup v-if="isWindowsPlatform" title-key="settings.groups.systemIntegration">
      <BooleanSettingRow
        id="enableExplorerContextMenu"
        control-id="setting-checkbox-enableExplorerContextMenu"
        stacked
      >
        <singleCheckbox
          id="setting-checkbox-enableExplorerContextMenu"
          v-model="enableExplorerContextMenuModel"
          @change="setSetting('enableExplorerContextMenu')"
        />
      </BooleanSettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>
