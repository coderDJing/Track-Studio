import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type {
  SetPackageExportResult,
  SetPackageFailure,
  SetPackageImportResult,
  SetPackagePickResult
} from '@shared/setPackage'
import type { IDir, ISongInfo } from '../../../../types/globals'
import { loadSetPlaylistSongs } from './libraryContextMenuHelpers'

type RuntimeStore = ReturnType<typeof useRuntimeStore>

const MAX_LISTED_FILES = 10

const confirmTaskBusy = async () => {
  await confirm({
    title: t('dialog.hint'),
    content: [t('import.waitForTask')],
    confirmShow: false
  })
}

const buildFileNameLines = (fileNames: string[] | undefined): string[] => {
  const names = Array.isArray(fileNames) ? fileNames.filter(Boolean) : []
  const lines = names.slice(0, MAX_LISTED_FILES)
  if (names.length > MAX_LISTED_FILES) {
    lines.push(t('library.setPackageMoreFiles', { count: names.length - MAX_LISTED_FILES }))
  }
  return lines
}

const showFailure = async (titleKey: string, failure: SetPackageFailure) => {
  const headlineByCode: Record<string, string> = {
    EMPTY_SET: t('library.setPackageEmptySet'),
    MISSING_FILES: t('library.setPackageMissingFiles'),
    TRACKS_MISMATCH: t('library.setPackageTracksChanged'),
    PACKAGE_FILE_MISSING: t('library.setPackageFileMissing'),
    PACKAGE_FILE_CORRUPTED: t('library.setPackageFileCorrupted'),
    MANIFEST_VERSION_UNSUPPORTED: t('library.setPackageVersionUnsupported'),
    NO_SPACE: t('library.setPackageNoSpace')
  }
  const headline =
    headlineByCode[failure.code] ||
    t('library.setPackageFailedReason', { message: failure.message || t('common.unknownError') })
  await confirm({
    title: t(titleKey),
    content: [headline, ...buildFileNameLines(failure.fileNames)],
    confirmShow: false
  })
}

const toPlainSongs = (songs: ISongInfo[]): ISongInfo[] =>
  JSON.parse(JSON.stringify(songs.map((song) => ({ ...song, cover: null })))) as ISongInfo[]

export async function exportSetPackageForPlaylist(runtime: RuntimeStore, playlistUuid: string) {
  if (runtime.isProgressing) {
    await confirmTaskBusy()
    return
  }
  runtime.isProgressing = true
  try {
    const songs = await loadSetPlaylistSongs(playlistUuid)
    if (!songs.length) {
      await showFailure('library.setPackageExportFailedTitle', {
        ok: false,
        code: 'EMPTY_SET',
        message: ''
      })
      return
    }
    const missingFiles = songs.filter((song) => song.fileMissing)
    if (missingFiles.length > 0) {
      await showFailure('library.setPackageExportFailedTitle', {
        ok: false,
        code: 'MISSING_FILES',
        message: '',
        fileNames: missingFiles.map((song) => song.fileName || song.filePath)
      })
      return
    }
    const result = (await window.electron.ipcRenderer.invoke('setList:export-package', {
      playlistUuid,
      songs: toPlainSongs(songs)
    })) as SetPackageExportResult
    if (!result.ok) {
      await showFailure('library.setPackageExportFailedTitle', result)
      return
    }
    if (result.canceled) return
    window.electron.ipcRenderer.send('show-item-in-folder', result.manifestPath)
    await confirm({
      title: t('library.setPackageExportSuccessTitle'),
      content: [
        t('library.setPackageExportSuccessCount', { count: result.trackCount }),
        t('library.setPackageExportSuccessPath', { path: result.packageDir }),
        t('library.setPackageExportSuccessHint')
      ],
      confirmShow: false
    })
  } finally {
    runtime.isProgressing = false
  }
}

const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g

const resolveUniqueChildName = (siblings: IDir[], desiredName: string): string => {
  const base = desiredName.replace(INVALID_NAME_CHARS, '_').trim() || 'SET'
  const used = new Set(siblings.map((item) => item.dirName.toLowerCase()))
  let candidate = base
  for (let index = 1; used.has(candidate.toLowerCase()); index += 1) {
    candidate = `${base} (${index})`
  }
  return candidate
}

const removeChildNode = (parent: IDir, uuid: string) => {
  const children = parent.children || []
  const index = children.findIndex((item) => item.uuid === uuid)
  if (index === -1) return
  const [removed] = children.splice(index, 1)
  for (const item of children) {
    if (item.order && removed.order && item.order > removed.order) item.order--
  }
}

// 歌单节点必须先落盘建好，主进程才能往里写曲目；导入失败时撤掉这个空歌单。
const createPlaylistAndImport = async (
  parent: IDir,
  playlistUuid: string,
  manifestPath: string
): Promise<SetPackageImportResult> => {
  const created = await libraryUtils.diffLibraryTreeExecuteFileOperation()
  if (!created) {
    return { ok: false, code: 'FAILED', message: t('library.setPackageCreatePlaylistFailed') }
  }
  const result = (await window.electron.ipcRenderer.invoke('setList:import-package', {
    manifestPath,
    playlistUuid
  })) as SetPackageImportResult
  if (!result.ok) {
    removeChildNode(parent, playlistUuid)
    await libraryUtils.diffLibraryTreeExecuteFileOperation()
  }
  return result
}

/** 导入到 SET 库根目录，或导入到指定的 SET 文件夹。 */
export async function importSetPackageIntoLibrary(runtime: RuntimeStore, parentNode?: IDir) {
  if (runtime.isProgressing) {
    await confirmTaskBusy()
    return
  }
  const parent =
    parentNode || runtime.libraryTree.children?.find((item) => item.dirName === 'SetLibrary')
  if (!parent) return
  const picked = (await window.electron.ipcRenderer.invoke(
    'setList:pick-package'
  )) as SetPackagePickResult
  if (!picked.ok) {
    await showFailure('library.setPackageImportFailedTitle', picked)
    return
  }
  if (picked.canceled) return

  parent.children = parent.children || []
  const playlistUuid = uuidV4()
  const dirName = resolveUniqueChildName(parent.children, picked.setName)
  for (const item of parent.children) {
    if (item.order) item.order++
  }
  parent.children.unshift({ uuid: playlistUuid, dirName, type: 'setList', order: 1, children: [] })

  runtime.isProgressing = true
  let imported: SetPackageImportResult
  try {
    imported = await createPlaylistAndImport(parent, playlistUuid, picked.manifestPath)
  } finally {
    runtime.isProgressing = false
  }
  if (!imported.ok) {
    await showFailure('library.setPackageImportFailedTitle', imported)
    return
  }
  emitter.emit('playlistContentChanged', { uuids: [playlistUuid] })
  if (runtime.libraryAreaSelected !== 'SetLibrary') runtime.libraryAreaSelected = 'SetLibrary'
  await confirm({
    title: t('library.setPackageImportSuccessTitle'),
    content: [
      t('library.setPackageImportSuccessCount', { name: dirName, count: imported.trackCount })
    ],
    confirmShow: false
  })
}
