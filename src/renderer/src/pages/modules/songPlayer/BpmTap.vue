<script setup lang="ts">
import { computed, ref, watch, useTemplateRef } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { formatBpmDisplay } from '@renderer/utils/bpm'
import {
  canTapBrowserPlayerRightTrackInfo,
  normalizeBrowserPlayerRightTrackInfo
} from '@shared/browserPlayerRightTrackInfo'
import { formatBrowserPlayerRightTrackInfoText } from '@renderer/utils/browserPlayerRightTrackInfoDisplay'
import { resolveSongListKeyDisplayStyle } from '@renderer/utils/songListFieldDisplay'

const props = defineProps<{
  song?: ISongInfo | null
  waveformShow: boolean
}>()

const isManual = ref(false)
const isTapActive = ref(false)
const manualBpm = ref<number | null>(null)
const tapTimestamps = ref<number[]>([])

const valueDomRef = useTemplateRef<HTMLSpanElement>('valueDomRef')
const runtime = useRuntimeStore()

const selectedField = computed(() =>
  normalizeBrowserPlayerRightTrackInfo(runtime.setting.browserPlayerRightTrackInfo)
)

const canTap = computed(() => canTapBrowserPlayerRightTrackInfo(selectedField.value))

const fieldDisplayOptions = computed(() => ({
  keyDisplayStyle: resolveSongListKeyDisplayStyle(runtime.setting.keyDisplayStyle),
  isDesktopRekordboxSong: props.song?.externalSourceKind === 'desktop'
}))

const fieldText = computed(() =>
  formatBrowserPlayerRightTrackInfoText(props.song, selectedField.value, fieldDisplayOptions.value)
)

const displayValue = computed<string>(() => {
  if (!isManual.value || manualBpm.value === null || !canTap.value) {
    return fieldText.value.displayText
  }
  const tappedBpm = formatBpmDisplay(manualBpm.value, '') || '-'
  if (selectedField.value === 'bpm') {
    return tappedBpm
  }
  const keyText = formatBrowserPlayerRightTrackInfoText(
    props.song,
    'key',
    fieldDisplayOptions.value
  ).displayText
  return `${tappedBpm} · ${keyText}`
})

const bubbleTitle = computed(() => fieldText.value.titleText || displayValue.value)

watch(
  () => [
    props.song?.filePath,
    props.song?.bpm,
    props.song?.beatGridMap,
    props.song?.key,
    selectedField.value
  ],
  () => {
    resetManual()
  }
)

const handleLeftClick = () => {
  if (!canTap.value) return
  isTapActive.value = true
  const now = Date.now()

  const last = tapTimestamps.value[tapTimestamps.value.length - 1]
  if (last && now - last > 2000) {
    tapTimestamps.value = []
  }

  tapTimestamps.value.push(now)

  if (tapTimestamps.value.length > 8) {
    tapTimestamps.value = tapTimestamps.value.slice(-8)
  }

  if (tapTimestamps.value.length >= 2) {
    const deltas: number[] = []
    for (let i = 1; i < tapTimestamps.value.length; i++) {
      const delta = tapTimestamps.value[i] - tapTimestamps.value[i - 1]
      if (delta > 50 && delta < 2000) {
        deltas.push(delta)
      }
    }

    if (deltas.length > 0) {
      const avgMs = deltas.reduce((a, b) => a + b, 0) / deltas.length
      const bpm = 60000 / avgMs
      manualBpm.value = Math.max(1, Math.min(999, Number(bpm.toFixed(6))))
      isManual.value = true
    }
  }
}

const handleRightClick = (e: MouseEvent) => {
  if (!canTap.value) return
  e.preventDefault()
  resetManual()
}

const resetManual = () => {
  isManual.value = false
  isTapActive.value = false
  manualBpm.value = null
  tapTimestamps.value = []
}
</script>

<template>
  <div
    v-show="waveformShow"
    class="unselectable bpm-tap"
    :class="{ 'is-manual': isManual, 'is-tappable': canTap }"
    @click.left="handleLeftClick"
    @contextmenu="handleRightClick"
  >
    <span ref="valueDomRef" class="bpm-tap__value">{{ displayValue }}</span>
  </div>
  <bubbleBox
    v-if="!isTapActive"
    :dom="valueDomRef || undefined"
    :title="bubbleTitle"
    :shortcut="canTap ? t('player.tapBeat') : ''"
    :max-width="250"
    :interactive="false"
    :only-when-overflow="true"
  />
</template>

<style scoped>
.bpm-tap {
  flex: 0 0 112px;
  width: 112px;
  min-width: 112px;
  max-width: 112px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  font-size: 16px;
  font-weight: bold;
}

.bpm-tap.is-tappable {
  cursor: pointer;
}

.bpm-tap.is-manual {
  color: var(--accent);
}

.bpm-tap__value {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}
</style>
