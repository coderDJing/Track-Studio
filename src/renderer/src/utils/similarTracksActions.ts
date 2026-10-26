import { rendererFilePathKey } from '@renderer/utils/filePathComparison'
import confirm from '@renderer/components/confirmDialog'
import { loadRekordboxPlaylistTracks } from '@renderer/composables/rekordboxDesktop/useRekordboxTrackLoader'
import { t } from '@renderer/utils/translate'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type { IPioneerPlaylistTrack, IPioneerPlaylistTreeNode, ISongInfo } from 'src/types/globals'

type CollectRekordboxSimilarSeedsOptions = {
  nodes: IPioneerPlaylistTreeNode[]
  sourceKind: RekordboxSourceKind
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
  /** 可选进度回调，按"已处理歌单数 / 总歌单数"上报；不传则行为不变 */
  onProgress?: (processed: number, total: number) => void
}

const normalizeSeedKey = (song: ISongInfo) =>
  song.filePath
    ? rendererFilePathKey(song.filePath)
    : String(song.mixtapeItemId || song.setItemId || '').trim()

const resolveFileNameAndFormat = (filePath: string) => {
  const fileName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop() || ''
  const parts = fileName.split('.')
  const fileFormat = parts.length > 1 ? String(parts.pop() || '').toUpperCase() : ''
  return { fileName, fileFormat }
}

const collectPlayablePlaylistNodes = (
  nodes: IPioneerPlaylistTreeNode[]
): IPioneerPlaylistTreeNode[] => {
  const result: IPioneerPlaylistTreeNode[] = []
  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const node of items) {
      if (!node) continue
      if (!node.isFolder && !node.isSmartPlaylist && Number(node.id) > 0) {
        result.push(node)
      }
      if (Array.isArray(node.children)) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}

const mapRekordboxTrackToSimilarSeed = (
  track: IPioneerPlaylistTrack,
  sourceKind: RekordboxSourceKind,
  sourceRootPath?: string
): ISongInfo => {
  const filePath = String(track.filePath || '').trim()
  const meta = resolveFileNameAndFormat(filePath)
  return {
    filePath,
    fileName: track.fileName || meta.fileName,
    fileFormat: track.fileFormat || meta.fileFormat,
    cover: null,
    title: track.title || track.fileName || meta.fileName,
    artist: track.artist || undefined,
    album: track.album || undefined,
    duration: track.duration || '',
    genre: track.genre || undefined,
    label: track.label || undefined,
    bitrate: track.bitrate,
    container: track.container || undefined,
    key: track.key,
    bpm: track.bpm,
    hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(track.memoryCues) ? track.memoryCues.map((cue) => ({ ...cue })) : [],
    mixOrder: track.entryIndex,
    externalAnalyzePath: track.analyzePath || null,
    externalWaveformRootPath: sourceRootPath || null,
    externalSourceKind: sourceKind,
    pioneerCoverPath: track.coverPath || null,
    pioneerAnalyzePath: sourceKind === 'usb' ? track.analyzePath || null : null,
    pioneerDeviceRootPath: sourceKind === 'usb' ? sourceRootPath || null : null,
    mixtapeItemId: track.rowKey,
    fileMissing: track.fileMissing ?? false
  }
}

export const collectRekordboxSimilarTracksSeeds = async ({
  nodes,
  sourceKind,
  sourceRootPath,
  sourceLibraryType,
  onProgress
}: CollectRekordboxSimilarSeedsOptions): Promise<ISongInfo[]> => {
  const playlistNodes = collectPlayablePlaylistNodes(nodes)
  const total = playlistNodes.length
  const seeds: ISongInfo[] = []
  const seen = new Set<string>()

  onProgress?.(0, total)
  let processed = 0
  for (const node of playlistNodes) {
    const playlistId = Number(node.id) || 0
    if (playlistId <= 0) {
      processed += 1
      onProgress?.(processed, total)
      continue
    }
    const result = await loadRekordboxPlaylistTracks({
      sourceKind,
      playlistId,
      sourceRootPath,
      sourceLibraryType
    })
    const tracks = Array.isArray(result?.tracks) ? result.tracks : []
    for (const track of tracks) {
      if (track.fileMissing || !track.filePath) continue
      const song = mapRekordboxTrackToSimilarSeed(track, sourceKind, sourceRootPath)
      const key = normalizeSeedKey(song)
      if (!key || seen.has(key)) continue
      seen.add(key)
      seeds.push(song)
    }
    processed += 1
    onProgress?.(processed, total)
  }

  return seeds
}

export const openBatchSimilarTracksDialogForSeeds = async (seeds: ISongInfo[]) => {
  if (!seeds.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('similarTracks.batchNoSeeds')],
      confirmShow: false
    })
    return
  }
  const { default: openBatchSimilarTracksDialog } =
    await import('@renderer/components/batchSimilarTracksDialog')
  await openBatchSimilarTracksDialog(seeds)
}
