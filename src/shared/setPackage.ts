// SET 包：把 SET 歌单、音频与分析结果导出为可导入 Track Studio 音乐库的文件夹。
export const SET_PACKAGE_FORMAT = 'frkb-set-package'
export const SET_PACKAGE_VERSION = 1
export const SET_PACKAGE_EXTENSION = 'frkbset'
export const SET_PACKAGE_AUDIO_DIR_NAME = 'audio'

export type SetPackageErrorCode =
  | 'PLAYLIST_NOT_FOUND'
  | 'PLAYLIST_NOT_EMPTY'
  | 'EMPTY_SET'
  | 'TRACKS_MISMATCH'
  | 'MISSING_FILES'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_VERSION_UNSUPPORTED'
  | 'PACKAGE_FILE_MISSING'
  | 'PACKAGE_FILE_CORRUPTED'
  | 'NO_SPACE'
  | 'FAILED'

export type SetPackageFailure = {
  ok: false
  code: SetPackageErrorCode
  message: string
  fileNames?: string[]
}

export type SetPackageExportResult =
  | { ok: true; canceled: true }
  | {
      ok: true
      canceled: false
      packageDir: string
      manifestPath: string
      trackCount: number
      fileCount: number
    }
  | SetPackageFailure

export type SetPackagePickResult =
  | { ok: true; canceled: true }
  | {
      ok: true
      canceled: false
      manifestPath: string
      setName: string
      trackCount: number
      appVersion: string
    }
  | SetPackageFailure

export type SetPackageImportSummary = {
  trackCount: number
  fileCount: number
  sourceCleanup?: 'deleted' | 'failed'
}

export type SetPackageImportResult = ({ ok: true } & SetPackageImportSummary) | SetPackageFailure

export type SetPackageImportDialogResult = {
  picked: Extract<SetPackagePickResult, { ok: true; canceled: false }>
  deleteSourceAfterImport: boolean
}
