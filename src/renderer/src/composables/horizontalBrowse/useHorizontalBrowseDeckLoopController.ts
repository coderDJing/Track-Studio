import type { ISongHotCue, ISongMemoryCue, ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { Ref } from 'vue'
import { resolveSongCueTimelineDefinition } from '@shared/songCueTimeBasis'
import {
  resolveNearestUnifiedSongBeatGridLine,
  resolveUnifiedSongBeatGridSecAtBeatOrdinal
} from '@shared/songBeatGridRuntime'
import { useHorizontalBrowseSongBeatGridLookup } from './useHorizontalBrowseSongBeatGridLookup'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
  durationSec: number
  startBeatIndex: number
  beatValue: number
}

type HorizontalBrowseStoredCueDefinition = Pick<
  ISongMemoryCue,
  'sec' | 'isLoop' | 'loopEndSec' | 'source'
>

type ToggleDeckLoopStateResult = {
  active: boolean
  shouldStartPlayback: boolean
}

type UseHorizontalBrowseDeckLoopControllerParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  nativeTransport: {
    toggleLoop: (deck: DeckKey) => Promise<unknown>
    stepLoopBeats: (deck: DeckKey, direction: -1 | 1) => Promise<unknown>
    setLoopFromRange: (deck: DeckKey, startSec: number, endSec: number) => Promise<unknown>
    clearLoop: (deck: DeckKey) => Promise<unknown>
  }
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckCuePointRef: (deck: DeckKey) => Ref<number>
}

const LOOP_DEFAULT_BEAT_VALUE = 8
const LOOP_BEAT_VALUES = [
  1 / 64,
  1 / 32,
  1 / 16,
  1 / 8,
  1 / 4,
  1 / 2,
  1,
  2,
  4,
  8,
  16,
  32,
  64,
  128,
  256,
  512
] as const

const formatLoopBeatLabel = (value: number) => {
  if (value >= 1) return String(Number.isInteger(value) ? value : Number(value.toFixed(4)))
  const denominator = Math.round(1 / value)
  return `1/${denominator}`
}

const normalizeLoopBeatValue = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : LOOP_DEFAULT_BEAT_VALUE
}

