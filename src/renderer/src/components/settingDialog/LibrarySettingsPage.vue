<script setup lang="ts">
import { computed, inject } from 'vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import { useCuratedArtists } from './useCuratedArtists'
import { useLibraryLocation } from './useLibraryLocation'
import SettingsPage from './SettingsPage.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'
import BooleanSettingRow from './BooleanSettingRow.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const { runtime, setSetting, closeImmediately } = ctx

const {
  curatedArtistFavoritesCount,
  clearCuratedArtistFavorites,
  openCuratedArtistFavoritesDialog
} = useCuratedArtists(runtime)
const { currentLibraryPathText, openCurrentLibraryInExplorer, reSelectLibrary } =
  useLibraryLocation(runtime, setSetting, closeImmediately)

const songListBubbleMode = computed<'overflowOnly' | 'always'>({
  get() {
    return runtime.setting.songListBubbleAlways ? 'always' : 'overflowOnly'
  },
  set(value) {
    runtime.setting.songListBubbleAlways = value === 'always'
  }
})
</script>

<template>
  <SettingsPage page="library">
    <SettingsGroup title-key="settings.groups.libraryList">
      <BooleanSettingRow
        id="showPlaylistTrackCount"
        control-id="setting-checkbox-showPlaylistTrackCount"
      >
        <singleCheckbox
          id="setting-checkbox-showPlaylistTrackCount"
          v-model="runtime.setting.showPlaylistTrackCount"
          @change="setSetting('showPlaylistTrackCount')"
        />
      </BooleanSettingRow>

      <BooleanSettingRow id="autoScrollToCurrentSong" control-id="setting-checkbox-autoCenterSong">
        <singleCheckbox
          id="setting-checkbox-autoCenterSong"
          v-model="runtime.setting.autoScrollToCurrentSong"
          @change="setSetting('autoScrollToCurrentSong')"
        />
      </BooleanSettingRow>

      <SettingRow id="songListBubbleAlways" stacked>
        <singleRadioGroup
          v-model="songListBubbleMode"
          name="songListBubble"
          :options="[
            { label: t('settings.songListBubble.overflowOnly'), value: 'overflowOnly' },
            { label: t('settings.songListBubble.always'), value: 'always' }
          ]"
          :option-font-size="12"
          @change="setSetting('songListBubbleAlways')"
        />
        <div class="settings-hint">{{ t('settings.songListBubble.hint') }}</div>
      </SettingRow>

      <BooleanSettingRow
        id="persistSongFilters"
        control-id="setting-checkbox-persistFiltersAfterRestart"
        stacked
      >
        <singleCheckbox
          id="setting-checkbox-persistFiltersAfterRestart"
          v-model="runtime.setting.persistSongFilters"
          @change="setSetting('persistSongFilters')"
        />
      </BooleanSettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.curatedArtists">
      <BooleanSettingRow
        id="curatedArtistTracking"
        control-id="setting-checkbox-curatedArtistTracking"
        stacked
      >
        <singleCheckbox
          id="setting-checkbox-curatedArtistTracking"
          v-model="runtime.setting.enableCuratedArtistTracking"
          @change="setSetting('curatedArtistTracking')"
        />
        <template #details>
          <div class="settings-hint">{{ t('settings.curatedArtistTracking.desc') }}</div>
          <div class="settings-hint">
            {{
              t('settings.curatedArtistTracking.clearDesc', {
                count: curatedArtistFavoritesCount
              })
            }}
          </div>
          <div class="settings-button-row">
            <button
              type="button"
              class="settings-inline-button"
              @click="openCuratedArtistFavoritesDialog()"
            >
              {{ t('settings.curatedArtistTracking.managerButton') }}
            </button>
            <button
              type="button"
              class="settings-inline-button settings-inline-button--danger"
              @click="clearCuratedArtistFavorites()"
            >
              {{ t('settings.curatedArtistTracking.clearButton') }}
            </button>
          </div>
        </template>
      </BooleanSettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.libraryLocation">
      <SettingRow id="currentLibraryPath" stacked>
        <bubbleBoxTrigger tag="div" class="settings-path-display" :title="currentLibraryPathText">
          {{ currentLibraryPathText }}
        </bubbleBoxTrigger>
        <div class="settings-hint">{{ t('settings.currentLibraryPathHint') }}</div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button"
            @click="openCurrentLibraryInExplorer()"
          >
            {{ t('settings.openCurrentLibraryInExplorer') }}
          </button>
        </div>
      </SettingRow>

      <SettingRow id="reselectLibrary" stacked inline>
        <button type="button" class="settings-inline-button" @click="reSelectLibrary()">
          {{ t('dialog.reselect') }}
        </button>
      </SettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>
