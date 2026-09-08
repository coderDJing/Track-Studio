import type { ISongInfo } from '../types/globals'
import { areSongHotCuesEqual } from './hotCues'
import { areSongMemoryCuesEqual } from './memoryCues'
import { normalizeSongBeatGridMapV2 } from './songBeatGridMapV2'
import { normalizeSongStructureAnalysis } from './songStructure'
import { normalizeFilePathForComparison } from './filePathComparison'

/**
 * 歌单行的等价判定。主进程（构建后台刷新计划）与 renderer（磁盘重载对比）必须用
 * 同一套字段与归一化规则，否则两边会对"这一行到底变没变"给出不同答案，
 * 后台刷新就会反复推送空补丁或漏推真实变化。
 *
 * 唯一与运行环境相关的差异是文件名大小写：win32 下文件名不区分大小写。
 * 因此这里用工厂注入 platform，而不是各自读全局。
 */
export type SongListItemComparatorOptions = {
  /** win32 语义：fileName 比较时忽略大小写。 */
  caseInsensitiveFileName: boolean
  /** win32 语义：filePath 比较时忽略大小写。 */
  caseInsensitiveFilePath: boolean
}

/** 只影响分析结果、不影响"这是哪一首/文件本身变了"的字段。 */
export const IGNORED_SONG_LIST_REFRESH_DIFF_FIELDS: ReadonlySet<string> = new Set([
  'key',
  'bpm',
  'beatGridMap',
  'beatGridStatus',
  'energyScore',
  'energyAlgorithmVersion',
  'songStructure'
])

/** 路径 key：统一分隔符；只有 win32 忽略大小写。 */
export const normalizeSongPath = (
  value: string | undefined | null,
  caseInsensitive = false
): string => normalizeFilePathForComparison(value, caseInsensitive)

export const normalizeComparableText = (value: unknown): string => String(value || '').trim()

const normalizeComparableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const normalizeComparableBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null

const normalizeComparableJson = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value) || ''
  } catch {
    return ''
  }
}

const normalizeComparableSongStructure = (value: unknown): string => {
  const structure = normalizeSongStructureAnalysis(value)
  return structure ? JSON.stringify(structure) : ''
}

const normalizeComparableBeatGridMap = (value: unknown): string => {
  const map = normalizeSongBeatGridMapV2(value, { allowSingleClip: true })
  return map ? map.signature : ''
}

/** 行身份：mixtape / set 条目用各自的条目 id，普通歌单用文件路径。 */
export const getSongIdentityKey = (song: ISongInfo, caseInsensitiveFilePath = false): string =>
  normalizeComparableText(song.mixtapeItemId) ||
  normalizeComparableText(song.setItemId) ||
  normalizeSongPath(song.filePath, caseInsensitiveFilePath)

export type SongListItemComparator = {
  getSongIdentityKey: (song: ISongInfo) => string
  normalizeSongPath: (value: string | undefined | null) => string
  normalizeComparableText: (value: unknown) => string
  isEquivalentSongInfo: (left: ISongInfo, right: ISongInfo) => boolean
  getSongInfoDiffFields: (left: ISongInfo, right: ISongInfo) => string[]
  hasMeaningfulDiffField: (fields: readonly string[]) => boolean
}

