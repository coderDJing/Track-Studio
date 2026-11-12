import { t } from '@renderer/utils/translate'
import {
  ANALYSIS_GRID_MODE_LABEL_KEYS,
  ANALYSIS_GRID_MODES,
  type AnalysisGridMode
} from '@shared/analysisGridMode'

/**
 * Normal / Dynamic 选项。Dynamic 在共享发布启用开关打开时可选；
 * 开关关闭时保留列表项并展示原因，不能静默改写成 normal 后假装请求成功。
 */
export const buildAnalysisGridModeOptions = (options: { dynamicAvailable: boolean }) =>
  ANALYSIS_GRID_MODES.map((mode: AnalysisGridMode) => ({
    label: t(ANALYSIS_GRID_MODE_LABEL_KEYS[mode]),
    value: mode,
    disabled: mode === 'dynamic' && !options.dynamicAvailable
  }))

export const ANALYSIS_GRID_MODE_HINT_KEYS = {
  settings: 'settings.analysisGridMode.settingsHint',
  dynamicScope: 'settings.analysisGridMode.dynamicScopeHint',
  productionDisabled: 'settings.analysisGridMode.productionDisabled'
} as const

/** 发布启用开关关闭时，选中 Dynamic 的网格任务必须真正无法提交。 */
export const isAnalysisGridSubmitBlocked = (params: {
  beatGridSelected: boolean
  mode: AnalysisGridMode
  dynamicAvailable: boolean
}): boolean => params.beatGridSelected && params.mode === 'dynamic' && !params.dynamicAvailable
