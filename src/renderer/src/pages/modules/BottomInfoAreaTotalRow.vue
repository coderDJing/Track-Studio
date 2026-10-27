<script setup lang="ts">
import { rendererFilePathKey } from '@renderer/utils/filePathComparison'

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
  t('bottomInfo.selectedSongs', { count: selectedSongCount.value })
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

const playlistTotalDaysHoursSeconds = computed(() => {
  const list = (runtime.songsArea?.songInfoArr || []) as Array<{ duration?: string }>
  let total = 0
  for (const s of list) {
    const mmss = String(s?.duration || '')
    const parts = mmss.split(':')
    if (parts.length === 2) {
      const m = Number(parts[0])
      const sec = Number(parts[1])
      if (!Number.isNaN(m) && !Number.isNaN(sec)) {
        total += m * 60 + sec
      }
    }
  }
  const days = Math.floor(total / 86400)
  const afterDays = total % 86400
  const hours = Math.floor(afterDays / 3600)
  const afterHours = afterDays % 3600
  const minutes = Math.floor(afterHours / 60)
  const seconds = afterHours % 60
  const joiner = currentLocale.value === 'zh-CN' ? '' : ' '
  const segments: string[] = []
  if (days > 0) {
    segments.push(formatDurationUnit('day', days))
  }
  segments.push(formatDurationUnit('hour', hours))
  segments.push(formatDurationUnit('minute', minutes))
  segments.push(formatDurationUnit('second', seconds))
  return segments.join(joiner)
})
</script>

<template>
  <div v-if="hasTotalRowContent" class="total-row">
    <template v-if="!isPioneerView && runtime.songsAreaPanels.splitEnabled">
      <div v-if="splitLeftSelectedCount > 0" class="selected-count-text">
        {{ t('bottomInfo.selectedSongsLeft', { count: splitLeftSelectedCount }) }}
      </div>
      <div v-if="splitRightSelectedCount > 0" class="selected-count-text">
        {{ t('bottomInfo.selectedSongsRight', { count: splitRightSelectedCount }) }}
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
