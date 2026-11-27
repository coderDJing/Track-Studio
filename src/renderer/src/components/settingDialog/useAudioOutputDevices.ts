import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { AUDIO_OUTPUT_FOLLOW_SYSTEM_ID } from '@renderer/components/settingDialogRuntimeDefaults'
import type {
  AudioOutputOption,
  SettingDialogOption,
  SettingDialogRuntimeStore,
  SettingPersist
} from './context'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '')

export const useAudioOutputDevices = (
  runtime: SettingDialogRuntimeStore,
  persist: SettingPersist
) => {
  const devices = ref<AudioOutputOption[]>([])
  const isEnumerating = ref(false)
  const error = ref<string | null>(null)
  const supported = computed(
    () =>
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.enumerateDevices === 'function'
  )

  let cleanupDeviceListener: (() => void) | null = null

  const options = computed<SettingDialogOption[]>(() => {
    const unknownText = t('player.audioOutputDeviceUnknown')
    return [
      { label: t('player.audioOutputFollowSystem'), value: AUDIO_OUTPUT_FOLLOW_SYSTEM_ID },
      ...devices.value.map((device, index) => ({
        label: device.label || `${unknownText} ${index + 1}`,
        value: device.deviceId
      }))
    ]
  })

  const refresh = async () => {
    error.value = null
    if (!supported.value || !navigator.mediaDevices) {
      devices.value = []
      error.value = t('player.audioOutputNotSupported')
      if (runtime.setting.audioOutputDeviceId) {
        runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
        await persist('audioOutputDeviceId')
      }
      return
    }

    isEnumerating.value = true
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices()
      const outputs = allDevices.filter(
        (device) =>
          device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default'
      )
      devices.value = outputs.map((device) => ({
        deviceId: device.deviceId,
        label: device.label
      }))

      const current = runtime.setting.audioOutputDeviceId || AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
      if (current && !devices.value.some((device) => device.deviceId === current)) {
        error.value = t('player.audioOutputDeviceUnavailable')
        runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
        await persist('audioOutputDeviceId')
      }
    } catch (refreshError) {
      error.value = t('player.audioOutputRefreshFailed', {
        reason: getErrorMessage(refreshError)
      })
    } finally {
      isEnumerating.value = false
    }
  }

  const handleChange = async () => {
    error.value = null
    runtime.setting.audioOutputDeviceId =
      runtime.setting.audioOutputDeviceId || AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
    await persist('audioOutputDeviceId')
  }

  onMounted(() => {
    if (!supported.value || !navigator.mediaDevices) {
      devices.value = []
      error.value = t('player.audioOutputNotSupported')
      if (runtime.setting.audioOutputDeviceId) {
        runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
        void persist('audioOutputDeviceId')
      }
      return
    }

    const handleDeviceChange = () => {
      void refresh()
    }

    if (typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
      cleanupDeviceListener = () => {
        navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
      }
    } else {
      const previousHandler = navigator.mediaDevices.ondevicechange
      navigator.mediaDevices.ondevicechange = handleDeviceChange
      cleanupDeviceListener = () => {
        if (navigator.mediaDevices.ondevicechange === handleDeviceChange) {
          navigator.mediaDevices.ondevicechange = previousHandler || null
        } else if (!navigator.mediaDevices.ondevicechange && previousHandler) {
          navigator.mediaDevices.ondevicechange = previousHandler
        }
      }
    }

    void refresh()
  })

  onUnmounted(() => {
    if (cleanupDeviceListener) {
      cleanupDeviceListener()
      cleanupDeviceListener = null
    }
  })

  watch(
    () => runtime.setting.language,
    () => {
      if (supported.value) {
        void refresh()
      }
    }
  )

  return {
    audioOutputDevices: devices,
    isEnumeratingAudioOutputs: isEnumerating,
    audioOutputError: error,
    audioOutputSupported: supported,
    audioOutputSelectOptions: options,
    refreshAudioOutputDevices: refresh,
    handleAudioOutputChange: handleChange
  }
}
