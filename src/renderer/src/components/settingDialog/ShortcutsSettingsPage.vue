<script setup lang="ts">
import { computed, inject } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import { formatSeekPercentModifierSettingValue } from '@shared/playerGlobalShortcuts'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import { useShortcutDialogs } from './useShortcutDialogs'
import SettingsPage from './SettingsPage.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const { runtime, setSetting } = ctx
const { globalCallShortcutHandle, playerGlobalShortcutHandle } = useShortcutDialogs(
  runtime,
  setSetting
)

const seekPercentModifierDisplay = computed(() => {
  const formatted = formatSeekPercentModifierSettingValue(
    runtime.setting.playerGlobalShortcuts?.seekPercentModifier || ''
  )
  return formatted || t('shortcuts.globalSeekPercentShortcutOff')
})
</script>

<template>
  <SettingsPage page="shortcuts">
    <SettingsGroup title-key="settings.groups.windowShortcuts">
      <SettingRow id="globalCallShortcut" stacked inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-shortcut-value"
          :title="runtime.setting.globalCallShortcut"
          @click="globalCallShortcutHandle()"
        >
          {{ runtime.setting.globalCallShortcut }}
        </bubbleBoxTrigger>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.playerShortcuts">
      <SettingRow id="shortcutTogglePlayPause" inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-shortcut-value"
          :title="runtime.setting.playerGlobalShortcuts.togglePlayPause"
          @click="playerGlobalShortcutHandle('togglePlayPause')"
        >
          {{ runtime.setting.playerGlobalShortcuts.togglePlayPause }}
        </bubbleBoxTrigger>
      </SettingRow>

      <SettingRow id="shortcutFastForward" inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-shortcut-value"
          :title="runtime.setting.playerGlobalShortcuts.fastForward"
          @click="playerGlobalShortcutHandle('fastForward')"
        >
          {{ runtime.setting.playerGlobalShortcuts.fastForward }}
        </bubbleBoxTrigger>
      </SettingRow>

      <SettingRow id="shortcutFastBackward" inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-shortcut-value"
          :title="runtime.setting.playerGlobalShortcuts.fastBackward"
          @click="playerGlobalShortcutHandle('fastBackward')"
        >
          {{ runtime.setting.playerGlobalShortcuts.fastBackward }}
        </bubbleBoxTrigger>
      </SettingRow>

      <SettingRow id="shortcutNextSong" inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-shortcut-value"
          :title="runtime.setting.playerGlobalShortcuts.nextSong"
          @click="playerGlobalShortcutHandle('nextSong')"
        >
          {{ runtime.setting.playerGlobalShortcuts.nextSong }}
        </bubbleBoxTrigger>
      </SettingRow>

      <SettingRow id="shortcutPreviousSong" inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-shortcut-value"
          :title="runtime.setting.playerGlobalShortcuts.previousSong"
          @click="playerGlobalShortcutHandle('previousSong')"
        >
          {{ runtime.setting.playerGlobalShortcuts.previousSong }}
        </bubbleBoxTrigger>
      </SettingRow>

      <SettingRow id="shortcutSeekPercent" inline>
        <bubbleBoxTrigger
          tag="div"
          class="settings-shortcut-value"
          :title="seekPercentModifierDisplay"
          @click="playerGlobalShortcutHandle('seekPercentModifier')"
        >
          {{ seekPercentModifierDisplay }}
        </bubbleBoxTrigger>
      </SettingRow>

      <div class="settings-group__footnote">
        <div>{{ t('shortcuts.playerGlobalShortcutsHint') }}</div>
        <div>{{ t('shortcuts.globalSeekPercentShortcutHint') }}</div>
      </div>
    </SettingsGroup>
  </SettingsPage>
</template>
