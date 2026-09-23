import {
  buildSpotifyClientSearchUrl,
  buildSpotifyWebSearchUrl,
  type SpotifySearchOpenResult
} from '@shared/spotifySearch'

type SpotifySearchDependencies = {
  platform: NodeJS.Platform
  getApplicationNameForProtocol: (url: string) => string
  openExternal: (url: string) => Promise<void>
}

const supportsSpotifyDesktopProtocol = (platform: NodeJS.Platform): boolean =>
  platform === 'win32' || platform === 'darwin'

const hasSpotifyProtocolHandler = (
  clientUrl: string,
  dependencies: SpotifySearchDependencies
): boolean | null => {
  if (!supportsSpotifyDesktopProtocol(dependencies.platform)) return false
  try {
    return dependencies.getApplicationNameForProtocol(clientUrl).trim().length > 0
  } catch {
    return null
  }
}

export const openSpotifySearchWithFallback = async (
  rawQuery: unknown,
  dependencies: SpotifySearchDependencies
): Promise<SpotifySearchOpenResult> => {
  const clientUrl = buildSpotifyClientSearchUrl(rawQuery)
  const webUrl = buildSpotifyWebSearchUrl(rawQuery)
  if (!clientUrl || !webUrl) return { success: false, reason: 'empty-query' }

  const hasProtocolHandler = hasSpotifyProtocolHandler(clientUrl, dependencies)
  if (hasProtocolHandler !== false) {
    try {
      await dependencies.openExternal(clientUrl)
      return { success: true, target: 'client' }
    } catch {
      // The handler may have been removed after detection; continue with the web search.
    }
  }

  try {
    await dependencies.openExternal(webUrl)
    return { success: true, target: 'web' }
  } catch {
    return { success: false, reason: 'open-failed' }
  }
}
