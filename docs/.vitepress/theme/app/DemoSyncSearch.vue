<script setup lang="ts">
// 官网“同步与发现”章节：并排渲染应用原版的全局搜歌弹窗与云端同步完成摘要。
// 搜歌走 song-search:query 通道（按主进程返回格式给演示结果），搜索框里逐字输入关键词。
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import GlobalSongSearchDialog, {
  type GlobalSongSearchDialogItem
} from '@renderer/components/globalSongSearchDialog.vue'
import CloudSyncSummaryDialog from '@renderer/components/cloudSyncSummaryDialog.vue'
import type { CloudSyncSummary } from 'src/types/cloudSync'
import { registerDemoIpcHandler } from './demoIpc'

const QUERY = 'hollow 128'

const LIBRARY: GlobalSongSearchDialogItem[] = [
  {
    id: '1',
    filePath: 'D:/Music/Track Studio/精选库/Peak Time/Hollow Signal - Red Room.mp3',
    fileName: 'Hollow Signal - Red Room.mp3',
    title: 'Red Room',
    artist: 'Hollow Signal',
    album: 'Red Room',
    genre: 'Techno',
    label: 'Signal Rec.',
    duration: '3:04',
    keyText: 'Cm',
    bpm: 130,
    container: 'MP3',
    songListUUID: 'peak',
    songListName: 'Peak Time',
    songListPath: '精选库/Peak Time',
    libraryName: 'CuratedLibrary',
    score: 0.92
  },
  {
    id: '2',
    filePath: 'D:/Music/Track Studio/筛选库/2026-09 新歌/Hollow Signal - Concrete Bloom.flac',
    fileName: 'Hollow Signal - Concrete Bloom.flac',
    title: 'Concrete Bloom',
    artist: 'Hollow Signal',
    album: 'Concrete Bloom EP',
    genre: 'Techno',
    label: 'Signal Rec.',
    duration: '3:02',
    keyText: 'Gm',
    bpm: 126,
    container: 'FLAC',
    songListUUID: 'new',
    songListName: 'Beatport 周榜',
    songListPath: '筛选库/2026-09 新歌/Beatport 周榜',
    libraryName: 'FilterLibrary',
    score: 0.88
  },
  {
    id: '3',
    filePath: 'D:/Music/Track Studio/精选库/Warm Up/Kaito Ren - Hollow Ground.aiff',
    fileName: 'Kaito Ren - Hollow Ground.aiff',
    title: 'Hollow Ground',
    artist: 'Kaito Ren',
    album: 'Pressure',
    genre: 'House',
    label: 'Pressure',
    duration: '5:40',
    keyText: 'F#m',
    bpm: 128,
    container: 'AIFF',
    songListUUID: 'warm',
    songListName: 'Warm Up',
    songListPath: '精选库/Warm Up',
    libraryName: 'CuratedLibrary',
    score: 0.81
  }
]

// 按关键词逐词匹配标题 / 艺人 / BPM，和主进程搜索一样返回 { items }
registerDemoIpcHandler('song-search:query', (payload) => {
  const keyword =
    payload && typeof payload === 'object' && 'keyword' in payload
      ? String((payload as { keyword?: unknown }).keyword || '')
      : ''
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean)
  const items = LIBRARY.filter((item) =>
    words.every((word) =>
      [item.title, item.artist, item.album, String(item.bpm ?? '')].some((field) =>
        field.toLowerCase().includes(word)
      )
    )
  )
  return { items }
})
registerDemoIpcHandler('song-search:warmup', () => null)

const summary: CloudSyncSummary = {
  addedToServerCount: 86,
  pulledToClientCount: 214,
  clientInitialCount: 8412,
  totalClientCountAfter: 8626,
  serverInitialCount: 8540,
  totalServerCountAfter: 8626,
  curatedArtistClientInitialCount: 120,
  curatedArtistClientCountAfter: 120,
  curatedArtistServerInitialCount: 110,
  curatedArtistServerCountAfter: 120
}

const rootRef = ref<HTMLDivElement | null>(null)
const searchReady = ref(false)
let timers: ReturnType<typeof setTimeout>[] = []
let intersectionObserver: IntersectionObserver | null = null

// 往原版搜索框里逐字输入：写 value 再派发 input 事件，走组件自己的 v-model
const typeQuery = () => {
  const input = rootRef.value?.querySelector<HTMLInputElement>('.search-input')
  if (!input) return
  const setValue = (value: string) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setValue('')
  QUERY.split('').forEach((_, index) => {
    timers.push(setTimeout(() => setValue(QUERY.slice(0, index + 1)), 500 + index * 130))
  })
  timers.push(setTimeout(typeQuery, 500 + QUERY.length * 130 + 4200))
}

const stop = () => {
  timers.forEach(clearTimeout)
  timers = []
}

onMounted(() => {
  intersectionObserver = new IntersectionObserver(async (entries) => {
    stop()
    if (!entries.some((entry) => entry.isIntersecting)) return
    if (!searchReady.value) {
      searchReady.value = true
      await nextTick()
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const input = rootRef.value?.querySelector<HTMLInputElement>('.search-input')
      if (input) {
        input.value = QUERY
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    } else {
      typeQuery()
    }
  })
  if (rootRef.value) intersectionObserver.observe(rootRef.value)
})

onUnmounted(() => {
  stop()
  intersectionObserver?.disconnect()
})
</script>

<template>
  <div ref="rootRef" class="demo-sync">
    <div class="frkb-app theme-dark frkb-app--dialog-host demo-sync__search">
      <GlobalSongSearchDialog v-if="searchReady" />
    </div>
    <div class="frkb-app theme-dark frkb-app--dialog-host demo-sync__summary">
      <CloudSyncSummaryDialog :summary="summary" />
    </div>
  </div>
</template>

<style scoped>
.demo-sync {
  display: grid;
  grid-template-rows: 600px 380px;
  justify-items: center;
  gap: 24px;
  box-sizing: border-box;
  min-width: 868px;
  height: 100%;
  padding: 24px;
}

.demo-sync__search {
  width: 820px;
  height: 600px;
}

.demo-sync__summary {
  width: 520px;
  height: 380px;
  border: 1px solid #3b3b3b;
}
</style>
