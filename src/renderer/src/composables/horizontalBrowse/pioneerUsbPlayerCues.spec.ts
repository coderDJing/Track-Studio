import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHorizontalBrowseDeckHotCues } from './useHorizontalBrowseDeckHotCues'
import { useHorizontalBrowseDeckMemoryCues } from './useHorizontalBrowseDeckMemoryCues'
import type { ISongInfo, ISongHotCue, ISongMemoryCue } from 'src/types/globals'
const { invoke, showError } = vi.hoisted(() => ({ invoke: vi.fn(), showError: vi.fn() }))
vi.mock('@renderer/utils/pioneerUsbWrite', () => ({
  showPioneerUsbWriteError: showError,
  prepareAndApplyPioneerUsbWrite: vi.fn()
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
})
const fixture = () => {
  let song = {
    filePath: 'D:\\Contents\\7.mp3',
    fileName: '7.mp3',
    fileFormat: 'MP3',
    title: 'Fixture',
    artist: '',
    album: '',
    duration: '02:00',
    genre: '',
    label: '',
    bitrate: 320,
    container: 'MP3',
    cover: null,
    externalSourceKind: 'usb',
    pioneerUsbSource: { rootPath: 'D:\\', libraryType: 'oneLibrary', trackId: 7 },
    hotCues: [],
    memoryCues: []
  } as ISongInfo
  const setSong = vi.fn((_deck: unknown, next: ISongInfo | null) => {
    if (next) song = next
  })
  const recall = vi.fn()
  const loop = { sec: 30, isLoop: true, loopEndSec: 34, loopNumerator: 8, loopDenominator: 1 }
  type HotParams = Parameters<typeof useHorizontalBrowseDeckHotCues>[0]
  const hot = useHorizontalBrowseDeckHotCues({
    resolveDeckSong: () => song,
    setDeckSong: setSong,
    resolveDeckMarkerPlacementSec: () => 20.0004,
    resolveDeckPlaying: () => false,
    resolveDeckDurationSeconds: () => 120,
    resolveTransportDeckSnapshot: () =>
      ({}) as ReturnType<HotParams['resolveTransportDeckSnapshot']>,
    buildDeckStoredCueDefinition: () => loop,
    handleDeckHotCueRecall: recall,
    nativeTransport: { seek: vi.fn(), setPlaying: vi.fn(), beatsync: vi.fn() },
    commitDeckStatesToNative: vi.fn(),
    syncDeckRenderState: vi.fn(),
    isDeckLoopActive: () => true
  })
  const memory = useHorizontalBrowseDeckMemoryCues({
    resolveDeckSong: () => song,
    setDeckSong: setSong,
    buildDeckStoredCueDefinition: () => loop,
    handleDeckMemoryCueRecall: recall
  })
  return {
    hot,
    memory,
    recall,
    setSong,
    song: () => song,
    switchSong: (next: ISongInfo) => {
      song = next
    }
  }
}
describe('existing player Cue and Loop buttons write directly to USB', () => {
  it('saves Hot Loop with its beat count and patches the returned native list', async () => {
    const state = fixture()
    const hotCues: ISongHotCue[] = [{ slot: 1, sec: 30, isLoop: true, loopEndSec: 34 }]
    invoke.mockResolvedValue({ ok: true, result: { filePath: state.song().filePath, hotCues } })
    await state.hot.handleDeckHotCuePress('top', 1)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'pioneer-device-library:edit-song',
      expect.objectContaining({
        source: state.song().pioneerUsbSource,
        edit: {
          kind: 'set-hot-cue',
          cue: {
            slot: 1,
            sec: 30,
            isLoop: true,
            loopEndSec: 34,
            loopNumerator: 8,
            loopDenominator: 1
          }
        }
      })
    )
    expect(state.song().hotCues).toEqual(hotCues)
  })
  it('saves Memory Loop using the ordinary memory button', async () => {
    const state = fixture()
    const memoryCues: ISongMemoryCue[] = [{ sec: 30, isLoop: true, loopEndSec: 34 }]
    invoke.mockResolvedValue({ ok: true, result: { filePath: state.song().filePath, memoryCues } })
    await state.memory.handleDeckMemoryCueCreate('top')
    expect(invoke.mock.calls[0][1].edit).toMatchObject({
      kind: 'add-memory-cue',
      cue: { sec: 30, isLoop: true, loopNumerator: 8, loopDenominator: 1 }
    })
    expect(state.song().memoryCues).toEqual(memoryCues)
  })
  it('recalls an existing Hot Cue without writing', async () => {
    const state = fixture()
    state.song().hotCues = [{ slot: 0, sec: 10 }]
    await state.hot.handleDeckHotCuePress('top', 0)
    expect(state.recall).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('keeps a failed save out of the deck state and shows the failure', async () => {
    const state = fixture()
    invoke.mockResolvedValue({ ok: false, error: 'Drive changed' })
    await state.memory.handleDeckMemoryCueCreate('top')
    expect(state.setSong).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(expect.any(Error))
  })
  it('does not apply an older save response to a newly loaded song', async () => {
    const state = fixture()
    invoke.mockImplementation(async () => {
      state.switchSong({ ...state.song(), filePath: 'D:\\Contents\\8.mp3' })
      return {
        ok: true,
        result: { filePath: 'D:\\Contents\\7.mp3', hotCues: [{ slot: 1, sec: 30 }] }
      }
    })
    await state.hot.handleDeckHotCuePress('top', 1)
    expect(state.setSong).not.toHaveBeenCalled()
  })
  it('keeps desktop rekordbox sources read only', async () => {
    const state = fixture()
    state.song().externalSourceKind = 'desktop'
    await state.hot.handleDeckHotCuePress('top', 1)
    await state.memory.handleDeckMemoryCueCreate('top')
    expect(invoke).not.toHaveBeenCalled()
  })
})
