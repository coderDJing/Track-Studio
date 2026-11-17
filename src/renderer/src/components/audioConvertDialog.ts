import { createVNode, render } from 'vue'
import AudioConvertDialogVue from './audioConvertDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type {
  AudioConvertDialogResult,
  OpenAudioConvertDialogArgs
} from './audioConvertDialog.types'

export default (args: OpenAudioConvertDialogArgs = {}) => {
  return new Promise<AudioConvertDialogResult>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const confirmCallback = (payload: AudioConvertDialogResult) => {
      render(null, div)
      div.remove()
      resolve(payload)
    }
    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(AudioConvertDialogVue, {
      confirmCallback,
      cancelCallback,
      sourceExts: args?.sourceExts || [],
      standaloneMode: Boolean(args?.standaloneMode),
      presetTargetFormat: args?.presetTargetFormat,
      lockTargetFormat: Boolean(args?.lockTargetFormat),
      lockNewFile: Boolean(args?.lockNewFile),
      requireOutputDir: Boolean(args?.requireOutputDir)
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
