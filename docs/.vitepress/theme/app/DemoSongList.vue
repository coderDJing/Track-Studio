<script setup lang="ts">
// 官网“曲库整理 / 播放与波形”章节：直接渲染应用原版 SongListHeader + SongListRows。
// 列定义取应用默认列（buildSongsAreaDefaultColumns，含名称、宽度、默认显示），可按章节只显示其中几列；
// 波形预览走应用自己的 waveform-list-preview-cache:batch 通道与列表预览 worker 绘制。
// 演示：选中行逐首下移，模拟用键盘一首首过歌。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import SongListHeader from '@renderer/pages/modules/songsArea/SongListHeader.vue'
import SongListRows from '@renderer/pages/modules/songsArea/SongListRows.vue'
import { buildSongsAreaDefaultColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import ascendingOrder from '@renderer/assets/ascending-order.svg?url'
import descendingOrder from '@renderer/assets/descending-order.svg?url'
import { t } from '@renderer/utils/translate'
import type { ISongsAreaColumn } from 'src/types/globals'
import {
  DEMO_EXTERNAL_SONGS,
  DEMO_LIBRARY_SONGS,
  DEMO_PLAYER_SONGS,
  loadDemoLibraryPreviews
} from './demoLibrarySongs'
import { registerDemoUnifiedWaveform } from './demoIpc'
import { loadDemoUnifiedWaveforms } from './demoSongs'

const props = withDefaults(
  defineProps<{
    // 只显示这些列（按应用默认顺序）；不传就用应用默认可见列
    columnKeys?: string[]
    // 选中行自动下移的间隔
    stepMs?: number
    sourceKind?: 'local' | 'external' | 'player'
  }>(),
  { columnKeys: undefined, stepMs: 1800, sourceKind: 'local' }
)

const columns = ref<ISongsAreaColumn[]>(
  buildSongsAreaDefaultColumns('default').map((column) => ({
    ...column,
    show: props.columnKeys ? props.columnKeys.includes(column.key) : column.show
  }))
)
const visibleColumns = computed(() => columns.value.filter((column) => column.show))
const totalWidth = computed(() =>
  visibleColumns.value.reduce((sum, column) => sum + (column.width || 0), 0)
)

const songs =
  props.sourceKind === 'external'
    ? DEMO_EXTERNAL_SONGS
    : props.sourceKind === 'player'
      ? DEMO_PLAYER_SONGS
      : DEMO_LIBRARY_SONGS
const cursor = ref(0)
const selectedFilePaths = computed(() => [songs[cursor.value].filePath])
const ready = ref(false)
const scrollRef = ref<HTMLDivElement | null>(null)
const rootRef = ref<HTMLDivElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
let intersectionObserver: IntersectionObserver | null = null

const start = () => {
  if (props.sourceKind === 'player') return
  if (timer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  timer = setInterval(() => {
    cursor.value = (cursor.value + 1) % songs.length
  }, props.stepMs)
}
const stop = () => {
  if (timer) clearInterval(timer)
  timer = null
}

onMounted(async () => {
  await loadDemoLibraryPreviews(withBase('/assets/unified-waveforms/'))
  if (props.sourceKind === 'player') {
    const waveforms = await loadDemoUnifiedWaveforms(withBase('/assets/unified-waveforms/'))
    waveforms.forEach(({ filePath, data }) => registerDemoUnifiedWaveform(filePath, data))
  }
  ready.value = true
  intersectionObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) start()
    else stop()
  })
  if (rootRef.value) intersectionObserver.observe(rootRef.value)
})

onUnmounted(() => {
  stop()
  intersectionObserver?.disconnect()
})
</script>

<template>
  <div ref="rootRef" class="frkb-app theme-dark demo-song-list">
    <div ref="scrollRef" class="demo-song-list__scroll">
      <SongListHeader
        :columns="columns"
        :t="t"
        :ascending-order="ascendingOrder"
        :descending-order="descendingOrder"
        :total-width="totalWidth"
      />
      <SongListRows
        v-if="ready"
        :songs="songs"
        :visible-columns="visibleColumns"
        :selected-song-file-paths="selectedFilePaths"
        :playing-song-file-path="songs[cursor].filePath"
        :total-width="totalWidth"
        :source-library-name="sourceKind === 'external' ? 'PioneerDeviceLibrary' : 'FilterLibrary'"
        :source-song-list-u-u-i-d="
          sourceKind === 'external' ? 'demo-rekordbox-usb' : 'demo-beatport-weekly'
        "
        :scroll-host-element="scrollRef"
        song-list-root-dir=""
        :enable-cover-thumbnails="false"
      />
    </div>
  </div>
</template>

<style scoped>
.demo-song-list {
  height: 100%;
  overflow: hidden;
}

/* 与应用歌曲区一致：横向超出时可以滚动，纵向由外层裁切 */
.demo-song-list__scroll {
  position: relative;
  height: 100%;
  overflow: auto;
  scrollbar-width: none;
}
</style>
