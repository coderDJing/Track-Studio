// 让官网直接渲染应用 renderer 里的真实 Vue 组件所需的构建配置。
// 应用由 electron-vite 构建，这里补齐它在 VitePress（普通 Vite）下缺的几样东西：
// - 路径别名 @renderer / @shared / src
// - electron-vite 专有的 `?asset` 导入（改写成 Vite 标准的 `?url`）
// - 应用自定义的 `*.wasm?inline`、`<template src>` 外置模板
// - renderer 代码里读取的 process.env.NODE_ENV 与 vue-i18n 编译期开关
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Plugin, UserConfig } from 'vite'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/')
const rendererSrc = `${repoRoot}src/renderer/src`
const sharedSrc = `${repoRoot}src/shared`

const assetQueryPlugin = (): Plugin => ({
  name: 'frkb-docs-asset-query',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!source.endsWith('?asset')) return null
    const resolved = await this.resolve(source.slice(0, -'?asset'.length), importer, {
      ...options,
      skipSelf: true
    })
    return resolved ? `${resolved.id}?url` : null
  }
})

// HorizontalBrowseRawWaveformDetail.vue 用 <template src="./*.template.html"> 外置模板。
// electron-vite 用的 @vitejs/plugin-vue 6 支持外置模板；VitePress 1.x 内置的 plugin-vue 5 会把它当成
// 空模板，组件渲染成 <template></template>。这里在进 SFC 编译前把外置模板内联回去。
// 应用模板文件可能含 <template> 外壳，也可能只有模板正文；SFC 编译器需要完整的模板块。
const inlineExternalTemplatePlugin = (): Plugin => ({
  name: 'frkb-docs-inline-external-template',
  enforce: 'pre',
  async transform(code, id) {
    const filePath = id.split('?')[0]
    if (!filePath.endsWith('.vue') || !filePath.startsWith(rendererSrc)) return null
    const match = code.match(/<template\s+src="([^"]+)"\s*><\/template>/)
    if (!match) return null
    const templatePath = fileURLToPath(new URL(match[1], pathToFileURL(filePath)))
    this.addWatchFile(templatePath)
    const templateSource = (await readFile(templatePath, 'utf8')).trim()
    const templateBlock = /^<template(?:\s|>)/.test(templateSource)
      ? templateSource
      : `<template>\n${templateSource}\n</template>`
    return code.replace(match[0], templateBlock)
  }
})

// 与 electron.vite.config.ts 的 inlineWasmPlugin 完全相同：`*.wasm?inline` 导出 base64 data URL
// （Mixtape 的变速引擎 rubberband-wasm 这样引入）
const inlineWasmPlugin = (): Plugin => ({
  name: 'frkb-docs-inline-wasm',
  enforce: 'pre',
  async load(id) {
    const [filePath, query = ''] = id.split('?')
    if (!filePath.endsWith('.wasm') || !query.split('&').includes('inline')) return null
    const bytes = await readFile(filePath)
    const dataUrl = `data:application/wasm;base64,${bytes.toString('base64')}`
    return `export default ${JSON.stringify(dataUrl)}`
  }
})

export const appBridgeViteConfig: UserConfig = {
  plugins: [assetQueryPlugin(), inlineExternalTemplatePlugin(), inlineWasmPlugin()],
  resolve: {
    alias: [
      { find: /^@renderer\//, replacement: `${rendererSrc}/` },
      { find: /^@shared\//, replacement: `${sharedSrc}/` },
      { find: /^src\//, replacement: `${repoRoot}src/` }
    ]
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    // vue-i18n 的 esm-bundler 构建读取这些编译期开关，Vite + plugin-vue 默认只注入 Vue 自己的
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_I18N_FULL_INSTALL__: 'true',
    __VUE_I18N_LEGACY_API__: 'false',
    __INTLIFY_PROD_DEVTOOLS__: 'false',
    __INTLIFY_JIT_COMPILATION__: 'true',
    __INTLIFY_DROP_MESSAGE_COMPILER__: 'false'
  },
  ssr: {
    // SSR 阶段也要走同一套 define，不能把 vue-i18n 当外部依赖直接 require
    noExternal: ['vue-i18n', '@intlify/core-base', '@intlify/shared', '@intlify/message-compiler']
  },
  css: {
    preprocessorOptions: {
      scss: { api: 'modern-compiler', silenceDeprecations: ['legacy-js-api'] }
    }
  },
  server: {
    fs: { allow: [repoRoot] }
  }
}
