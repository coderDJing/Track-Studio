import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { usePioneerUsbGridEditing } from './usePioneerUsbGridEditing'
import type { ISongInfo } from 'src/types/globals'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

const { edit, dispose } = vi.hoisted(() => ({ edit: vi.fn(), dispose: [] as (() => void)[] }))
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onUnmounted: (callback: () => void) => dispose.push(callback)
}))
vi.mock('@renderer/utils/pioneerUsbEditing', async (original) => ({
  ...(await original<typeof import('@renderer/utils/pioneerUsbEditing')>()),
  editPioneerUsbSong: edit
}))
const entries = [
  { beatNumber: 1, bpm: 120, timeMs: 100 },
  { beatNumber: 2, bpm: 120, timeMs: 600 }
]
const fixture = () => {
  const song = ref({
    filePath: 'D:\\Contents\\7.mp3',
    externalSourceKind: 'usb',
    pioneerUsbSource: { rootPath: 'D:\\', libraryType: 'oneLibrary', trackId: 7 },
    rekordboxGridEntries: entries
  } as ISongInfo)
  const firstBeatMs = ref(100)
  const state = usePioneerUsbGridEditing({
    song: () => song.value,
    previewFirstBeatMs: firstBeatMs,
    previewBpm: ref(120),
    previewDownbeatBeatOffset: ref(0),
    previewBeatGridMap: ref<SongBeatGridMapV2 | null>(null),
    draw: vi.fn()
  })
  return { song, firstBeatMs, ...state }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
})
afterEach(() => {
  dispose.splice(0).forEach((callback) => callback())
  vi.useRealTimers()
})
describe('native USB grid buttons save silently without losing queued movement', () => {
  it('previews immediately and merges repeated presses into one save', async () => {
    const state = fixture()
    edit.mockResolvedValue({
      rekordboxGridEntries: entries.map((entry) => ({ ...entry, timeMs: entry.timeMs + 15 }))
    })
    state.shift(5)
    state.shift(5)
    state.shift(5)
    expect(state.firstBeatMs.value).toBe(115)
    expect(edit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(350)
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ filePath: 'D:\\Contents\\7.mp3' }),
      { kind: 'shift-grid', offsetMs: 15 }
    )
    expect(state.firstBeatMs.value).toBe(115)
  })
  it('saves the original song when the deck changes before the debounce expires', async () => {
    const state = fixture()
    edit.mockResolvedValue({ rekordboxGridEntries: entries })
    state.shift(-5)
    state.song.value = {
      ...state.song.value,
      filePath: 'D:\\Contents\\8.mp3',
      pioneerUsbSource: { rootPath: 'D:\\', libraryType: 'oneLibrary', trackId: 8 }
    }
    state.firstBeatMs.value = 900
    await vi.advanceTimersByTimeAsync(350)
    expect(edit.mock.calls[0][0].pioneerUsbSource.trackId).toBe(7)
    expect(state.firstBeatMs.value).toBe(900)
  })
  it('restores the saved preview after a failed write', async () => {
    const state = fixture()
    edit.mockResolvedValue(null)
    state.shift(5)
    await state.flush()
    expect(state.firstBeatMs.value).toBe(100)
  })
  it('retains a second movement made while the first save is pending', async () => {
    const state = fixture()
    let finish: ((value: unknown) => void) | undefined
    edit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    edit.mockResolvedValue({
      rekordboxGridEntries: entries.map((entry) => ({ ...entry, timeMs: entry.timeMs + 10 }))
    })
    state.shift(5)
    const pending = state.flush()
    state.shift(5)
    finish?.({
      rekordboxGridEntries: entries.map((entry) => ({ ...entry, timeMs: entry.timeMs + 5 }))
    })
    await pending
    expect(edit).toHaveBeenCalledTimes(2)
    expect(state.firstBeatMs.value).toBe(110)
  })
})
