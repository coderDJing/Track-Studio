import { t } from '@renderer/utils/translate'
import {
  KEY_DETECTOR_MODE_LABEL_KEYS,
  KEY_DETECTOR_MODES,
  type KeyDetectorMode
} from '@shared/keyDetectorMode'

/** 模板匹配 / 神经网络选项；两种算法都已随原生模块打包，始终可选。 */
export const buildKeyDetectorModeOptions = () =>
  KEY_DETECTOR_MODES.map((mode: KeyDetectorMode) => ({
    label: t(KEY_DETECTOR_MODE_LABEL_KEYS[mode]),
    value: mode
  }))

export const KEY_DETECTOR_MODE_HINT_KEYS = {
  settings: 'settings.keyDetectorMode.settingsHint',
  neuralScope: 'settings.keyDetectorMode.neuralScopeHint'
} as const
