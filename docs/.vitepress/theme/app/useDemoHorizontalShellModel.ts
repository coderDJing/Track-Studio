// 官网首屏双轨演示的状态模型。
// 应用里这些状态来自主进程音频传输（horizontalBrowseNativeTransport）和一串 composable；
// 官网没有音频，这里提供同形状的演示值，交给应用原版的 HorizontalBrowseModeShellWaveformStack 渲染。
// 行为约束：两轨同步按 128 BPM 播放、交叉推子固定居中、Deck A 为 Master、Deck B 开 Beat Sync。
import { computed, reactive, ref } from 'vue'
import { withBase } from 'vitepress'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseModeShellWaveformStackModel } from '@renderer/components/horizontalBrowseModeShellWaveformStackTypes'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import {
  createDefaultDeckToolbarState,
  createDefaultSharedDetailZoomState,
  type SharedDetailZoomState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseModeShellTypes'
import { resolveHorizontalBrowseDeckToolbarPresentation } from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckToolbarPresentation'
import { HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { useHorizontalBrowseWaveformPresentationCoordinator } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import { createEmptyHorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'
import { formatBpmDisplay } from '@renderer/utils/bpm'
import { installDemoIpc, registerDemoUnifiedWaveform } from './demoIpc'
import { DEMO_TRACKS, loadDemoUnifiedWaveforms } from './demoSongs'

type DeckKey = HorizontalBrowseDeckKey
type Model = HorizontalBrowseModeShellWaveformStackModel

const DECKS: DeckKey[] = ['top', 'bottom']
const noop = () => {}
const asyncNoop = async () => {}

export const useDemoHorizontalShellModel = () => {
  const [topTrack, bottomTrack] = DEMO_TRACKS
  // 波形数据加载完成前先不给歌曲，避免组件用空数据发起一次加载
  const topDeckSong = ref<ISongInfo | null>(null)
  const bottomDeckSong = ref<ISongInfo | null>(null)
  const positions = reactive<Record<DeckKey, number>>({
    top: topTrack.startSec,
    bottom: bottomTrack.startSec
  })
  const dragSession = reactive({
    active: false,
    source: 'top' as DeckKey,
    start: { top: positions.top, bottom: positions.bottom },
    anchors: { top: positions.top, bottom: positions.bottom }
  })
  const playing = ref(false)
  const playbackSyncRevision = reactive<Record<DeckKey, number>>({ top: 0, bottom: 0 })

  // 传输快照：Deck A 为 Master，两轨都开 Beat Sync
  const transportState = reactive(createEmptyHorizontalBrowseTransportSnapshot())
  transportState.leaderDeck = 'top'
  transportState.output.crossfaderValue = 0
  const faderTransport = {
    state: transportState,
    setOutputState: async (_crossfaderValue: number, masterGain: number) => {
      transportState.output.crossfaderValue = 0
      transportState.output.masterGain = masterGain
    }
  }
  const deckBandState = reactive({
    top: { high: true, mid: true, low: true },
    bottom: { high: true, mid: true, low: true }
  })

  const sharedDetailZoomState = ref<SharedDetailZoomState>(
    createDefaultSharedDetailZoomState(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
  )
  const editDetailZoomState = ref<SharedDetailZoomState>(
    createDefaultSharedDetailZoomState(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
  )
  const toolbarStates = reactive<Record<DeckKey, ReturnType<typeof createDefaultDeckToolbarState>>>(
    {
      top: createDefaultDeckToolbarState(),
      bottom: createDefaultDeckToolbarState()
    }
  )
  const waveformPresentation = useHorizontalBrowseWaveformPresentationCoordinator()
  const deckQuantizeEnabled = reactive<Record<DeckKey, boolean>>({ top: true, bottom: true })
  const deckSeekIntent = reactive<Record<DeckKey, { seconds: number; revision: number }>>({
    top: { seconds: topTrack.startSec, revision: 0 },
    bottom: { seconds: bottomTrack.startSec, revision: 0 }
  })

  const resolveSong = (deck: DeckKey) => (deck === 'top' ? topDeckSong.value : bottomDeckSong.value)
  const resolveTrack = (deck: DeckKey) => (deck === 'top' ? topTrack : bottomTrack)

  // audioEdit 只在编辑模式下被读取；双轨模式下模板只读 session 上的几个字段，给出“无编辑”的值
  const emptyRef = <T>(value: T) => computed(() => value)
  const audioEdit = {
    session: {
      hasEdits: emptyRef(false),
      clips: emptyRef([]),
      completeSelection: emptyRef(null),
      pendingStartSec: emptyRef(null),
      pendingEndSec: emptyRef(null),
      insertedRanges: emptyRef([]),
      hotCues: emptyRef([]),
      memoryCues: emptyRef([]),
      loopRange: emptyRef(null),
      songStructure: emptyRef(null)
    },
    saving: ref(false),
    writable: emptyRef(false),
    subMode: ref<'audio' | 'grid'>('audio'),
    handleDisplayBeatGridChange: noop,
    handleGridDirtyChange: noop,
    // 波形栈挂载时把网格宿主交给编辑器；双轨模式下不需要
    attachGridHost: noop
  }

  const model = {
    isEditMode: computed(() => false),
    topDeckSong,
    bottomDeckSong,
    deckSyncState: transportState,
    deckKeysHarmonicMatched: computed(() => false),
    topDeckVisibleCurrentSeconds: computed(() => positions.top),
    topDeckVisibleDurationSeconds: computed(() => topTrack.durationSec),
    topDeckVisiblePlaying: computed(() => playing.value),
    bottomDeckRenderCurrentSeconds: computed(() => positions.bottom),
    bottomDeckDurationSeconds: computed(() => bottomTrack.durationSec),
    bottomDeckUiPlaying: computed(() => playing.value),
    audioEdit,
    playbackRangeOverlay: computed(() => ({
      visible: false,
      startPercent: 0,
      endPercent: 100,
      locked: false,
      lockedRanges: [],
      setStartPercent: noop,
      setEndPercent: noop
    })),
    deckQuantizeEnabled,
    topDeckWaveformPlaybackActive: computed(() => playing.value && !dragSession.active),
    bottomDeckWaveformPlaybackActive: computed(() => playing.value && !dragSession.active),
    topDeckPlaybackRate: computed(() => 1),
    bottomDeckPlaybackRate: computed(() => 1),
    topDeckPlaybackSyncRevision: computed(() => playbackSyncRevision.top),
    bottomDeckPlaybackSyncRevision: computed(() => playbackSyncRevision.bottom),
    topDeckGridBpm: computed(() => topTrack.spec.bpm),
    bottomDeckGridBpm: computed(() => bottomTrack.spec.bpm),
    topDeckCuePointSeconds: ref(0),
    bottomDeckCuePointSeconds: ref(0),
    deckSeekIntent,
    sharedDetailZoomState,
    editDetailZoomState,
    gridEditMode: ref(false),
    waveformPresentation,
    isDeckHovered: () => false,
    resolveDeckSyncUiEnabled: (deck: DeckKey) => deck === 'bottom',
    pendingMasterDeck: ref<DeckKey | null>(null),
    failedMasterDeck: ref<DeckKey | null>(null),
    pendingBeatSync: reactive<Record<DeckKey, boolean>>({ top: false, bottom: false }),
    resolveDeckToolbarState: (deck: DeckKey) =>
      resolveHorizontalBrowseDeckToolbarPresentation({
        toolbarState: toolbarStates[deck],
        bpmInputValue: formatBpmDisplay(resolveTrack(deck).spec.bpm, ''),
        loopBeatLabel: '8',
        loopActive: false,
        loopDisabled: false,
        editMode: false,
        editSaving: false,
        editSubMode: 'audio',
        song: resolveSong(deck)
      }),
    resolveDeckLoopRange: () => null,
    isDeckSongReadOnly: () => false,
    isDeckMasterTempoEnabled: () => true,
    resolveDeckTempoNudgeDirection: () => null,
    handleRegionDragEnter: noop,
    handleRegionDragOver: noop,
    handleRegionDragLeave: noop,
    handleRegionDrop: noop,
    triggerDeckBeatSync: asyncNoop,
    toggleDeckMaster: asyncNoop,
    handleTopDeckEjectSong: noop,
    handleDeckEjectSong: noop,
    handleDeckPlayheadSeek: (deck: DeckKey, seconds: number) => seekLinkedDecks(deck, seconds),
    handleDeckSectionSeekPlay: (deck: DeckKey, seconds: number) => seekLinkedDecks(deck, seconds),
    handleDeckSetDownbeatLineAtPlayhead: noop,
    handleDeckGridShiftLargeLeft: noop,
    handleDeckGridShiftSmallLeft: noop,
    handleDeckGridShiftSmallRight: noop,
    handleDeckGridShiftLargeRight: noop,
    handleDeckBpmInputUpdate: noop,
    handleDeckBpmInputLive: noop,
    handleDeckBpmInputBlur: noop,
    handleDeckBpmTap: noop,
    handleDeckMemoryCueCreate: asyncNoop,
    handleDeckSelectWholeAdjustment: noop,
    handleDeckSplitAfterPlayhead: noop,
    handleDeckDeleteBoundary: noop,
    handleDeckMetronomeStateCycle: noop,
    handleDeckLoopStepDown: noop,
    handleDeckLoopStepUp: noop,
    handleDeckLoopToggle: noop,
    handleDeckMasterTempoToggle: noop,
    resetDeckTempo: noop,
    handleDeckQuantizeToggle: noop,
    startDeckTempoNudge: noop,
    stopDeckTempoNudge: noop,
    openDeckMoveDialog: noop,
    resolveDeckPlaybackRateForTransport: () => 1,
    resolveDeckWaveformGain: () => 1,
    isDeckWaveformDragging: () => dragSession.active,
    resolveDeckWaveformDragAnchorSec: (deck: DeckKey) =>
      dragSession.active ? dragSession.anchors[deck] : null,
    shouldPreserveGridShiftPhase: () => false,
    // 详情组件把网格 / BPM 等工具栏状态回报上来，和应用一样存下再交给工具栏渲染
    handleToolbarStateChange: (
      deck: DeckKey,
      value: ReturnType<typeof createDefaultDeckToolbarState>
    ) => {
      toolbarStates[deck] = { ...value }
    },
    handleDetailZoomChange: noop,
    handleDeckRawWaveformDragStart: (deck: DeckKey) => startDrag(deck),
    handleDeckRawWaveformScrubPreview: (deck: DeckKey, payload: { anchorSec: number }) =>
      previewDrag(deck, payload.anchorSec),
    handleDeckRawWaveformDragEnd: (
      deck: DeckKey,
      payload: { anchorSec: number; committed: boolean }
    ) => endDrag(deck, payload),
    handleEditWaveformLoadingChange: noop,
    handleDeckHotCuePress: asyncNoop,
    handleDeckHotCueDelete: asyncNoop,
    handleDeckMemoryCueRecallPress: asyncNoop,
    handleDeckMemoryCueDelete: asyncNoop
  } as unknown as Model
  // 上面的 handler 签名都比应用宽松（演示里不做任何事），形状以 Model 类型为准

  // 播放时钟：两轨同步推进，接近结尾时跳回起始小节（相当于 seek，要递增 seekRevision）
  let rafId = 0
  let lastTs = 0
  let visible = false
  let disposed = false
  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const seekDeck = (deck: DeckKey, seconds: number) => {
    positions[deck] = seconds
    deckSeekIntent[deck] = { seconds, revision: deckSeekIntent[deck].revision + 1 }
    playbackSyncRevision[deck] += 1
  }

  const clampDeckSeconds = (deck: DeckKey, seconds: number) =>
    Math.max(0, Math.min(resolveTrack(deck).durationSec - 4, seconds))

  const seekLinkedDecks = (deck: DeckKey, seconds: number) => {
    const target = clampDeckSeconds(deck, seconds)
    const delta = target - positions[deck]
    DECKS.forEach((key) => {
      seekDeck(key, clampDeckSeconds(key, positions[key] + delta))
    })
    lastTs = 0
  }

  const startDrag = (deck: DeckKey) => {
    dragSession.active = true
    dragSession.source = deck
    DECKS.forEach((key) => {
      dragSession.start[key] = positions[key]
      dragSession.anchors[key] = positions[key]
    })
    waveformPresentation.markDragPreview(deck, positions[deck], true, dragSession.anchors)
  }

  const previewDrag = (deck: DeckKey, seconds: number) => {
    if (!dragSession.active || dragSession.source !== deck) return
    const target = clampDeckSeconds(deck, seconds)
    const delta = target - dragSession.start[deck]
    DECKS.forEach((key) => {
      dragSession.anchors[key] = clampDeckSeconds(key, dragSession.start[key] + delta)
    })
    waveformPresentation.markDragPreview(deck, target, true, dragSession.anchors)
  }

  const endDrag = (deck: DeckKey, payload: { anchorSec: number; committed: boolean }) => {
    if (!dragSession.active || dragSession.source !== deck) return
    if (payload.committed) {
      const target = clampDeckSeconds(deck, payload.anchorSec)
      const delta = target - dragSession.start[deck]
      DECKS.forEach((key) => {
        seekDeck(key, clampDeckSeconds(key, dragSession.start[key] + delta))
      })
    }
    dragSession.active = false
    waveformPresentation.clearDrag(deck, false)
    lastTs = 0
  }

  const tick = (ts: number) => {
    if (!playing.value || disposed) return
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0
    lastTs = ts
    if (dragSession.active) {
      rafId = requestAnimationFrame(tick)
      return
    }
    DECKS.forEach((deck) => {
      const track = resolveTrack(deck)
      const next = positions[deck] + dt
      if (next >= track.durationSec - 4) seekDeck(deck, track.startSec)
      else positions[deck] = next
    })
    rafId = requestAnimationFrame(tick)
  }

  const updatePlaying = () => {
    const shouldPlay = visible && !reducedMotion && !disposed && !!topDeckSong.value
    if (shouldPlay === playing.value) return
    playing.value = shouldPlay
    DECKS.forEach((deck) => (playbackSyncRevision[deck] += 1))
    cancelAnimationFrame(rafId)
    if (shouldPlay) {
      lastTs = 0
      rafId = requestAnimationFrame(tick)
    }
  }

  const init = async () => {
    installDemoIpc()
    try {
      const waveforms = await loadDemoUnifiedWaveforms(withBase('/assets/unified-waveforms/'))
      waveforms.forEach(({ filePath, data }) => registerDemoUnifiedWaveform(filePath, data))
    } catch (error) {
      console.error('Failed to load demo waveforms:', error)
    }
    if (disposed) return
    topDeckSong.value = topTrack.song
    bottomDeckSong.value = bottomTrack.song
    updatePlaying()
  }

  return {
    model,
    faderTransport,
    deckBandState,
    playing,
    init,
    setVisible: (value: boolean) => {
      visible = value
      updatePlaying()
    },
    togglePlay: () => {
      visible = !playing.value
      updatePlaying()
    },
    dispose: () => {
      disposed = true
      cancelAnimationFrame(rafId)
    }
  }
}
