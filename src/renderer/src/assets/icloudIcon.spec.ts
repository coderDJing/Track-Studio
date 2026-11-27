import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { preprocessCSS, resolveConfig } from 'vite'
import { parse } from '@vue/compiler-sfc'

const svg = readFileSync(new URL('./icloud.svg', import.meta.url), 'utf8')
const source = readFileSync(new URL('./icloud.source.md', import.meta.url), 'utf8')
const entry = readFileSync(
  new URL('../pages/modules/IcloudLibraryEntry.vue', import.meta.url),
  'utf8'
)

describe('iCloud brand mask resource', () => {
  it('ships a local, single-path, filled silhouette with a normalized icon viewBox', () => {
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg.match(/<path\b/g)).toHaveLength(1)
    expect(svg).not.toMatch(/<(?:script|image|foreignObject)\b|(?:href|stroke)=/i)
    expect(svg).toContain('icloud.source.md')
  })
  it('retains the verifiable Apple raster source and avoids claiming an official or freely licensed SVG', () => {
    expect(source).toContain(
      'https://www.icloud.com/system/icloud.com/2642Build23/favicons/default-favicon-light-180x180.png'
    )
    expect(source).toContain('75587923b33c96fd83dce9970412d620d69efb46ff77460c64bcc8a07b0349a2')
    expect(source).toContain('NOT an Apple-supplied SVG')
    expect(source).toContain('Public availability is not a license grant')
  })
  it('uses the same mask sizing and theme tokens as the rekordbox rail icon, including active and hover states', () => {
    for (const declaration of [
      'width: 25px',
      'height: 25px',
      'background-color: currentColor',
      'color: var(--text)',
      'opacity: var(--sidebar-icon-opacity)',
      'mask-image: var(--icon-mask)',
      '-webkit-mask-image: var(--icon-mask)',
      'mask-position: center',
      'mask-size: contain',
      '.icloud-entry:hover .sidebar-icon',
      '.icloud-entry .sidebar-icon.is-active'
    ])
      expect(entry).toContain(declaration)
    expect(entry).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})

describe('iCloud rail interaction parity', () => {
  it('matches peer hover opacity without a hover/focus/selected backplate and retains keyboard outline', async () => {
    const peerUrl = new URL('../pages/modules/librarySelectArea.vue', import.meta.url)
    const peer = readFileSync(peerUrl, 'utf8')
    const style = parse(peer).descriptor.styles[0]
    const peerStyle = style.src ? readFileSync(new URL(style.src, peerUrl), 'utf8') : style.content
    const config = await resolveConfig(
      { configFile: false, logLevel: 'silent', css: { transformer: 'lightningcss' } },
      'serve'
    )
    const iconCss = await preprocessCSS(
      entry.match(/<style[^>]*>([\s\S]*?)<\/style>/)![1],
      'icloud-entry.css',
      config
    )
    const peerCss = await preprocessCSS(peerStyle, 'library-rail.scss', config)
    const rules = (css: string) =>
      Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), ([, selector, body]) => ({
        selector: selector.trim(),
        declarations: Object.fromEntries(
          body
            .split(';')
            .filter((value) => value.trim())
            .map((value) => {
              const colon = value.indexOf(':')
              return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()]
            })
        )
      }))
    const iconRules = rules(iconCss.code)
    const peerHover = rules(peerCss.code).find((rule) =>
      rule.selector.includes('.iconBox:hover .sidebar-icon')
    )!
    const iconHover = iconRules.find(
      (rule) => rule.selector.includes(':hover') && rule.selector.includes('.sidebar-icon')
    )!
    expect(peerHover).toBeDefined()
    expect(iconHover.declarations).toEqual(peerHover.declarations)
    const peerActive = rules(peerCss.code).find((rule) =>
      rule.selector.includes('.sidebar-icon.is-active')
    )!
    const iconActive = iconRules.find((rule) => rule.selector.includes('.sidebar-icon.is-active'))!
    expect(iconActive.declarations).toEqual(peerActive.declarations)
    for (const rule of iconRules.filter(
      (rule) =>
        /:hover|:focus-visible|\.is-active/.test(rule.selector) &&
        !/:{1,2}before\b/.test(rule.selector)
    )) {
      expect(
        Object.keys(rule.declarations).filter((name) => name.startsWith('background')),
        rule.selector
      ).toEqual([])
    }
    const focus = iconRules.find((rule) => rule.selector === 'button:focus-visible')!
    expect(focus.declarations.outline).toMatch(/solid.*var\(--accent\)/)
    expect(focus.declarations['outline-offset']).toBe('1px')
    expect(iconRules.find((rule) => rule.selector === 'button')!.declarations.background).toBe(
      'none'
    )
  })
})
