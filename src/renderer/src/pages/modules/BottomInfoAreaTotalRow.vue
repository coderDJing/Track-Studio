<script setup lang="ts">
import { rendererFilePathKey } from '@renderer/utils/filePathComparison'
import libraryUtils from '@renderer/utils/libraryUtils'

import { computed } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { i18n } from '@renderer/i18n'
import { type SongsAreaPaneKey, useRuntimeStore } from '@renderer/stores/runtime'
import { activateSongsAreaPane } from '@renderer/utils/songsAreaSplit'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { collectMissingAnalysisFilesFromSongs } from '@renderer/utils/manualKeyAnalysis'
import type { ISongInfo } from 'src/types/globals'

const runtime = useRuntimeStore()

const normalizeAnalysisPath = (value: string) => rendererFilePathKey(String(value || ''))

const isPioneerView = computed(() => runtime.libraryAreaSelected === 'PioneerDeviceLibrary')
const currentLocale = computed(() => i18n.global.locale.value)
const totalDurationLabel = computed(() => t('bottomInfo.totalDurationLabel'))
const selectedSongCount = computed(() =>
  isPioneerView.value
    ? runtime.pioneerSelectedRowKeys.filter(Boolean).length
    : runtime.songsArea.selectedSongFilePath.filter(Boolean).length
)
const selectedSongsText = computed(() =>
  t('bottomInfo.selectedSongs', {
    count: selectedSongCount.value,
    duration: selectedDurationText.value
  })
)
const splitLeftSelectedCount = computed(
  () => runtime.songsAreaPanels.panes.left.selectedSongFilePath.filter(Boolean).length
)
const splitRightSelectedCount = computed(
  () => runtime.songsAreaPanels.panes.right.selectedSongFilePath.filter(Boolean).length
)

const collectPendingAnalysisFiles = (songInfoArr: ISongInfo[]): string[] =>
  collectMissingAnalysisFilesFromSongs(
    songInfoArr,
    runtime.analysisRuntime.available === true,
    undefined,
    {
      includeSongStructure: true,
      missingWaveformFilePaths: runtime.songsArea?.missingWaveformFilePaths || []
    }
  )

