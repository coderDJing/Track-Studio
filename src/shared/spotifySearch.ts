const MAX_SPOTIFY_SEARCH_QUERY_CODE_POINTS = 150

export const normalizeSpotifySearchQuery = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replace(/\s+/g, ' ')
  return Array.from(normalized).slice(0, MAX_SPOTIFY_SEARCH_QUERY_CODE_POINTS).join('')
}

export const buildSpotifyClientSearchUrl = (value: unknown): string => {
  const query = normalizeSpotifySearchQuery(value)
  return query ? `spotify:search:${encodeURIComponent(query)}` : ''
}

export const buildSpotifyWebSearchUrl = (value: unknown): string => {
  const query = normalizeSpotifySearchQuery(value)
  return query ? `https://open.spotify.com/search/${encodeURIComponent(query)}` : ''
}

export type SpotifySearchOpenResult =
  | { success: true; target: 'client' | 'web' }
  | { success: false; reason: 'empty-query' | 'open-failed' }
