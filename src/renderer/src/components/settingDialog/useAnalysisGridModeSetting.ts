import { computed } from 'vue'
import type { ISettingConfig } from 'src/types/globals'
import {
  isDynamicAnalysisGridAvailable,
  normalizeAnalysisGridMode,
  type AnalysisGridMode
} from '@shared/analysisGridMode'
import {
  ANALYSIS_GRID_MODE_HINT_KEYS,
  buildAnalysisGridModeOptions
} from '@renderer/utils/analysisGridModeUi'
import { t } from '@renderer/utils/translate'

type GridModeSettingRuntime = {
  setting: Pick<ISettingConfig, 'analysisGridMode'>
}

/** 设置弹窗里的网格模式控件状态；Dynamic 未就绪时只禁用选项并展示原因。 */
export const useAnalysisGridModeSetting = (runtime: GridModeSettingRuntime) => {
  const available = isDynamicAnalysisGridAvailable({ isDevelopment: import.meta.env.DEV })
  const model = computed<AnalysisGridMode>({
    get: () => normalizeAnalysisGridMode(runtime.setting.analysisGridMode),
    set: (value) => {
      runtime.setting.analysisGridMode = normalizeAnalysisGridMode(value)
    }
  })
  const options = computed(() => buildAnalysisGridModeOptions({ dynamicAvailable: available }))
  const hint = computed(() =>
    model.value === 'dynamic'
      ? t(ANALYSIS_GRID_MODE_HINT_KEYS.dynamicScope)
      : t(ANALYSIS_GRID_MODE_HINT_KEYS.settings)
  )
  return { available, model, options, hint }
}
