import path from 'node:path'
import { getLibraryDb } from '../libraryDb'
import { loadLibraryNodes, type LibraryNodeRow } from '../libraryTreeDb'
import { resolveCacheListRootAbs } from '../libraryCacheDb'
import store from '../store'
import { getCoreFsDirName } from '../utils'
import type { ISongInfo } from '../../types/globals'
import { log } from '../log'
import { normalizeSongHotCues } from '../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'
import { normalizePlaylistTrackNumber } from './playlistTrackNumbers'
import { normalizeAddedAtMs } from '../../shared/songAddedAt'
import { verifyPlaylistCacheOffMainThread } from './songListScanWorker'
import { normalizeSongEnergyScore } from '../../shared/songEnergy'
import {
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis
} from '../../shared/songStructure'
import {
  hasUsableKeyAnalysis,
  resolveCanonicalSongBeatGridV2
} from '../../shared/songAnalysisCompleteness'

type CoreLibraryName = 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary' | 'RecycleBin'

type SearchDoc = {
  id: string
  filePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  keyText: string
  bpm?: number
  container: string
  songListUUID: string
  songListName: string
  songListPath: string
  libraryName: CoreLibraryName
  searchText: string
  searchCompact: string
  titleNorm: string
  artistNorm: string
  albumNorm: string
  genreNorm: string
  labelNorm: string
  keyNorm: string
  containerNorm: string
  fileNameNorm: string
  songListNameNorm: string
  pathNorm: string
}

type PlaylistMeta = {
  uuid: string
  dirName: string
  relPath: string
  absPath: string
  normalizedAbsPath: string
  libraryName: CoreLibraryName
}

type GlobalSongSearchResultItem = {
  id: string
  filePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  keyText: string
  bpm?: number
  container: string
  songListUUID: string
  songListName: string
  songListPath: string
  libraryName: CoreLibraryName
  score: number
}

type GlobalSongSearchQueryResult = {
  items: GlobalSongSearchResultItem[]
  tookMs: number
  indexedCount: number
  snapshotAt: number
}

type PlaylistFastLoadResult = {
  hit: boolean
  items: ISongInfo[]
  missingWaveformFilePaths: string[]
  tookMs: number
  snapshotAt: number
  /** 命中时带上扫描根与文件身份摘要，调用方据此把视图快照补上（见 songSearchHandlers）。 */
  listRoot: string
  identityDigest: string
}

export type MarkGlobalSongSearchDirtyOptions = {
  songListUUID?: string
  songListUUIDs?: string[]
}

const SEARCH_MAX_LIMIT = 200
const DEFAULT_LIMIT = 80
const AUTO_REBUILD_AGE_MS = 20000
const SEARCH_EXTENDED_FIELD_LIMIT = 240
const SEARCH_EXTENDED_LYRICS_LIMIT = 800
const SEARCH_REBUILD_YIELD_EVERY_ROWS = 400
const SEARCH_REBUILD_DB_PAGE_ROWS = 160

const EXTENDED_SEARCH_FIELD_KEYS = [
  'albumArtist',
  'composer',
  'lyricist',
  'year',
  'trackNo',
  'trackTotal',
  'discNo',
  'discTotal',
  'isrc',
  'comment',
  'originalPlaylistPath',
  'recycleBinSourceType'
]

type EnsureReadyOptions = {
  allowDirtyStale?: boolean
  allowAgedStale?: boolean
}

const CORE_LIBRARY_NAME_SET = new Set<CoreLibraryName>([
  'FilterLibrary',
  'CuratedLibrary',
  'MixtapeLibrary',
  'RecycleBin'
])

const normalizePathForCompare = (input: string) => {
  if (!input) return ''
  let resolved = path.resolve(input).replace(/\\/g, '/')
  resolved = resolved.replace(/\/+$/g, '')
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase()
  }
  return resolved
}

const normalizeText = (input: unknown) => {
  const text = String(input || '').trim()
  if (!text) return ''
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
}

const compactText = (input: string) => input.replace(/\s+/g, '')

