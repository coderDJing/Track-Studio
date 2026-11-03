<script setup lang="ts">
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  isNewSongsImportLibrary,
  openNewSongsImport,
  type NewSongsImportLibrary
} from '@renderer/utils/newSongsImport'
import emitter from '@renderer/utils/mitt'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import { requestUserGuideStep } from '@renderer/composables/userGuideBridge'
import { computed, onMounted, onUnmounted, ref } from 'vue'

type WelcomePlaylistAction = {
  kind: 'songList' | 'setList' | 'stemMixtape' | 'eqMixtape'
  label: string
}

type WelcomePlaylistCreatedPayload = {
  uuid: string
}

const props = defineProps<{
  horizontal: boolean
}>()

const runtime = useRuntimeStore()
const welcomePlaylistActions = computed<WelcomePlaylistAction[]>(() => {
  switch (runtime.libraryAreaSelected) {
    case 'FilterLibrary':
    case 'CuratedLibrary':
      return [{ kind: 'songList', label: t('library.createPlaylist') }]
    case 'SetLibrary':
      return [{ kind: 'setList', label: t('library.createSetPlaylist') }]
    case 'MixtapeLibrary':
      return [
        { kind: 'stemMixtape', label: t('library.createStemMixtape') },
        { kind: 'eqMixtape', label: t('library.createEqMixtape') }
      ]
    default:
      return []
  }
})
const selectedLibraryLabel = computed(() => toLibraryDisplayName(runtime.libraryAreaSelected))
const selectedImportLibrary = computed<NewSongsImportLibrary | null>(() => {
  const libraryName = runtime.libraryAreaSelected
  return isNewSongsImportLibrary(libraryName) ? libraryName : null
})
const importNewSongsLabel = computed(() =>
  selectedImportLibrary.value
    ? t('library.importNewTracks', { libraryType: selectedLibraryLabel.value })
    : ''
)
const isCreationNudgeActive = ref(false)
const creationNudgeStyle = ref<Record<string, string>>({})
let creationNudgeTimer: ReturnType<typeof setTimeout> | null = null
let creationNudgeOrigin: { x: number; y: number } | null = null

const clearCreationNudge = () => {
  isCreationNudgeActive.value = false
  creationNudgeStyle.value = {}
  if (creationNudgeTimer) clearTimeout(creationNudgeTimer)
  creationNudgeTimer = null
}

const startCreationNudge = (target: HTMLElement) => {
  if (!creationNudgeOrigin) return
  const targetRect = target.getBoundingClientRect()
  const targetX = targetRect.left + targetRect.width / 2
  const targetY = targetRect.top + targetRect.height / 2
  const offsetX = targetX - creationNudgeOrigin.x
  const offsetY = targetY - creationNudgeOrigin.y
  const distance = Math.hypot(offsetX, offsetY)
  if (distance < 1) return

  creationNudgeStyle.value = {
    left: `${creationNudgeOrigin.x}px`,
    top: `${creationNudgeOrigin.y}px`,
    '--welcome-trail-angle': `${Math.atan2(offsetY, offsetX)}rad`,
    '--welcome-trail-distance': `${distance}px`
  }
  isCreationNudgeActive.value = true
  if (creationNudgeTimer) clearTimeout(creationNudgeTimer)
  creationNudgeTimer = setTimeout(clearCreationNudge, 680)
}

const handleWelcomePlaylistCreated = (payload: unknown) => {
  const uuid = (payload as WelcomePlaylistCreatedPayload | null)?.uuid
  if (!uuid || !creationNudgeOrigin) return

  let attempts = 0
  const findTargetInput = () => {
    const target = document.querySelector<HTMLElement>(
      `[data-welcome-created-playlist-input="${uuid}"]`
    )
    if (target) {
      startCreationNudge(target)
      return
    }
    attempts += 1
    if (attempts < 6) requestAnimationFrame(findTargetInput)
  }
  requestAnimationFrame(findTargetInput)
}

const createPlaylistFromWelcome = async (
  kind: WelcomePlaylistAction['kind'],
  event: MouseEvent
) => {
  const origin = event.currentTarget
  await requestUserGuideStep('songsSource')
  if (origin instanceof HTMLElement) {
    const originRect = origin.getBoundingClientRect()
    creationNudgeOrigin = {
      x: originRect.left + originRect.width / 2,
      y: originRect.top + originRect.height / 2
    }
  }
  emitter.emit('welcome:create-playlist', kind)
}

const importNewSongsFromWelcome = async () => {
  const libraryName = selectedImportLibrary.value
  if (!libraryName) return
  await requestUserGuideStep('songsSource')
  await openNewSongsImport(libraryName, { openSongListAfterImport: true })
}

onMounted(() => {
  emitter.on('welcome:playlist-created', handleWelcomePlaylistCreated)
})

onUnmounted(() => {
  emitter.off('welcome:playlist-created', handleWelcomePlaylistCreated)
  clearCreationNudge()
})
</script>

