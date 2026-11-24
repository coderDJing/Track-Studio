import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUTPUT_PATH = path.join(ROOT, 'resources', 'demoAnalysis', 'demo-analysis-seed.sqlite')
const DATABASE_FILE_NAME = 'FRKB.database.sqlite'

const DEMO_TRACKS = [
  {
    fileName: 'Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3',
    playlistHint: 'filterlibrary/house'
  },
  {
    fileName: 'War - Low Rider (Kyle Watson Remix).mp3',
    playlistHint: 'filterlibrary/house'
  },
  {
    fileName: 'Armand Van Helden - I Want Your Soul (AVH Rework).mp3',
    playlistHint: 'curatedlibrary/house nice'
  }
]

// 只保留“分析结果”本身；播放列表位置、热标记、外部库绑定等属于用户/环境数据。
const USER_SPECIFIC_FIELDS = [
  'playlistTrackNumber',
  'addedAtMs',
  'mixOrder',
  'mixtapeItemId',
  'setItemId',
  'hotCues',
  'memoryCues',
  'deletedAtMs',
  'originalPlaylistPath',
  'recycleBinSourceType',
  'analysisOnly',
  'autoFilled',
  'externalAnalyzePath',
  'externalWaveformRootPath',
  'waveformPreviewListRoot',
  'externalSourceKind',
  'externalLibraryKind',
  'externalWaveformPreference',
  'externalBeatGridPreference',
  'pioneerCoverPath',
  'pioneerAnalyzePath',
  'pioneerDeviceRootPath',
  'pioneerUsbSource',
  'rekordboxGridEntries',
  'neteaseSongId',
  'neteaseDownloaded',
  'neteaseLocalPath',
  'neteasePendingDownload',
  'neteasePendingStatus',
  'neteasePendingError'
]

const parseArgs = (argv) => {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--library-dir' || arg === '--db' || arg === '--out') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`)
      options[arg.slice(2)] = value
      i += 1
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

const readDotEnv = () => {
  const result = {}
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) return result
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return result
}

const toPosix = (value) => String(value || '').replace(/\\/g, '/')

const toLibraryRelative = (rawPath) => {
  const text = toPosix(rawPath)
  if (!text) return null
  if (!/^([A-Za-z]:)?\//.test(text)) return text.replace(/^\/+/, '')
  const parts = text.split('/').filter(Boolean)
  const index = parts.findIndex((part) => part.toLowerCase() === 'library')
  if (index < 0) return null
  return parts.slice(index).join('/')
}

const toPlaylistRelative = (rawFilePath, rawListRoot) => {
  const fileText = toPosix(rawFilePath)
  if (!fileText) return null
  if (!/^([A-Za-z]:)?\//.test(fileText)) return fileText
  const rootText = toPosix(rawListRoot).replace(/\/+$/, '')
  const lowerRoot = rootText.toLowerCase()
  if (rootText && fileText.toLowerCase().startsWith(`${lowerRoot}/`)) {
    return fileText.slice(rootText.length + 1)
  }
  return path.posix.basename(fileText)
}

const requirePositiveInt = (value, label) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    throw new Error(`${label} 无效：${value}`)
  }
  return numeric
}

const requireBuffer = (value, label) => {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : null
  if (!buffer || buffer.byteLength === 0) throw new Error(`${label} 为空，先对示例曲完成分析`)
  return buffer
}

const resolveSongRow = (songRows, track) => {
  const candidates = songRows.filter(
    (row) =>
      path.posix.basename(toPosix(row.file_path)).toLowerCase() === track.fileName.toLowerCase()
  )
  if (candidates.length === 0) return null
  const hinted = candidates.find((row) =>
    toPosix(row.list_root).toLowerCase().includes(track.playlistHint)
  )
  if (hinted) return hinted
  if (candidates.length === 1) return candidates[0]
  throw new Error(
    `示例曲 ${track.fileName} 在多个歌单中出现，无法确定使用哪一份分析结果：` +
      candidates.map((row) => toPosix(row.list_root)).join(', ')
  )
}

