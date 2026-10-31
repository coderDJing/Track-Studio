import path = require('path')
import fs = require('fs-extra')
import type { ISongInfo } from '../../../types/globals'
import {
  SET_PACKAGE_FORMAT,
  SET_PACKAGE_ANALYSIS_DIR_NAME,
  SET_PACKAGE_VERSION,
  type SetPackageErrorCode
} from '../../../shared/setPackage'

export type SetPackageAssetEntry = {
  /** 相对包目录的路径，统一用 / 分隔 */
  path: string
  size: number
  sha256: string
}

export type SetPackageFileEntry = SetPackageAssetEntry & {
  id: string
  fileName: string
  waveform?: SetPackageAssetEntry
}

export type SetPackageTrackEntry = {
  fileId: string
  addedAtMs: number
  song: Partial<ISongInfo>
}

export type SetPackageManifest = {
  format: typeof SET_PACKAGE_FORMAT
  version: number
  appVersion: string
  exportedAt: string
  set: { name: string }
  files: SetPackageFileEntry[]
  tracks: SetPackageTrackEntry[]
}

export class SetPackageError extends Error {
  readonly code: SetPackageErrorCode
  readonly fileNames?: string[]

  constructor(code: SetPackageErrorCode, message: string, fileNames?: string[]) {
    super(message)
    this.code = code
    this.fileNames = fileNames
  }
}

// 这些字段只在本机有意义（路径、行身份、运行时标记），不能带到另一台电脑。
const MACHINE_LOCAL_SONG_KEYS = [
  'filePath',
  'cover',
  'setItemId',
  'playlistTrackNumber',
  'addedAtMs',
  'fileMissing',
  'waveformPreviewListRoot',
  'analysisOnly',
  'mixOrder',
  'mixtapeItemId',
  'externalAnalyzePath',
  'externalWaveformRootPath',
  'externalSourceKind',
  'externalLibraryKind',
  'pioneerCoverPath',
  'pioneerAnalyzePath',
  'pioneerDeviceRootPath',
  'pioneerUsbSource',
  'deletedAtMs',
  'originalPlaylistPath',
  'recycleBinSourceType'
] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function stripMachineLocalSongFields(song: Partial<ISongInfo>): Partial<ISongInfo> {
  const next: Record<string, unknown> = { ...song }
  for (const key of MACHINE_LOCAL_SONG_KEYS) {
    delete next[key]
  }
  return next as Partial<ISongInfo>
}

export function toPackageRelativePath(packageDir: string, absPath: string): string {
  return path.relative(packageDir, absPath).split(path.sep).join('/')
}

export function resolvePackageFilePath(packageDir: string, relPath: string): string | null {
  const parts = relPath.split('/').filter((part) => part.length > 0)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null
  const resolved = path.resolve(packageDir, ...parts)
  const root = path.resolve(packageDir)
  if (!resolved.startsWith(root + path.sep)) return null
  return resolved
}

