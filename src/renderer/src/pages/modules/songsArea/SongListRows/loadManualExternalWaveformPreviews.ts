import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
import type { ISongInfo } from 'src/types/globals'
import type { RekordboxSourceKind } from '@shared/rekordboxSources'
import { resolveSongExternalWaveformSource } from '@renderer/utils/rekordboxExternalSource'

const selectNativeExternalWaveformPaths = (
  paths: string[],
  resolveSong: (filePath: string) => ISongInfo | null | undefined,
  rootPath: string,
  sourceKind?: RekordboxSourceKind
) =>
  paths.filter((filePath) => {
    const song = resolveSong(filePath)
    return Boolean(
      song?.externalLibraryKind || resolveSongExternalWaveformSource(song, { rootPath, sourceKind })
    )
  })

export const loadManualExternalWaveformPreviews = async (params: {
  filePaths: string[]
  resolveSong: (filePath: string) => ISongInfo | null | undefined
  rootPath: string
  sourceKind?: RekordboxSourceKind
  inflight: Set<string>
  getVersion: (filePath: string) => number
  store: (filePath: string, data: WaveformListPreviewData) => void
  markReady: (filePath: string) => void
}) => {
  const ready = new Set<string>()
  const filePaths = selectNativeExternalWaveformPaths(
    params.filePaths,
    params.resolveSong,
    params.rootPath,
    params.sourceKind
  )
  if (!filePaths.length) return ready
  const versions = new Map(filePaths.map((filePath) => [filePath, params.getVersion(filePath)]))
  for (const filePath of filePaths) params.inflight.add(filePath)
  try {
    const response = (await window.electron.ipcRenderer.invoke(
      'waveform-list-preview-cache:batch',
      { filePaths, queueIfMissing: false, manualOnly: true }
    )) as { items?: Array<{ filePath: string; data: WaveformListPreviewData | null }> }
    for (const item of response?.items || []) {
      if (!item.data || params.getVersion(item.filePath) !== versions.get(item.filePath)) continue
      params.store(item.filePath, item.data)
      params.markReady(item.filePath)
      ready.add(item.filePath)
    }
  } catch {
    // A missing manual cache leaves the native preview available.
  } finally {
    for (const filePath of filePaths) params.inflight.delete(filePath)
  }
  return ready
}
