// Run: pnpm exec vitest run src/renderer/src/utils/bpmFixActions.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BpmFixSnapshot } from '@shared/bpmFix'

const { ensureRuntime } = vi.hoisted(() => ({ ensureRuntime: vi.fn(async () => true) }))
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  render: vi.fn()
}))
vi.mock('@renderer/utils/appContext', () => ({ attachAppContext: vi.fn() }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/components/BpmFixDialog.vue', () => ({ default: {} }))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => ({}) }))
vi.mock('@renderer/composables/useAnalysisRuntimeDownload', () => ({
  useAnalysisRuntimeDownload: () => ({ ensureAnalysisRuntimeForBpmFix: ensureRuntime })
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/utils/mitt', () => ({ default: { emit: vi.fn() } }))

const input = { filePaths: ['C:/Music/track.wav'], songListUUID: 'list', songListPath: 'C:/Music' }
let session: BpmFixSnapshot | null
const invoke = vi.fn(async (channel: string) => {
  if (channel === 'audio:bpm-fix:prepare') {
    session = {
      id: 'session',
      status: 'pending',
      stage: 'pending',
      current: 0,
      percent: 0,
      currentPercent: 0,
      tracks: [{ id: 'track', filePath: input.filePaths[0], status: 'pending' }]
    }
  }
  if (channel === 'audio:bpm-fix:analyze' && session) {
    session = { ...session, status: 'analyzing', stage: 'loading' }
  }
  return session
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  session = null
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke, on: vi.fn() } } })
  vi.stubGlobal('document', {
    createElement: () => ({ remove: vi.fn() }),
    body: { appendChild: vi.fn() }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('opening BPM drift repair', () => {
  it('opens the selected songs without starting analysis or checking runtime dependencies', async () => {
    const actions = await import('./bpmFixActions')
    await actions.startBpmFix(input)
    expect(actions.bpmFixDialogOpen.value).toBe(true)
    expect(actions.bpmFixSnapshot.value?.status).toBe('pending')
    expect(invoke).toHaveBeenCalledWith('audio:bpm-fix:prepare', input)
    expect(invoke.mock.calls.some(([channel]) => channel === 'audio:bpm-fix:analyze')).toBe(false)
    expect(ensureRuntime).not.toHaveBeenCalled()

    await actions.analyzeBpmFix()
    expect(ensureRuntime).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('audio:bpm-fix:analyze', 'session')
    expect(actions.bpmFixSnapshot.value?.status).toBe('analyzing')
  })

  it('does not start a closed session after the runtime prompt finishes', async () => {
    const actions = await import('./bpmFixActions')
    await actions.startBpmFix(input)
    let finishRuntimeCheck: (ready: boolean) => void = () => {}
    ensureRuntime.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishRuntimeCheck = resolve
        })
    )
    const analyzing = actions.analyzeBpmFix()
    actions.bpmFixSnapshot.value = null
    finishRuntimeCheck(true)
    await analyzing
    expect(invoke.mock.calls.some(([channel]) => channel === 'audio:bpm-fix:analyze')).toBe(false)
  })
})