export const useHorizontalBrowseDeckLoopController = (
  params: UseHorizontalBrowseDeckLoopControllerParams
) => {
  const createDeckBeatGridLookup = (deck: DeckKey) =>
    useHorizontalBrowseSongBeatGridLookup({
      beatGridMap: () => params.resolveDeckSong(deck)?.beatGridMap,
      durationSeconds: () => params.resolveDeckDurationSeconds(deck)
    })
  const deckBeatGridLookup = {
    top: createDeckBeatGridLookup('top'),
    bottom: createDeckBeatGridLookup('bottom')
  }
  const dynamicLoopBeatValueOverride: Record<DeckKey, number | null> = {
    top: null,
    bottom: null
  }

  const resolveLoopBeatValueIndex = (value: number) => {
    const exactIndex = LOOP_BEAT_VALUES.findIndex(
      (candidate) => Math.abs(candidate - value) <= 1e-9
    )
    if (exactIndex >= 0) return exactIndex
    const nextIndex = LOOP_BEAT_VALUES.findIndex((candidate) => candidate >= value)
    return nextIndex >= 0 ? nextIndex : LOOP_BEAT_VALUES.length - 1
  }

  const resolveNextLoopBeatValue = (currentValue: number, direction: -1 | 1) => {
    const currentIndex = resolveLoopBeatValueIndex(currentValue)
    const nextIndex = Math.max(0, Math.min(LOOP_BEAT_VALUES.length - 1, currentIndex + direction))
    return LOOP_BEAT_VALUES[nextIndex]
  }

  const resolveDeckLoopBeatValue = (deck: DeckKey) =>
    dynamicLoopBeatValueOverride[deck] ??
    normalizeLoopBeatValue(params.resolveTransportDeckSnapshot(deck).loopBeatValue)

  const resolveDeckAnchorSec = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (params.resolveDeckPlaying(deck)) {
      const renderCurrentSec = Number(snapshot.renderCurrentSec)
      if (Number.isFinite(renderCurrentSec)) return renderCurrentSec
    }
    const currentSec = Number(snapshot.currentSec)
    return Number.isFinite(currentSec) ? currentSec : 0
  }

  const resolveDynamicLoopRange = (
    deck: DeckKey,
    beatValue: number,
    anchorSec: number
  ): { startSec: number; endSec: number } | null => {
    const song = params.resolveDeckSong(deck)
    const durationSec = params.resolveDeckDurationSeconds(deck)
    const startLine = resolveNearestUnifiedSongBeatGridLine(
      song?.beatGridMap,
      durationSec,
      anchorSec
    )
    if (!startLine) return null
    const endSec = resolveUnifiedSongBeatGridSecAtBeatOrdinal(
      song?.beatGridMap,
      durationSec,
      startLine.beatOrdinal + beatValue
    )
    if (endSec === null || endSec <= startLine.sec) return null
    return {
      startSec: startLine.sec,
      endSec
    }
  }

  const resolveDeckLoopRange = (deck: DeckKey): HorizontalBrowseLoopRange | null => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (!snapshot.loopActive) return null
    const startBeatIndex = Number(snapshot.loopStartBeatIndex)
    const startSec = Number(snapshot.loopStartSec) || 0
    const endSec = Number(snapshot.loopEndSec) || 0
    const beatValue = resolveDeckLoopBeatValue(deck)
    const durationSec = Math.max(0, endSec - startSec)
    if (!Number.isFinite(startBeatIndex) || durationSec <= 0) return null
    return {
      startSec,
      endSec,
      durationSec,
      startBeatIndex,
      beatValue
    }
  }

  const resolveDeckLoopDisabled = (deck: DeckKey) => {
    const song = params.resolveDeckSong(deck)
    if (deckBeatGridLookup[deck].runtime.value?.lines.length) {
      return false
    }
    const bpm = Number(song?.bpm)
    return !song || !Number.isFinite(bpm) || bpm <= 0
  }

  const resolveDeckLoopBeatLabel = (deck: DeckKey) =>
    formatLoopBeatLabel(resolveDeckLoopBeatValue(deck))

  const isDeckLoopActive = (deck: DeckKey) =>
    Boolean(params.resolveTransportDeckSnapshot(deck).loopActive)

  const deactivateDeckLoop = async (deck: DeckKey) => {
    dynamicLoopBeatValueOverride[deck] = null
    await params.nativeTransport.clearLoop(deck)
  }

  const toggleDeckLoopState = async (deck: DeckKey): Promise<ToggleDeckLoopStateResult> => {
    params.touchDeckInteraction(deck)
    if (resolveDeckLoopDisabled(deck)) {
      return { active: false, shouldStartPlayback: false }
    }
    const wasActive = isDeckLoopActive(deck)
    if (!wasActive) {
      const beatValue = resolveDeckLoopBeatValue(deck)
      const dynamicRange = resolveDynamicLoopRange(deck, beatValue, resolveDeckAnchorSec(deck))
      if (dynamicRange) {
        dynamicLoopBeatValueOverride[deck] = beatValue
        await params.nativeTransport.setLoopFromRange(
          deck,
          dynamicRange.startSec,
          dynamicRange.endSec
        )
        const nextRange = resolveDeckLoopRange(deck)
        if (nextRange) {
          params.resolveDeckCuePointRef(deck).value = nextRange.startSec
        }
        return {
          active: Boolean(nextRange),
          shouldStartPlayback: !params.resolveDeckPlaying(deck) && Boolean(nextRange)
        }
      }
    } else {
      dynamicLoopBeatValueOverride[deck] = null
    }
    await params.nativeTransport.toggleLoop(deck)
    const nextRange = resolveDeckLoopRange(deck)
    if (nextRange) {
      params.resolveDeckCuePointRef(deck).value = nextRange.startSec
    }
    return {
      active: !wasActive && Boolean(nextRange),
      shouldStartPlayback: !wasActive && !params.resolveDeckPlaying(deck) && Boolean(nextRange)
    }
  }

  const handleDeckLoopStepDown = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (resolveDeckLoopDisabled(deck)) return
    const loopRange = resolveDeckLoopRange(deck)
    if (loopRange && params.resolveDeckSong(deck)?.beatGridMap) {
      const nextBeatValue = resolveNextLoopBeatValue(loopRange.beatValue, -1)
      const dynamicRange = resolveDynamicLoopRange(deck, nextBeatValue, loopRange.startSec)
      if (dynamicRange) {
        dynamicLoopBeatValueOverride[deck] = nextBeatValue
        await params.nativeTransport.setLoopFromRange(
          deck,
          dynamicRange.startSec,
          dynamicRange.endSec
        )
        params.resolveDeckCuePointRef(deck).value = dynamicRange.startSec
        return
      }
    }
    await params.nativeTransport.stepLoopBeats(deck, -1)
    const nextRange = resolveDeckLoopRange(deck)
    if (nextRange) {
      params.resolveDeckCuePointRef(deck).value = nextRange.startSec
    }
  }

  const handleDeckLoopStepUp = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (resolveDeckLoopDisabled(deck)) return
    const loopRange = resolveDeckLoopRange(deck)
    if (loopRange && params.resolveDeckSong(deck)?.beatGridMap) {
      const nextBeatValue = resolveNextLoopBeatValue(loopRange.beatValue, 1)
      const dynamicRange = resolveDynamicLoopRange(deck, nextBeatValue, loopRange.startSec)
      if (dynamicRange) {
        dynamicLoopBeatValueOverride[deck] = nextBeatValue
        await params.nativeTransport.setLoopFromRange(
          deck,
          dynamicRange.startSec,
          dynamicRange.endSec
        )
        params.resolveDeckCuePointRef(deck).value = dynamicRange.startSec
        return
      }
    }
    await params.nativeTransport.stepLoopBeats(deck, 1)
    const nextRange = resolveDeckLoopRange(deck)
    if (nextRange) {
      params.resolveDeckCuePointRef(deck).value = nextRange.startSec
    }
  }

  const handleDeckLoopPlaybackTick = (_deck: DeckKey) => {
    // loop 回环已迁到播放内核，renderer 不再靠 RAF 盯着时间补 seek。
  }

  const syncDeckIntoLoopRangeBeforePlay = async (_deck: DeckKey) => {
    // 播放前的 loop 对齐已迁到内核 set_playing。
  }

  const buildDeckStoredCueDefinition = (
    deck: DeckKey
  ): HorizontalBrowseStoredCueDefinition | null => {
    const cueSec = Number(params.resolveDeckCuePointRef(deck).value)
    if (!Number.isFinite(cueSec) || cueSec < 0) return null
    const loopRange = resolveDeckLoopRange(deck)
    if (loopRange) {
      return {
        sec: loopRange.startSec,
        isLoop: true,
        loopEndSec: loopRange.endSec
      }
    }
    return {
      sec: cueSec,
      isLoop: false,
      loopEndSec: undefined
    }
  }

  const applyDeckStoredCueDefinition = async (
    deck: DeckKey,
    cue:
      | HorizontalBrowseStoredCueDefinition
      | Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => {
    const timelineCue = resolveSongCueTimelineDefinition(
      cue,
      params.resolveDeckSong(deck)?.timeBasisOffsetMs
    )
    const cueSec = timelineCue?.sec ?? Math.max(0, Number(cue?.sec) || 0)
    params.resolveDeckCuePointRef(deck).value = cueSec
    const loopEndSec = Number(timelineCue?.loopEndSec)
    const isLoop =
      Boolean(timelineCue?.isLoop) && Number.isFinite(loopEndSec) && loopEndSec > cueSec
    if (!isLoop) {
      dynamicLoopBeatValueOverride[deck] = null
      await params.nativeTransport.clearLoop(deck)
      return null
    }
    await params.nativeTransport.setLoopFromRange(deck, cueSec, loopEndSec)
    const loopRange = resolveDeckLoopRange(deck)
    if (loopRange) {
      params.resolveDeckCuePointRef(deck).value = loopRange.startSec
    }
    return loopRange
  }

  return {
    resolveDeckLoopRange,
    resolveDeckLoopBeatLabel,
    resolveDeckLoopDisabled,
    isDeckLoopActive,
    deactivateDeckLoop,
    toggleDeckLoopState,
    handleDeckLoopStepDown,
    handleDeckLoopStepUp,
    handleDeckLoopPlaybackTick,
    syncDeckIntoLoopRangeBeforePlay,
    buildDeckStoredCueDefinition,
    applyDeckStoredCueDefinition
  }
}
