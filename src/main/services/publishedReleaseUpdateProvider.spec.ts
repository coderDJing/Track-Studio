import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { PublishedReleaseUpdateProvider } from './publishedReleaseUpdateProvider'
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'

vi.mock('../fetchWithSystemProxy', () => ({ fetchWithSystemProxy: vi.fn() }))

const current = '1.2.5-rc.202610031849'
const next = '1.2.5-rc.202610080044'
const later = '1.2.5-rc.202610090044'
const fetchMock = vi.mocked(fetchWithSystemProxy)

const release = (tag: string, platform = 'win32') => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes('-'),
  published_at: '2026-10-08T01:00:00Z',
  body: 'Release notes',
  assets: [
    { name: platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml', size: 200, state: 'uploaded' },
    { name: `Setup-${tag}.${platform === 'darwin' ? 'zip' : 'exe'}`, size: 100, state: 'uploaded' }
  ]
})

const manifest = (tag: string, extension = 'exe') =>
  new Response(
    `version: ${tag}\nfiles:\n  - url: Setup-${tag}.${extension}\n    sha512: checksum\n    size: 100\n`
  )

const provider = (version = current, platform: 'win32' | 'darwin' = 'win32') =>
  new PublishedReleaseUpdateProvider(
    { provider: 'custom' },
    { currentVersion: { version } } as unknown as AppUpdater,
    { platform, isUseMultipleRangeRequest: false } as ProviderRuntimeOptions
  )

beforeEach(() => fetchMock.mockReset())

describe('published release update checks', () => {
  it('ignores deleted tags absent from the API and reports the installed RC as current', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([release(current)]))
    expect((await provider().getLatestVersion()).version).toBe(current)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/releases?per_page=100')
  })

  it('skips draft and incomplete newer releases and resolves the complete update files', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json([
        { ...release(later), draft: true },
        { ...release(later), assets: release(later).assets.slice(0, 1) },
        release(next)
      ])
    )
    fetchMock.mockResolvedValueOnce(manifest(later))
    fetchMock.mockResolvedValueOnce(manifest(next))
    const source = provider()
    const info = await source.getLatestVersion()
    expect(info.version).toBe(next)
    expect(info.releaseNotes).toBe('Release notes')
    expect(source.resolveFiles(info)[0].url.href).toBe(
      `https://github.com/coderDJing/Track-Studio/releases/download/${next}/Setup-${next}.exe`
    )
  })

  it('rechecks every time so a build becoming published is discovered', async () => {
    const source = provider()
    fetchMock.mockResolvedValueOnce(Response.json([release(current)]))
    expect((await source.getLatestVersion()).version).toBe(current)
    fetchMock.mockResolvedValueOnce(Response.json([release(next)]))
    fetchMock.mockResolvedValueOnce(manifest(next))
    expect((await source.getLatestVersion()).version).toBe(next)
  })

  it('skips a manifest removed after the API listing', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([release(later), release(next)]))
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    fetchMock.mockResolvedValueOnce(manifest(next))
    expect((await provider().getLatestVersion()).version).toBe(next)
  })

  it('keeps network and API errors visible instead of reporting no update', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }))
    await expect(provider().getLatestVersion()).rejects.toMatchObject({ statusCode: 403 })
    fetchMock.mockResolvedValueOnce(Response.json([release(next)]))
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(provider().getLatestVersion()).rejects.toMatchObject({ statusCode: 503 })
  })

  it('keeps RC, stable and resource releases in their own channels', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json([release('2.0.0'), release('demucs-runtime-assets-rc'), release(current)])
    )
    expect((await provider().getLatestVersion()).version).toBe(current)
    fetchMock.mockResolvedValueOnce(Response.json([release(next), release('1.2.5')]))
    fetchMock.mockResolvedValueOnce(manifest('1.2.5'))
    expect((await provider('1.2.4').getLatestVersion()).version).toBe('1.2.5')
  })

  it('selects the highest version even if API ordering differs', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([release(next), release(later)]))
    fetchMock.mockResolvedValueOnce(manifest(later))
    expect((await provider().getLatestVersion()).version).toBe(later)
  })

  it('requires macOS zip assets and latest-mac.yml', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([release(next, 'darwin')]))
    fetchMock.mockResolvedValueOnce(manifest(next, 'zip'))
    expect((await provider(current, 'darwin').getLatestVersion()).version).toBe(next)
    expect(String(fetchMock.mock.calls[1][0])).toContain('/latest-mac.yml')
  })

  it('rejects a mismatched manifest version or missing package size', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([release(next)]))
    fetchMock.mockResolvedValueOnce(manifest(later))
    expect((await provider().getLatestVersion()).version).toBe(current)
    const incomplete = release(next)
    incomplete.assets[1].size = 0
    fetchMock.mockResolvedValueOnce(Response.json([incomplete]))
    fetchMock.mockResolvedValueOnce(manifest(next))
    expect((await provider().getLatestVersion()).version).toBe(current)
  })
})