const pendingAnalysisFiles = computed(() =>
  collectPendingAnalysisFiles(runtime.songsArea?.songInfoArr || [])
)
const pendingAnalysisCount = computed(() =>
  isPioneerView.value ? 0 : pendingAnalysisFiles.value.length
)
const manualPendingAnalysisPathSet = computed(
  () =>
    new Set(
      runtime.manualKeyAnalysisPendingFilePaths
        .map((filePath) => normalizeAnalysisPath(filePath))
        .filter(Boolean)
    )
)
const manualPendingAnalysisCount = computed(() => manualPendingAnalysisPathSet.value.size)
const pioneerPendingAnalysisCount = computed(() =>
  Math.max(0, Number(runtime.pioneerDeviceLibrary.pendingAnalysisCount) || 0)
)
const splitLeftPendingFiles = computed(() =>
  collectPendingAnalysisFiles(runtime.songsAreaPanels.panes.left.songInfoArr)
)
const splitRightPendingFiles = computed(() =>
  collectPendingAnalysisFiles(runtime.songsAreaPanels.panes.right.songInfoArr)
)
const splitLeftPendingCount = computed(() => splitLeftPendingFiles.value.length)
const splitRightPendingCount = computed(() => splitRightPendingFiles.value.length)
const resolveFirstPendingAnalysisFile = (songInfoArr: ISongInfo[], pendingFiles: string[]) => {
  const manualPathSet = manualPendingAnalysisPathSet.value
  if (manualPathSet.size > 0) {
    const manualSong = songInfoArr.find((song) => {
      if (song.fileMissing) return false
      const filePath = normalizeAnalysisPath(song.filePath)
      return Boolean(filePath && manualPathSet.has(filePath))
    })
    if (manualSong?.filePath) return manualSong.filePath
  }
  return pendingFiles[0] || ''
}
const firstPendingAnalysisFile = computed(() =>
  resolveFirstPendingAnalysisFile(runtime.songsArea.songInfoArr, pendingAnalysisFiles.value)
)
const firstSplitLeftPendingFile = computed(() =>
  resolveFirstPendingAnalysisFile(
    runtime.songsAreaPanels.panes.left.songInfoArr,
    splitLeftPendingFiles.value
  )
)
const firstSplitRightPendingFile = computed(() =>
  resolveFirstPendingAnalysisFile(
    runtime.songsAreaPanels.panes.right.songInfoArr,
    splitRightPendingFiles.value
  )
)
const firstPioneerPendingAnalysisFile = computed(() =>
  String(runtime.pioneerDeviceLibrary.firstPendingAnalysisFilePath || '').trim()
)
const displayPendingAnalysisCount = computed(() =>
  manualPendingAnalysisCount.value > 0
    ? manualPendingAnalysisCount.value
    : pendingAnalysisCount.value
)
const displayPioneerPendingAnalysisCount = computed(() =>
  manualPendingAnalysisCount.value > 0
    ? manualPendingAnalysisCount.value
    : pioneerPendingAnalysisCount.value
)
const hasTotalRowContent = computed(() => {
  if (manualPendingAnalysisCount.value > 0) return true
  if (isPioneerView.value) {
    return selectedSongCount.value > 0 || pioneerPendingAnalysisCount.value > 0
  }
  if (runtime.songsAreaPanels.splitEnabled) {
    return (
      runtime.songsAreaPanels.panes.left.songInfoArr.length > 0 ||
      runtime.songsAreaPanels.panes.right.songInfoArr.length > 0
    )
  }
  return Boolean(runtime.songsArea.songListUUID && runtime.songsArea.songInfoArr.length > 0)
})
const focusPendingAnalysisSong = (
  pane: SongsAreaPaneKey | 'pioneer',
  filePath: string,
  songListUUID = ''
) => {
  const targetFilePath = String(filePath || '').trim()
  if (!targetFilePath) return
  if (pane !== 'pioneer') {
    activateSongsAreaPane(runtime, pane)
  }
  emitter.emit('songsArea/focus-song', {
    pane,
    songListUUID,
    filePath: targetFilePath,
    flash: true,
    waitForListStabilize: false
  })
}
const focusSplitPendingAnalysisSong = (pane: Extract<SongsAreaPaneKey, 'left' | 'right'>) => {
  const paneState = runtime.songsAreaPanels.panes[pane]
  const filePath =
    pane === 'left' ? firstSplitLeftPendingFile.value : firstSplitRightPendingFile.value
  focusPendingAnalysisSong(pane, filePath, paneState.songListUUID)
}
function formatDurationUnit(unit: 'day' | 'hour' | 'minute' | 'second', count: number): string {
  const pluralKey = count === 1 ? 'one' : 'other'
  return t(`bottomInfo.durationUnits.${unit}.${pluralKey}`, { count })
}

const sumDurations = (durations: string[]) =>
  durations.reduce((total, duration) => {
    const parts = String(duration || '').split(':')
    if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part))) return total
    return total + Number(parts[0]) * 60 + Number(parts[1])
  }, 0)

const formatTotalDuration = (total: number) => {
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const segments: string[] = []
  if (days > 0) segments.push(formatDurationUnit('day', days))
  segments.push(formatDurationUnit('hour', hours))
  segments.push(formatDurationUnit('minute', minutes))
  segments.push(formatDurationUnit('second', seconds))
  return segments.join(currentLocale.value === 'zh-CN' ? '' : ' ')
}

const selectedDuration = (songs: ISongInfo[], keys: string[], songListUUID: string) => {
  const selected = new Set(keys.filter(Boolean))
  const listType = libraryUtils.getLibraryTreeByUUID(songListUUID)?.type
  return sumDurations(
    songs
      .filter((song) => {
        const key =
          listType === 'mixtapeList' && song.mixtapeItemId
            ? song.mixtapeItemId
            : listType === 'setList' && song.setItemId
              ? song.setItemId
              : song.filePath
        return selected.has(key)
      })
      .map((song) => song.duration)
  )
}
const selectedDurationText = computed(() =>
  formatTotalDuration(
    isPioneerView.value
      ? sumDurations(runtime.pioneerSelectedDurations)
      : selectedDuration(
          runtime.songsArea.songInfoArr,
          runtime.songsArea.selectedSongFilePath,
          runtime.songsArea.songListUUID
        )
  )
)
const splitSelectedDurationText = (pane: 'left' | 'right') => {
  const state = runtime.songsAreaPanels.panes[pane]
  return formatTotalDuration(
    selectedDuration(state.songInfoArr, state.selectedSongFilePath, state.songListUUID)
  )
}
const playlistTotalDaysHoursSeconds = computed(() =>
  formatTotalDuration(sumDurations(runtime.songsArea.songInfoArr.map((song) => song.duration)))
)
</script>

