import fs = require('fs-extra')
import path = require('path')
import { log } from '../log'
import store from '../store'
import { initDatabaseStructure } from '../initDatabase'
import { getLibraryDb, type SqliteDatabase } from '../libraryDb'
import { resolveFilePathInput, resolveListRootInput } from '../libraryCacheDb/pathResolvers'
import { enqueueKeyAnalysisList } from './keyAnalysisQueue'
import { scanSongList } from './scanSongs'
import type { ISongInfo } from '../../types/globals'

const DEMO_PLAYLISTS = [
  {
    playlist: 'FilterLibrary/House',
    songListUuid: 'filterLibrarySonglistDemo1'
  },
  {
    playlist: 'CuratedLibrary/House Nice',
    songListUuid: 'curatedLibrarySonglistDemo1'
  }
]

const DEMO_TRACKS = [
  {
    playlist: 'FilterLibrary/House',
    fileName: 'Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
  },
  {
    playlist: 'FilterLibrary/House',
    fileName: 'War - Low Rider (Kyle Watson Remix).mp3'
  },
  {
    playlist: 'CuratedLibrary/House Nice',
    fileName: 'Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
  }
]

const READY_TIMEOUT_MS = 20 * 60 * 1000
const POLL_INTERVAL_MS = 1000
const PROGRESS_INTERVAL_MS = 30 * 1000

type SeedTarget = {
  absFilePath: string
  listRootKey: string
  fileKey: string
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const parseSongInfo = (raw: unknown): ISongInfo | null => {
  if (raw === undefined || raw === null) return null
  try {
    return JSON.parse(String(raw)) as ISongInfo
  } catch {
    return null
  }
}

const isSongInfoComplete = (info: ISongInfo | null): boolean => {
  if (!info) return false
  if (typeof info.key !== 'string' || info.key.trim() === '') return false
  if (!info.beatGridMap) return false
  if (typeof info.energyScore !== 'number' || !Number.isFinite(info.energyScore)) return false
  return !!info.songStructure
}

const isTargetReady = (db: SqliteDatabase, target: SeedTarget): boolean => {
  const infoRow = db
    .prepare<{ info_json?: unknown }>(
      'SELECT info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
    )
    .get(target.listRootKey, target.fileKey)
  if (!isSongInfoComplete(parseSongInfo(infoRow?.info_json))) return false

  const surfaceRow = db
    .prepare<{ list_preview_payload?: unknown; global_overview_payload?: unknown }>(
      `SELECT list_preview_payload, global_overview_payload
         FROM waveform_surface_cache
        WHERE list_root = ? AND file_path = ?`
    )
    .get(target.listRootKey, target.fileKey)
  if (!surfaceRow?.list_preview_payload || !surfaceRow?.global_overview_payload) return false

  const unifiedRow = db
    .prepare<{ payload?: unknown }>(
      `SELECT payload FROM unified_display_waveform_cache
        WHERE list_root = ? AND file_path = ?`
    )
    .get(target.listRootKey, target.fileKey)
  return !!unifiedRow?.payload
}

const resolveSeedTargets = (libraryDir: string): SeedTarget[] =>
  DEMO_TRACKS.map((track) => {
    const playlistDir = path.join(libraryDir, 'library', ...track.playlist.split('/'))
    const absFilePath = path.join(playlistDir, track.fileName)
    if (!fs.pathExistsSync(absFilePath)) {
      throw new Error(`缺少示例曲文件：${absFilePath}`)
    }
    const resolvedRoot = resolveListRootInput(playlistDir)
    if (!resolvedRoot) throw new Error(`无法解析示例歌单根目录：${playlistDir}`)
    const resolvedFile = resolveFilePathInput(resolvedRoot.abs, absFilePath)
    if (!resolvedFile) throw new Error(`无法解析示例曲缓存键：${absFilePath}`)
    return {
      absFilePath,
      listRootKey: resolvedRoot.key,
      fileKey: resolvedFile.key
    }
  })

/**
 * 打包前生成随包示例分析：在临时库里真实跑一遍分析流水线，
 * 由外层脚本负责把临时库导出成 resources/demoAnalysis 下的 seed 文件。
 */
export async function runDemoAnalysisSeedGeneration(dirPath: string): Promise<void> {
  const libraryDir = path.resolve(dirPath)
  fs.removeSync(libraryDir)
  const initResult = await initDatabaseStructure(libraryDir, { createSamples: true })
  if (!initResult.samplesCreated) {
    throw new Error('示例曲未写入临时库，无法生成预置分析')
  }
  store.databaseDir = libraryDir
  const db = getLibraryDb()
  if (!db) throw new Error('临时库数据库不可用')

  // 先做一次正常歌单扫描，让示例曲带上 title/artist/duration 等元数据，
  // 再进入分析，否则缓存里只有 analysisOnly 的精简信息，首屏展示会缺元数据。
  for (const playlist of DEMO_PLAYLISTS) {
    const playlistDir = path.join(libraryDir, 'library', ...playlist.playlist.split('/'))
    await scanSongList(playlistDir, ['.mp3'], playlist.songListUuid, {
      enablePostScanTasks: false
    })
  }

  const targets = resolveSeedTargets(libraryDir)
  console.log(`[demo-seed] 开始分析 ${targets.length} 首示例曲`)
  enqueueKeyAnalysisList(
    targets.map((target) => target.absFilePath),
    'high',
    {
      source: 'foreground',
      forceAnalysis: true,
      includeStructure: true,
      analysisTargets: {
        key: true,
        bpm: true,
        energy: true,
        structure: true,
        waveform: true
      }
    }
  )

  const startedAt = Date.now()
  let lastProgressAt = startedAt
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    await delay(POLL_INTERVAL_MS)
    const readyCount = targets.filter((target) => isTargetReady(db, target)).length
    if (readyCount === targets.length) {
      console.log(`[demo-seed] 示例曲分析完成：${readyCount}/${targets.length}`)
      return
    }
    if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
      lastProgressAt = Date.now()
      console.log(`[demo-seed] 进度 ${readyCount}/${targets.length}`)
    }
  }
  throw new Error('示例曲分析超时，未能在限定时间内生成完整分析结果')
}
