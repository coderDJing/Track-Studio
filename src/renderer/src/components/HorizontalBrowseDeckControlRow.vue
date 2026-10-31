<script setup lang="ts">
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseTransportBandState } from '@shared/horizontalBrowseTransport'
import HorizontalBrowseDeckBandControls from '@renderer/components/HorizontalBrowseDeckBandControls.vue'
import HorizontalBrowseDeckButtons from '@renderer/components/HorizontalBrowseDeckButtons.vue'

const props = defineProps<{
  deck: HorizontalBrowseDeckKey
  playing: boolean
  decoding: boolean
  pendingPlay: boolean
  pendingCue: boolean
  cueActive: boolean
  bandsVisible: boolean
  bands: HorizontalBrowseTransportBandState
  songPresent: boolean
  cueMonitorEnabled: boolean
  disabled?: boolean
  showCue?: boolean
}>()

const emit = defineEmits<{
  (event: 'cue-pointer-down', pointerEvent: PointerEvent): void
  (event: 'cue-click'): void
  (event: 'play-toggle'): void
  (
    event: 'toggle-band',
    deck: HorizontalBrowseDeckKey,
    band: keyof HorizontalBrowseTransportBandState
  ): void
  (event: 'toggle-cue-monitor', deck: HorizontalBrowseDeckKey): void
}>()

const handleToggleBand = (
  deck: HorizontalBrowseDeckKey,
  band: keyof HorizontalBrowseTransportBandState
) => {
  emit('toggle-band', deck, band)
}
</script>

<template>
  <div class="deck-control-row">
    <HorizontalBrowseDeckButtons
      :deck="props.deck"
      :playing="props.playing"
      :decoding="props.decoding"
      :pending-play="props.pendingPlay"
      :pending-cue="props.pendingCue"
      :cue-active="props.cueActive"
      :disabled="props.disabled || !props.songPresent"
      :show-cue="props.showCue"
      @cue-pointer-down="emit('cue-pointer-down', $event)"
      @cue-click="emit('cue-click')"
      @play-toggle="emit('play-toggle')"
    />
    <HorizontalBrowseDeckBandControls
      v-if="props.bandsVisible"
      :deck="props.deck"
      :bands="props.bands"
      :cue-monitor-enabled="props.cueMonitorEnabled"
      :cue-monitor-disabled="!props.songPresent"
      @toggle-band="handleToggleBand"
      @toggle-cue-monitor="emit('toggle-cue-monitor', $event)"
    />
  </div>
</template>

<style scoped lang="scss">
.deck-control-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  align-items: stretch;
  min-width: 0;
  min-height: 0;
}
</style>
