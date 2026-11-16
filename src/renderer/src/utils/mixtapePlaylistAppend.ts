import { rendererFilePathKey } from '@renderer/utils/filePathComparison'
import confirm from '@renderer/components/confirmDialog'
import openSelectSongListDialog from '@renderer/components/selectSongListDialog'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { toIpcCloneablePayload } from './ipcCloneablePayload'
import type { LibraryTransferActionMode } from '@renderer/utils/libraryTransfer'
import type {
  IPioneerPlaylistTrack,
  ISongHotCue,
  ISongInfo,
  ISongMemoryCue
} from '../../../types/globals'

type MixtapeAppendInfo = {
  filePath: string
  fileName: string
  fileFormat: string
  cover: null
  title: string | undefined
  artist: string | undefined
  album: string | undefined
  duration: string
  genre: string | undefined
  label: string | undefined
  bitrate: number | undefined
  container: string | undefined
  key: string | undefined
  keyAnalysisAlgorithmVersion: number | undefined
  originalKey: string | undefined
  originalBpm: number | undefined
  energyScore: number | undefined
  energyAlgorithmVersion: number | undefined
  energyAnalysis: ISongInfo['energyAnalysis']
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
}

type MixtapeAppendItem = {
  filePath: string
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  info: MixtapeAppendInfo
}

type MixtapeAppendResult = {
  inserted?: number
  skippedNoBpm?: number
}

type SongSnapshotInput = Partial<ISongInfo> & Partial<IPioneerPlaylistTrack>

export type MixtapeAppendSourceEntry = {
  song: ISongInfo
  originPlaylistUuid?: string
  originPathSnapshot?: string
}

const normalizePathKey = (value: string) => rendererFilePathKey(String(value || ''))

const resolveFileNameAndFormat = (filePath: string) => {
  const baseName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop() || ''
  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts.pop() || '' : ''
  return {
    fileName: baseName,
    fileFormat: ext ? ext.toUpperCase() : ''
  }
}

const buildSongSnapshot = (
  filePath: string,
  song?: SongSnapshotInput | null
): MixtapeAppendInfo => {
  const meta = resolveFileNameAndFormat(filePath)
  return {
    filePath,
    fileName: String(song?.fileName || meta.fileName),
    fileFormat: String(song?.fileFormat || meta.fileFormat),
    cover: null,
    title: song?.title ?? meta.fileName,
    artist: song?.artist || undefined,
    album: song?.album || undefined,
    duration: song?.duration ?? '',
    genre: song?.genre || undefined,
    label: song?.label || undefined,
    bitrate: song?.bitrate,
    container: song?.container || undefined,
    key: song?.key,
    keyAnalysisAlgorithmVersion: song?.keyAnalysisAlgorithmVersion,
    originalKey: song?.key,
    originalBpm: song?.bpm,
    energyScore: song?.energyScore,
    energyAlgorithmVersion: song?.energyAlgorithmVersion,
    energyAnalysis: song?.energyAnalysis,
    hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
  }
}

const emitNoBpmMixtapeHint = (count: number) => {
  const skipped = Math.max(0, Math.round(Number(count) || 0))
  if (skipped <= 0) return
  emitter.emit('songsArea/clipboardHint', {
    message: skipped > 1 ? t('mixtape.noBpmSkipped', { count: skipped }) : t('mixtape.noBpmBlocked')
  })
}

const emitAppendResultHint = (inserted: number, skippedNoBpm: number) => {
  emitter.emit('songsArea/clipboardHint', {
    message:
      skippedNoBpm > 0
        ? t('mixtape.addedToMixtapeWithNoBpmSkipped', {
            count: inserted,
            skipped: skippedNoBpm
          })
        : t('mixtape.addedToMixtape', { count: inserted })
  })
}

const chooseMixtapeTarget = async (actionMode: LibraryTransferActionMode) => {
  const target = await openSelectSongListDialog({
    libraryName: 'MixtapeLibrary',
    actionMode
  })
  return target === 'cancel' ? '' : target.uuid
}

const appendItemsToMixtape = async (playlistId: string, rawItems: MixtapeAppendItem[]) => {
  const items = rawItems
  const skippedBySnapshot = 0
  if (!items.length) {
    emitNoBpmMixtapeHint(skippedBySnapshot)
    return
  }

  const result = (await window.electron.ipcRenderer.invoke(
    'mixtape:append',
    toIpcCloneablePayload({ playlistId, items })
  )) as MixtapeAppendResult | null
  const skippedNoBpm = skippedBySnapshot + Math.max(0, Number(result?.skippedNoBpm || 0))
  const inserted = Math.max(0, Number(result?.inserted || 0))
  if (inserted <= 0) {
    emitNoBpmMixtapeHint(skippedNoBpm)
    return
  }
  emitter.emit('playlistContentChanged', { uuids: [playlistId] })
  emitAppendResultHint(inserted, skippedNoBpm)
}