const splitQueryTokens = (input: string) =>
  input
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

const buildNgramSet = (input: string, n: number) => {
  const result = new Set<string>()
  if (!input || n <= 0) return result
  if (input.length <= n) {
    result.add(input)
    return result
  }
  for (let i = 0; i <= input.length - n; i += 1) {
    result.add(input.slice(i, i + n))
  }
  return result
}

const addToInvertedIndex = (
  index: Map<string, Set<number>>,
  terms: Iterable<string>,
  docIndex: number
) => {
  for (const term of terms) {
    if (!term) continue
    const bucket = index.get(term)
    if (bucket) {
      bucket.add(docIndex)
    } else {
      index.set(term, new Set<number>([docIndex]))
    }
  }
}

const intersectSets = (a: Set<number>, b: Set<number>) => {
  if (a.size === 0 || b.size === 0) return new Set<number>()
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  const result = new Set<number>()
  for (const item of small) {
    if (large.has(item)) result.add(item)
  }
  return result
}

const resolveCoreLibraryName = (value: string): CoreLibraryName => {
  if (CORE_LIBRARY_NAME_SET.has(value as CoreLibraryName)) {
    return value as CoreLibraryName
  }
  return 'FilterLibrary'
}

const tryParseSongInfo = (raw: unknown): Partial<ISongInfo> | null => {
  if (raw === null || raw === undefined) return null
  try {
    return JSON.parse(String(raw)) as Partial<ISongInfo>
  } catch {
    return null
  }
}

const toSearchTextValue = (input: unknown, maxLength = SEARCH_EXTENDED_FIELD_LIMIT): string => {
  if (input === null || input === undefined) return ''
  if (Array.isArray(input)) {
    return input
      .map((item) => toSearchTextValue(item, maxLength))
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  if (typeof input === 'object') return ''
  const normalized = String(input).trim()
  if (!normalized) return ''
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized
}

const collectExtendedSearchTerms = (rawInfo: Partial<ISongInfo> | null) => {
  if (!rawInfo || typeof rawInfo !== 'object') return [] as string[]
  const record = rawInfo as Record<string, unknown>
  const terms: string[] = []

  for (const key of EXTENDED_SEARCH_FIELD_KEYS) {
    const text = toSearchTextValue(record[key])
    if (text) terms.push(text)
  }

  const lyrics = toSearchTextValue(record.lyrics, SEARCH_EXTENDED_LYRICS_LIMIT)
  if (lyrics) terms.push(lyrics)

  return terms
}

const fallbackFileFormat = (filePath: string) => {
  const ext = path.extname(filePath)
  if (!ext) return ''
  return ext.slice(1).toUpperCase()
}

const playlistTrackNumberCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
})

const comparePlaylistSongOrder = (left: ISongInfo, right: ISongInfo) => {
  const leftNumber = normalizePlaylistTrackNumber(left.playlistTrackNumber)
  const rightNumber = normalizePlaylistTrackNumber(right.playlistTrackNumber)
  if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
    return leftNumber - rightNumber
  }
  if (leftNumber !== undefined && rightNumber === undefined) return -1
  if (leftNumber === undefined && rightNumber !== undefined) return 1
  return playlistTrackNumberCollator.compare(
    String(left.filePath || ''),
    String(right.filePath || '')
  )
}