const invalid = (message: string): never => {
  throw new SetPackageError('MANIFEST_INVALID', message)
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function parseFileEntry(raw: unknown, index: number): SetPackageFileEntry {
  if (!isPlainObject(raw)) return invalid(`files[${index}] 不是对象`)
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const relPath = typeof raw.path === 'string' ? raw.path.trim() : ''
  const fileName = typeof raw.fileName === 'string' ? raw.fileName.trim() : ''
  const size = Number(raw.size)
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
  if (!id || !relPath || !fileName) return invalid(`files[${index}] 缺少 id/path/fileName`)
  if (fileName !== path.basename(fileName) || /[<>:"/\\|?*\u0000-\u001F]/.test(fileName)) {
    return invalid(`files[${index}] 文件名非法`)
  }
  if (!Number.isSafeInteger(size) || size < 0) return invalid(`files[${index}] size 非法`)
  if (!SHA256_PATTERN.test(sha256)) return invalid(`files[${index}] sha256 非法`)
  let waveform: SetPackageAssetEntry | undefined
  if (raw.waveform !== undefined) {
    if (!isPlainObject(raw.waveform)) return invalid(`files[${index}] waveform 非法`)
    const asset = raw.waveform
    if (
      typeof asset.path !== 'string' ||
      !asset.path.startsWith(`${SET_PACKAGE_ANALYSIS_DIR_NAME}/`) ||
      !resolvePackageFilePath(path.resolve('.'), asset.path) ||
      !Number.isSafeInteger(asset.size) ||
      Number(asset.size) <= 0 ||
      typeof asset.sha256 !== 'string' ||
      !SHA256_PATTERN.test(asset.sha256)
    )
      return invalid(`files[${index}] waveform 路径或身份非法`)
    waveform = { path: asset.path, size: Number(asset.size), sha256: asset.sha256 }
  }
  return { id, path: relPath, fileName, size, sha256, ...(waveform ? { waveform } : {}) }
}

export const listSetPackageAssets = (manifest: SetPackageManifest) =>
  manifest.files.flatMap((file) => [
    { path: file.path, size: file.size, sha256: file.sha256, fileName: file.fileName },
    ...(file.waveform
      ? [{ ...file.waveform, fileName: path.posix.basename(file.waveform.path) }]
      : [])
  ])

const SONG_STRING_KEYS = [
  'fileName',
  'fileFormat',
  'title',
  'artist',
  'album',
  'duration',
  'genre',
  'label',
  'container',
  'key',
  'beatGridSource',
  'beatGridStatus',
  'externalWaveformPreference',
  'externalBeatGridPreference'
] as const
const SONG_NUMBER_KEYS = [
  'bitrate',
  'keyAnalysisAlgorithmVersion',
  'bpm',
  'firstBeatMs',
  'downbeatBeatOffset',
  'energyScore',
  'energyAlgorithmVersion',
  'timeBasisOffsetMs',
  'timeBasisOffsetAlgorithmVersion',
  'beatGridAlgorithmVersion'
] as const
const SONG_OBJECT_KEYS = ['beatGridMap', 'energyAnalysis', 'songStructure'] as const
const SONG_OBJECT_ARRAY_KEYS = ['hotCues', 'memoryCues', 'rekordboxGridEntries'] as const

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

// 曲目信息会原样写进分析缓存，类型不对的字段会让播放器和列表读出脏数据，必须在入库前拒绝。
function findInvalidSongField(song: Record<string, unknown>): string | null {
  const isAbsent = (value: unknown) => value === undefined || value === null
  for (const key of SONG_STRING_KEYS) {
    if (!isAbsent(song[key]) && typeof song[key] !== 'string') return key
  }
  for (const key of SONG_NUMBER_KEYS) {
    if (!isAbsent(song[key]) && !isFiniteNumber(song[key])) return key
  }
  for (const key of SONG_OBJECT_KEYS) {
    if (!isAbsent(song[key]) && !isPlainObject(song[key])) return key
  }
  for (const key of SONG_OBJECT_ARRAY_KEYS) {
    const value = song[key]
    if (isAbsent(value)) continue
    if (!Array.isArray(value) || !value.every(isPlainObject)) return key
  }
  if (!isAbsent(song.autoFilled) && typeof song.autoFilled !== 'boolean') return 'autoFilled'
  const hotCues = Array.isArray(song.hotCues) ? song.hotCues : []
  if (!hotCues.every((cue) => isFiniteNumber(cue.slot) && isFiniteNumber(cue.sec))) {
    return 'hotCues'
  }
  const memoryCues = Array.isArray(song.memoryCues) ? song.memoryCues : []
  if (!memoryCues.every((cue) => isFiniteNumber(cue.sec))) return 'memoryCues'
  return null
}

function parseTrackEntry(
  raw: unknown,
  index: number,
  fileIds: ReadonlySet<string>
): SetPackageTrackEntry {
  if (!isPlainObject(raw)) return invalid(`tracks[${index}] 不是对象`)
  const fileId = typeof raw.fileId === 'string' ? raw.fileId.trim() : ''
  if (!fileIds.has(fileId)) return invalid(`tracks[${index}] 引用了不存在的文件`)
  const addedAtMs = Number(raw.addedAtMs)
  if (!isPlainObject(raw.song)) return invalid(`tracks[${index}] 缺少曲目信息`)
  const invalidField = findInvalidSongField(raw.song)
  if (invalidField) return invalid(`tracks[${index}] ${invalidField} 非法`)
  const song = stripMachineLocalSongFields(raw.song as Partial<ISongInfo>)
  return {
    fileId,
    addedAtMs: Number.isFinite(addedAtMs) && addedAtMs > 0 ? Math.floor(addedAtMs) : 0,
    song
  }
}

export async function readSetPackageManifest(manifestPath: string): Promise<SetPackageManifest> {
  let raw: unknown
  try {
    raw = await fs.readJSON(manifestPath)
  } catch {
    return invalid('描述文件不是有效的 JSON')
  }
  if (!isPlainObject(raw) || raw.format !== SET_PACKAGE_FORMAT) {
    return invalid('不是 SET 包描述文件')
  }
  const version = Number(raw.version)
  if (!Number.isInteger(version) || version < 1) return invalid('描述文件版本非法')
  if (version > SET_PACKAGE_VERSION) {
    throw new SetPackageError(
      'MANIFEST_VERSION_UNSUPPORTED',
      `SET 包版本 ${version} 高于当前支持的版本 ${SET_PACKAGE_VERSION}`
    )
  }
  const setName =
    isPlainObject(raw.set) && typeof raw.set.name === 'string' ? raw.set.name.trim() : ''
  if (!setName) return invalid('缺少 SET 名称')
  if (!Array.isArray(raw.files) || !Array.isArray(raw.tracks)) {
    return invalid('缺少 files/tracks')
  }
  const files = raw.files.map((entry, index) => parseFileEntry(entry, index))
  const fileIds = new Set<string>()
  const assetPaths = new Set<string>()
  for (const file of files) {
    if (fileIds.has(file.id)) return invalid(`文件 id 重复：${file.id}`)
    fileIds.add(file.id)
    for (const asset of [file, ...(file.waveform ? [file.waveform] : [])]) {
      const key = asset.path.toLowerCase()
      if (assetPaths.has(key)) return invalid(`包内文件路径重复：${asset.path}`)
      assetPaths.add(key)
    }
  }
  const tracks = raw.tracks.map((entry, index) => parseTrackEntry(entry, index, fileIds))
  if (tracks.length === 0) return invalid('SET 包里没有曲目')
  return {
    format: SET_PACKAGE_FORMAT,
    version,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    set: { name: setName },
    files,
    tracks
  }
}

/** 校验包内每个音频都存在且大小一致；内容哈希在导入复制后再校验。 */
export async function assertSetPackageFilesPresent(
  packageDir: string,
  manifest: SetPackageManifest
): Promise<void> {
  const missing: string[] = []
  const mismatched: string[] = []
  for (const file of listSetPackageAssets(manifest)) {
    const absPath = resolvePackageFilePath(packageDir, file.path)
    if (!absPath) return invalid(`文件路径非法：${file.path}`)
    const stat = await fs.stat(absPath).catch(() => null)
    if (!stat || !stat.isFile()) {
      missing.push(file.fileName)
      continue
    }
    if (stat.size !== file.size) mismatched.push(file.fileName)
  }
  if (missing.length > 0) {
    throw new SetPackageError('PACKAGE_FILE_MISSING', 'SET 包内缺少文件', missing)
  }
  if (mismatched.length > 0) {
    throw new SetPackageError('PACKAGE_FILE_CORRUPTED', 'SET 包内文件已损坏', mismatched)
  }
}