<template>
  <div v-if="hasTotalRowContent" class="total-row">
    <template v-if="!isPioneerView && runtime.songsAreaPanels.splitEnabled">
      <div v-if="splitLeftSelectedCount > 0" class="selected-count-text">
        {{
          t('bottomInfo.selectedSongsLeft', {
            count: splitLeftSelectedCount,
            duration: splitSelectedDurationText('left')
          })
        }}
      </div>
      <div v-if="splitRightSelectedCount > 0" class="selected-count-text">
        {{
          t('bottomInfo.selectedSongsRight', {
            count: splitRightSelectedCount,
            duration: splitSelectedDurationText('right')
          })
        }}
      </div>
    </template>
    <div v-else-if="selectedSongCount > 0" class="selected-count-text">{{ selectedSongsText }}</div>
    <template
      v-if="
        !isPioneerView && runtime.songsAreaPanels.splitEnabled && manualPendingAnalysisCount <= 0
      "
    >
      <bubbleBoxTrigger
        v-if="splitLeftPendingCount > 0"
        tag="button"
        type="button"
        class="selected-count-text pending-analysis-button"
        :title="t('bottomInfo.locatePendingAnalysis')"
        :aria-label="t('bottomInfo.locatePendingAnalysis')"
        @click="focusSplitPendingAnalysisSong('left')"
      >
        {{ t('bottomInfo.pendingAnalysisLeft', { count: splitLeftPendingCount }) }}
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        v-if="splitRightPendingCount > 0"
        tag="button"
        type="button"
        class="selected-count-text pending-analysis-button"
        :title="t('bottomInfo.locatePendingAnalysis')"
        :aria-label="t('bottomInfo.locatePendingAnalysis')"
        @click="focusSplitPendingAnalysisSong('right')"
      >
        {{ t('bottomInfo.pendingAnalysisRight', { count: splitRightPendingCount }) }}
      </bubbleBoxTrigger>
    </template>
    <template v-else-if="isPioneerView">
      <bubbleBoxTrigger
        v-if="displayPioneerPendingAnalysisCount > 0"
        tag="button"
        type="button"
        class="selected-count-text pending-analysis-button"
        :title="t('bottomInfo.locatePendingAnalysis')"
        :aria-label="t('bottomInfo.locatePendingAnalysis')"
        @click="focusPendingAnalysisSong('pioneer', firstPioneerPendingAnalysisFile)"
      >
        {{ t('bottomInfo.pendingAnalysis', { count: displayPioneerPendingAnalysisCount }) }}
      </bubbleBoxTrigger>
    </template>
    <template v-else>
      <bubbleBoxTrigger
        v-if="displayPendingAnalysisCount > 0"
        tag="button"
        type="button"
        class="selected-count-text pending-analysis-button"
        :title="t('bottomInfo.locatePendingAnalysis')"
        :aria-label="t('bottomInfo.locatePendingAnalysis')"
        @click="
          focusPendingAnalysisSong(
            runtime.songsAreaPanels.splitEnabled ? runtime.songsAreaPanels.activePane : 'single',
            firstPendingAnalysisFile,
            runtime.songsArea.songListUUID
          )
        "
      >
        {{ t('bottomInfo.pendingAnalysis', { count: displayPendingAnalysisCount }) }}
      </bubbleBoxTrigger>
    </template>
    <div v-if="!isPioneerView" class="total-text">
      {{ totalDurationLabel }}{{ playlistTotalDaysHoursSeconds }}
    </div>
  </div>
</template>
<style lang="scss" scoped src="./BottomInfoAreaTotalRow.scss"></style>
