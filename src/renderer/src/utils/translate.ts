import { i18n } from '@renderer/i18n'

// 核心库中文名 -> i18n key 的集中映射
const LIBRARY_NAME_TO_I18N_KEY: Record<string, string> = {
  FilterLibrary: 'library.filter',
  CuratedLibrary: 'library.curated',
  SetLibrary: 'library.setLibrary',
  RecordingLibrary: 'library.recordingLibrary',
  MixtapeLibrary: 'library.mixtapeLibrary',
  RecycleBin: 'recycleBin.recycleBin'
}
type RuntimeI18nGlobal = {
  locale: string | { value: string }
  t: (key: string, values?: Record<string, unknown>) => string
}

// 仅用于将核心库名转为展示文本（遵循正常 i18n）
export function toLibraryDisplayName(libraryName: string): string {
  const key = LIBRARY_NAME_TO_I18N_KEY[libraryName]
  return key ? t(key) : libraryName
}

// 兼容旧调用：导出同名 t()，内部使用 vue-i18n
export function t(text: string, index?: number): string
export function t(text: string, values?: Record<string, unknown>): string
export function t(text: string, valuesOrIndex?: number | Record<string, unknown>): string {
  try {
    // 若传入的不是命名空间 key（不包含'.'），直接返回原文，避免触发缺失 key 警告
    const looksLikeKey = (val: string) => val.includes('.')
    if (!looksLikeKey(text)) return text

    // 访问 locale 以建立对语言的响应式依赖，切换语言时触发重渲染
    const i18nGlobal = i18n.global as unknown as RuntimeI18nGlobal
    const localeRef = i18nGlobal.locale

    typeof localeRef === 'object' ? localeRef.value : localeRef

    const i18nT = i18nGlobal.t
    const translated =
      valuesOrIndex && typeof valuesOrIndex === 'object' ? i18nT(text, valuesOrIndex) : i18nT(text)

    // 若未命中 key（vue-i18n 会回传 key 本身），保持原文
    if (translated === text) return text
    return translated
  } catch (_) {
    return text
  }
}

// 表单标签加冒号：中文用全角“：”，英文用半角“:”
export function tLabel(key: string): string {
  return t('common.labelColon', { label: t(key) })
}

export const translate = { t }
export default translate