const toSongInfo = (rawInfo: Partial<ISongInfo> | null, filePath: string): ISongInfo => {
  const fileName =
    String(rawInfo?.fileName || path.basename(filePath)).trim() || path.basename(filePath)
  const fileFormat = String(rawInfo?.fileFormat || fallbackFileFormat(filePath)).trim()
  const title =
    typeof rawInfo?.title === 'string' && rawInfo.title.trim().length > 0 ? rawInfo.title : fileName
  const artist =
    typeof rawInfo?.artist === 'string' && rawInfo.artist.trim().length > 0
      ? rawInfo.artist
      : undefined
  const album =
    typeof rawInfo?.album === 'string' && rawInfo.album.trim().length > 0
      ? rawInfo.album
      : undefined
  const duration = typeof rawInfo?.duration === 'string' ? rawInfo.duration : ''
  const genre =
    typeof rawInfo?.genre === 'string' && rawInfo.genre.trim().length > 0
      ? rawInfo.genre
      : undefined
  const label =
    typeof rawInfo?.label === 'string' && rawInfo.label.trim().length > 0
      ? rawInfo.label
      : undefined
  const container =
    typeof rawInfo?.container === 'string' && rawInfo.container.trim().length > 0
      ? rawInfo.container
      : fileFormat || undefined
  const bitrate =
    typeof rawInfo?.bitrate === 'number' && Number.isFinite(rawInfo.bitrate)
      ? rawInfo.bitrate
      : undefined
  const hasKeyAnalysis = hasUsableKeyAnalysis(rawInfo)
  const key = hasKeyAnalysis ? rawInfo?.key?.trim() : undefined
  const keyAnalysisAlgorithmVersion = hasKeyAnalysis
    ? rawInfo?.keyAnalysisAlgorithmVersion
    : undefined
  const grid = resolveCanonicalSongBeatGridV2(rawInfo)
  const bpm = grid.kind === 'grid' ? grid.bpm : undefined
  const firstBeatMs = grid.kind === 'grid' ? grid.firstBeatMs : undefined
  const downbeatBeatOffset = grid.kind === 'grid' ? grid.downbeatBeatOffset : undefined
  const beatGridMap = grid.kind === 'grid' ? grid.beatGridMap : undefined
  const beatGridAlgorithmVersion =
    grid.kind !== 'missing' ? rawInfo?.beatGridAlgorithmVersion : undefined
  const beatGridSource = grid.kind === 'grid' ? grid.beatGridMap.source : undefined
  const beatGridStatus = grid.kind === 'no-bpm' ? 'no-bpm' : undefined
  const timeBasisOffsetMs =
    grid.kind === 'grid' &&
    typeof rawInfo?.timeBasisOffsetMs === 'number' &&
    Number.isFinite(rawInfo.timeBasisOffsetMs)
      ? rawInfo.timeBasisOffsetMs
      : undefined
  const energyScore = normalizeSongEnergyScore(rawInfo?.energyScore)
  const energyAlgorithmVersion =
    energyScore !== undefined ? rawInfo?.energyAlgorithmVersion : undefined
  const songStructure = hasUsableSongStructureAnalysis(rawInfo)
    ? normalizeSongStructureAnalysis(rawInfo?.songStructure)
    : undefined
  const playlistTrackNumber = normalizePlaylistTrackNumber(rawInfo?.playlistTrackNumber)

  return {
    filePath,
    fileName,
    fileFormat,
    cover: null,
    title,
    artist,
    album,
    duration,
    genre,
    label,
    bitrate,
    container,
    key,
    keyAnalysisAlgorithmVersion,
    bpm,
    firstBeatMs,
    downbeatBeatOffset,
    timeBasisOffsetMs,
    beatGridAlgorithmVersion,
    beatGridSource,
    beatGridStatus,
    beatGridMap,
    energyScore,
    energyAlgorithmVersion,
    songStructure,
    playlistTrackNumber,
    addedAtMs: normalizeAddedAtMs(rawInfo?.addedAtMs),
    hotCues: normalizeSongHotCues(rawInfo?.hotCues),
    memoryCues: normalizeSongMemoryCues(rawInfo?.memoryCues),
    analysisOnly: rawInfo?.analysisOnly === true ? true : undefined,
    autoFilled: rawInfo?.autoFilled === true ? true : undefined
  }
}

