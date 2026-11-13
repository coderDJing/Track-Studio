import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyOptionalComponentDownloadState,
  downloadOptionalComponent,
  ensureOptionalComponentStatesLoaded,
  isOptionalComponentReady,
  normalizeOptionalComponentDownloadState,
  resetOptionalComponentDownloadsForTests,
  sanitizeOptionalComponentErrorMessage,
  useOptionalComponentDownloads
} from './useOptionalComponentDownloads'

const invoke = vi.fn()

const baseState = (overrides: Record<string, unknown> = {}) => ({
  id: 'stem-model-htdemucs',
  status: 'downloading',
  percent: 20,
  downloadedBytes: 1024,
  totalBytes: 4096,
  error: '',
  updatedAt: 100,
  ...overrides
})

beforeEach(() => {
  invoke.mockReset()
  resetOptionalComponentDownloadsForTests()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke, on: vi.fn() } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('optional component download state', () => {
  it('loads memory state at startup without triggering any download', async () => {
    invoke.mockResolvedValue([
      baseState(),
      baseState({ id: 'rekordbox-desktop-runtime', status: 'failed', percent: 0 })
    ])

    await ensureOptionalComponentStatesLoaded()

    expect(invoke.mock.calls).toEqual([['optional-component:states']])
    const { entries } = useOptionalComponentDownloads()
    expect(entries.value.map((entry) => entry.id)).toEqual([
      'stem-model-htdemucs',
      'rekordbox-desktop-runtime'
    ])
  })

  it('keeps multiple component states independent and ignores bad payloads', async () => {
    applyOptionalComponentDownloadState(normalizeOptionalComponentDownloadState(baseState())!)
    applyOptionalComponentDownloadState(
      normalizeOptionalComponentDownloadState(
        baseState({ id: 'stem-model-mdx_extra_q', status: 'installing', percent: 100 })
      )!
    )

    const { entries } = useOptionalComponentDownloads()
    expect(entries.value.map((entry) => [entry.id, entry.status])).toEqual([
      ['stem-model-htdemucs', 'downloading'],
      ['stem-model-mdx_extra_q', 'installing']
    ])

    for (const bad of [null, 'x', [], { id: 'unknown', status: 'downloading' }]) {
      expect(normalizeOptionalComponentDownloadState(bad)).toBeUndefined()
    }
    expect(
      normalizeOptionalComponentDownloadState(baseState({ status: 'mystery' }))
    ).toBeUndefined()
    expect(
      normalizeOptionalComponentDownloadState(baseState({ percent: Number.NaN }))?.percent
    ).toBe(0)
  })

  it('sanitizes failure reasons before showing them', () => {
    const sanitized = sanitizeOptionalComponentErrorMessage(
      'download failed https://user:pass@example.com/a?token=abc at C:\\Users\\me\\manifest.json pid=1234'
    )
    expect(sanitized).not.toMatch(/user|pass|token|C:|json|1234|example\.com/i)
    expect(sanitizeOptionalComponentErrorMessage('network down')).toBe('network down')
    expect(sanitizeOptionalComponentErrorMessage(undefined)).toBe('')
  })

  it('reuses a ready component without starting a download', () => {
    applyOptionalComponentDownloadState(
      normalizeOptionalComponentDownloadState(baseState({ status: 'ready', percent: 100 }))!
    )
    const { entries } = useOptionalComponentDownloads()
    expect(entries.value[0]).toMatchObject({ status: 'ready', percent: 100 })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('retries a failed component through the download channel and reuses ready state', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'optional-component:download') return { ok: true }
      if (channel === 'optional-component:states') {
        return [baseState({ id: 'stem-model-htdemucs', status: 'ready', percent: 100 })]
      }
      return []
    })

    const { retry, entries } = useOptionalComponentDownloads()
    await retry('stem-model-htdemucs')

    expect(invoke).toHaveBeenCalledWith('optional-component:download', 'stem-model-htdemucs')
    expect(isOptionalComponentReady('stem-model-htdemucs')).toBe(true)
    expect(entries.value[0]).toMatchObject({ id: 'stem-model-htdemucs', status: 'ready' })
  })

  it('reports download failure without dropping the visible failed state', async () => {
    applyOptionalComponentDownloadState(
      normalizeOptionalComponentDownloadState(
        baseState({ id: 'rekordbox-desktop-runtime', status: 'failed', percent: 0 })
      )!
    )
    invoke.mockResolvedValue({ ok: false, error: 'network down' })

    await expect(downloadOptionalComponent('rekordbox-desktop-runtime')).resolves.toEqual({
      ok: false,
      error: 'network down'
    })
    const { entries, hasEntries } = useOptionalComponentDownloads()
    expect(hasEntries.value).toBe(true)
    expect(entries.value[0]).toMatchObject({
      id: 'rekordbox-desktop-runtime',
      status: 'failed'
    })
  })
})
