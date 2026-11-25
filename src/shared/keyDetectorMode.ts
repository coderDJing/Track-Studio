/**
 * 调性检测算法档位（模板匹配 / 神经网络）。
 *
 * - Template：模板匹配，低+中频整曲 chroma 平均 + 单次 Pearson，默认值。
 * - Neural：神经网络（卷积网络评分），较慢，对电子舞曲通常更准。
 *
 * 该模块只放纯函数与常量，主进程、renderer 与测试共用。
 */

export type KeyDetectorMode = 'template' | 'neural'

export const DEFAULT_KEY_DETECTOR_MODE: KeyDetectorMode = 'template'

export const KEY_DETECTOR_MODES: readonly KeyDetectorMode[] = ['template', 'neural']

/** 旧版本持久化过的取值，读取时自动迁移到新命名。 */
const LEGACY_KEY_DETECTOR_MODES: Record<string, KeyDetectorMode> = {
  standard: 'template'
}

export const isKeyDetectorMode = (value: unknown): value is KeyDetectorMode =>
  value === 'template' || value === 'neural'

/** 缺失/非法值回退到调用方给出的默认值；旧值 standard 迁移为 template。 */
export const normalizeKeyDetectorMode = (
  value: unknown,
  defaultMode: KeyDetectorMode = DEFAULT_KEY_DETECTOR_MODE
): KeyDetectorMode => {
  if (isKeyDetectorMode(value)) return value
  if (typeof value === 'string') {
    const migrated = LEGACY_KEY_DETECTOR_MODES[value]
    if (migrated) return migrated
  }
  return defaultMode
}

export const KEY_DETECTOR_MODE_LABEL_KEYS: Record<KeyDetectorMode, string> = {
  template: 'settings.keyDetectorMode.template',
  neural: 'settings.keyDetectorMode.neural'
}