<template>
  <div
    v-if="welcomePlaylistActions.length"
    class="welcome-create-playlist-actions"
    data-user-guide-target="songs-source"
    :class="{ 'welcome-create-playlist-actions--horizontal': props.horizontal }"
  >
    <div
      v-if="isCreationNudgeActive"
      class="welcome-creation-nudge"
      :style="creationNudgeStyle"
      aria-hidden="true"
    >
      <span class="welcome-creation-nudge__beam"></span>
    </div>
    <button
      v-for="action in welcomePlaylistActions"
      :key="action.kind"
      type="button"
      class="welcome-create-playlist"
      :class="{ 'welcome-create-playlist--acknowledged': isCreationNudgeActive }"
      @click="createPlaylistFromWelcome(action.kind, $event)"
    >
      <span class="welcome-create-playlist__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <span class="welcome-create-playlist__copy">
        <span class="welcome-create-playlist__title">{{ action.label }}</span>
        <span class="welcome-create-playlist__hint">{{ selectedLibraryLabel }}</span>
      </span>
    </button>
    <button
      v-if="selectedImportLibrary"
      type="button"
      class="welcome-create-playlist welcome-import-songs"
      @click="importNewSongsFromWelcome"
    >
      <span class="welcome-create-playlist__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 19h14" />
        </svg>
      </span>
      <span class="welcome-create-playlist__copy">
        <span class="welcome-create-playlist__title">{{ importNewSongsLabel }}</span>
        <span class="welcome-create-playlist__hint">{{ selectedLibraryLabel }}</span>
      </span>
    </button>
  </div>
</template>

<style lang="scss" scoped>
.welcome-create-playlist-actions {
  display: flex;
  width: min(100%, 500px);
  justify-content: center;
  gap: 10px;
}

.welcome-creation-nudge {
  position: fixed;
  z-index: 100;
  width: 1px;
  height: 1px;
  pointer-events: none;
  transform: rotate(var(--welcome-trail-angle));
  transform-origin: 0 50%;
}

.welcome-creation-nudge__beam {
  position: absolute;
  top: -3px;
  left: 0;
  width: 96px;
  height: 6px;
  border-radius: 99px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 30%, transparent) 42%,
    color-mix(in srgb, var(--accent) 92%, var(--text)) 78%,
    color-mix(in srgb, var(--accent) 90%, var(--text))
  );
  box-shadow:
    0 0 10px color-mix(in srgb, var(--accent) 70%, transparent),
    0 0 22px color-mix(in srgb, var(--accent) 35%, transparent);
  animation: welcomeCreationNudge 0.66s cubic-bezier(0.16, 0.82, 0.28, 1) forwards;

  &::after {
    position: absolute;
    top: -3px;
    right: -1px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    content: '';
    background: color-mix(in srgb, var(--accent) 92%, var(--text));
    box-shadow:
      0 0 7px color-mix(in srgb, var(--accent) 86%, transparent),
      0 0 16px color-mix(in srgb, var(--accent) 48%, transparent);
  }
}

@keyframes welcomeCreationNudge {
  0% {
    transform: translateX(-92px);
    opacity: 0;
  }

  12% {
    opacity: 1;
  }

  100% {
    transform: translateX(calc(var(--welcome-trail-distance) - 92px));
    opacity: 0;
  }
}

.welcome-create-playlist {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  max-width: 240px;
  box-sizing: border-box;
  min-height: 46px;
  padding: 6px 10px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  border-radius: 11px;
  background:
    radial-gradient(
      circle at 0% 0%,
      color-mix(in srgb, var(--accent) 24%, transparent),
      transparent 58%
    ),
    linear-gradient(135deg, color-mix(in srgb, var(--bg-elev) 90%, var(--accent)), var(--bg-elev));
  color: var(--text);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 12%, transparent);
  cursor: pointer;
  text-align: left;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &::after {
    position: absolute;
    inset: 0;
    content: '';
    background: linear-gradient(
      115deg,
      transparent 25%,
      color-mix(in srgb, var(--text) 12%, transparent) 50%,
      transparent 75%
    );
    transform: translateX(-120%);
    transition: transform 0.5s ease;
  }

  &:hover {
    border-color: var(--accent);
    box-shadow: 0 10px 28px color-mix(in srgb, var(--accent) 24%, transparent);
    transform: translateY(-2px);

    &::after {
      transform: translateX(120%);
    }
  }

  &:active {
    transform: translateY(0) scale(0.99);
  }
}

.welcome-create-playlist--acknowledged {
  animation: welcomeCreatePlaylistAcknowledged 0.34s ease-out;
}

@keyframes welcomeCreatePlaylistAcknowledged {
  0% {
    transform: scale(1);
  }

  45% {
    transform: scale(0.985);
  }

  100% {
    transform: scale(1);
  }
}

.welcome-create-playlist__icon {
  position: relative;
  z-index: 1;
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  place-items: center;
  border-radius: 8px;
  background: var(--accent);
  color: var(--bg);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent);

  svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
}

.welcome-create-playlist__copy {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.welcome-create-playlist__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}

.welcome-create-playlist__hint {
  overflow: hidden;
  color: var(--text-weak);
  font-size: 11px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.welcome-create-playlist-actions--horizontal {
  align-self: center;
  width: min(100%, 460px);

  .welcome-create-playlist {
    align-self: stretch;
    max-width: 220px;
    min-height: 40px;
    padding: 5px 8px;
    border-radius: 9px;
  }

  .welcome-create-playlist__icon {
    width: 24px;
    height: 24px;
    flex-basis: 24px;
    border-radius: 7px;
  }

  .welcome-create-playlist__title {
    font-size: 12px;
  }

  .welcome-create-playlist__hint {
    font-size: 10px;
  }
}
</style>
