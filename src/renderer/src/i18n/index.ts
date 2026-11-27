import { createI18n } from 'vue-i18n'
import { withFileManagerLabels } from '@shared/fileManagerLabels'
import zhCN from './locales/zh-CN/index'
import enUS from './locales/en-US/index'

// 支持的语言列表
const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
// The existing preload exposes the actual OS before any renderer entry starts.
const platform = typeof window === 'undefined' ? '' : window.electron?.process?.platform || ''
const messages = {
  'zh-CN': withFileManagerLabels(zhCN, 'zh-CN', platform),
  'en-US': withFileManagerLabels(enUS, 'en-US', platform)
}

// 创建i18n实例
export const i18n = createI18n({
  legacy: false, // 使用Composition API模式
  globalInjection: true,
  locale: 'zh-CN', // 默认语言
  fallbackLocale: 'zh-CN', // 回退语言
  messages: messages as never,
  // 开发环境下显示警告
  missingWarn: process.env.NODE_ENV === 'development',
  fallbackWarn: process.env.NODE_ENV === 'development'
})

// 切换语言
export function setLocale(locale: SupportedLocale) {
  i18n.global.locale.value = locale
}
