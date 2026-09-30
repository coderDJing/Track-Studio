import type { HeadConfig } from 'vitepress'

const siteUrl = 'https://coderdjing.github.io/Track-Studio/'

type SeoPage = {
  path: string
  alternatePath: string
  language: 'zh-CN' | 'en-US'
  isHome: boolean
}

const pages: Record<string, SeoPage> = {
  'index.md': { path: '', alternatePath: 'en/', language: 'zh-CN', isHome: true },
  'en/index.md': { path: 'en/', alternatePath: '', language: 'en-US', isHome: true },
  'features.md': {
    path: 'features',
    alternatePath: 'en/features',
    language: 'zh-CN',
    isHome: false
  },
  'en/features.md': {
    path: 'en/features',
    alternatePath: 'features',
    language: 'en-US',
    isHome: false
  }
}

const absoluteUrl = (path: string) => `${siteUrl}${path}`

export function buildSeoHead(pagePath: string, title: string, description: string): HeadConfig[] {
  const page = pages[pagePath.replaceAll('\\', '/').replace(/^\//, '')]
  if (!page) return []

  const url = absoluteUrl(page.path)
  const imageUrl = `${siteUrl}assets/og-track-studio-${page.language === 'zh-CN' ? 'zh' : 'en'}.png`
  const zhUrl = absoluteUrl(page.language === 'zh-CN' ? page.path : page.alternatePath)
  const enUrl = absoluteUrl(page.language === 'en-US' ? page.path : page.alternatePath)
  const head: HeadConfig[] = [
    ['link', { rel: 'canonical', href: url }],
    ['link', { rel: 'alternate', hreflang: 'zh-CN', href: zhUrl }],
    ['link', { rel: 'alternate', hreflang: 'en-US', href: enUrl }],
    ['link', { rel: 'alternate', hreflang: 'x-default', href: zhUrl }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Track Studio' }],
    ['meta', { property: 'og:locale', content: page.language === 'zh-CN' ? 'zh_CN' : 'en_US' }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:image', content: imageUrl }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: title }],
    ['meta', { name: 'twitter:description', content: description }],
    ['meta', { name: 'twitter:image', content: imageUrl }]
  ]

  if (page.isHome) {
    head.push([
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Track Studio',
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Windows, macOS',
        inLanguage: page.language,
        url,
        image: imageUrl,
        downloadUrl: 'https://github.com/coderDJing/Track-Studio/releases/latest',
        description
      })
    ])
  }

  return head
}