const buildNodePathMap = (rows: LibraryNodeRow[]) => {
  const byUuid = new Map<string, LibraryNodeRow>()
  const childrenByParent = new Map<string, LibraryNodeRow[]>()
  for (const row of rows) {
    byUuid.set(row.uuid, row)
    if (!row.parentUuid) continue
    const list = childrenByParent.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenByParent.set(row.parentUuid, [row])
    }
  }
  const root = rows.find((row) => row.parentUuid === null && row.nodeType === 'root')
  if (!root) return new Map<string, string>()
  const pathByUuid = new Map<string, string>()
  pathByUuid.set(root.uuid, root.dirName)
  const queue: LibraryNodeRow[] = [root]
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]
    const basePath = pathByUuid.get(current.uuid)
    if (!basePath) continue
    const children = childrenByParent.get(current.uuid) || []
    for (const child of children) {
      const childPath = path.join(basePath, child.dirName)
      if (!pathByUuid.has(child.uuid)) {
        pathByUuid.set(child.uuid, childPath)
      }
      queue.push(child)
    }
  }
  return pathByUuid
}

const resolveLibraryNameByRelativePath = (relativePath: string): CoreLibraryName => {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length < 2) return 'FilterLibrary'
  const fsName = segments[1]
  const coreMap = new Map<string, CoreLibraryName>([
    [getCoreFsDirName('FilterLibrary'), 'FilterLibrary'],
    [getCoreFsDirName('CuratedLibrary'), 'CuratedLibrary'],
    [getCoreFsDirName('MixtapeLibrary'), 'MixtapeLibrary'],
    [getCoreFsDirName('RecycleBin'), 'RecycleBin']
  ])
  return coreMap.get(fsName) || resolveCoreLibraryName(fsName)
}

const resolveListRootAbsolute = (listRootRaw: string) => {
  const resolvedFromCache = resolveCacheListRootAbs(listRootRaw)
  if (resolvedFromCache) return resolvedFromCache
  if (path.isAbsolute(listRootRaw)) return listRootRaw
  if (store.databaseDir) return path.join(store.databaseDir, listRootRaw)
  return listRootRaw
}

const yieldToNodeMainLoop = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

class GlobalSongSearchEngine {
  private docs: SearchDoc[] = []
  private allDocIndices: number[] = []
  private trigramIndex = new Map<string, Set<number>>()
  private bigramIndex = new Map<string, Set<number>>()
  private charIndex = new Map<string, Set<number>>()
  private playlistSongs = new Map<string, ISongInfo[]>()
  private knownPlaylists = new Set<string>()

  private dirty = true
  private dirtyPlaylists = new Set<string>()
  private ready = false
  private lastBuiltAt = 0
  private buildingPromise: Promise<void> | null = null

  markDirty(_reason?: string, options?: MarkGlobalSongSearchDirtyOptions) {
    const uuids = [
      ...(typeof options?.songListUUID === 'string' ? [options.songListUUID] : []),
      ...(Array.isArray(options?.songListUUIDs) ? options.songListUUIDs : [])
    ]
      .map((uuid) => String(uuid || '').trim())
      .filter(Boolean)

    this.dirty = true
    if (uuids.length === 0) {
      for (const uuid of this.knownPlaylists) this.dirtyPlaylists.add(uuid)
      return
    }
    for (const uuid of uuids) this.dirtyPlaylists.add(uuid)
  }

  getStats() {
    return {
      ready: this.ready,
      dirty: this.dirty,
      dirtyPlaylistCount: this.dirtyPlaylists.size,
      indexedCount: this.docs.length,
      playlistCount: this.playlistSongs.size,
      snapshotAt: this.lastBuiltAt
    }
  }

  async warmup(force = false) {
    await this.ensureReady(force)
    return this.getStats()
  }

