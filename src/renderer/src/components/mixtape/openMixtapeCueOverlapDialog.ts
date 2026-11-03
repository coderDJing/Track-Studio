import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import MixtapeCueOverlapDialog from './MixtapeCueOverlapDialog.vue'
import type {
  MixtapeCueOverlapSettings,
  MixtapeCueOverlapPlan
} from '@renderer/composables/mixtape/mixtapeCueOverlap'

export const openMixtapeCueOverlapDialog = (options: {
  initialBpm: number
  buildPlan: (settings: MixtapeCueOverlapSettings) => MixtapeCueOverlapPlan
  confirm: (settings: MixtapeCueOverlapSettings) => Promise<void>
}) =>
  new Promise<void>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const close = () => {
      render(null, container)
      container.remove()
      resolve()
    }
    const vnode = createVNode(MixtapeCueOverlapDialog, { ...options, onClose: close })
    attachAppContext(vnode)
    render(vnode, container)
  })
