<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import { CONTACT_EMAIL } from '../constants/app'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import confirm from '@renderer/components/confirmDialog'
import dangerConfirmWithInput from '@renderer/components/dangerConfirmWithInputDialog'
import CuratedLibrarySyncSettings from '@renderer/components/settingDialog/CuratedLibrarySyncSettings.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  CLOUD_SYNC_AUTO_INTERVAL_MS,
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '@shared/cloudSyncAuto'

const hintIcon = hintIconAsset
const emits = defineEmits(['cancel'])
const uuid = uuidV4()
const runtime = useRuntimeStore()
const curatedSettingsRef = useTemplateRef<{ refreshOverview: () => Promise<void> }>(
  'curatedSettingsRef'
)

const userKey = ref('')
const testing = ref(false)
const saving = ref(false)
const resettingCloudLibrary = ref(false)
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const cancel = () => {
  closeWithAnimation(() => emits('cancel'))
}

const dialogScrollOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  },
  overflow: {
    x: 'hidden' as const,
    y: 'scroll' as const
  }
}

const persistSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const cloudSyncAutoEnabledModel = computed<boolean>({
  get: () => normalizeCloudSyncAutoEnabled(runtime.setting.cloudSyncAutoEnabled),
  set: (value) => {
    runtime.setting.cloudSyncAutoEnabled = value
    if (value) {
      runtime.setting.cloudSyncAutoIntervalMs = normalizeCloudSyncAutoIntervalMs(
        runtime.setting.cloudSyncAutoIntervalMs
      )
    }
  }
})

const cloudSyncAutoIntervalModel = computed<number>({
  get: () => normalizeCloudSyncAutoIntervalMs(runtime.setting.cloudSyncAutoIntervalMs),
  set: (value) => {
    runtime.setting.cloudSyncAutoIntervalMs = normalizeCloudSyncAutoIntervalMs(value)
  }
})

const cloudSyncAutoIntervalOptions = computed(() => [
  { label: t('cloudSync.autoInterval15m'), value: CLOUD_SYNC_AUTO_INTERVAL_MS.minutes15 },
  { label: t('cloudSync.autoInterval30m'), value: CLOUD_SYNC_AUTO_INTERVAL_MS.minutes30 },
  { label: t('cloudSync.autoInterval1h'), value: CLOUD_SYNC_AUTO_INTERVAL_MS.hours1 },
  { label: t('cloudSync.autoInterval6h'), value: CLOUD_SYNC_AUTO_INTERVAL_MS.hours6 },
  { label: t('cloudSync.autoInterval12h'), value: CLOUD_SYNC_AUTO_INTERVAL_MS.hours12 },
  { label: t('cloudSync.autoInterval24h'), value: CLOUD_SYNC_AUTO_INTERVAL_MS.hours24 }
])

const notifyConnectivity = async (res: {
  success?: boolean
  message?: string
  limit?: unknown
}) => {
  const success = res?.success === true
  const content = [
    t(
      String(
        res?.message || (success ? 'cloudSync.connectivityOk' : 'cloudSync.connectivityFailed')
      )
    )
  ]
  const limitNum = Number(res?.limit)
  if (success && Number.isFinite(limitNum)) {
    content.push(`${t('cloudSync.limit')}: ${limitNum}`)
  }
  await confirm({
    title: success ? t('common.success') : t('common.error'),
    content,
    confirmShow: false,
    innerHeight: 0,
    innerWidth: 360
  })
}

const clickTest = async () => {
  if (testing.value) return
  testing.value = true
  try {
    const res = await window.electron.ipcRenderer.invoke('cloudSync/testConnectivity', {
      userKey: userKey.value
    })
    await notifyConnectivity(res)
  } catch {
    await notifyConnectivity({ success: false, message: 'cloudSync.errors.cannotConnect' })
  } finally {
    testing.value = false
  }
}