  async query(keyword: string, limit = DEFAULT_LIMIT): Promise<GlobalSongSearchQueryResult> {
    const started = Date.now()
    await this.ensureReady(false, { allowDirtyStale: true, allowAgedStale: true })

    const normalizedKeyword = normalizeText(keyword)
    const tokens = splitQueryTokens(normalizedKeyword)
    if (!tokens.length) {
      return {
        items: [],
        tookMs: Date.now() - started,
        indexedCount: this.docs.length,
        snapshotAt: this.lastBuiltAt
      }
    }

    const safeLimit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Number(limit) || DEFAULT_LIMIT))
    let candidateSet: Set<number> | null = null
    for (const token of tokens) {
      const indexedCandidates = this.getIndexedCandidatesByToken(token)
      if (indexedCandidates) {
        candidateSet = candidateSet
          ? intersectSets(candidateSet, indexedCandidates)
          : indexedCandidates
      }
      if (candidateSet && candidateSet.size === 0) {
        return {
          items: [],
          tookMs: Date.now() - started,
          indexedCount: this.docs.length,
          snapshotAt: this.lastBuiltAt
        }
      }
    }

    const candidateIndices = candidateSet ? Array.from(candidateSet) : this.allDocIndices
    const scored: GlobalSongSearchResultItem[] = []
    for (const docIndex of candidateIndices) {
      const doc = this.docs[docIndex]
      if (!doc) continue
      const matched = tokens.every(
        (token) => doc.searchText.includes(token) || doc.searchCompact.includes(token)
      )
      if (!matched) continue
      const score = this.calculateScore(doc, tokens)
      scored.push({
        id: doc.id,
        filePath: doc.filePath,
        fileName: doc.fileName,
        title: doc.title,
        artist: doc.artist,
        album: doc.album,
        genre: doc.genre,
        label: doc.label,
        duration: doc.duration,
        keyText: doc.keyText,
        bpm: doc.bpm,
        container: doc.container,
        songListUUID: doc.songListUUID,
        songListName: doc.songListName,
        songListPath: doc.songListPath,
        libraryName: doc.libraryName,
        score
      })
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const titleCmp = a.title.localeCompare(b.title, 'zh-CN', { sensitivity: 'base' })
      if (titleCmp !== 0) return titleCmp
      const artistCmp = a.artist.localeCompare(b.artist, 'zh-CN', { sensitivity: 'base' })
      if (artistCmp !== 0) return artistCmp
      return a.filePath.localeCompare(b.filePath, 'zh-CN', { sensitivity: 'base' })
    })

    return {
      items: scored.slice(0, safeLimit),
      tookMs: Date.now() - started,
      indexedCount: this.docs.length,
      snapshotAt: this.lastBuiltAt
    }
  }

  async getPlaylistFastLoad(songListUUID: string): Promise<PlaylistFastLoadResult> {
    const started = Date.now()
    const normalizedUuid = String(songListUUID || '').trim()
    const miss = (): PlaylistFastLoadResult => ({
      hit: false,
      items: [],
      missingWaveformFilePaths: [],
      tookMs: Date.now() - started,
      snapshotAt: this.lastBuiltAt,
      listRoot: '',
      identityDigest: ''
    })
    if (!normalizedUuid) return miss()

    // 打开歌单不能等全库索引重建；核对走 worker，搜歌索引在后台补。
    if (!this.ready) this.startBackgroundRebuild('playlist-fast-load-cold')
    else if (this.dirty) this.startBackgroundRebuild('playlist-fast-load-dirty')

    const playlistMeta = this.findPlaylistMetaByUuid(normalizedUuid)
    if (!playlistMeta?.absPath) return miss()

    try {
      const verified = await verifyPlaylistCacheOffMainThread({
        scanPath: playlistMeta.absPath,
        audioExt: store.settingConfig.audioExt || [],
        songListUUID: normalizedUuid,
        databaseDir: store.databaseDir
      })
      if (!verified?.cacheIdentityVerified) return miss()
      this.dirtyPlaylists.delete(normalizedUuid)
      this.playlistSongs.set(normalizedUuid, verified.scanData)
      return {
        hit: true,
        items: verified.scanData,
        missingWaveformFilePaths: Array.isArray(verified.missingWaveformFilePaths)
          ? verified.missingWaveformFilePaths
          : [],
        tookMs: Date.now() - started,
        snapshotAt: this.lastBuiltAt,
        listRoot: playlistMeta.absPath,
        identityDigest: String(verified.identityDigest || '')
      }
    } catch {
      return miss()
    }
  }

  private getOrCreateRebuildTask() {
    if (!this.buildingPromise) {
      // 不能从 IPC 调用栈直接进入 rebuild：async 函数会在首个 await 前同步执行，
      // 曾经这里的 SQLite 全量 .all() 会让“打开歌单”连 loading 都来不及画出。
      this.buildingPromise = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          void this.rebuild().then(resolve, reject)
        })
      }).finally(() => {
        this.buildingPromise = null
      })
    }
    return this.buildingPromise
  }

  private startBackgroundRebuild(reason: string) {
    void this.getOrCreateRebuildTask().catch((error) => {
      log.error(`[song-search] rebuild failed (${reason})`, error)
    })
  }

  private async ensureReady(force = false, options?: EnsureReadyOptions) {
    const stale = Date.now() - this.lastBuiltAt > AUTO_REBUILD_AGE_MS
    const allowDirtyStale = options?.allowDirtyStale === true
    const allowAgedStale = options?.allowAgedStale === true
    const canUseCurrentSnapshot = this.ready && this.docs.length > 0

    if (force || !this.ready) {
      await this.getOrCreateRebuildTask()
      return
    }

    if (this.dirty) {
      if (allowDirtyStale && canUseCurrentSnapshot) {
        this.startBackgroundRebuild('dirty')
        return
      }
      await this.getOrCreateRebuildTask()
      return
    }

    if (stale) {
      if (allowAgedStale && canUseCurrentSnapshot) {
        this.startBackgroundRebuild('stale')
        return
      }
      await this.getOrCreateRebuildTask()
    }
  }

  private async rebuild() {
    const db = getLibraryDb()
    if (!db) {
      this.docs = []
      this.allDocIndices = []
      this.trigramIndex = new Map()
      this.bigramIndex = new Map()
      this.charIndex = new Map()
      this.playlistSongs = new Map()
      this.knownPlaylists = new Set()
      this.lastBuiltAt = Date.now()
      this.ready = true
      this.dirty = false
      this.dirtyPlaylists = new Set()
      return
    }

    type SongCacheRow = {
      row_id: number
      list_root: string
      file_path: string
      info_json: string
    }

    const songCachePageQuery = db.prepare<SongCacheRow>(
      `SELECT rowid AS row_id, list_root, file_path, info_json
       FROM song_cache
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
    )

    const playlistInfo = this.buildPlaylistMeta()
    const docs: SearchDoc[] = []
    const trigramIndex = new Map<string, Set<number>>()
    const bigramIndex = new Map<string, Set<number>>()
    const charIndex = new Map<string, Set<number>>()
    const playlistSongsMap = new Map<string, Map<string, ISongInfo>>()
    const knownPlaylists = new Set<string>(playlistInfo.knownUuids)

    let processedRows = 0
    let lastRowId = 0
    while (true) {
      const songCacheRows = songCachePageQuery.all(lastRowId, SEARCH_REBUILD_DB_PAGE_ROWS)
      if (songCacheRows.length === 0) break

      for (const row of songCacheRows) {
        processedRows += 1
        const rowId = Number(row?.row_id)
        if (Number.isFinite(rowId) && rowId > lastRowId) {
          lastRowId = rowId
        }
        if (!row || !row.list_root || row.info_json === undefined) continue

        const listRootAbs = resolveListRootAbsolute(String(row.list_root))
        const normalizedListRoot = normalizePathForCompare(listRootAbs)
        let playlist = playlistInfo.byAbsPath.get(normalizedListRoot)
        if (!playlist) {
          playlist = this.findPlaylistByPrefix(playlistInfo.byAbsPath, normalizedListRoot)
        }

        const parsedInfo = tryParseSongInfo(row.info_json)
        const fallbackAbsPath = (() => {
          const filePathRaw = String(row.file_path || '').trim()
          if (!filePathRaw) return ''
          if (path.isAbsolute(filePathRaw)) return filePathRaw
          if (!listRootAbs) return filePathRaw
          return path.join(listRootAbs, filePathRaw)
        })()
        const filePath = String(parsedInfo?.filePath || fallbackAbsPath).trim()
        if (!filePath) continue

        const songInfo = toSongInfo(parsedInfo, filePath)
        const songListUUID = playlist?.uuid || ''
        const songListName = playlist?.dirName || ''
        const songListPath = playlist?.relPath ? playlist.relPath.replace(/\\/g, '/') : ''
        const libraryName = playlist?.libraryName || 'FilterLibrary'
        const extendedTerms = collectExtendedSearchTerms(parsedInfo)

        const searchText = normalizeText(
          [
            songInfo.title,
            songInfo.artist,
            songInfo.album,
            songInfo.genre,
            songInfo.label,
            songInfo.fileName,
            songInfo.fileFormat,
            songInfo.container,
            songInfo.duration,
            songInfo.bitrate,
            songInfo.key,
            songInfo.bpm,
            libraryName,
            songListUUID,
            songListName,
            songListPath,
            songInfo.filePath,
            ...extendedTerms
          ]
            .filter((item) => item !== undefined && item !== null && String(item).trim().length > 0)
            .join(' ')
        )
        if (!searchText) continue

        const searchCompact = compactText(searchText)
        const docIndex = docs.length
        const doc: SearchDoc = {
          id: `${songListUUID || 'unknown'}|${songInfo.filePath}|${docIndex}`,
          filePath: songInfo.filePath,
          fileName: songInfo.fileName || path.basename(songInfo.filePath),
          title: String(songInfo.title || ''),
          artist: String(songInfo.artist || ''),
          album: String(songInfo.album || ''),
          genre: String(songInfo.genre || ''),
          label: String(songInfo.label || ''),
          duration: String(songInfo.duration || ''),
          keyText: String(songInfo.key || ''),
          bpm: songInfo.bpm,
          container: String(songInfo.container || ''),
          songListUUID,
          songListName,
          songListPath,
          libraryName,
          searchText,
          searchCompact,
          titleNorm: normalizeText(songInfo.title),
          artistNorm: normalizeText(songInfo.artist),
          albumNorm: normalizeText(songInfo.album),
          genreNorm: normalizeText(songInfo.genre),
          labelNorm: normalizeText(songInfo.label),
          keyNorm: normalizeText(songInfo.key),
          containerNorm: normalizeText(songInfo.container),
          fileNameNorm: normalizeText(songInfo.fileName),
          songListNameNorm: normalizeText(songListName),
          pathNorm: normalizeText(songInfo.filePath)
        }
        docs.push(doc)

        const charTerms = new Set(searchCompact.split('').filter(Boolean))
        const bigramTerms = buildNgramSet(searchCompact, 2)
        const trigramTerms = buildNgramSet(searchCompact, 3)
        addToInvertedIndex(charIndex, charTerms, docIndex)
        addToInvertedIndex(bigramIndex, bigramTerms, docIndex)
        addToInvertedIndex(trigramIndex, trigramTerms, docIndex)

        if (songListUUID) {
          const bucket = playlistSongsMap.get(songListUUID) || new Map<string, ISongInfo>()
          bucket.set(normalizePathForCompare(songInfo.filePath), songInfo)
          playlistSongsMap.set(songListUUID, bucket)
        }

        if (processedRows % SEARCH_REBUILD_YIELD_EVERY_ROWS === 0) {
          await yieldToNodeMainLoop()
        }
      }

      await yieldToNodeMainLoop()
    }

    const playlistSongs = new Map<string, ISongInfo[]>()
    for (const [uuid, bucket] of playlistSongsMap) {
      playlistSongs.set(uuid, Array.from(bucket.values()).sort(comparePlaylistSongOrder))
    }
    for (const uuid of knownPlaylists) {
      if (!playlistSongs.has(uuid)) {
        playlistSongs.set(uuid, [])
      }
    }

    this.docs = docs
    this.allDocIndices = docs.map((_, index) => index)
    this.trigramIndex = trigramIndex
    this.bigramIndex = bigramIndex
    this.charIndex = charIndex
    this.playlistSongs = playlistSongs
    this.knownPlaylists = knownPlaylists
    this.lastBuiltAt = Date.now()
    this.ready = true
    this.dirty = false
    this.dirtyPlaylists = new Set()
  }

  private getIndexedCandidatesByToken(token: string) {
    const normalized = compactText(normalizeText(token))
    if (!normalized) return null
    if (normalized.length === 1) {
      return this.charIndex.get(normalized) || new Set<number>()
    }
    if (normalized.length === 2) {
      return this.bigramIndex.get(normalized) || new Set<number>()
    }
    const trigrams = Array.from(buildNgramSet(normalized, 3))
    if (!trigrams.length) return null
    let merged: Set<number> | null = null
    for (const gram of trigrams) {
      const bucket = this.trigramIndex.get(gram)
      if (!bucket) return new Set<number>()
      merged = merged ? intersectSets(merged, bucket) : new Set<number>(bucket)
      if (merged.size === 0) return merged
    }
    return merged
  }

  private calculateScore(doc: SearchDoc, tokens: string[]) {
    let score = 0
    for (const rawToken of tokens) {
      const token = compactText(rawToken)
      if (!token) continue
      if (doc.titleNorm.startsWith(token)) {
        score += 60
      } else if (doc.titleNorm.includes(token)) {
        score += 40
      }
      if (doc.artistNorm.includes(token)) score += 25
      if (doc.albumNorm.includes(token)) score += 22
      if (doc.genreNorm.includes(token)) score += 20
      if (doc.labelNorm.includes(token)) score += 18
      if (doc.fileNameNorm.includes(token)) score += 20
      if (doc.keyNorm.includes(token)) score += 16
      if (doc.containerNorm.includes(token)) score += 14
      if (doc.songListNameNorm.includes(token)) score += 14
      if (doc.pathNorm.includes(token)) score += 10
    }
    return score
  }

  private buildPlaylistMeta(): {
    byAbsPath: Map<string, PlaylistMeta>
    knownUuids: Set<string>
  } {
    const rows = loadLibraryNodes(store.databaseDir) || []
    const byAbsPath = new Map<string, PlaylistMeta>()
    const knownUuids = new Set<string>()
    if (!rows.length || !store.databaseDir) return { byAbsPath, knownUuids }

    const pathByUuid = buildNodePathMap(rows)
    for (const row of rows) {
      if (row.nodeType !== 'songList' && row.nodeType !== 'mixtapeList') continue
      const relPath = pathByUuid.get(row.uuid)
      if (!relPath) continue
      const absPath = path.join(store.databaseDir, relPath)
      const normalizedAbsPath = normalizePathForCompare(absPath)
      const libraryName = resolveLibraryNameByRelativePath(relPath)
      knownUuids.add(row.uuid)
      byAbsPath.set(normalizedAbsPath, {
        uuid: row.uuid,
        dirName: row.dirName,
        relPath,
        absPath,
        normalizedAbsPath,
        libraryName
      })
    }
    return { byAbsPath, knownUuids }
  }

  private findPlaylistByPrefix(
    map: Map<string, PlaylistMeta>,
    normalizedListRoot: string
  ): PlaylistMeta | undefined {
    if (!normalizedListRoot) return undefined
    let matched: PlaylistMeta | undefined
    for (const meta of map.values()) {
      if (!meta.normalizedAbsPath) continue
      if (
        normalizedListRoot === meta.normalizedAbsPath ||
        normalizedListRoot.startsWith(`${meta.normalizedAbsPath}/`)
      ) {
        if (!matched || meta.normalizedAbsPath.length > matched.normalizedAbsPath.length) {
          matched = meta
        }
      }
    }
    return matched
  }

  private findPlaylistMetaByUuid(uuid: string): PlaylistMeta | undefined {
    const playlistInfo = this.buildPlaylistMeta()
    for (const meta of playlistInfo.byAbsPath.values()) {
      if (meta.uuid === uuid) return meta
    }
    return undefined
  }
}

const globalSongSearchEngine = new GlobalSongSearchEngine()

export const markGlobalSongSearchDirty = (
  reason?: string,
  options?: MarkGlobalSongSearchDirtyOptions
) => {
  globalSongSearchEngine.markDirty(reason, options)
}

export default globalSongSearchEngine