export const appendOrderedTracksToMixtape = async ({
  entries,
  actionMode = 'move'
}: {
  entries: MixtapeAppendSourceEntry[]
  actionMode?: LibraryTransferActionMode
}) => {
  const rawItems = entries
    .filter((entry) => !entry.song.fileMissing && String(entry.song.filePath || '').trim())
    .map((entry): MixtapeAppendItem => {
      const filePath = String(entry.song.filePath || '').trim()
      return {
        filePath,
        originPlaylistUuid: entry.originPlaylistUuid || null,
        originPathSnapshot: entry.originPathSnapshot || null,
        info: buildSongSnapshot(filePath, entry.song)
      }
    })

  if (!rawItems.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('mixtape.noTracksToAdd')],
      confirmShow: false
    })
    return
  }

  const targetPlaylistId = await chooseMixtapeTarget(actionMode)
  if (!targetPlaylistId) return
  await appendItemsToMixtape(targetPlaylistId, rawItems)
}

const filterExistingPioneerTracks = async (tracks: IPioneerPlaylistTrack[]) => {
  const candidates = tracks.filter(
    (track) => !track.fileMissing && String(track.filePath || '').trim()
  )
  const filePaths = candidates.map((track) => String(track.filePath || '').trim())
  if (!filePaths.length) return []

  const existsMap = (await window.electron.ipcRenderer.invoke(
    'check-paths-exist',
    filePaths
  )) as Record<string, boolean>
  return candidates.filter((track) => Boolean(existsMap[String(track.filePath || '').trim()]))
}

/**
 * 把一批本地文件加进混音。
 *
 * 先复制进混音自己的 vault，再追加。
 *
 * 复制失败的那首**不进混音**——这一点和 `copyPioneerTracksToMixtape` 一致，也和"混音不能
 * 依赖别人的缓存目录"这条原则一致：源是网易云的 `.store`，用户随时可能在设置里清缓存，
 * 一旦清掉，混音里就会出现一批断掉的引用。宁可少加几首并明确告知，也不要留下暗雷。
 */
export const appendDownloadedFilesToMixtape = async ({
  playlistId,
  entries
}: {
  playlistId: string
  entries: Array<{ filePath: string; song?: SongSnapshotInput | null }>
}) => {
  const sourcePaths = entries
    .map((entry) => String(entry.filePath || '').trim())
    .filter((filePath) => filePath.length > 0)
  if (!playlistId || sourcePaths.length === 0) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('mixtape.noTracksToAdd')],
      confirmShow: false
    })
    return
  }

  const copiedMap = new Map<string, string>()
  try {
    const copied = (await window.electron.ipcRenderer.invoke('mixtape:copy-files-to-vault', {
      filePaths: sourcePaths
    })) as Array<{ sourcePath: string; targetPath: string }>
    for (const item of Array.isArray(copied) ? copied : []) {
      if (item?.sourcePath && item?.targetPath) {
        copiedMap.set(normalizePathKey(item.sourcePath), item.targetPath)
      }
    }
  } catch {}

  const rawItems = entries
    .map((entry): MixtapeAppendItem | null => {
      const sourcePath = String(entry.filePath || '').trim()
      if (!sourcePath) return null
      const targetPath = copiedMap.get(normalizePathKey(sourcePath))
      if (!targetPath) return null
      return {
        filePath: targetPath,
        originPlaylistUuid: null,
        originPathSnapshot: '网易云音乐',
        info: buildSongSnapshot(targetPath, entry.song)
      }
    })
    .filter((item): item is MixtapeAppendItem => item !== null)

  if (!rawItems.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('netease.mixtapeVaultCopyFailed')],
      confirmShow: false
    })
    return
  }

  await appendItemsToMixtape(playlistId, rawItems)
}

export const copyPioneerTracksToMixtape = async ({
  tracks,
  originPathSnapshot
}: {
  tracks: IPioneerPlaylistTrack[]
  originPathSnapshot: string
}) => {
  const existingTracks = await filterExistingPioneerTracks(tracks)
  if (!existingTracks.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('mixtape.noTracksToAdd')],
      confirmShow: false
    })
    return
  }

  const targetPlaylistId = await chooseMixtapeTarget('copy')
  if (!targetPlaylistId) return

  const copiedTracks = (await window.electron.ipcRenderer.invoke('mixtape:copy-files-to-vault', {
    filePaths: existingTracks.map((track) => String(track.filePath || '').trim())
  })) as Array<{ sourcePath: string; targetPath: string }>

  const copiedPathMap = new Map(
    copiedTracks.map((item) => [normalizePathKey(item.sourcePath), item.targetPath])
  )
  const rawItems = existingTracks
    .map((track): MixtapeAppendItem | null => {
      const sourcePath = String(track.filePath || '').trim()
      const targetPath = copiedPathMap.get(normalizePathKey(sourcePath))
      if (!targetPath) return null
      return {
        filePath: targetPath,
        originPathSnapshot,
        info: buildSongSnapshot(targetPath, track)
      }
    })
    .filter((item): item is MixtapeAppendItem => item !== null)

  if (!rawItems.length) {
    throw new Error('MIXTAPE_COPY_TO_VAULT_FAILED')
  }

  await appendItemsToMixtape(targetPlaylistId, rawItems)
}
