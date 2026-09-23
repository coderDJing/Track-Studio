import { describe, expect, it, vi } from 'vitest'
import { openSpotifySearchWithFallback } from './spotifySearch'

const query = 'Daft Punk Get Lucky'
const clientUrl = 'spotify:search:Daft%20Punk%20Get%20Lucky'
const webUrl = 'https://open.spotify.com/search/Daft%20Punk%20Get%20Lucky'

describe('openSpotifySearchWithFallback', () => {
  it('opens the desktop client when the Spotify protocol is registered', async () => {
    const openExternal = vi.fn(async () => undefined)

    await expect(
      openSpotifySearchWithFallback(query, {
        platform: 'win32',
        getApplicationNameForProtocol: () => 'Spotify',
        openExternal
      })
    ).resolves.toEqual({ success: true, target: 'client' })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(clientUrl)
  })

  it('opens the web search when no protocol handler is registered', async () => {
    const openExternal = vi.fn(async () => undefined)

    await expect(
      openSpotifySearchWithFallback(query, {
        platform: 'darwin',
        getApplicationNameForProtocol: () => '',
        openExternal
      })
    ).resolves.toEqual({ success: true, target: 'web' })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(webUrl)
  })

  it('falls back to the web search when opening the client fails', async () => {
    const openExternal = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('client unavailable'))
      .mockResolvedValueOnce(undefined)

    await expect(
      openSpotifySearchWithFallback(query, {
        platform: 'win32',
        getApplicationNameForProtocol: () => 'Spotify',
        openExternal
      })
    ).resolves.toEqual({ success: true, target: 'web' })
    expect(openExternal.mock.calls).toEqual([[clientUrl], [webUrl]])
  })

  it('reports a failure when neither target can be opened', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('unavailable')
    })

    await expect(
      openSpotifySearchWithFallback(query, {
        platform: 'win32',
        getApplicationNameForProtocol: () => 'Spotify',
        openExternal
      })
    ).resolves.toEqual({ success: false, reason: 'open-failed' })
  })

  it('does not open anything for an empty query', async () => {
    const openExternal = vi.fn(async () => undefined)

    await expect(
      openSpotifySearchWithFallback('   ', {
        platform: 'win32',
        getApplicationNameForProtocol: () => 'Spotify',
        openExternal
      })
    ).resolves.toEqual({ success: false, reason: 'empty-query' })
    expect(openExternal).not.toHaveBeenCalled()
  })
})
