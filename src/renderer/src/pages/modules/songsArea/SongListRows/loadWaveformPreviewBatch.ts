import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
import {
  isIcloudWaveformPath,
  loadIcloudWaveformPreviewBatch
} from '@renderer/utils/icloudWaveformPreview'

type WaveformPreviewItem = { filePath: string; data: WaveformListPreviewData | null }

export const loadWaveformPreviewBatch = async (
  filePaths: string[],
  resolveListRoot: (filePath: string) => string
): Promise<WaveformPreviewItem[] | null> => {
  const cloudPaths = filePaths.filter(isIcloudWaveformPath)
  const libraryPaths = filePaths.filter((filePath) => !isIcloudWaveformPath(filePath))
  const cloudItems = cloudPaths.length ? await loadIcloudWaveformPreviewBatch(cloudPaths) : []
  if (!libraryPaths.length) return cloudItems
  const groups = new Map<string, string[]>()
  for (const filePath of libraryPaths) {
    const listRoot = resolveListRoot(filePath)
    const group = groups.get(listRoot) || []
    group.push(filePath)
    groups.set(listRoot, group)
  }
  try {
    const responses = await Promise.all(
      Array.from(groups.entries()).map(async ([listRoot, groupedFilePaths]) => {
        const response: { items?: WaveformPreviewItem[] } | null =
          await window.electron.ipcRenderer.invoke('waveform-list-preview-cache:batch', {
            listRoot,
            filePaths: groupedFilePaths,
            queueIfMissing: false
          })
        return Array.isArray(response?.items) ? response.items : []
      })
    )
    return [...cloudItems, ...responses.flat()]
  } catch {
    return cloudItems.length ? cloudItems : null
  }
}
