<script setup lang="ts">
// 官网首页。整页当作一首歌：顶部固定的整曲概览条就是阅读进度，每个章节是一个 Hot Cue。
// 只做暗色，配色全部取自应用暗色主题（main.scss .theme-dark / HorizontalBrowse 系列）。
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'
import DownloadButtons from './DownloadButtons.vue'
import HorizontalBrowseWaveformOverview from '@renderer/components/HorizontalBrowseWaveformOverview.vue'
import DemoHorizontalShell from './app/DemoHorizontalShell.vue'
import DemoSongList from './app/DemoSongList.vue'
import DemoDedupFlow from './app/DemoDedupFlow.vue'
import DemoPlayer from './app/DemoPlayer.vue'
import DemoStemWorkbench from './app/DemoStemWorkbench.vue'
import DemoSyncSearch from './app/DemoSyncSearch.vue'
import DemoKeyboard from './app/DemoKeyboard.vue'
import DemoExternalLibrary from './app/DemoExternalLibrary.vue'
import DemoViewport from './app/DemoViewport.vue'
import { DEMO_TRACKS, loadDemoUnifiedWaveforms } from './app/demoSongs'
import { registerDemoUnifiedWaveform } from './app/demoIpc'
import { enContent, zhContent, type Chapter } from './homeContent'
import './home.css'
import './homeMobile.css'

const { localeIndex } = useData()
const DemoMixtape = defineAsyncComponent(() => import('./app/DemoMixtape.vue'))
const clientReady = ref(false)
const isEn = computed(() => localeIndex.value === 'en')
const c = computed(() => (isEn.value ? enContent : zhContent))
const resolveHref = (href: string) => (href.startsWith('/') ? withBase(href) : href)

// 顶部进度条：用首屏 Deck A 那首歌的整曲波形，播放头 = 滚动进度
const progressReady = ref(false)
const scrollRatio = ref(0)
const activeChapter = ref(-1)
const chapterRatios = ref<number[]>([])
const navScrolled = ref(false)

let frame = 0
let scrollHost: HTMLElement | null = null
const measure = () => {
  frame = 0
  const host = scrollHost
  if (!host) return
  const max = Math.max(1, host.scrollHeight - host.clientHeight)
  scrollRatio.value = Math.min(1, Math.max(0, host.scrollTop / max))
  navScrolled.value = host.scrollTop > 24
  // 章节位置 → 概览条上的 Hot Cue 位置
  const sections = c.value.chapters.map((chapter) => document.getElementById(chapter.id))
  chapterRatios.value = sections.map((el) =>
    el ? Math.min(1, Math.max(0, (el.offsetTop - host.clientHeight * 0.3) / max)) : 0
  )
  const probe = host.scrollTop + host.clientHeight * 0.4
  let current = -1
  sections.forEach((el, index) => {
    if (el && el.offsetTop <= probe) current = index
  })
  activeChapter.value = current
}
const scheduleMeasure = () => {
  if (!frame) frame = requestAnimationFrame(measure)
}

