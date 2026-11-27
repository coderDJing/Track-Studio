<script setup lang="ts">
import { inject } from 'vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import confirm from '@renderer/components/confirmDialog'
import dangerConfirmWithInput from '@renderer/components/dangerConfirmWithInputDialog'
import { t } from '@renderer/utils/translate'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import { useFingerprintLibrary } from './useFingerprintLibrary'
import { useMaintenanceActions } from './useMaintenanceActions'
import SettingsPage from './SettingsPage.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'
import BooleanSettingRow from './BooleanSettingRow.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const { runtime, setSetting, cancel, isDevOrPrerelease } = ctx
const { songFingerprintListLength, clearTracksFingerprintLibrary } = useFingerprintLibrary(runtime)
const { clearLibraryDirtyData, clearAnalysisRuntime } = useMaintenanceActions(runtime)

const openCloudSyncSettings = () => {
  cancel()
  window.dispatchEvent(new CustomEvent('openDialogFromChild', { detail: 'cloudSync.settings' }))
}

const clearCloudFingerprints = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }

  const config = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  const userKey = config?.userKey || ''
  if (!userKey) {
    openCloudSyncSettings()
    await confirm({
      title: t('cloudSync.settings'),
      content: [t('cloudSync.needUserKeyBeforeDanger')],
      confirmShow: false
    })
    return
  }

  const danger = await dangerConfirmWithInput({
    title: t('cloudSync.reset.title'),
    description: t('cloudSync.reset.description'),
    confirmKeyword: 'DELETE',
    placeholder: 'DELETE'
  })
  if (danger === 'cancel') return

  try {
    const response = await window.electron.ipcRenderer.invoke('cloudSync/resetUserData', {
      notes: 'reset from client'
    })
    if (response?.success) {
      await confirm({
        title: t('common.success'),
        content: [t('cloudSync.reset.success')],
        confirmShow: false
      })
    } else {
      const messageKey = response?.message || 'common.error'
      await confirm({ title: t('common.error'), content: [t(messageKey)], confirmShow: false })
    }
  } catch {
    await confirm({
      title: t('common.error'),
      content: [t('cloudSync.errors.cannotConnect')],
      confirmShow: false
    })
  }
}
</script>

<template>
  <SettingsPage page="advanced">
    <SettingsGroup title-key="settings.groups.privacyDiagnostics">
      <BooleanSettingRow
        id="enableErrorReport"
        control-id="setting-checkbox-enableErrorReport"
        stacked
      >
        <singleCheckbox
          id="setting-checkbox-enableErrorReport"
          v-model="runtime.setting.enableErrorReport"
          @change="setSetting('enableErrorReport')"
        />
        <template #details>
          <div class="settings-hint">{{ t('errorReport.hint') }}</div>
        </template>
      </BooleanSettingRow>
    </SettingsGroup>

    <SettingsGroup title-key="settings.groups.dangerZone" class="settings-group--danger">
      <SettingRow id="clearFingerprintLibrary" danger>
        <div class="settings-hint settings-hint--first">
          {{ t('fingerprints.currentCount', { count: songFingerprintListLength }) }}
        </div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button settings-inline-button--danger"
            @click="clearTracksFingerprintLibrary()"
          >
            {{ t('fingerprints.clearShort') }}
          </button>
        </div>
      </SettingRow>

      <SettingRow id="clearCloudData" danger>
        <div class="settings-hint settings-hint--first">{{ t('cloudSync.reset.description') }}</div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button settings-inline-button--danger"
            @click="clearCloudFingerprints()"
          >
            {{ t('cloudSync.reset.short') }}
          </button>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup
      v-if="isDevOrPrerelease"
      title-key="settings.groups.developerTools"
      class="settings-group--danger"
    >
      <SettingRow id="clearLibraryDirtyData" danger>
        <div class="settings-hint settings-hint--first">
          {{ t('settings.clearDirtyData.desc') }}
        </div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button settings-inline-button--danger"
            @click="clearLibraryDirtyData()"
          >
            {{ t('settings.clearDirtyData.button') }}
          </button>
        </div>
      </SettingRow>

      <SettingRow id="clearAnalysisRuntime" danger>
        <div class="settings-hint settings-hint--first">
          {{ t('settings.clearAnalysisRuntime.desc') }}
        </div>
        <div class="settings-button-row">
          <button
            type="button"
            class="settings-inline-button settings-inline-button--danger"
            @click="clearAnalysisRuntime()"
          >
            {{ t('settings.clearAnalysisRuntime.button') }}
          </button>
        </div>
      </SettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>
