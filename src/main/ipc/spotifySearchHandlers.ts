import { app, ipcMain, shell } from 'electron'
import { openSpotifySearchWithFallback } from '../services/spotifySearch'

export const registerSpotifySearchHandlers = (): void => {
  ipcMain.handle('spotify:search', async (_event, query: unknown) =>
    openSpotifySearchWithFallback(query, {
      platform: process.platform,
      getApplicationNameForProtocol: (url) => app.getApplicationNameForProtocol(url),
      openExternal: (url) => shell.openExternal(url)
    })
  )
}