const jumpTo = (chapter: Chapter) => {
  document.getElementById(chapter.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 出现动画
let revealObserver: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null

onMounted(async () => {
  clientReady.value = true
  scrollHost = document.documentElement
  document.documentElement.removeAttribute('data-theme')
  revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          revealObserver?.unobserve(entry.target)
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -60px 0px' }
  )
  document.querySelectorAll('.home-root .reveal').forEach((el) => revealObserver?.observe(el))
  window.addEventListener('scroll', scheduleMeasure, { passive: true })
  resizeObserver = new ResizeObserver(scheduleMeasure)
  const home = document.querySelector('.home-root')
  if (home) resizeObserver.observe(home)
  measure()
  try {
    const waveforms = await loadDemoUnifiedWaveforms(withBase('/assets/unified-waveforms/'))
    waveforms.forEach(({ filePath, data }) => registerDemoUnifiedWaveform(filePath, data))
    progressReady.value = true
  } catch (error) {
    console.error('Failed to load progress waveform:', error)
  }
})

onUnmounted(() => {
  revealObserver?.disconnect()
  resizeObserver?.disconnect()
  window.removeEventListener('scroll', scheduleMeasure)
  scrollHost = null
  if (frame) cancelAnimationFrame(frame)
})

const surfaceCaptionOf = (chapter: Chapter) => chapter.surfaceCaption
const surfaceSizes = {
  library: { width: 960, height: 300 },
  dedup: { width: 640, height: 320 },
  player: { width: 960, height: 360 },
  mixtape: { width: 1100, height: 560 },
  stem: { width: 820, height: 620 },
  external: { width: 960, height: 440 },
  sync: { width: 868, height: 1060 }
}
</script>

<template>
  <div class="home-root">
    <!-- 顶栏 + 整曲概览进度条 -->
    <header class="h-top" :class="{ 'is-scrolled': navScrolled }">
      <div class="h-top-bar">
        <a class="h-brand" :href="withBase(isEn ? '/en/' : '/')">
          <img :src="withBase('/assets/icon.webp')" alt="" width="22" height="22" />
          <span>Track Studio</span>
        </a>
        <nav class="h-top-links">
          <a v-for="item in c.nav" :key="item.href" :href="resolveHref(item.href)">{{
            item.label
          }}</a>
          <a href="https://github.com/coderDJing/Track-Studio" target="_blank" rel="noopener"
            >GitHub</a
          >
          <a :href="withBase(isEn ? '/' : '/en/')" class="h-lang">{{ isEn ? '中文' : 'EN' }}</a>
        </nav>
      </div>
      <div class="h-progress" :aria-label="c.progressLabel">
        <div class="h-progress-waveform frkb-app theme-dark" aria-hidden="true">
          <HorizontalBrowseWaveformOverview
            v-if="progressReady"
            :song="DEMO_TRACKS[0].song"
            :current-seconds="scrollRatio * DEMO_TRACKS[0].durationSec"
            :duration-seconds="DEMO_TRACKS[0].durationSec"
          />
        </div>
        <span
          v-for="(chapter, index) in c.chapters"
          :key="`marker-${chapter.id}`"
          class="h-progress-mobile-marker"
          aria-hidden="true"
          :style="{ left: `${(chapterRatios[index] ?? 0) * 100}%`, '--cue-color': chapter.color }"
        ></span>
        <button
          v-for="(chapter, index) in c.chapters"
          :key="chapter.id"
          type="button"
          class="h-progress-cue"
          :class="{ 'is-active': index === activeChapter }"
          :style="{ left: `${(chapterRatios[index] ?? 0) * 100}%`, '--cue-color': chapter.color }"
          :aria-label="`${c.progressLabel} ${chapter.cue}: ${chapter.kicker}`"
          :aria-current="index === activeChapter ? 'location' : undefined"
          @click="jumpTo(chapter)"
        >
          {{ chapter.cue }}
        </button>
      </div>
    </header>

    <!-- 首屏：原 slogan + 应用真实双轨组件 -->
    <section class="h-hero">
      <div class="h-container">
        <h1 class="h-hero-title reveal" :class="{ 'h-hero-title--en': isEn }">
          <span>{{ c.hero.titleTop }}</span>
          <span class="h-hero-title-accent">{{ c.hero.titleBottom }}</span>
        </h1>
        <p class="h-hero-sub reveal">{{ c.hero.subtitle }}</p>
        <div class="h-hero-cta reveal">
          <DownloadButtons
            :windows-label="c.download.windows"
            :mac-label="c.download.mac"
            :other-prefix="c.download.otherPrefix"
          />
          <div class="h-hero-meta">
            <span>{{ c.hero.platforms }}</span>
            <i></i>
            <span>{{ c.hero.formats }}</span>
          </div>
        </div>
      </div>
      <div class="h-container h-container--wide">
        <div class="h-window reveal">
          <div class="h-window-bar">
            <img :src="withBase('/assets/icon.webp')" alt="" width="14" height="14" />
            <span>Track Studio</span>
          </div>
          <div class="h-hero-demo">
            <DemoViewport :width="1100" :height="372">
              <DemoHorizontalShell v-if="clientReady" />
            </DemoViewport>
          </div>
        </div>
        <p class="h-scroll-hint reveal">{{ c.hero.scrollHint }}</p>
      </div>
    </section>

    <!-- 章节：每章一个 Hot Cue -->
    <section
      v-for="chapter in c.chapters"
      :id="chapter.id"
      :key="chapter.id"
      class="h-chapter"
      :style="{ '--cue-color': chapter.color }"
    >
      <div class="h-container">
        <div class="h-chapter-head reveal">
          <span class="h-cue-badge">{{ chapter.cue }}</span>
          <span class="h-chapter-kicker">{{ chapter.kicker }}</span>
        </div>
        <h2 class="h-chapter-title reveal">{{ chapter.title }}</h2>
        <p class="h-chapter-lead reveal">{{ chapter.lead }}</p>
      </div>

      <div v-if="chapter.surface !== 'deck'" class="h-container h-container--wide">
        <figure class="h-surface reveal" :class="`h-surface--${chapter.surface}`">
          <div class="h-surface-frame">
            <DemoViewport v-bind="surfaceSizes[chapter.surface]">
              <DemoSongList v-if="clientReady && chapter.surface === 'library'" />
              <DemoDedupFlow v-else-if="clientReady && chapter.surface === 'dedup'" />
              <DemoPlayer v-else-if="clientReady && chapter.surface === 'player'">
                <DemoSongList
                  source-kind="player"
                  :column-keys="['waveformPreview', 'title', 'artist', 'bpm', 'key']"
                />
              </DemoPlayer>
              <DemoMixtape v-else-if="chapter.surface === 'mixtape' && clientReady" />
              <DemoStemWorkbench v-else-if="clientReady && chapter.surface === 'stem'" />
              <DemoExternalLibrary v-else-if="clientReady && chapter.surface === 'external'" />
              <DemoSyncSearch v-else-if="clientReady && chapter.surface === 'sync'" />
            </DemoViewport>
          </div>
          <figcaption><span class="h-cue-dot"></span>{{ surfaceCaptionOf(chapter) }}</figcaption>
        </figure>
      </div>

      <div class="h-container">
        <div class="h-groups">
          <div v-for="group in chapter.groups" :key="group.title" class="h-group reveal">
            <h3>{{ group.title }}</h3>
            <dl>
              <div v-for="item in group.items" :key="item.name" class="h-item">
                <dt>{{ item.name }}</dt>
                <dd>{{ item.detail }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </section>

    <!-- 键盘优先 -->
    <section class="h-chapter h-keyboard" style="--cue-color: #d98921">
      <div class="h-container h-keyboard-grid">
        <div>
          <div class="h-chapter-head reveal">
            <span class="h-cue-badge h-cue-badge--memory"></span>
            <span class="h-chapter-kicker">{{ c.keyboard.kicker }}</span>
          </div>
          <h2 class="h-chapter-title reveal">{{ c.keyboard.title }}</h2>
          <p class="h-chapter-lead reveal">{{ c.keyboard.lead }}</p>
          <ul class="h-keyboard-points reveal">
            <li v-for="point in c.keyboard.points" :key="point">{{ point }}</li>
          </ul>
        </div>
        <div class="h-surface-frame h-keyboard-frame reveal">
          <DemoViewport :width="640" :height="540">
            <DemoKeyboard v-if="clientReady" />
          </DemoViewport>
        </div>
      </div>
    </section>

    <!-- 收尾下载 -->
    <section class="h-finale">
      <div class="h-container">
        <div class="h-finale-card reveal">
          <h2>{{ c.finale.title }}</h2>
          <p>{{ c.finale.subtitle }}</p>
          <DownloadButtons
            :windows-label="c.download.windows"
            :mac-label="c.download.mac"
            :other-prefix="c.download.otherPrefix"
          />
          <dl class="h-specs">
            <div>
              <dt>{{ c.finale.systemsTitle }}</dt>
              <dd v-for="item in c.finale.systems" :key="item">{{ item }}</dd>
            </div>
            <div>
              <dt>{{ c.finale.formatsTitle }}</dt>
              <dd class="h-specs-formats">{{ c.finale.formats }}</dd>
            </div>
            <div>
              <dt>{{ c.finale.upgradeTitle }}</dt>
              <dd v-for="item in c.finale.upgrade" :key="item">{{ item }}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>

    <footer class="h-footer">
      <div class="h-container h-footer-inner">
        <span>© 2026 Track Studio · {{ c.footer.license }}</span>
        <span class="h-footer-links">
          <a :href="withBase(isEn ? '/en/features' : '/features')">{{ c.footer.features }}</a>
          <a href="https://github.com/coderDJing/Track-Studio" target="_blank" rel="noopener"
            >GitHub</a
          >
        </span>
      </div>
    </footer>
  </div>
</template>

<style lang="scss">
@use './app/appScope.scss';
</style>