export function createSongListItemComparator(
  options: SongListItemComparatorOptions
): SongListItemComparator {
  const normalizeComparatorSongPath = (value: string | undefined | null) =>
    normalizeSongPath(value, options.caseInsensitiveFilePath)
  const getComparatorSongIdentityKey = (song: ISongInfo) =>
    getSongIdentityKey(song, options.caseInsensitiveFilePath)
  const normalizeComparableFileName = (value: unknown): string => {
    const normalized = normalizeComparableText(value)
    return options.caseInsensitiveFileName ? normalized.toLowerCase() : normalized
  }

  const isEquivalentSongInfo = (left: ISongInfo, right: ISongInfo): boolean =>
    getComparatorSongIdentityKey(left) === getComparatorSongIdentityKey(right) &&
    normalizeComparatorSongPath(left.filePath) === normalizeComparatorSongPath(right.filePath) &&
    normalizeComparableFileName(left.fileName) === normalizeComparableFileName(right.fileName) &&
    normalizeComparableText(left.fileFormat).toUpperCase() ===
      normalizeComparableText(right.fileFormat).toUpperCase() &&
    normalizeComparableText(left.title) === normalizeComparableText(right.title) &&
    normalizeComparableText(left.artist) === normalizeComparableText(right.artist) &&
    normalizeComparableText(left.album) === normalizeComparableText(right.album) &&
    normalizeComparableText(left.duration) === normalizeComparableText(right.duration) &&
    normalizeComparableText(left.genre) === normalizeComparableText(right.genre) &&
    normalizeComparableText(left.label) === normalizeComparableText(right.label) &&
    normalizeComparableNumber(left.bitrate) === normalizeComparableNumber(right.bitrate) &&
    normalizeComparableText(left.container).toUpperCase() ===
      normalizeComparableText(right.container).toUpperCase() &&
    normalizeComparableText(left.key) === normalizeComparableText(right.key) &&
    normalizeComparableNumber(left.keyAnalysisAlgorithmVersion) ===
      normalizeComparableNumber(right.keyAnalysisAlgorithmVersion) &&
    normalizeComparableNumber(left.bpm) === normalizeComparableNumber(right.bpm) &&
    normalizeComparableNumber(left.firstBeatMs) === normalizeComparableNumber(right.firstBeatMs) &&
    normalizeComparableNumber(left.downbeatBeatOffset) ===
      normalizeComparableNumber(right.downbeatBeatOffset) &&
    normalizeComparableText(left.beatGridSource) ===
      normalizeComparableText(right.beatGridSource) &&
    normalizeComparableBeatGridMap(left.beatGridMap) ===
      normalizeComparableBeatGridMap(right.beatGridMap) &&
    normalizeComparableJson(left.rekordboxGridEntries) ===
      normalizeComparableJson(right.rekordboxGridEntries) &&
    normalizeComparableNumber(left.beatGridAlgorithmVersion) ===
      normalizeComparableNumber(right.beatGridAlgorithmVersion) &&
    normalizeComparableText(left.beatGridStatus) ===
      normalizeComparableText(right.beatGridStatus) &&
    normalizeComparableNumber(left.energyScore) === normalizeComparableNumber(right.energyScore) &&
    normalizeComparableNumber(left.energyAlgorithmVersion) ===
      normalizeComparableNumber(right.energyAlgorithmVersion) &&
    normalizeComparableSongStructure(left.songStructure) ===
      normalizeComparableSongStructure(right.songStructure) &&
    normalizeComparableNumber(left.timeBasisOffsetMs) ===
      normalizeComparableNumber(right.timeBasisOffsetMs) &&
    normalizeComparableNumber(left.timeBasisOffsetAlgorithmVersion) ===
      normalizeComparableNumber(right.timeBasisOffsetAlgorithmVersion) &&
    areSongHotCuesEqual(left.hotCues, right.hotCues) &&
    areSongMemoryCuesEqual(left.memoryCues, right.memoryCues) &&
    normalizeComparableNumber(left.mixOrder) === normalizeComparableNumber(right.mixOrder) &&
    normalizeComparableText(left.mixtapeItemId) === normalizeComparableText(right.mixtapeItemId) &&
    normalizeComparableText(left.setItemId) === normalizeComparableText(right.setItemId) &&
    normalizeComparableBoolean(left.analysisOnly) ===
      normalizeComparableBoolean(right.analysisOnly) &&
    normalizeComparableBoolean(left.autoFilled) === normalizeComparableBoolean(right.autoFilled) &&
    normalizeComparableBoolean(left.fileMissing) ===
      normalizeComparableBoolean(right.fileMissing) &&
    normalizeComparableText(left.externalAnalyzePath) ===
      normalizeComparableText(right.externalAnalyzePath) &&
    normalizeComparableText(left.externalWaveformRootPath) ===
      normalizeComparableText(right.externalWaveformRootPath) &&
    normalizeComparableText(left.waveformPreviewListRoot) ===
      normalizeComparableText(right.waveformPreviewListRoot) &&
    normalizeComparableText(left.externalSourceKind) ===
      normalizeComparableText(right.externalSourceKind) &&
    normalizeComparableText(left.pioneerCoverPath) ===
      normalizeComparableText(right.pioneerCoverPath) &&
    normalizeComparableText(left.pioneerAnalyzePath) ===
      normalizeComparableText(right.pioneerAnalyzePath) &&
    normalizeComparableText(left.pioneerDeviceRootPath) ===
      normalizeComparableText(right.pioneerDeviceRootPath) &&
    normalizeComparableNumber(left.deletedAtMs) === normalizeComparableNumber(right.deletedAtMs) &&
    normalizeComparableText(left.originalPlaylistPath) ===
      normalizeComparableText(right.originalPlaylistPath) &&
    normalizeComparableText(left.recycleBinSourceType) ===
      normalizeComparableText(right.recycleBinSourceType) &&
    normalizeComparableNumber(left.playlistTrackNumber) ===
      normalizeComparableNumber(right.playlistTrackNumber) &&
    normalizeComparableNumber(left.addedAtMs) === normalizeComparableNumber(right.addedAtMs)

  const getSongInfoDiffFields = (left: ISongInfo, right: ISongInfo): string[] => {
    const fields: string[] = []
    const pushIfTextDiff = (field: keyof ISongInfo) => {
      if (normalizeComparableText(left[field]) !== normalizeComparableText(right[field])) {
        fields.push(field)
      }
    }
    const pushIfUpperTextDiff = (field: keyof ISongInfo) => {
      if (
        normalizeComparableText(left[field]).toUpperCase() !==
        normalizeComparableText(right[field]).toUpperCase()
      ) {
        fields.push(field)
      }
    }
    const pushIfNumberDiff = (field: keyof ISongInfo) => {
      if (normalizeComparableNumber(left[field]) !== normalizeComparableNumber(right[field])) {
        fields.push(field)
      }
    }

    if (getComparatorSongIdentityKey(left) !== getComparatorSongIdentityKey(right)) {
      fields.push('__identity__')
    }
    if (
      normalizeComparatorSongPath(left.filePath) !== normalizeComparatorSongPath(right.filePath)
    ) {
      fields.push('filePath')
    }
    if (
      normalizeComparableFileName(left.fileName) !== normalizeComparableFileName(right.fileName)
    ) {
      fields.push('fileName')
    }
    pushIfUpperTextDiff('fileFormat')
    pushIfTextDiff('title')
    pushIfTextDiff('artist')
    pushIfTextDiff('album')
    pushIfTextDiff('duration')
    pushIfTextDiff('genre')
    pushIfTextDiff('label')
    pushIfNumberDiff('bitrate')
    pushIfUpperTextDiff('container')
    pushIfTextDiff('key')
    pushIfNumberDiff('keyAnalysisAlgorithmVersion')
    pushIfNumberDiff('bpm')
    pushIfNumberDiff('firstBeatMs')
    pushIfNumberDiff('downbeatBeatOffset')
    pushIfTextDiff('beatGridSource')
    if (
      normalizeComparableBeatGridMap(left.beatGridMap) !==
      normalizeComparableBeatGridMap(right.beatGridMap)
    ) {
      fields.push('beatGridMap')
    }
    if (
      normalizeComparableJson(left.rekordboxGridEntries) !==
      normalizeComparableJson(right.rekordboxGridEntries)
    ) {
      fields.push('rekordboxGridEntries')
    }
    pushIfNumberDiff('beatGridAlgorithmVersion')
    pushIfTextDiff('beatGridStatus')
    pushIfNumberDiff('energyScore')
    pushIfNumberDiff('energyAlgorithmVersion')
    if (
      normalizeComparableSongStructure(left.songStructure) !==
      normalizeComparableSongStructure(right.songStructure)
    ) {
      fields.push('songStructure')
    }
    pushIfNumberDiff('timeBasisOffsetMs')
    pushIfNumberDiff('timeBasisOffsetAlgorithmVersion')
    if (!areSongHotCuesEqual(left.hotCues, right.hotCues)) fields.push('hotCues')
    if (!areSongMemoryCuesEqual(left.memoryCues, right.memoryCues)) fields.push('memoryCues')
    pushIfNumberDiff('mixOrder')
    pushIfTextDiff('mixtapeItemId')
    pushIfTextDiff('setItemId')
    if (
      normalizeComparableBoolean(left.analysisOnly) !==
      normalizeComparableBoolean(right.analysisOnly)
    ) {
      fields.push('analysisOnly')
    }
    if (
      normalizeComparableBoolean(left.autoFilled) !== normalizeComparableBoolean(right.autoFilled)
    ) {
      fields.push('autoFilled')
    }
    if (
      normalizeComparableBoolean(left.fileMissing) !== normalizeComparableBoolean(right.fileMissing)
    ) {
      fields.push('fileMissing')
    }
    pushIfTextDiff('externalAnalyzePath')
    pushIfTextDiff('externalWaveformRootPath')
    pushIfTextDiff('waveformPreviewListRoot')
    pushIfTextDiff('externalSourceKind')
    pushIfTextDiff('pioneerCoverPath')
    pushIfTextDiff('pioneerAnalyzePath')
    pushIfTextDiff('pioneerDeviceRootPath')
    pushIfNumberDiff('deletedAtMs')
    pushIfTextDiff('originalPlaylistPath')
    pushIfTextDiff('recycleBinSourceType')
    pushIfNumberDiff('playlistTrackNumber')
    pushIfNumberDiff('addedAtMs')
    return fields
  }

  const hasMeaningfulDiffField = (fields: readonly string[]): boolean =>
    fields.some((field) => !IGNORED_SONG_LIST_REFRESH_DIFF_FIELDS.has(field))

  return {
    getSongIdentityKey: getComparatorSongIdentityKey,
    normalizeSongPath: normalizeComparatorSongPath,
    normalizeComparableText,
    isEquivalentSongInfo,
    getSongInfoDiffFields,
    hasMeaningfulDiffField
  }
}