const clickSave = async () => {
  if (saving.value) return
  saving.value = true
  try {
    const res = await window.electron.ipcRenderer.invoke('cloudSync/config/save', {
      userKey: userKey.value
    })
    if (res?.success) {
      cancel()
      return
    }
    await notifyConnectivity({
      success: false,
      message: res?.message || 'cloudSync.connectivityFailed'
    })
  } finally {
    saving.value = false
  }
}

const clickCopyEmail = async () => {
  await navigator.clipboard.writeText(CONTACT_EMAIL)
}

const resetCloudCuratedLibrary = async () => {
  if (resettingCloudLibrary.value) return
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  const cfg = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  const savedUserKey = String(cfg?.userKey || '').trim()
  if (!savedUserKey) {
    await confirm({
      title: t('cloudSync.settings'),
      content: [t('cloudSync.curatedLibrary.reset.needUserKey')],
      confirmShow: false
    })
    return
  }
  const danger = await dangerConfirmWithInput({
    title: t('cloudSync.curatedLibrary.reset.title'),
    description: t('cloudSync.curatedLibrary.reset.description'),
    confirmKeyword: 'DELETE',
    placeholder: 'DELETE',
    innerHeight: 340,
    innerWidth: 480
  })
  if (danger === 'cancel') return
  resettingCloudLibrary.value = true
  try {
    const res = await window.electron.ipcRenderer.invoke('curatedLibrarySync/resetCloud')
    if (res?.success) {
      await curatedSettingsRef.value?.refreshOverview()
      await confirm({
        title: t('common.success'),
        content: [t('cloudSync.curatedLibrary.reset.success')],
        confirmShow: false
      })
      return
    }
    await confirm({
      title: t('common.error'),
      content: [t(res?.message || 'common.error')],
      confirmShow: false
    })
  } catch {
    await confirm({
      title: t('common.error'),
      content: [t('cloudSync.errors.cannotConnect')],
      confirmShow: false
    })
  } finally {
    resettingCloudLibrary.value = false
  }
}

const emailHintIconRef = useTemplateRef<HTMLImageElement>('emailHintIconRef')