const createOutputSchema = (db) => {
  db.exec(`
    CREATE TABLE demo_seed_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE demo_song_cache (
      list_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      info_json TEXT NOT NULL,
      PRIMARY KEY (list_root, file_path)
    );
    CREATE TABLE demo_waveform_surface_cache (
      list_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      cache_version INTEGER NOT NULL,
      list_preview_parameter_version INTEGER NOT NULL,
      global_overview_parameter_version INTEGER NOT NULL,
      duration REAL NOT NULL,
      sample_rate INTEGER NOT NULL,
      list_preview_frame_count INTEGER NOT NULL,
      global_overview_frame_count INTEGER NOT NULL,
      list_preview_payload BLOB NOT NULL,
      global_overview_payload BLOB NOT NULL,
      PRIMARY KEY (list_root, file_path)
    );
    CREATE TABLE demo_unified_display_waveform_cache (
      list_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      cache_version INTEGER NOT NULL,
      parameter_version INTEGER NOT NULL,
      duration REAL NOT NULL,
      detail_rate INTEGER NOT NULL,
      overview_rate INTEGER NOT NULL,
      frame_count INTEGER NOT NULL,
      payload BLOB NOT NULL,
      PRIMARY KEY (list_root, file_path)
    );
  `)
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const env = readDotEnv()
  const libraryDir =
    options['library-dir'] || process.env.FRKB_DEV_DATABASE_URL || env.FRKB_DEV_DATABASE_URL
  const sourcePath = options.db
    ? path.resolve(options.db)
    : libraryDir
      ? path.join(path.resolve(libraryDir), DATABASE_FILE_NAME)
      : ''
  if (!sourcePath) {
    throw new Error('缺少数据源：请传 --db <FRKB.database.sqlite> 或 --library-dir <音乐库目录>')
  }
  if (!fs.existsSync(sourcePath)) throw new Error(`数据库不存在：${sourcePath}`)

  const outputPath = options.out ? path.resolve(options.out) : OUTPUT_PATH
  const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    const songRows = sourceDb
      .prepare('SELECT list_root, file_path, size, mtime_ms, info_json FROM song_cache')
      .all()
    const surfaceStmt = sourceDb.prepare(
      `SELECT list_root, file_path, size, mtime_ms, cache_version,
              list_preview_parameter_version, global_overview_parameter_version,
              duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
              list_preview_payload, global_overview_payload
         FROM waveform_surface_cache
        WHERE list_root = ? AND file_path = ?`
    )
    const unifiedStmt = sourceDb.prepare(
      `SELECT list_root, file_path, size, mtime_ms, cache_version, parameter_version,
              duration, detail_rate, overview_rate, frame_count, payload
         FROM unified_display_waveform_cache
        WHERE list_root = ? AND file_path = ?`
    )

    const records = []
    let seedVersions = null
    for (const track of DEMO_TRACKS) {
      const songRow = resolveSongRow(songRows, track)
      if (!songRow) {
        throw new Error(`未找到示例曲 ${track.fileName} 的缓存，请先在开发版里对示例曲执行分析`)
      }
      const info = JSON.parse(String(songRow.info_json))
      if (!info?.key) throw new Error(`示例曲 ${track.fileName} 缺少调性分析结果`)
      if (!info?.beatGridMap) throw new Error(`示例曲 ${track.fileName} 缺少网格分析结果`)
      if (!Number.isFinite(Number(info?.energyScore))) {
        throw new Error(`示例曲 ${track.fileName} 缺少能量分析结果`)
      }
      if (!info?.songStructure) {
        console.warn(`[warn] ${track.fileName} 没有曲式分析结果，示例里也不会显示曲式`)
      }

      const surfaceRow = surfaceStmt.get(songRow.list_root, songRow.file_path)
      if (!surfaceRow) throw new Error(`示例曲 ${track.fileName} 缺少列表波形缓存`)
      const unifiedRow = unifiedStmt.get(songRow.list_root, songRow.file_path)
      if (!unifiedRow) throw new Error(`示例曲 ${track.fileName} 缺少播放器波形缓存`)

      const listRoot = toLibraryRelative(songRow.list_root)
      const filePath = toPlaylistRelative(songRow.file_path, songRow.list_root)
      if (!listRoot || !filePath)
        throw new Error(`示例曲 ${track.fileName} 的缓存键无法转为相对路径`)

      const versions = {
        waveformSurfaceCacheVersion: requirePositiveInt(
          surfaceRow.cache_version,
          'waveform surface cache_version'
        ),
        waveformListPreviewParameterVersion: requirePositiveInt(
          surfaceRow.list_preview_parameter_version,
          'list preview parameter_version'
        ),
        waveformGlobalOverviewParameterVersion: requirePositiveInt(
          surfaceRow.global_overview_parameter_version,
          'global overview parameter_version'
        ),
        unifiedDisplayWaveformCacheVersion: requirePositiveInt(
          unifiedRow.cache_version,
          'unified display cache_version'
        ),
        unifiedDisplayWaveformParameterVersion: requirePositiveInt(
          unifiedRow.parameter_version,
          'unified display parameter_version'
        ),
        beatGridAlgorithmVersion: requirePositiveInt(
          info.beatGridAlgorithmVersion,
          'beatGridAlgorithmVersion'
        ),
        keyAnalysisAlgorithmVersion: requirePositiveInt(
          info.keyAnalysisAlgorithmVersion,
          'keyAnalysisAlgorithmVersion'
        ),
        songEnergyAlgorithmVersion: requirePositiveInt(
          info.energyAlgorithmVersion,
          'energyAlgorithmVersion'
        )
      }
      if (!seedVersions) {
        seedVersions = versions
      } else if (JSON.stringify(seedVersions) !== JSON.stringify(versions)) {
        throw new Error(
          `示例曲之间的分析版本不一致，请对三首示例曲全部重新分析后重试：${track.fileName}`
        )
      }

      for (const field of USER_SPECIFIC_FIELDS) delete info[field]

      records.push({
        listRoot,
        filePath,
        size: Number(songRow.size),
        mtimeMs: Number(songRow.mtime_ms),
        info,
        surface: {
          size: Number(surfaceRow.size),
          mtimeMs: Number(surfaceRow.mtime_ms),
          duration: Number(surfaceRow.duration),
          sampleRate: requirePositiveInt(surfaceRow.sample_rate, 'sample_rate'),
          listPreviewFrameCount: requirePositiveInt(
            surfaceRow.list_preview_frame_count,
            'list_preview_frame_count'
          ),
          globalOverviewFrameCount: requirePositiveInt(
            surfaceRow.global_overview_frame_count,
            'global_overview_frame_count'
          ),
          listPreviewPayload: requireBuffer(surfaceRow.list_preview_payload, '列表波形'),
          globalOverviewPayload: requireBuffer(surfaceRow.global_overview_payload, '总览波形')
        },
        unified: {
          size: Number(unifiedRow.size),
          mtimeMs: Number(unifiedRow.mtime_ms),
          duration: Number(unifiedRow.duration),
          detailRate: Number(unifiedRow.detail_rate),
          overviewRate: Number(unifiedRow.overview_rate),
          frameCount: requirePositiveInt(unifiedRow.frame_count, 'frame_count'),
          payload: requireBuffer(unifiedRow.payload, '播放器波形')
        }
      })
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    const tempPath = `${outputPath}.tmp`
    fs.rmSync(tempPath, { force: true })
    const outputDb = new Database(tempPath)
    try {
      outputDb.pragma('journal_mode = OFF')
      createOutputSchema(outputDb)
      const insertMeta = outputDb.prepare('INSERT INTO demo_seed_meta (key, value) VALUES (?, ?)')
      const insertSong = outputDb.prepare(
        `INSERT INTO demo_song_cache (list_root, file_path, size, mtime_ms, info_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      const insertSurface = outputDb.prepare(
        `INSERT INTO demo_waveform_surface_cache (
           list_root, file_path, size, mtime_ms, cache_version,
           list_preview_parameter_version, global_overview_parameter_version,
           duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
           list_preview_payload, global_overview_payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insertUnified = outputDb.prepare(
        `INSERT INTO demo_unified_display_waveform_cache (
           list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
           detail_rate, overview_rate, frame_count, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const write = outputDb.transaction(() => {
        for (const [key, value] of Object.entries(seedVersions)) {
          insertMeta.run(key, String(value))
        }
        for (const record of records) {
          insertSong.run(
            record.listRoot,
            record.filePath,
            record.size,
            record.mtimeMs,
            JSON.stringify(record.info)
          )
          insertSurface.run(
            record.listRoot,
            record.filePath,
            record.surface.size,
            record.surface.mtimeMs,
            seedVersions.waveformSurfaceCacheVersion,
            seedVersions.waveformListPreviewParameterVersion,
            seedVersions.waveformGlobalOverviewParameterVersion,
            record.surface.duration,
            record.surface.sampleRate,
            record.surface.listPreviewFrameCount,
            record.surface.globalOverviewFrameCount,
            record.surface.listPreviewPayload,
            record.surface.globalOverviewPayload
          )
          insertUnified.run(
            record.listRoot,
            record.filePath,
            record.unified.size,
            record.unified.mtimeMs,
            seedVersions.unifiedDisplayWaveformCacheVersion,
            seedVersions.unifiedDisplayWaveformParameterVersion,
            record.unified.duration,
            record.unified.detailRate,
            record.unified.overviewRate,
            record.unified.frameCount,
            record.unified.payload
          )
        }
      })
      write()
    } finally {
      outputDb.close()
    }
    fs.rmSync(outputPath, { force: true })
    fs.renameSync(tempPath, outputPath)
    const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)
    console.log(`已导出示例分析缓存：${outputPath}（${sizeMb} MB，${records.length} 首）`)
    console.log(`版本：${JSON.stringify(seedVersions)}`)
  } finally {
    sourceDb.close()
  }
}

try {
  main()
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
