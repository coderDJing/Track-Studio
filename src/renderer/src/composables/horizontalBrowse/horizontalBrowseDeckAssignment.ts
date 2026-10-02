import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellState'
import type { HorizontalBrowseDeckTransportStateOverride } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseTransportMutations'
import { resolveHorizontalBrowseDefaultCuePointSec } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailMath'
import {
  isSameHorizontalBrowseSongFilePath,
  mergeHorizontalBrowseSongWithHotCues,
  mergeHorizontalBrowseSongWithMemoryCues,
  mergeHorizontalBrowseSongWithSharedGrid
} from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'
import type { SongStructureAnalysis } from '@shared/songStructure'
import { buildHorizontalBrowseTransportGridPayload } from '@shared/horizontalBrowseTransportGrid'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTrace'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { loadRekordboxPlaybackRuntime } from '@renderer/utils/loadRekordboxPlaybackRuntime'
import { queueHorizontalBrowseDeckAnalysis } from '@renderer/composables/horizontalBrowse/horizontalBrowseExternalDjAnalysis'
import { resolveHorizontalBrowseInteractionElapsedMs } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline'
import type { HorizontalBrowseTransportBeatGridInput } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type SharedSongGridPayload = {
  filePath?: string
  beatGridMap?: ISongInfo['beatGridMap'] | null
  songStructure?: SongStructureAnalysis
  externalBeatGridPreference?: 'frkb-manual'
} | null

type CreateHorizontalBrowseDeckAssignerParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  shouldDeferDeckSongPriorityAnalysis: (deck: DeckKey) => boolean
  syncDeckDefaultCue: (deck: DeckKey, song: ISongInfo | null, force?: boolean) => void
  primeDeckRenderCurrentSeconds: (deck: DeckKey, seconds: number) => void
  setDeckBeatGridToNative: (
    deck: DeckKey,
    payload: HorizontalBrowseTransportBeatGridInput
  ) => Promise<unknown>
  commitDeckStateToNative: (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ) => Promise<unknown>
}

export type HorizontalBrowseDeckAssignTransportOptions = {
  initialCurrentSec?: number
  waitForHydration?: boolean
  applyHydratedCue?: boolean
}

