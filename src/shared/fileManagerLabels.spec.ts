import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_MANAGER_LABEL_ALIASES,
  getFileManagerCopy,
  getFileManagerLabel,
  withFileManagerLabels
} from './fileManagerLabels'
import { buildLibraryContextMenuArr } from '../renderer/src/components/libraryItem/libraryContextMenuHelpers'

const cases = [
  {
    platform: 'darwin',
    locale: 'zh-CN',
    show: '在 Finder 中显示',
    open: '在 Finder 中打开',
    name: 'Finder'
  },
  {
    platform: 'win32',
    locale: 'zh-CN',
    show: '在文件资源管理器中显示',
    open: '在文件资源管理器中打开',
    name: '文件资源管理器'
  },
  {
    platform: 'darwin',
    locale: 'en-US',
    show: 'Show in Finder',
    open: 'Open in Finder',
    name: 'Finder'
  },
  {
    platform: 'win32',
    locale: 'en-US',
    show: 'Show in File Explorer',
    open: 'Open in File Explorer',
    name: 'File Explorer'
  }
] as const
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('platform file-manager copy', () => {
  it.each(cases)(
    '$platform / $locale keeps reveal, open and log semantics',
    ({ platform, locale, show, open, name }) => {
      const copy = getFileManagerCopy(locale, platform)
      expect(copy.show).toBe(show)
      expect(copy.open).toBe(open)
      expect(copy.name).toBe(name)
      for (const key of Object.keys(FILE_MANAGER_LABEL_ALIASES)) {
        const label = getFileManagerLabel(key, locale, platform)!
        expect(label).toContain(name)
        if (platform === 'darwin') expect(label).not.toMatch(/Explorer|资源管理器|访达/)
        else expect(label).not.toContain('Finder')
      }
      expect(copy.screenshotSaved).toContain(name)
      expect(getFileManagerLabel('menu.openLog', locale, platform)).toBeUndefined()
      const original = {
        settings: { unrelated: 'unchanged' },
        errors: { open: 'permission denied' }
      }
      const before = JSON.stringify(original)
      const merged = withFileManagerLabels(original, locale, platform)
      expect(merged.errors).toEqual(original.errors)
      expect(merged.settings).toMatchObject({
        unrelated: 'unchanged',
        openCurrentLibraryInExplorer: open
      })
      expect(JSON.stringify(original)).toBe(before)
    }
  )
  it.each(cases)(
    '$platform / $locale reaches real renderer i18n and existing library menu IDs',
    async ({ platform, locale, show, open }) => {
      vi.stubGlobal('window', { electron: { process: { platform } } })
      const { i18n, setLocale } = await import('../renderer/src/i18n')
      const { t } = await import('../renderer/src/utils/translate')
      setLocale(locale)
      const menu = buildLibraryContextMenuArr({
        dirData: { uuid: 'fixture', type: 'dir', dirName: 'Music' },
        libraryAreaSelected: 'CuratedLibrary',
        libraryName: 'CuratedLibrary',
        creatingSongListUUID: ''
      })
      const reveal = menu.flat().find((item) => item.menuName === 'tracks.showInFileExplorer')!
      expect(reveal).toBeDefined()
      expect(t(reveal.menuName)).toBe(show)
      const globalI18n = i18n.global as unknown as { t: (key: string) => string }
      expect(globalI18n.t(reveal.menuName)).toBe(show)
      expect(t('icloud.reveal')).toBe(show)
      expect(t('settings.openCurrentLibraryInExplorer')).toBe(open)
      for (const key of Object.keys(FILE_MANAGER_LABEL_ALIASES)) {
        expect(t(key)).toBe(getFileManagerLabel(key, locale, platform))
      }
      // Locale changes still work without changing or reconstructing any consumer.
      const other = locale === 'zh-CN' ? 'en-US' : 'zh-CN'
      setLocale(other)
      expect(t(reveal.menuName)).toBe(getFileManagerCopy(other, platform).show)
    }
  )
  it('keeps native menu and screenshot consumers on the same centralized labels without changing actions', () => {
    const native = read('main/menu/macMenu.ts')
    const notification = read('main/window/mainWindow/index.ts')
    expect(native).toContain('getFileManagerLabel(key, localeId, process.platform)')
    expect(native).toContain("tMenu('menu.showLogInFinder')")
    expect(notification).toContain("getFileManagerCopy('en-US', process.platform)")
    expect(notification).toContain("getFileManagerCopy('zh-CN', process.platform)")
    expect(notification).toContain('shell.showItemInFolder(outputPath)')
    expect(notification).not.toContain('Click to reveal in Explorer.')
  })
  it('guards actual renderer reveal consumers against platform-specific hardcoded action text', () => {
    const consumers = {
      'components/playerControls.vue': 'tracks.showInFileExplorer',
      'composables/miniPlayer/MiniPlayerMoreMenu.vue': 'tracks.showInFileExplorer',
      'components/libraryItem/libraryContextMenuHelpers.ts': 'tracks.showInFileExplorer',
      'pages/modules/libraryArea.vue': 'tracks.showInFileExplorer',
      'pages/modules/pioneerSongsArea/usePioneerSongContextMenu.ts': 'tracks.showInFileExplorer',
      'pages/modules/songsArea/composables/songItemContextMenuMenus.ts':
        'tracks.showInFileExplorer',
      'components/settingDialog/SettingDialogBody.vue': 'settings.openCurrentLibraryInExplorer',
      'components/titleComponent.vue': 'menu.showLogInFolder',
      'pages/modules/IcloudLibraryPanel.vue': 'icloud.reveal'
    }
    for (const [path, key] of Object.entries(consumers)) {
      expect(read('renderer/src/' + path), path).toContain(key)
      expect(Object.keys(FILE_MANAGER_LABEL_ALIASES)).toContain(key)
    }
    const root = fileURLToPath(new URL('../renderer/src/', import.meta.url))
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory() && entry.name !== 'i18n') scan(path)
        else if (
          entry.isFile() &&
          /\.(?:ts|vue)$/.test(entry.name) &&
          !entry.name.endsWith('.spec.ts')
        ) {
          expect(readFileSync(path, 'utf8'), path).not.toMatch(
            /["'`]Show in (?:Finder|File Explorer)["'`]|["'`]在(?: Finder |文件资源(?:管理|浏览)器)中显示["'`]/
          )
        }
      }
    }
    scan(root)
  })
})
