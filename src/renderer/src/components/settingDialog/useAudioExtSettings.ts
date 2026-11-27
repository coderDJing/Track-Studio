import { nextTick, ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { SUPPORTED_AUDIO_FORMATS } from '@shared/audioFormats'
import type { SettingDialogRuntimeStore, SettingPersist } from './context'

type AudioFormatKey = (typeof SUPPORTED_AUDIO_FORMATS)[number]
type AudioExt = Record<AudioFormatKey, boolean>

export const useAudioExtSettings = (
  runtime: SettingDialogRuntimeStore,
  persist: SettingPersist
) => {
  const allFormats = SUPPORTED_AUDIO_FORMATS
  const configuredExtensions = Array.isArray(runtime.setting.audioExt)
    ? runtime.setting.audioExt
    : []
  const audioExt = ref<AudioExt>(
    Object.fromEntries(
      allFormats.map((format) => [format, configuredExtensions.includes(`.${format}`)])
    ) as AudioExt
  )

  let previousAudioExt = JSON.parse(JSON.stringify(audioExt.value)) as AudioExt

  const extChange = async () => {
    await nextTick()
    if (runtime.isProgressing) {
      audioExt.value = { ...previousAudioExt }
      await confirm({
        title: t('common.setting'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
      return
    }

    previousAudioExt = JSON.parse(JSON.stringify(audioExt.value)) as AudioExt
    const selectedExt = Object.entries(audioExt.value)
      .filter(([, checked]) => checked)
      .map(([format]) => `.${format}`)
    runtime.setting.audioExt = selectedExt
    await persist('scanFormats')
  }

  return {
    allFormats,
    audioExt,
    extChange
  }
}
