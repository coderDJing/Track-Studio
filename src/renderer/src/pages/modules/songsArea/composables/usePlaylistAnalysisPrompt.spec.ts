import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive, ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import { usePlaylistAnalysisPrompt } from './usePlaylistAnalysisPrompt'

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(async () => ({ batchId: '', queued: 0, canceled: true })),
  invoke: vi.fn(async () => ({ filePaths: [] as string[] }))
}))

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: vi.fn(),
  onUnmounted: vi.fn()
}))
vi.mock('@renderer/utils/manualKeyAnalysis', async () => ({
  ...(await import('@renderer/utils/manualKeyAnalysisCompleteness')),
  promptAndQueueManualKeyAnalysisBatch: mocks.prompt
}))

const scopes: ReturnType<typeof effectScope>[] = []
const noBpmSong = (index: number): ISongInfo => ({
  filePath: `C:/music/ambient-${index}.wav`,
  fileName: `ambient-${index}.wav`,
  fileFormat: 'wav',
  cover: null,
  title: undefined,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  key: '2A',
  beatGridStatus: 'no-bpm'
})

const mountPrompt = (songs: ISongInfo[], missingWaveformFilePaths: string[] = []) => {
  const runtime = reactive({
    libraryAreaSelected: 'library',
    manualKeyAnalysisPendingFilePaths: [] as string[],
    analysisRuntime: { available: true },
    playlistAnalysisPromptDismissedSongListUUIDs: [] as string[]
  })
  const songsAreaState = reactive({
    songListUUID: 'ambient-playlist',
    songInfoArr: songs,
    missingWaveformFilePaths
  })
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() =>
    usePlaylistAnalysisPrompt({ runtime, songsAreaState, isMixtapeListView: ref(false) })
  )!
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke: mocks.invoke } } })
})

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.unstubAllGlobals()
})

describe('playlist entry analysis prompt', () => {
  it('does not prompt again for three completed no-BPM songs without energy or structure', async () => {
    const prompt = mountPrompt([noBpmSong(0), noBpmSong(1), noBpmSong(2)])

    await prompt.handleUserOpenedSongList('ambient-playlist')
    await prompt.handleUserOpenedSongList('ambient-playlist', { forceAnalysisPrompt: true })

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(prompt.playlistAnalysisActionVisible.value).toBe(false)
    expect(prompt.analysisPromptPending.value).toBe(false)
  })

  it('still prompts for genuinely missing key and waveform results in a no-BPM playlist', async () => {
    const missingKey = { ...noBpmSong(1), key: undefined }
    const missingWaveform = noBpmSong(2)
    const prompt = mountPrompt(
      [noBpmSong(0), missingKey, missingWaveform],
      [missingWaveform.filePath]
    )

    await prompt.handleUserOpenedSongList('ambient-playlist')

    expect(mocks.prompt).toHaveBeenCalledWith(
      [missingKey.filePath, missingWaveform.filePath],
      'tracks.analyzingPlaylist',
      expect.objectContaining({ missingWaveformFilePaths: [missingWaveform.filePath] })
    )
    expect(prompt.playlistAnalysisActionVisible.value).toBe(true)
  })
})
