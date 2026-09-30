<script setup lang="ts">
// Rekordbox 本机 / U 盘和 Serato 来源栏与歌曲列表均直接使用应用组件。
import { onMounted, onUnmounted, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import LibrarySelectArea from '@renderer/pages/modules/librarySelectArea.vue'
import DemoSongList from './DemoSongList.vue'

const runtime = useRuntimeStore()
const rootRef = ref<HTMLDivElement | null>(null)
let observer: IntersectionObserver | null = null

const setSelectedSource = (visible: boolean) => {
  if (visible) {
    runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'usb'
    runtime.pioneerDeviceLibrary.selectedSourceKey = 'pioneer-drive:demo-usb:deviceLibrary'
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = 'E:/'
    runtime.pioneerDeviceLibrary.selectedLibraryType = 'deviceLibrary'
  } else if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
    runtime.libraryAreaSelected = 'FilterLibrary'
  }
}

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    setSelectedSource(entries.some((entry) => entry.isIntersecting))
  })
  if (rootRef.value) observer.observe(rootRef.value)
})

onUnmounted(() => {
  observer?.disconnect()
  setSelectedSource(false)
})
</script>

<template>
  <div ref="rootRef" class="frkb-app theme-dark demo-external">
    <LibrarySelectArea />
    <div class="demo-external__songs">
      <DemoSongList
        source-kind="external"
        :column-keys="['waveform', 'title', 'artist', 'bpm', 'key', 'format']"
      />
    </div>
  </div>
</template>

<style scoped>
.demo-external {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
}
.demo-external__songs {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
