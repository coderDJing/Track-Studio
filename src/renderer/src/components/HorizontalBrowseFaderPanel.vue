<script setup lang="ts">
import { computed, toRef } from 'vue'
import type { CSSProperties } from 'vue'
import { useHorizontalBrowseOutput } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseOutput'
import { t } from '@renderer/utils/translate'

type HorizontalBrowseOutputTransport = {
  state: {
    output?: {
      crossfaderValue?: number
      masterGain?: number
    }
  }
  setOutputState: (crossfaderValue: number, masterGain: number) => Promise<unknown>
}

type FaderTick = {
  id: number
  top: string
  major: boolean
  center: boolean
}

const props = defineProps<{
  nativeTransport: HorizontalBrowseOutputTransport
  mainWindowVolume: number
  expanded: boolean
  transportSyncEnabled: boolean
  transportSyncDisabled: boolean
}>()

const emit = defineEmits<{
  (event: 'update:expanded', value: boolean): void
  (event: 'toggle-transport-sync'): void
}>()

const mainWindowVolumeRef = toRef(props, 'mainWindowVolume')

const {
  faderRef,
  faderRailRef,
  faderTicks,
  faderThumbStyle,
  faderDragging,
  syncCrossfaderValue,
  handleFaderPointerDown,
  handleFaderDoubleClick,
  nudgeCrossfaderByKeyboard,
  resetCrossfaderByKeyboard
} = useHorizontalBrowseOutput({
  nativeTransport: props.nativeTransport,
  mainWindowVolume: mainWindowVolumeRef
})

const resolvedFaderTicks = computed(() => faderTicks as FaderTick[])
const resolvedFaderThumbStyle = computed(() => faderThumbStyle.value as CSSProperties)

const togglePanelExpanded = () => {
  emit('update:expanded', !props.expanded)
}

defineExpose({
  syncCrossfaderValue,
  nudgeCrossfaderByKeyboard,
  resetCrossfaderByKeyboard
})
</script>

<template>
  <div class="fader-panel" :class="{ 'is-expanded': props.expanded }">
    <div
      ref="faderRef"
      class="fader"
      :class="{ 'is-dragging': faderDragging }"
      @pointerdown="handleFaderPointerDown"
      @dblclick.prevent="handleFaderDoubleClick"
    >
      <div class="fader__scale">
        <div class="fader__scale-inner">
          <span
            v-for="tick in resolvedFaderTicks"
            :key="`left-${tick.id}`"
            class="fader__tick"
            :class="{ 'is-major': tick.major, 'is-center': tick.center }"
            :style="{ top: tick.top }"
          ></span>
        </div>
      </div>
      <div ref="faderRailRef" class="fader__rail">
        <div class="fader__slot"></div>
        <div class="fader__thumb" :style="resolvedFaderThumbStyle"></div>
      </div>
      <div class="fader__scale">
        <div class="fader__scale-inner">
          <span
            v-for="tick in resolvedFaderTicks"
            :key="`right-${tick.id}`"
            class="fader__tick"
            :class="{ 'is-major': tick.major, 'is-center': tick.center }"
            :style="{ top: tick.top }"
          ></span>
        </div>
      </div>
    </div>

    <button
      class="fader-panel__toggle"
      type="button"
      :aria-expanded="props.expanded"
      :aria-label="
        t(props.expanded ? 'horizontalBrowse.collapseFaderPanel' : 'horizontalBrowse.expandFaderPanel')
      "
      @click.stop="togglePanelExpanded"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" :class="{ 'is-flipped': props.expanded }">
        <path
          d="M6.5 4L10 8l-3.5 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <div
      v-if="props.expanded"
      class="fader-panel__sync-slot"
      data-user-guide-target="horizontal-link"
    >
      <button
        class="fader-panel__sync-button"
        :class="{ 'is-active': props.transportSyncEnabled }"
        type="button"
        :disabled="props.transportSyncDisabled"
        :aria-pressed="props.transportSyncEnabled"
        :aria-label="
          t(
            props.transportSyncEnabled
              ? 'horizontalBrowse.transportSyncOn'
              : 'horizontalBrowse.transportSyncOff'
          )
        "
        @click.stop="emit('toggle-transport-sync')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.fader-panel {
  position: relative;
  display: grid;
  grid-template-columns: 52px 16px;
  align-items: stretch;
  min-height: 0;
  padding: 2px 0;
  box-sizing: border-box;
  overflow: hidden;
  z-index: 60;
}

.fader-panel.is-expanded {
  grid-template-columns: 52px 16px minmax(0, 1fr);
}

.fader {
  display: grid;
  grid-template-columns: 6px 24px 6px;
  justify-content: center;
  align-items: stretch;
  min-height: 0;
  column-gap: 2px;
  box-sizing: border-box;
  touch-action: none;
}

.fader__scale {
  position: relative;
  min-height: 0;
}

.fader__scale-inner {
  position: absolute;
  inset: 0;
}

.fader__tick {
  position: absolute;
  top: 0;
  left: 50%;
  width: 4px;
  height: 1px;
  border-radius: 999px;
  background: var(--shell-grid);
  transform: translate(-50%, -50%);
}

.fader__tick.is-major {
  width: 6px;
  background: var(--shell-grid-major);
}

.fader__tick.is-center {
  width: 6px;
  height: 2px;
  background: var(--text);
}

.fader__rail {
  position: relative;
  min-height: 0;
}

.fader__slot {
  position: absolute;
  top: var(--fader-travel-inset);
  bottom: var(--fader-travel-inset);
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: var(--shell-grid-major);
}

.fader__thumb {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 26px;
  height: 4px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--shell-border);
  border-radius: 999px;
  background-color: var(--text);
  transition:
    top 0.08s ease,
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;
}

.fader__thumb:hover,
.fader.is-dragging .fader__thumb {
  border-color: color-mix(in srgb, var(--accent) 72%, var(--border));
  background-color: color-mix(in srgb, var(--accent) 88%, var(--bg));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
}

.fader.is-dragging .fader__thumb {
  transition: none;
}

.fader-panel__toggle {
  align-self: center;
  justify-self: center;
  width: 14px;
  height: 48px;
  padding: 0;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  cursor: pointer;
}

.fader-panel__toggle svg {
  width: 12px;
  height: 12px;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.fader-panel__toggle svg.is-flipped {
  transform: rotate(180deg);
}

.fader-panel__toggle:hover {
  background: color-mix(in srgb, var(--text-weak) 12%, transparent);
  color: var(--text);
}

.fader-panel.is-expanded .fader-panel__toggle {
  color: var(--accent);
}

.fader-panel.is-expanded .fader-panel__toggle:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.fader-panel__sync-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.fader-panel__sync-button {
  justify-self: center;
  width: 32px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--shell-border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--shell-panel) 86%, var(--bg-elev));
  color: var(--text-weak);
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.1s ease;
}

.fader-panel__sync-button svg {
  width: 14px;
  height: 14px;
}

.fader-panel__sync-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--text-weak) 42%, var(--shell-border));
  color: var(--text);
}

.fader-panel__sync-button.is-active {
  border-color: var(--shell-active-control-border);
  background: var(--shell-active-control-bg);
  color: var(--shell-active-control-text);
  box-shadow:
    0 0 0 1px var(--shell-active-control-outline),
    inset 0 1px 0 var(--shell-active-control-inset);
}

.fader-panel__sync-button:disabled {
  cursor: default;
  opacity: 0.45;
}
</style>
