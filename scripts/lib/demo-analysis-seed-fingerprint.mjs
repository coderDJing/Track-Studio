import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

export const DEMO_SEED_ASSET_RELEASE_TAG = 'demo-analysis-seed-assets'
export const DEMO_SEED_FILE_NAME = 'demo-analysis-seed.sqlite'
export const DEMO_SEED_FINGERPRINT_FILE_NAME = 'demo-analysis-seed.fingerprint'
export const DEMO_MUSIC_DIR = path.join(ROOT, 'resources', 'demoMusic')

// 版本常量是种子可用性的唯一契约：任一变化，旧种子会被运行时判定不可用。
const VERSION_CONSTANT_SOURCES = [
  {
    file: 'src/shared/songEnergy.ts',
    constants: {
      songEnergyAlgorithmVersion: 'CURRENT_SONG_ENERGY_ALGORITHM_VERSION'
    }
  },
  {
    file: 'src/shared/waveformSurfaceCache.ts',
    constants: {
      waveformSurfaceCacheVersion: 'WAVEFORM_SURFACE_CACHE_VERSION',
      waveformListPreviewParameterVersion: 'WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION',
      waveformGlobalOverviewParameterVersion: 'WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION'
    }
  },
  {
    file: 'src/shared/unifiedDisplayWaveform.ts',
    constants: {
      unifiedDisplayWaveformCacheVersion: 'UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION',
      unifiedDisplayWaveformParameterVersion: 'UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION'
    }
  },
  {
    file: 'src/main/services/beatGridAlgorithmVersion.ts',
    constants: {
      beatGridAlgorithmVersion: 'CURRENT_BEAT_GRID_ALGORITHM_VERSION'
    }
  },
  {
    file: 'src/main/services/keyAnalysisAlgorithmVersion.ts',
    constants: {
      keyAnalysisAlgorithmVersion: 'CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION'
    }
  }
]

const sha256File = (filePath) =>
  createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

export const readDemoAnalysisVersionConstants = () => {
  const versions = {}
  for (const source of VERSION_CONSTANT_SOURCES) {
    const absolutePath = path.join(ROOT, source.file)
    const content = fs.readFileSync(absolutePath, 'utf8')
    for (const [metaKey, constantName] of Object.entries(source.constants)) {
      const pattern = new RegExp(`export\\s+const\\s+${constantName}\\s*=\\s*(\\d+)`)
      const match = content.match(pattern)
      if (!match) {
        throw new Error(`无法从 ${source.file} 解析版本常量 ${constantName}`)
      }
      versions[metaKey] = Number(match[1])
    }
  }
  return versions
}

export const listDemoMusicFiles = () => {
  if (!fs.existsSync(DEMO_MUSIC_DIR)) {
    throw new Error(`示例音频目录不存在：${DEMO_MUSIC_DIR}`)
  }
  const files = fs
    .readdirSync(DEMO_MUSIC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
    .map((entry) => entry.name)
    .sort()
  if (files.length === 0) {
    throw new Error(`示例音频目录没有 mp3：${DEMO_MUSIC_DIR}`)
  }
  return files
}

export const computeDemoAnalysisSeedFingerprint = () => {
  const versions = readDemoAnalysisVersionConstants()
  const demoMusic = listDemoMusicFiles().map((name) => {
    const absolutePath = path.join(DEMO_MUSIC_DIR, name)
    return {
      name,
      size: fs.statSync(absolutePath).size,
      sha256: sha256File(absolutePath)
    }
  })
  const payload = JSON.stringify({ versions, demoMusic })
  const fingerprint = createHash('sha256').update(payload).digest('hex').slice(0, 16)
  return { fingerprint, versions, demoMusic }
}

export const demoSeedAssetName = (fingerprint) => `demo-analysis-seed-${fingerprint}.sqlite`

export const verifyDemoAnalysisSeed = (dbPath) => {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { ok: false, reason: `种子文件不存在：${dbPath}` }
  }
  let versions
  let expectedTrackCount
  try {
    versions = readDemoAnalysisVersionConstants()
    expectedTrackCount = listDemoMusicFiles().length
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  let db
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch (error) {
    return {
      ok: false,
      reason: `无法打开种子数据库：${error instanceof Error ? error.message : String(error)}`
    }
  }

  try {
    const rows = db.prepare('SELECT key, value FROM demo_seed_meta').all()
    const meta = new Map(rows.map((row) => [String(row.key), String(row.value)]))
    for (const [key, expected] of Object.entries(versions)) {
      const raw = meta.get(key)
      if (raw === undefined) {
        return { ok: false, reason: `种子缺少版本字段 ${key}` }
      }
      const value = Number(raw)
      if (!Number.isFinite(value) || value !== expected) {
        return { ok: false, reason: `种子版本 ${key}=${raw} 与当前 ${expected} 不一致` }
      }
    }
    const row = db.prepare('SELECT COUNT(*) AS count FROM demo_song_cache').get()
    const trackCount = Number(row?.count)
    if (trackCount !== expectedTrackCount) {
      return {
        ok: false,
        reason: `种子示例曲数量 ${trackCount} 与当前示例音频数量 ${expectedTrackCount} 不一致`
      }
    }
    return { ok: true, reason: '' }
  } catch (error) {
    return {
      ok: false,
      reason: `校验种子数据库失败：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    db.close()
  }
}
