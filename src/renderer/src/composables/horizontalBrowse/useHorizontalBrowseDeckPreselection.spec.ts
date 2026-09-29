import { nextTick, reactive, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import { createEmptyHorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'
import { useHorizontalBrowseDeckPreselection } from './useHorizontalBrowseDeckPreselection'

const song = (filePath: string) => ({ filePath }) as ISongInfo

const setup = () => {
  const state = reactive(createEmptyHorizontalBrowseTransportSnapshot())
  const topSong = ref<ISongInfo | null>(null)
  const bottomSong = ref<ISongInfo | null>(null)
  const activateMaster = vi.fn(async (deck: 'top' | 'bottom') => {
    state.leaderDeck = deck
  })
  const activateBeatSync = vi.fn(async (deck: 'top' | 'bottom') => {
    state[deck].syncEnabled = !state[deck].syncEnabled
  })
  const selection = useHorizontalBrowseDeckPreselection({
    editMode: () => false,
    resolveDeckSong: (deck) => (deck === 'top' ? topSong.value : bottomSong.value),
    resolveDeckSnapshot: (deck) => state[deck],
    resolveLeaderDeck: () => state.leaderDeck,
    touchDeckInteraction: vi.fn(),
    activateMaster,
    activateBeatSync
  })
  return { state, topSong, bottomSong, activateMaster, activateBeatSync, selection }
}

describe('empty deck sync preselection', () => {
  it('keeps Master pending until the selected deck audio is loaded', async () => {
    const { state, bottomSong, activateMaster, selection } = setup()
    state.leaderDeck = 'top'
    await selection.toggleDeckMaster('bottom')
    expect(selection.pendingMasterDeck.value).toBe('bottom')
    expect(state.leaderDeck).toBe('top')

    bottomSong.value = song('bottom.mp3')
    await nextTick()
    expect(activateMaster).not.toHaveBeenCalled()

    state.bottom.loaded = true
    await nextTick()
    await vi.waitFor(() => expect(selection.pendingMasterDeck.value).toBeNull())
    expect(activateMaster).toHaveBeenCalledOnce()
    expect(state.leaderDeck).toBe('bottom')
  })

  it('allows cancellation before a track is loaded', async () => {
    const { state, activateMaster, selection } = setup()
    await selection.toggleDeckMaster('bottom')
    await selection.toggleDeckMaster('bottom')
    state.bottom.loaded = true
    await nextTick()
    expect(selection.pendingMasterDeck.value).toBeNull()
    expect(activateMaster).not.toHaveBeenCalled()
  })

  it('reports failed audio loading without switching Master', async () => {
    const { state, bottomSong, activateMaster, selection } = setup()
    state.leaderDeck = 'top'
    await selection.toggleDeckMaster('bottom')
    bottomSong.value = song('broken.mp3')
    state.bottom.decoding = true
    await nextTick()
    state.bottom.decoding = false
    await nextTick()

    expect(selection.failedMasterDeck.value).toBe('bottom')
    expect(selection.pendingMasterDeck.value).toBe('bottom')
    expect(state.leaderDeck).toBe('top')
    expect(activateMaster).not.toHaveBeenCalled()

    await selection.toggleDeckMaster('bottom')
    expect(selection.failedMasterDeck.value).toBeNull()
    expect(selection.pendingMasterDeck.value).toBeNull()
  })

  it('waits for both loaded tracks with BPM before enabling Beat Sync', async () => {
    const { state, topSong, bottomSong, activateBeatSync, selection } = setup()
    await selection.triggerDeckBeatSync('bottom')
    bottomSong.value = song('bottom.mp3')
    state.bottom.loaded = true
    state.bottom.bpm = 128
    await nextTick()
    expect(activateBeatSync).not.toHaveBeenCalled()

    topSong.value = song('top.mp3')
    state.top.loaded = true
    state.top.bpm = 128
    await nextTick()
    await vi.waitFor(() => expect(selection.pendingBeatSync.bottom).toBe(false))
    expect(activateBeatSync).toHaveBeenCalledOnce()
    expect(state.bottom.syncEnabled).toBe(true)
  })
})
