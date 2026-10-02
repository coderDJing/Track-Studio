import fs from 'node:fs/promises'
import path from 'node:path'
import { enqueueKeyAnalysisList } from '../keyAnalysisQueue'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import { findSongListRoot } from '../cacheMaintenance'
import {
  hasRequiredSongEnergyAnalysis,
  hasUsableKeyAnalysis,
  resolveCanonicalSongBeatGridV2
} from '../../../shared/songAnalysisCompleteness'
import type { ISongInfo } from '../../../types/globals'
import type { ExternalAnalysisSourceKind } from '../../libraryCacheDb'

const EXTERNAL_PLAYBACK_SOURCE_ID = 'local'

type PioneerPlaylistAnalysisTrack = {
  filePath?: unknown
}

type PioneerPlaylistAnalysisPrepareResult = {
  sourceKind: ExternalAnalysisSourceKind | ''
  sourceId: string
  usbUuid: string
  usbIdPersisted: boolean
  requested: number
  registered: number
  completeFilePaths: string[]
  queuedFilePaths: string[]
  missingFilePaths: string[]
  staleFilePaths: string[]
}

const normalizeAbsolutePathKey = (filePath: string) => {
  const resolved = path.resolve(String(filePath || '').trim()).replace(/\\/g, '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const buildExternalPlaybackRelativePath = (filePath: string) =>
  `abs:${normalizeAbsolutePathKey(filePath)}`

const hasCompleteFrkbAnalysis = (info: Partial<ISongInfo> | null | undefined) => {
  if (!info) return false
  return (
    hasUsableKeyAnalysis(info) &&
    hasRequiredSongEnergyAnalysis(info) &&
    resolveCanonicalSongBeatGridV2(info).kind !== 'missing'
  )
}

const buildAnalysisOnlyInfo = (filePath: string) => {
  const info = applyLiteDefaults(buildLiteSongInfo(filePath), filePath)
  info.analysisOnly = true
  return info
}

const resolveExternalPlaybackAnalysisSource = (sourceId?: string) => {
  const resolvedSourceId = String(sourceId || '').trim() || EXTERNAL_PLAYBACK_SOURCE_ID
  return {
    sourceKind: 'external-playback' as const,
    sourceId: resolvedSourceId,
    usbUuid: '',
    usbIdPersisted: false
  }
}

async function prepareExternalPlaybackSourcePlaylistAnalysis(params: {
  sourceId?: string
  tracks: PioneerPlaylistAnalysisTrack[]
}): Promise<PioneerPlaylistAnalysisPrepareResult> {
  const tracks = Array.isArray(params?.tracks) ? params.tracks : []
  const source = resolveExternalPlaybackAnalysisSource(params.sourceId)

  const result: PioneerPlaylistAnalysisPrepareResult = {
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    usbUuid: source.usbUuid,
    usbIdPersisted: source.usbIdPersisted,
    requested: tracks.length,
    registered: 0,
    completeFilePaths: [],
    queuedFilePaths: [],
    missingFilePaths: [],
    staleFilePaths: []
  }
  if (!source.sourceId) return result

  await LibraryCacheDb.touchExternalAnalysisDevice(source.sourceKind, source.sourceId, '')
  await LibraryCacheDb.pruneStaleExternalAnalysisDevices()
  if (tracks.length === 0) {
    await LibraryCacheDb.pruneStaleExternalAnalysisCacheEntries(source.sourceKind, source.sourceId)
    return result
  }

  const queued = new Set<string>()
  const complete = new Set<string>()
  for (const track of tracks) {
    const filePath = String(track?.filePath || '').trim()
    if (!filePath) continue
    const songListRoot = await findSongListRoot(path.dirname(filePath))
    if (songListRoot) continue
    const relativePath = buildExternalPlaybackRelativePath(filePath)
    if (!relativePath) continue
    const context = LibraryCacheDb.registerExternalAnalysisContext({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      rootPath: '',
      relativePath,
      filePath
    })
    if (!context) continue
    result.registered += 1

    let stat: { size: number; mtimeMs: number } | null = null
    try {
      const fsStat = await fs.stat(filePath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      await LibraryCacheDb.removeExternalAnalysisCacheEntry(context)
      result.missingFilePaths.push(filePath)
      continue
    }

    const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, stat)
    if (cached === null) {
      result.staleFilePaths.push(filePath)
    }
    if (cached) {
      await LibraryCacheDb.touchExternalAnalysisCacheEntrySeen(context)
    }
    if (cached?.info && hasCompleteFrkbAnalysis(cached.info) && cached.hasWaveform) {
      complete.add(filePath)
      continue
    }

    if (!cached) {
      await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
        context,
        stat,
        buildAnalysisOnlyInfo(filePath)
      )
    }
    queued.add(filePath)
  }

  result.completeFilePaths = Array.from(complete)
  result.queuedFilePaths = Array.from(queued)
  await LibraryCacheDb.pruneStaleExternalAnalysisCacheEntries(source.sourceKind, source.sourceId)
  if (result.queuedFilePaths.length > 0) {
    enqueueKeyAnalysisList(result.queuedFilePaths, 'low', {
      source: 'foreground',
      preemptible: true,
      category: 'visible'
    })
  }
  return result
}

export async function prepareExternalPlaybackPlaylistAnalysis(params: {
  tracks: PioneerPlaylistAnalysisTrack[]
}): Promise<PioneerPlaylistAnalysisPrepareResult> {
  return prepareExternalPlaybackSourcePlaylistAnalysis({
    sourceId: EXTERNAL_PLAYBACK_SOURCE_ID,
    tracks: params.tracks
  })
}
