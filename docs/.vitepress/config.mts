import { defineConfig } from 'vitepress'
import { appBridgeViteConfig } from './appBridge'
import { buildSeoHead } from './seo'

export default defineConfig({
  title: 'Track Studio',
  description: 'Track Studio — DJ 音乐整理与演出准备工作站',
  base: '/Track-Studio/',
  // 官网只做暗色，与应用暗色主题保持一致
  appearance: 'force-dark',
  // 首页直接渲染应用的真实组件，需要应用的别名与导入约定
  vite: appBridgeViteConfig,
  lastUpdated: true,
  cleanUrls: true,
  sitemap: { hostname: 'https://coderdjing.github.io/Track-Studio/' },
  transformHead: ({ page, title, description }) => buildSeoHead(page, title, description),

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Track Studio - DJ 音乐整理与演出准备工作站',
      description:
        '为 DJ 整理真实音频文件、按指纹去重、双轨波形试听、编排 SET，并用 Mixtape 录制与 Stem 分轨准备演出。支持 Windows 和 macOS。'
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Track Studio - DJ Music Library & Set Preparation',
      description:
        'Organize real audio files, find duplicates by fingerprint, audition on two decks, prepare SET playlists, record Mixtapes, and separate stems. For Windows and macOS.'
    }
  },

  themeConfig: {
    logo: '/assets/icon.webp',
    socialLinks: [{ icon: 'github', link: 'https://github.com/coderDJing/Track-Studio' }]
  },

  head: [
    ['link', { rel: 'icon', href: '/Track-Studio/assets/icon.webp' }],
    ['meta', { name: 'theme-color', content: '#181818' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap',
        rel: 'stylesheet'
      }
    ]
  ]
})
