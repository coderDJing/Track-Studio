<script setup lang="ts">
import { ref } from 'vue'
import icloudIcon from '@renderer/assets/icloud.svg?asset'
import rightClickMenu from '@renderer/components/rightClickMenu'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { dropLocalSongsOnIcloud } from '@renderer/utils/icloudDrag'
import { t } from '@renderer/utils/translate'
import { icloudOpen } from '@renderer/utils/icloudLibrary'
import { hideIcloudLibraryIcon } from '@renderer/utils/icloudLibraryPreferences'
// Vite inlines small SVGs as data URLs containing raw parentheses / apostrophes.
// An unquoted url(...) becomes a CSS BadUrl and leaves a solid background square.
const iconMask = `url(${JSON.stringify(icloudIcon)})`
const runtime = useRuntimeStore()
const dragOver = (event: DragEvent) => {
  if (event.dataTransfer?.types.includes('application/x-song-drag')) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }
}
const drop = (event: DragEvent) =>
  dropLocalSongsOnIcloud(event, runtime.draggingSongFilePaths || [])
const anchor = ref<HTMLElement>()
const failed = ref(false)
async function context(event: MouseEvent) {
  const choice = await rightClickMenu({
    clickEvent: event,
    menuArr: [[{ menuName: 'icloud.hideIcon' }]]
  })
  if (choice !== 'cancel' && choice.menuName === 'icloud.hideIcon') {
    try {
      failed.value = false
      await hideIcloudLibraryIcon()
    } catch {
      failed.value = true
    }
  }
}
</script>
<template>
  <div
    class="icloud-entry"
    :class="{ 'is-active': icloudOpen }"
    @contextmenu.stop.prevent="context"
    @dragover="dragOver"
    @drop="drop"
  >
    <button
      ref="anchor"
      type="button"
      :aria-label="t('icloud.title')"
      :aria-pressed="icloudOpen"
      @click="icloudOpen = true"
    >
      <span
        class="sidebar-icon"
        :class="{ 'is-active': icloudOpen }"
        :style="{ '--icon-mask': iconMask }"
        aria-hidden="true"
      />
    </button>
    <bubbleBox :dom="anchor" :title="t(failed ? 'icloud.preferenceFailed' : 'icloud.title')" />
  </div>
</template>
<style scoped>
.icloud-entry {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 45px;
  height: 45px;
}
.icloud-entry.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  width: 2px;
  height: 100%;
  background: var(--accent);
}
button {
  display: grid;
  place-items: center;
  width: 40px;
  height: 38px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
.sidebar-icon {
  display: inline-block;
  width: 25px;
  height: 25px;
  opacity: var(--sidebar-icon-opacity);
  background-color: currentColor;
  mask-image: var(--icon-mask);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--icon-mask);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
  transition:
    opacity 0.15s ease,
    color 0.15s ease;
}
.icloud-entry:hover .sidebar-icon,
button:focus-visible .sidebar-icon {
  opacity: 0.85;
}
.icloud-entry .sidebar-icon.is-active {
  opacity: 1;
}
</style>
