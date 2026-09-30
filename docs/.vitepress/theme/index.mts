import DefaultTheme from 'vitepress/theme'
import { createPinia } from 'pinia'
import { i18n, setLocale } from '@renderer/i18n'
import { useRuntimeStore } from '@renderer/stores/runtime'
// 应用在 main.ts / mixtape_main.ts 里全局引入的滚动条样式；Mixtape 时间线靠它把视口收在容器内
import 'overlayscrollbars/overlayscrollbars.css'
import dialogDrag from '@renderer/directives/dialogDrag'
import { installDemoAudioScheme, installDemoIpc } from './app/demoIpc'
import Home from './Home.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    // 首页直接渲染应用的真实组件：它们依赖 pinia 的 runtime store 与 vue-i18n，
    // 并在 setup / mounted 里就会访问 window.electron，所以 IPC 替身要在任何组件挂载前装好
    installDemoIpc()
    const pinia = createPinia()
    app.use(pinia)
    // 官网只做暗色：应用组件按 runtime.setting.themeMode 选主题（默认 'system' 会跟随访客系统变亮）
    useRuntimeStore(pinia).setting.themeMode = 'dark'
    app.use(i18n)
    // 应用在 main.ts 里全局注册的弹窗拖动指令
    app.directive('dialog-drag', dialogDrag)
    installDemoAudioScheme()
    const syncLocale = (path: string) => setLocale(path.includes('/en/') ? 'en-US' : 'zh-CN')
    syncLocale(router.route.path)
    router.onAfterRouteChange = syncLocale
    // 注册全局组件，这样在 Markdown 里写 <Home /> 就能用
    app.component('Home', Home)
  }
}
