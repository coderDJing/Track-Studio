import { describe, expect, it } from 'vitest'
import {
  buildSpotifyClientSearchUrl,
  buildSpotifyWebSearchUrl,
  normalizeSpotifySearchQuery
} from './spotifySearch'

describe('Spotify search URLs', () => {
  it('normalizes whitespace and encodes a search for both targets', () => {
    const query = '  Daft   Punk / Get Lucky  '
    expect(normalizeSpotifySearchQuery(query)).toBe('Daft Punk / Get Lucky')
    expect(buildSpotifyClientSearchUrl(query)).toBe(
      'spotify:search:Daft%20Punk%20%2F%20Get%20Lucky'
    )
    expect(buildSpotifyWebSearchUrl(query)).toBe(
      'https://open.spotify.com/search/Daft%20Punk%20%2F%20Get%20Lucky'
    )
  })

  it('does not build a URL for non-string or empty values', () => {
    expect(buildSpotifyClientSearchUrl(null)).toBe('')
    expect(buildSpotifyWebSearchUrl('   ')).toBe('')
  })

  it('keeps encoded URLs within the Windows shell limit without splitting emoji', () => {
    const clientUrl = buildSpotifyClientSearchUrl('🎵'.repeat(300))
    expect(clientUrl).toBe(`spotify:search:${'%F0%9F%8E%B5'.repeat(150)}`)
    expect(clientUrl.length).toBeLessThan(2081)
  })
})
