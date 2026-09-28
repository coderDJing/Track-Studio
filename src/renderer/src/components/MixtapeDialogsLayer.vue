<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import MixtapeOutputDialog from '@renderer/components/mixtapeOutputDialog.vue'
import MixtapeBeatAlignDialog from '@renderer/components/MixtapeBeatAlignDialog.vue'
import ColumnHeaderContextMenu from '@renderer/pages/modules/songsArea/ColumnHeaderContextMenu.vue'
import SongListHeader from '@renderer/pages/modules/songsArea/SongListHeader.vue'
import SongListRows from '@renderer/pages/modules/songsArea/SongListRows.vue'
import { useColumnDragPreview } from '@renderer/pages/modules/songsArea/composables/useColumnDragPreview'
import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import type { ISongInfo, ISongsAreaColumn } from 'src/types/globals'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const emit = defineEmits<{
  (event: 'update:autoGainColumnMenuVisible', value: boolean): void
}>()

const autoGainSongListScrollRef = ref<OverlayScrollbarsComponentRef>(null)
const resolveMixtapeTrackBeatGridMapV2 = (track: MixtapeTrack) =>
  normalizeSongBeatGridMapV2(track.beatGridMap, { allowSingleClip: true })
type BeatAlignGridPayload = {
  beatGridMap: MixtapeTrack['beatGridMap']
}

type OutputDialogPayload = {
  outputPath: string
  outputFormat: 'wav' | 'mp3'
  outputFilename: string
}
const props = defineProps<{
  t: (key: string, payload?: Record<string, unknown>) => string
  transportPreloading: boolean
  transportPreloadDone: number
  transportPreloadTotal: number
  transportPreloadPercent: number
  stemSeparationProgressVisible: boolean
  stemSeparationProgressPercent: number
  stemSeparationProgressText: string
  stemSeparationRunningProgressLines: string[]
  bpmAnalysisActive: boolean
  bpmAnalysisFailed: boolean
  bpmAnalysisFailedCount: number
  bpmAnalysisFailedReason: string
  retryBpmAnalysis: () => void
  dismissBpmAnalysisFailure: () => void
  autoGainBusy: boolean
  autoGainDialogVisible: boolean
  autoGainProgressText: string
  outputRunning: boolean
  outputProgressText: string
  outputProgressPercent: number
  autoGainReferenceFeedback: string
  autoGainDialogColumns: ISongsAreaColumn[]
  autoGainSongColumns: ISongsAreaColumn[]
  autoGainSongTotalWidth: number
  autoGainDialogSongs: ISongInfo[]
  autoGainSelectedRowKeys: string[]
  autoGainColumnMenuVisible: boolean
  autoGainColumnMenuEvent: MouseEvent | null
  autoGainHeaderTranslate: (key: string) => string
  ascendingOrder: string
  descendingOrder: string
  mixtapePlaylistId: string
  handleAutoGainColumnsUpdate: (columns: ISongsAreaColumn[]) => void
  handleAutoGainColumnClick: (...args: unknown[]) => void
  handleAutoGainHeaderContextMenu: (...args: unknown[]) => void
  handleAutoGainToggleColumnVisibility: (...args: unknown[]) => void
  handleAutoGainSongClick: (...args: unknown[]) => void
  handleAutoGainSongDragStart: (...args: unknown[]) => void
  handleAutoGainSelectLoudestReferenceClick: () => void
  handleAutoGainSelectQuietestReferenceClick: () => void
  handleAutoGainDialogCancelClick: () => void
  handleAutoGainDialogConfirmClick: () => void
  autoGainReferenceTrackId: string
  outputDialogVisible: boolean
  outputPath: string
  outputFormat: 'wav' | 'mp3'
  outputFilename: string
  handleOutputDialogConfirm: (payload: OutputDialogPayload) => void
  handleOutputDialogCancel: () => void
  handleOutputCancelRunning: () => void
  trackContextMenuVisible: boolean
  trackContextMenuStyle: Record<string, string>
  handleTrackMenuAdjustGrid: () => void
  handleTrackMenuToggleMasterTempo: () => void
  handleTrackMenuRemoveFromMixtape: () => void
  trackMenuMasterTempoChecked: boolean
  beatAlignDialogVisible: boolean
  beatAlignTrack: MixtapeTrack | null
  beatAlignWindowVolume: number
  resolveTrackTitle: (track: MixtapeTrack) => string
  handleBeatAlignGridDefinitionSave: (payload: BeatAlignGridPayload) => void
  handleBeatAlignDialogCancel: () => void
}>()

const { rowsVisibleColumns: autoGainRowsVisibleColumns, handleColumnDragPreview } =
  useColumnDragPreview(toRef(props, 'autoGainSongColumns'))

