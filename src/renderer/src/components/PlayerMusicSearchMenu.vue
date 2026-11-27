<script setup lang="ts">
import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import type { ISongInfo } from '../../../types/globals'
import {
  getMusicSearchOpenFailedMessageKey,
  openMusicSearch,
  resolveMusicSearch,
  type MusicSearchMode,
  type MusicSearchProvider
} from '@renderer/utils/musicSearch'
const props = defineProps<{ song: ISongInfo | null }>()
const emit = defineEmits<{ close: [] }>()
const musicSearchSubmenu = ref<MusicSearchProvider | null>(null)
const providers = ['netease', 'spotify'] as const
const modes = [
  ['titleArtist', 'TitleArtist'],
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album']
] as const
const showMusicSearchHint = async (messageKey: string) => {
  await confirm({
    title: t('dialog.hint'),
    content: [t(messageKey)],
    confirmShow: false
  })
}

const handleMusicSearch = async (provider: MusicSearchProvider, mode: MusicSearchMode) => {
  const song = props.song
  if (!song) return
  const resolution = resolveMusicSearch(provider, mode, song)
  if (!resolution.query) {
    await showMusicSearchHint(resolution.emptyMessageKey)
    return
  }
  if (!(await openMusicSearch(provider, resolution.query))) {
    await showMusicSearchHint(getMusicSearchOpenFailedMessageKey(provider))
  }
  emit('close')
}
</script>
<template>
  <div
    style="padding: 5px 5px; border-bottom: 1px solid var(--border)"
    @mouseleave="musicSearchSubmenu = null"
  >
    <div
      v-for="provider in providers"
      :key="provider"
      class="menuButton hasSubmenu"
      :class="{ submenuOpen: musicSearchSubmenu === provider }"
      @mouseenter="musicSearchSubmenu = provider"
    >
      <span>{{ t('tracks.' + provider + 'Search') }}</span
      ><span style="margin-left: 8px; opacity: 0.6">▸</span>
      <div v-if="musicSearchSubmenu === provider" class="submenu">
        <div
          v-for="[mode, suffix] in modes"
          :key="mode"
          class="menuButton"
          @click.stop="handleMusicSearch(provider, mode)"
        >
          <span>{{ t('tracks.' + provider + 'Search' + suffix) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped lang="scss">
.menuButton {
  display: flex;
  justify-content: space-between;
  padding: 5px 20px;
  border-radius: 5px;
  &:hover {
    background-color: var(--accent);
    color: #fff;
  }
}
.hasSubmenu {
  position: relative;
  &.submenuOpen {
    background-color: var(--accent);
    color: #fff;
  }
}
.submenu {
  position: absolute;
  left: 100%;
  bottom: 0;
  width: 200px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 5px 5px;
  z-index: var(--z-popover);
}
</style>
