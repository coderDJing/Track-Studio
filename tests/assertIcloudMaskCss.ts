import { expect } from 'vitest'
import { preprocessCSS, resolveConfig } from 'vite'

export async function assertIcloudMaskCss(mask: string, icloudIcon: string) {
  const config = await resolveConfig(
    { configFile: false, logLevel: 'silent', css: { transformer: 'lightningcss' } },
    'serve'
  )
  await expect(
    preprocessCSS(`.icon { mask-image: url(${icloudIcon}); }`, 'icloud-mask.css', config)
  ).rejects.toThrow(/BadUrl/)
  const parsed = await preprocessCSS(
    `.icon { --icon-mask: ${mask}; mask-image: ${mask}; -webkit-mask-image: ${mask}; }`,
    'icloud-mask.css',
    config
  )
  expect(parsed.code).toContain('mask-image: url("data:image/svg+xml,')
  expect(parsed.code).not.toContain('mask-image: none')
}