export const createHorizontalBrowseDeckAssigner = (
  params: CreateHorizontalBrowseDeckAssignerParams
) => {
  const buildNativeGridPayload = (song: ISongInfo): HorizontalBrowseTransportBeatGridInput | null =>
    buildHorizontalBrowseTransportGridPayload(song)

  const resolveDeckSongWithSharedGrid = async (song: ISongInfo) => {
    const filePath = String(song.filePath || '').trim()
    if (!filePath) return { ...song }
    if (isRekordboxExternalPlaybackSource('', song)) {
      return loadRekordboxPlaybackRuntime(song)
    }
    const startedAt = performance.now()
    sendHorizontalBrowseInteractionTrace('resolve-deck-song:start', { filePath })
    try {
      const [payload, hotCuePayload, memoryCuePayload] = await Promise.all([
        window.electron.ipcRenderer.invoke('song:get-shared-grid-definition', { filePath }),
        window.electron.ipcRenderer.invoke('song:get-hot-cues', { filePath }),
        window.electron.ipcRenderer.invoke('song:get-memory-cues', { filePath })
      ])
      const resolvedHotCuePayload =
        Array.isArray(hotCuePayload) && hotCuePayload.length > 0
          ? { filePath, hotCues: hotCuePayload as ISongHotCue[] }
          : Array.isArray(song.hotCues) && song.hotCues.length > 0
            ? { filePath, hotCues: song.hotCues }
            : null
      const resolvedMemoryCuePayload =
        Array.isArray(memoryCuePayload) && memoryCuePayload.length > 0
          ? { filePath, memoryCues: memoryCuePayload as ISongMemoryCue[] }
          : Array.isArray(song.memoryCues) && song.memoryCues.length > 0
            ? { filePath, memoryCues: song.memoryCues }
            : null
      const merged = mergeHorizontalBrowseSongWithMemoryCues(
        mergeHorizontalBrowseSongWithHotCues(
          mergeHorizontalBrowseSongWithSharedGrid({ ...song }, payload as SharedSongGridPayload),
          resolvedHotCuePayload
        ),
        resolvedMemoryCuePayload
      )
      sendHorizontalBrowseInteractionTrace('resolve-deck-song:done', {
        filePath,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        hasGrid: Boolean(payload),
        hotCueCount: Array.isArray(hotCuePayload) ? hotCuePayload.length : 0,
        memoryCueCount: Array.isArray(memoryCuePayload) ? memoryCuePayload.length : 0
      })
      return merged
    } catch {
      sendHorizontalBrowseInteractionTrace('resolve-deck-song:error', {
        filePath,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1))
      })
      return { ...song }
    }
  }

  const assignSongToDeck = async (
    deck: DeckKey,
    song: ISongInfo,
    options?: HorizontalBrowseDeckAssignTransportOptions
  ) => {
    const startedAt = performance.now()
    const filePath = String(song.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace('assign-song:start', {
      deck,
      filePath,
      sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, filePath)
    })
    params.touchDeckInteraction(deck)
    const initialSong = { ...song }
    const initialFilePath = String(initialSong.filePath || '').trim()
    const nowMs = performance.now()
    const initialDurationSec = parseHorizontalBrowseDurationToSeconds(initialSong.duration)
    const initialCueSec = resolveHorizontalBrowseDefaultCuePointSec(initialSong, initialDurationSec)
    const hasInitialCurrentSec =
      typeof options?.initialCurrentSec === 'number' && Number.isFinite(options.initialCurrentSec)
    const initialCurrentSec =
      hasInitialCurrentSec && initialDurationSec > 0
        ? Math.min(Math.max(0, Number(options.initialCurrentSec)), initialDurationSec)
        : hasInitialCurrentSec
          ? Math.max(0, Number(options.initialCurrentSec))
          : initialCueSec
    const applyHydratedCue = options?.applyHydratedCue ?? !hasInitialCurrentSec
    params.primeDeckRenderCurrentSeconds(deck, initialCurrentSec)
    params.setDeckSong(deck, initialSong)
    queueHorizontalBrowseDeckAnalysis(
      deck,
      initialSong,
      params.shouldDeferDeckSongPriorityAnalysis(deck)
    )
    params.syncDeckDefaultCue(deck, initialSong, true)

    const initialCommit = params.commitDeckStateToNative(deck, {
      currentSec: initialCurrentSec,
      lastObservedAtMs: nowMs,
      durationSec: initialDurationSec,
      playing: false,
      playbackRate: 1
    })
    const hydration = resolveDeckSongWithSharedGrid(initialSong)

    await initialCommit
    sendHorizontalBrowseInteractionTrace('assign-song:ready', {
      deck,
      filePath: initialFilePath,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, initialFilePath)
    })

    const finishHydration = async () => {
      const nextSong = await hydration
      const nextFilePath = String(nextSong.filePath || '').trim()
      if (
        !isSameHorizontalBrowseSongFilePath(params.resolveDeckSong(deck)?.filePath, nextFilePath)
      ) {
        return
      }

      const nextDurationSec = parseHorizontalBrowseDurationToSeconds(nextSong.duration)
      const nextCueSec = resolveHorizontalBrowseDefaultCuePointSec(nextSong, nextDurationSec)
      const canApplyHydratedCue =
        applyHydratedCue &&
        !params.resolveDeckPlaying(deck) &&
        Math.abs(params.resolveDeckCurrentSeconds(deck) - initialCurrentSec) <= 0.05
      if (canApplyHydratedCue && Math.abs(nextCueSec - initialCurrentSec) > 0.0001) {
        params.primeDeckRenderCurrentSeconds(deck, nextCueSec)
      }
      params.setDeckSong(deck, nextSong)
      params.syncDeckDefaultCue(deck, nextSong, canApplyHydratedCue)
      const nativeGridPayload = buildNativeGridPayload(nextSong)
      if (nativeGridPayload) {
        await params.setDeckBeatGridToNative(deck, nativeGridPayload)
      }
      if (canApplyHydratedCue && Math.abs(nextCueSec - initialCurrentSec) > 0.0001) {
        await params.commitDeckStateToNative(deck, {
          currentSec: nextCueSec,
          lastObservedAtMs: performance.now(),
          durationSec: nextDurationSec,
          playing: false
        })
      }
      sendHorizontalBrowseInteractionTrace('assign-song:hydrated', {
        deck,
        filePath: nextFilePath,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, nextFilePath)
      })
      sendHorizontalBrowseInteractionTrace('assign-song:done', {
        deck,
        filePath: nextFilePath,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, nextFilePath)
      })
    }

    if (options?.waitForHydration === false) {
      void finishHydration().catch((error) => {
        console.error('[horizontal-browse] assign song hydration failed', error)
      })
      return
    }

    await finishHydration()
  }

  return {
    assignSongToDeck
  }
}
