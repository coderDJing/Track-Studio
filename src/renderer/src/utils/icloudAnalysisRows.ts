import { rendererFilePathKey } from '@renderer/utils/filePathComparison'
import {
  projectSongBeatGridMapV2ToFixedGrid,
  type SongBeatGridMapV2
} from '@shared/songBeatGridMapV2'

export type IcloudAnalysisRow = {
  key?: string
  bpm?: number
  beatGridMap?: SongBeatGridMapV2
}

export type IcloudAnalysisItem = {
  relative?: string
  filePath?: string
  key?: string
  beatGridMap?: unknown
}

const pathKey = (filePath: string) => rendererFilePathKey(filePath)

/** 双轨分析回传的是本机路径。先记下来，列表才能在绑定完成前就把 BPM 和波形对上这一行。 */
export function rememberIcloudAnalysisPath(
  paths: Map<string, string>,
  filePath: string,
  relative: string
) {
  const key = pathKey(filePath)
  const logical = relative.trim()
  if (!key || !logical) return
  paths.set(key, logical)
}

export function icloudListKeyForAnalysisPath(
  paths: Map<string, string>,
  filePath: string | undefined
) {
  const relative = paths.get(pathKey(filePath || ''))
  return relative ? `icloud-song:${relative}` : ''
}

export function publishIcloudBoundAnalysis(
  items: IcloudAnalysisItem[],
  remember: (items: IcloudAnalysisItem[]) => void,
  notify: (key: string) => void
) {
  remember(items)
  for (const item of items) if (item.relative) notify(`icloud-song:${item.relative}`)
}

export function icloudLocalPathForRelative(paths: Map<string, string>, relative: string) {
  const logical = relative.trim()
  if (!logical) return ''
  for (const [filePath, stored] of paths) {
    if (stored === logical) return filePath
  }
  return ''
}

export function mergeIcloudAnalysis(
  current: Record<string, IcloudAnalysisRow>,
  paths: Map<string, string>,
  items: IcloudAnalysisItem[]
) {
  const next = { ...current }
  let changed = false
  for (const item of Array.isArray(items) ? items : []) {
    if (!item.relative || !item.filePath) continue
    paths.set(pathKey(item.filePath), item.relative)
    const bpm = projectSongBeatGridMapV2ToFixedGrid(item.beatGridMap as SongBeatGridMapV2)?.bpm
    const previous = next[item.relative]
    next[item.relative] = {
      ...previous,
      ...(item.key ? { key: item.key } : {}),
      ...(item.beatGridMap ? { beatGridMap: item.beatGridMap as SongBeatGridMapV2 } : {}),
      ...(typeof bpm === 'number' && bpm > 0 ? { bpm } : {})
    }
    changed = true
  }
  return changed ? next : current
}

export async function bindIcloudAnalysisRows(
  relatives: string[],
  token: string,
  read: (relatives: string[], token: string) => Promise<IcloudAnalysisItem[]>
) {
  if (!relatives.length || !token) return []
  try {
    const items = await read(relatives, token)
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

export function icloudAnalysisItemForPath(
  paths: Map<string, string>,
  filePath: string | undefined,
  patch: Omit<IcloudAnalysisItem, 'relative' | 'filePath'>
): IcloudAnalysisItem | null {
  const normalized = pathKey(filePath || '')
  const relative = paths.get(normalized)
  if (!normalized || !relative) return null
  return { relative, filePath: normalized, ...patch }
}

type IcloudAnalysisLivePayload = { filePath?: string; keyText?: string; beatGridMap?: unknown }

/** 列表行的地址是逻辑键。分析事件带本机路径，这里译回那一行。 */
export function subscribeIcloudAnalysisLive(options: {
  paths: Map<string, string>
  remember: (items: IcloudAnalysisItem[]) => void
  onWaveformKey: (key: string) => void
}) {
  const ipc = window.electron.ipcRenderer
  const onKey = (_event: unknown, payload: IcloudAnalysisLivePayload) => {
    const item = icloudAnalysisItemForPath(options.paths, payload?.filePath, {
      key: payload?.keyText
    })
    if (item?.key) options.remember([item])
  }
  const onGrid = (_event: unknown, payload: IcloudAnalysisLivePayload) => {
    const item = icloudAnalysisItemForPath(options.paths, payload?.filePath, {
      beatGridMap: payload?.beatGridMap
    })
    if (item?.beatGridMap) options.remember([item])
  }
  const onBatch = (_event: unknown, payloads: IcloudAnalysisLivePayload[]) => {
    if (!Array.isArray(payloads)) return
    for (const payload of payloads) onGrid(_event, payload)
  }
  const onWaveform = (_event: unknown, payload: IcloudAnalysisLivePayload) => {
    const key = icloudListKeyForAnalysisPath(options.paths, payload?.filePath)
    if (key) options.onWaveformKey(key)
  }
  ipc.on('song-key-updated', onKey)
  ipc.on('song-grid-updated', onGrid)
  ipc.on('song-grid-batch-updated', onBatch)
  ipc.on('song-waveform-updated', onWaveform)
  return () => {
    ipc.removeListener('song-key-updated', onKey)
    ipc.removeListener('song-grid-updated', onGrid)
    ipc.removeListener('song-grid-batch-updated', onBatch)
    ipc.removeListener('song-waveform-updated', onWaveform)
  }
}