onMounted(async () => {
  const cfg = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  userKey.value = cfg?.userKey || ''
  hotkeys('E,Enter', uuid, () => {
    void clickSave()
  })
  hotkeys('T', uuid, () => {
    void clickTest()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => utils.delHotkeysScope(uuid))
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="title dialog-title dialog-header">{{ t('cloudSync.settings') }}</div>
      <OverlayScrollbarsComponent
        :options="dialogScrollOptions"
        element="div"
        class="dialog-scroll"
        defer
      >
        <div class="dialog-content">
          <section class="settings-section">
            <div class="section-title">{{ t('cloudSync.sectionAccount') }}</div>
            <div class="setting-block">{{ t('cloudSync.userKey') }}</div>
            <div class="setting-control">
              <input v-model="userKey" class="input" placeholder="uuid-v4" />
            </div>

            <div class="setting-block email-row">{{ t('cloudSync.applyEmailHint') }}</div>
            <div class="setting-control email-value">
              <span>{{ CONTACT_EMAIL }}</span>
              <span class="link" @click="clickCopyEmail">{{ t('cloudSync.copyEmail') }}</span>
              <img
                ref="emailHintIconRef"
                :src="hintIcon"
                class="hint-icon theme-icon"
                :draggable="false"
              />
              <bubbleBox
                :dom="emailHintIconRef || undefined"
                :title="t('cloudSync.applyEmailInstruction')"
                :max-width="320"
              />
            </div>
          </section>

          <section class="settings-section">
            <div class="section-title">{{ t('cloudSync.sectionSchedule') }}</div>
            <label class="setting-block" for="cloud-sync-auto-enabled">
              {{ t('cloudSync.autoEnabled') }}
            </label>
            <div class="setting-control">
              <singleCheckbox
                id="cloud-sync-auto-enabled"
                v-model="cloudSyncAutoEnabledModel"
                @change="persistSetting()"
              />
              <div class="hint">{{ t('cloudSync.autoEnabledHint') }}</div>
              <div class="hint">{{ t('cloudSync.autoNeedUserKeyHint') }}</div>
            </div>

            <div class="setting-block">{{ t('cloudSync.autoInterval') }}</div>
            <div class="setting-control">
              <BaseSelect
                v-model="cloudSyncAutoIntervalModel"
                :options="cloudSyncAutoIntervalOptions"
                :width="220"
                :disabled="!cloudSyncAutoEnabledModel"
                @change="persistSetting"
              />
            </div>
          </section>

          <section class="settings-section">
            <div class="section-title">{{ t('cloudSync.sectionLibrary') }}</div>
            <CuratedLibrarySyncSettings ref="curatedSettingsRef" />
          </section>

          <section class="settings-section settings-section--danger">
            <div class="section-title">{{ t('cloudSync.sectionDanger') }}</div>
            <div class="setting-block">{{ t('cloudSync.curatedLibrary.reset.sectionTitle') }}</div>
            <div class="setting-control">
              <div class="hint">{{ t('cloudSync.curatedLibrary.reset.hint') }}</div>
              <div class="action-row">
                <div
                  class="danger-button"
                  :class="{ disabled: resettingCloudLibrary }"
                  @click="resettingCloudLibrary ? undefined : void resetCloudCuratedLibrary()"
                >
                  {{ t('cloudSync.curatedLibrary.reset.short') }}
                </div>
              </div>
            </div>
          </section>
        </div>
      </OverlayScrollbarsComponent>
      <div class="dialog-footer">
        <div
          class="button footer-button"
          :class="{ disabled: testing }"
          @click="testing ? undefined : void clickTest()"
        >
          {{ t('cloudSync.testConnectivity') }} (T)
        </div>
        <div class="button footer-button" @click="clickSave">{{ t('common.save') }} (E)</div>
        <div class="button footer-button" @click="cancel">{{ t('common.cancel') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 560px;
  max-width: calc(100vw - 24px);
  height: min(80vh, 720px);
  max-height: 80vh;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.title {
  color: var(--text);
  flex-shrink: 0;
}

.dialog-scroll {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  width: 100%;
}

.dialog-content {
  padding: 16px 24px 20px 20px;
}

.dialog-footer {
  flex-shrink: 0;
}

.settings-section {
  padding-top: 2px;
  margin-top: 28px;
}

.settings-section:first-child {
  margin-top: 0;
}

.settings-section--danger {
  margin-top: 32px;
}

.section-title {
  position: relative;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  padding-left: 12px;
  margin-bottom: 4px;
  text-align: left;
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

.settings-section--danger .section-title::before {
  background: rgba(232, 17, 35, 0.5);
}

.setting-block {
  margin-top: 18px;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  line-height: 1.4;
}

label.setting-block {
  display: block;
  user-select: none;
}

.setting-control {
  margin-top: 10px;
  max-width: 100%;
}

.hint {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  text-align: left;
  margin-top: 8px;
}

.input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 8px;
  border-radius: 4px;
}

.input::placeholder {
  color: var(--text-weak);
}

.input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.email-row {
  position: relative;
}

.email-value {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--text);
}

.hint-icon {
  width: 14px;
  height: 14px;
}

.link {
  color: var(--accent);
  cursor: pointer;
}

.action-row {
  margin-top: 10px;
}

.danger-button {
  width: fit-content;
  min-width: 110px;
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  text-align: center;
  background-color: var(--hover);
  border: 1px solid var(--border);
  font-size: 14px;
  color: var(--text);
  cursor: pointer;

  &:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}

.danger-button.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.footer-button {
  width: 120px;
  text-align: center;
  height: 25px;
  line-height: 25px;
}

.footer-button.disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
