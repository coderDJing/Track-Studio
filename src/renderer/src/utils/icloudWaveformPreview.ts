import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import { isIcloudPlaybackUrl } from '@shared/icloudLibrary'
import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
import { normalizeWaveformSurfaceData } from '@shared/waveformSurfaceCache'
import { icloudLocalPathForRelative } from './icloudAnalysisRows'
import { icloudInvoke } from './icloudLibrary'

export type IcloudWaveformPreviewSource = { relative: string; token: string }

export type IcloudWaveformPreviewLoader = {
  resolve: (filePath: string) => IcloudWaveformPreviewSource | null
  read: (
    relative: string,
    token: string,
    requestId: string
  ) => Promise<WaveformListPreviewData | null>
  cancel: (requestId: string) => void
}

type WaveformPreviewItem = { filePath: string; data: WaveformListPreviewData | null }

let loader: IcloudWaveformPreviewLoader | null = null
let generation = 0

export function isIcloudWaveformPath(filePath: string) {
  return filePath.startsWith('icloud-song:') || filePath.startsWith('frkb-preview://icloud/')
}

export function registerIcloudWaveformPreviewLoader(next: IcloudWaveformPreviewLoader | null) {
  generation += 1
  loader = next
}

/** 主播放器只借用列表预览的峰值，不写入曲库分析。 */
export function toPlayerCompactWaveform(
  data: WaveformListPreviewData | null | undefined
): CompactVisualWaveformData | null {
  if (!data?.detailPeakTop?.length) return null
  return {
    version: data.version,
    parameterVersion: data.parameterVersion,
    duration: data.duration,
    sampleRate: data.sampleRate,
    detailRate: data.detailRate,
    overviewRate: data.overviewRate,
    bodyRateDivisor: data.bodyRateDivisor,
    colorRateDivisor: data.colorRateDivisor,
    detailPeakTop: data.detailPeakTop,
    detailPeakBottom: data.detailPeakBottom,
    detailBody: data.detailBody,
    colorIndex: data.colorIndex,
    colorLow: data.colorLow,
    colorMid: data.colorMid,
    colorHigh: data.colorHigh,
    colorRed: data.colorRed,
    colorGreen: data.colorGreen,
    colorBlue: data.colorBlue,
    overviewTop: data.overviewTop,
    overviewBottom: data.overviewBottom
  }
}

/** 双轨分析写进外部缓存的波形。列表预览列读这份，而不是只解析 wav。 */
export async function readIcloudAnalyzedListWaveform(filePath: string) {
  const localPath = String(filePath || '').trim()
  if (!localPath) return null
  try {
    const response = (await window.electron.ipcRenderer.invoke('waveform-list-preview-cache:load', {
      listRoot: '',
      filePath: localPath,
      queueIfMissing: false
    })) as { data?: unknown } | null
    const normalized = normalizeWaveformSurfaceData(response?.data, 'listPreview')
    return normalized?.surfaceKind === 'listPreview' ? normalized : null
  } catch {
    return null
  }
}

export async function readIcloudSongListWaveform(
  paths: Map<string, string>,
  relative: string,
  token: string,
  requestId: string
): Promise<WaveformListPreviewData | null> {
  const analyzed = await readIcloudAnalyzedListWaveform(icloudLocalPathForRelative(paths, relative))
  if (analyzed) return analyzed
  const raw = await icloudInvoke<unknown>('icloud:waveform-preview', [relative], token, requestId)
  const normalized = normalizeWaveformSurfaceData(raw, 'listPreview')
  return normalized?.surfaceKind === 'listPreview' ? normalized : null
}

export async function loadIcloudPlayerWaveform(
  song:
    | {
        filePath?: string
        icloudOrigin?: { relativePath?: string; rootToken?: string }
      }
    | null
    | undefined
) {
  const origin = song?.icloudOrigin
  const current = loader
  if (!origin?.relativePath || !origin.rootToken || !current) return null
  if (!isIcloudPlaybackUrl(song?.filePath || '')) return null
  const version = generation
  const requestId = crypto.randomUUID()
  try {
    const data = await current.read(origin.relativePath, origin.rootToken, requestId)
    if (version !== generation || current !== loader) return null
    const normalized = data ? normalizeWaveformSurfaceData(data, 'listPreview') : null
    return toPlayerCompactWaveform(normalized?.surfaceKind === 'listPreview' ? normalized : null)
  } catch {
    return null
  } finally {
    if (version !== generation || current !== loader) current.cancel(requestId)
  }
}

export async function loadIcloudWaveformPreviewBatch(
  filePaths: string[]
): Promise<WaveformPreviewItem[]> {
  const current = loader
  const version = generation
  const items: WaveformPreviewItem[] = []
  if (!current) return filePaths.map((filePath) => ({ filePath, data: null }))
  for (const filePath of filePaths) {
    if (version !== generation || current !== loader) {
      items.push({ filePath, data: null })
      continue
    }
    const source = current.resolve(filePath)
    if (!source) {
      items.push({ filePath, data: null })
      continue
    }
    const requestId = crypto.randomUUID()
    try {
      const data = await current.read(source.relative, source.token, requestId)
      if (
        version !== generation ||
        current !== loader ||
        current.resolve(filePath)?.token !== source.token
      ) {
        items.push({ filePath, data: null })
        continue
      }
      items.push({
        filePath,
        data: data ? normalizeWaveformSurfaceData(data, 'listPreview') : null
      })
    } catch {
      if (version === generation && current === loader) items.push({ filePath, data: null })
      else items.push({ filePath, data: null })
    } finally {
      if (version !== generation || current !== loader) current.cancel(requestId)
    }
  }
  return items
}
