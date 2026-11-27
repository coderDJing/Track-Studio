import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import zh from './locales/zh-CN/icloud.json'
import en from './locales/en-US/icloud.json'

const flatten = (value: unknown, prefix = ''): Record<string, string> => {
  if (typeof value === 'string') return { [prefix]: value }
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key))
    )
  )
}

describe('concise iCloud copy in both languages', () => {
  it('keeps translation keys and interpolation parameters compatible', () => {
    const chinese = flatten(zh),
      english = flatten(en)
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
    for (const key of Object.keys(chinese)) {
      expect(english[key].match(/\{[^}]+\}/g) || []).toEqual(chinese[key].match(/\{[^}]+\}/g) || [])
    }
  })
  it.each([zh, en])('keeps actionable states short and never calls copying uploading', (locale) => {
    const copy = locale.icloud
    expect(copy.title).toBe('iCloud')
    for (const text of [
      copy.unavailable,
      copy.folderNotLocal,
      copy.cancelHint,
      ...Object.values(copy.errors)
    ]) {
      expect(text.length).toBeLessThanOrEqual(80)
    }
    for (const text of Object.values(copy.residency)) expect(text.length).toBeLessThan(20)
    expect(copy.copiedCount).not.toMatch(/上传|uploaded/i)
    expect(JSON.stringify(locale)).not.toMatch(/CloudDocs|rootToken|令牌|com~apple/)
  })
  it('does not render constant technical explanations or drag tutorials in iCloud views', async () => {
    for (const file of [
      'modules/IcloudLibraryPanel.vue',
      'modules/IcloudFolderTree.vue',
      'homePage.vue'
    ]) {
      const source = await fs.readFile(
        path.join(process.cwd(), 'src/renderer/src/pages', file),
        'utf8'
      )
      expect(source).not.toMatch(
        /t\('icloud\.(musicHint|copyNotice|manualDownload|driveProjectionHint|localDropTargets)'/
      )
    }
  })
})