const autoGainColumnMenuVisibleModel = computed({
  get: () => props.autoGainColumnMenuVisible,
  set: (value: boolean) => emit('update:autoGainColumnMenuVisible', value)
})
</script>

<template>
  <div v-if="transportPreloading" class="mixtape-decode-mask">
    <div class="bpm-loading-card">
      <div class="bpm-loading-title">{{ t('mixtape.transportPreloading') }}</div>
      <div class="bpm-loading-sub">{{ t('mixtape.transportPreloadingHint') }}</div>
      <div class="bpm-loading-sub">
        {{
          t('mixtape.transportPreloadingProgress', {
            done: transportPreloadDone,
            total: transportPreloadTotal,
            percent: transportPreloadPercent
          })
        }}
      </div>
    </div>
  </div>
  <div v-if="bpmAnalysisActive" class="mixtape-bpm-mask">
    <div class="bpm-loading-card">
      <div class="bpm-loading-title">{{ t('mixtape.bpmAnalyzing') }}</div>
      <div class="bpm-loading-sub">{{ t('mixtape.bpmAnalyzingHint') }}</div>
    </div>
  </div>
  <div v-else-if="bpmAnalysisFailed" class="mixtape-bpm-failed">
    <div class="bpm-loading-card is-error">
      <div class="bpm-loading-title">{{ t('mixtape.bpmAnalyzeFailed') }}</div>
      <div class="bpm-loading-sub">
        {{ t('mixtape.bpmAnalyzeFailedHint', { count: bpmAnalysisFailedCount }) }}
      </div>
      <div v-if="bpmAnalysisFailedReason" class="bpm-loading-sub">
        {{ t('mixtape.bpmAnalyzeFailedReasonHint', { reason: bpmAnalysisFailedReason }) }}
      </div>
      <div class="bpm-loading-actions">
        <div
          class="button bpm-loading-action-btn"
          role="button"
          tabindex="0"
          @click="retryBpmAnalysis"
        >
          {{ t('common.retry') }}
        </div>
        <div
          class="button bpm-loading-action-btn"
          role="button"
          tabindex="0"
          @click="dismissBpmAnalysisFailure"
        >
          {{ t('common.close') }}
        </div>
      </div>
    </div>
  </div>
  <div v-if="autoGainBusy && !autoGainDialogVisible" class="mixtape-auto-gain-mask">
    <div class="bpm-loading-card">
      <div class="bpm-loading-title">{{ t('mixtape.autoGainRunning') }}</div>
      <div class="bpm-loading-sub">{{ autoGainProgressText }}</div>
    </div>
  </div>
  <div v-if="outputRunning" class="mixtape-output-mask">
    <div class="bpm-loading-card">
      <div class="bpm-loading-title">{{ t('mixtape.outputRunning') }}</div>
      <div class="bpm-loading-sub">{{ outputProgressText }}</div>
      <div class="preload-bar">
        <div class="preload-bar__fill" :style="{ width: `${outputProgressPercent}%` }"></div>
      </div>
      <div class="bpm-loading-actions">
        <button type="button" class="bpm-loading-action-btn" @click="handleOutputCancelRunning">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
  </div>
  <div v-if="autoGainDialogVisible" class="mixtape-auto-gain-dialog">
    <div class="mixtape-auto-gain-dialog__card">
      <div class="mixtape-auto-gain-dialog__title">{{ t('mixtape.autoGainDialogTitle') }}</div>
      <div class="mixtape-auto-gain-dialog__hint">{{ t('mixtape.autoGainDialogHint') }}</div>
      <div v-if="autoGainReferenceFeedback" class="mixtape-auto-gain-dialog__feedback">
        {{ autoGainReferenceFeedback }}
      </div>
      <div class="mixtape-auto-gain-dialog__song-list-host">
        <OverlayScrollbarsComponent
          ref="autoGainSongListScrollRef"
          class="mixtape-auto-gain-dialog__songs-scroll"
          :options="{
            scrollbars: {
              autoHide: 'leave' as const,
              autoHideDelay: 50,
              clickScroll: true
            } as const,
            overflow: {
              x: 'scroll',
              y: 'scroll'
            } as const
          }"
          element="div"
          defer
        >
          <SongListHeader
            :columns="autoGainDialogColumns"
            :t="autoGainHeaderTranslate"
            :ascending-order="ascendingOrder"
            :descending-order="descendingOrder"
            :total-width="autoGainSongTotalWidth"
            @update:columns="handleAutoGainColumnsUpdate"
            @columns-preview="handleColumnDragPreview"
            @column-click="handleAutoGainColumnClick"
            @header-contextmenu="handleAutoGainHeaderContextMenu"
          />
          <div class="mixtape-auto-gain-dialog__song-list">
            <SongListRows
              :songs="autoGainDialogSongs"
              :visible-columns="autoGainRowsVisibleColumns"
              :selected-song-file-paths="autoGainSelectedRowKeys"
              :total-width="autoGainSongTotalWidth"
              source-library-name="mixtape-auto-gain"
              :source-song-list-u-u-i-d="mixtapePlaylistId"
              :scroll-host-element="autoGainSongListScrollRef?.osInstance()?.elements().viewport"
              song-list-root-dir=""
              @song-click="handleAutoGainSongClick"
              @song-dragstart="handleAutoGainSongDragStart"
            />
          </div>
        </OverlayScrollbarsComponent>
        <ColumnHeaderContextMenu
          v-model="autoGainColumnMenuVisibleModel"
          :target-event="autoGainColumnMenuEvent"
          :columns="autoGainDialogColumns"
          :scroll-host-element="autoGainSongListScrollRef?.osInstance()?.elements().host"
          @toggle-column-visibility="handleAutoGainToggleColumnVisibility"
        />
      </div>
      <div class="mixtape-auto-gain-dialog__actions">
        <button
          type="button"
          :disabled="autoGainBusy || autoGainDialogSongs.length < 2"
          @click="handleAutoGainSelectLoudestReferenceClick"
        >
          {{ t('mixtape.autoGainSelectLoudestAction') }}
        </button>
        <button
          type="button"
          :disabled="autoGainBusy || autoGainDialogSongs.length < 2"
          @click="handleAutoGainSelectQuietestReferenceClick"
        >
          {{ t('mixtape.autoGainSelectQuietestAction') }}
        </button>
        <button type="button" :disabled="autoGainBusy" @click="handleAutoGainDialogCancelClick">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          :disabled="autoGainBusy || !autoGainReferenceTrackId"
          @click="handleAutoGainDialogConfirmClick"
        >
          {{ t('common.confirm') }}
        </button>
      </div>
      <div v-if="autoGainBusy" class="mixtape-auto-gain-dialog__busy-mask">
        <div class="bpm-loading-card">
          <div class="bpm-loading-title">{{ t('mixtape.autoGainRunning') }}</div>
          <div class="bpm-loading-sub">{{ autoGainProgressText }}</div>
        </div>
      </div>
    </div>
  </div>
  <MixtapeOutputDialog
    v-if="outputDialogVisible"
    :output-path="outputPath"
    :output-format="outputFormat"
    :output-filename="outputFilename"
    @confirm="handleOutputDialogConfirm"
    @cancel="handleOutputDialogCancel"
  />
  <div
    v-if="trackContextMenuVisible"
    data-frkb-context-menu="true"
    class="mixtape-track-menu"
    :style="trackContextMenuStyle"
    @contextmenu.stop.prevent
  >
    <button class="mixtape-track-menu__item" type="button" @click="handleTrackMenuAdjustGrid">
      {{ t('mixtape.adjustGridMenu') }}
    </button>
    <button
      class="mixtape-track-menu__item"
      type="button"
      @click="handleTrackMenuToggleMasterTempo"
    >
      <span class="mixtape-track-menu__check">{{ trackMenuMasterTempoChecked ? '✓' : '' }}</span>
      <span>{{ t('mixtape.masterTempoMenu') }}</span>
    </button>
    <button
      class="mixtape-track-menu__item"
      type="button"
      @click="handleTrackMenuRemoveFromMixtape"
    >
      {{ t('mixtape.removeFromPlaylistMenu') }}
    </button>
  </div>
  <MixtapeBeatAlignDialog
    v-if="beatAlignDialogVisible && beatAlignTrack"
    :track-title="resolveTrackTitle(beatAlignTrack)"
    :track-key="beatAlignTrack.key"
    :file-path="beatAlignTrack.filePath"
    :bpm="
      Number(beatAlignTrack.gridBaseBpm) ||
      Number(beatAlignTrack.originalBpm) ||
      Number(beatAlignTrack.bpm) ||
      128
    "
    :first-beat-ms="Number(beatAlignTrack.firstBeatMs) || 0"
    :time-basis-offset-ms="Number(beatAlignTrack.timeBasisOffsetMs) || 0"
    :downbeat-beat-offset="Number(beatAlignTrack.downbeatBeatOffset) || 0"
    :beat-grid-map="resolveMixtapeTrackBeatGridMapV2(beatAlignTrack)"
    :window-volume="beatAlignWindowVolume"
    @save-grid-definition="handleBeatAlignGridDefinitionSave"
    @cancel="handleBeatAlignDialogCancel"
  />
</template>

<style scoped lang="scss" src="./MixtapeDialogsLayer.scss"></style>
