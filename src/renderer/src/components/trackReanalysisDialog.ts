import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import TrackReanalysisDialog from './trackReanalysisDialog.vue'
import type { AnalysisBpmRangePresetId } from '@shared/analysisBpmRange'
import type { AnalysisGridMode } from '@shared/analysisGridMode'
import type { TrackReanalysisUserSelection } from '@shared/trackReanalysisSelection'

export type TrackAnalysisDialogPurpose = 'reanalysis' | 'missing'

export type TrackAnalysisDialogResult = {
  selection: TrackReanalysisUserSelection
  analysisBpmRangeId?: AnalysisBpmRangePresetId
  analysisGridMode?: AnalysisGridMode
}

type TrackReanalysisDialogOptions = {
  count: number
  initialSelection: TrackReanalysisUserSelection
  canSelectStructureAlone: boolean
  purpose?: TrackAnalysisDialogPurpose
  initialBpmRangeId?: AnalysisBpmRangePresetId
  initialGridMode?: AnalysisGridMode
}

export default (options: TrackReanalysisDialogOptions) =>
  new Promise<TrackAnalysisDialogResult | null>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const close = (value: TrackAnalysisDialogResult | null) => {
      render(null, container)
      container.remove()
      resolve(value)
    }

    const vnode = createVNode(TrackReanalysisDialog, {
      ...options,
      confirmCallback: (value: TrackAnalysisDialogResult) => close(value),
      cancelCallback: () => close(null)
    })
    attachAppContext(vnode)
    render(vnode, container)
  })
