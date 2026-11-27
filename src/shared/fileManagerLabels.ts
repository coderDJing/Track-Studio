import zhCN from '../renderer/src/i18n/locales/zh-CN/fileManager.json'
import enUS from '../renderer/src/i18n/locales/en-US/fileManager.json'

export type FileManagerLocale = 'zh-CN' | 'en-US'
const copies = { 'zh-CN': zhCN.fileManager, 'en-US': enUS.fileManager }

// Keep menu action IDs and existing translation keys stable; only their display copy varies.
export const FILE_MANAGER_LABEL_ALIASES = {
  'tracks.showInFileExplorer': 'show',
  'settings.openCurrentLibraryInExplorer': 'open',
  'menu.showLogInFolder': 'showLog',
  'menu.showLogInFinder': 'showLog',
  'tracks.dragHintTargetExplorer': 'name',
  'tracks.dragHintTargetFinder': 'name',
  'icloud.reveal': 'show',
  'userGuide.browser.browserTreeMenu.rekordbox.line2': 'guideImport',
  'userGuide.browser.browserTreeMenu.general.line2': 'guideFolders'
} as const

export function getFileManagerCopy(locale: FileManagerLocale, platform: string) {
  // Preserve the existing Windows fallback; this does not add another supported OS.
  return copies[locale][platform === 'darwin' ? 'mac' : 'win']
}

export function getFileManagerLabel(key: string, locale: FileManagerLocale, platform: string) {
  const name = FILE_MANAGER_LABEL_ALIASES[key as keyof typeof FILE_MANAGER_LABEL_ALIASES]
  return name ? getFileManagerCopy(locale, platform)[name] : undefined
}

export function withFileManagerLabels(
  messages: Record<string, unknown>,
  locale: FileManagerLocale,
  platform: string
): Record<string, unknown> {
  const result = { ...messages }
  const copy = getFileManagerCopy(locale, platform)
  for (const [key, name] of Object.entries(FILE_MANAGER_LABEL_ALIASES)) {
    const parts = key.split('.')
    let target = result
    for (const part of parts.slice(0, -1)) {
      const existing = target[part]
      const child =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : {}
      target[part] = child
      target = child
    }
    target[parts[parts.length - 1]] = copy[name]
  }
  return result
}
