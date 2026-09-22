import { ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from '../../types/globals'
import {
  normalizeSongHotCueSec,
  normalizeSongHotCues,
  normalizeSongHotCueSlot,
  removeSongHotCue,
  upsertSongHotCue,
  upsertSongHotCueDefinition
} from '../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'
import { upsertMixtapeItemHotCuesByFilePath } from '../mixtapeDb'
import { upsertMixtapeItemMemoryCuesByFilePath } from '../mixtapeDb'
import { emitSongHotCuesUpdated } from '../services/songHotCueEvents'
import { emitSongMemoryCuesUpdated } from '../services/songMemoryCueEvents'
import {
  loadSharedSongHotCueDefinition,
  persistSharedSongHotCueDefinition
} from '../services/sharedSongHotCues'
import { persistSharedSongMemoryCueDefinition } from '../services/sharedSongMemoryCues'
import { findSongListRoot } from '../services/cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../services/songInfoLite'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'

const ANALYSIS_FIELD_KEYS = [
  'key',
  'keyAnalysisAlgorithmVersion',
  'energyScore',
  'energyAlgorithmVersion',
  'energyAnalysis'
] as const

type SongAnalysisFieldKey = (typeof ANALYSIS_FIELD_KEYS)[number]
type SongAnalysisFieldPayload = Pick<ISongInfo, SongAnalysisFieldKey>

const copyAnalysisFields = (source: Partial<ISongInfo> | null | undefined) => {
  const next: Partial<SongAnalysisFieldPayload> = {}
  if (!source || typeof source !== 'object') return next
  for (const key of ANALYSIS_FIELD_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      next[key] = value as never
    }
  }
  return next
}

const hasAnalysisFields = (value: Partial<SongAnalysisFieldPayload>) =>
  ANALYSIS_FIELD_KEYS.some((key) => value[key] !== undefined)

export function registerHotCueHandlers() {
  ipcMain.handle('song:get-hot-cues', async (_event, payload?: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return []
    const result = await loadSharedSongHotCueDefinition(filePath)
    return result?.hotCues || []
  })

  ipcMain.handle(
    'song:set-hot-cue',
    async (
      _event,
      payload?: {
        filePath?: string
        slot?: number
        sec?: number
        durationSec?: number
        isLoop?: boolean
        loopEndSec?: number
      }
    ) => {
      assertLibraryMergeMutationAllowed()
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const slot = normalizeSongHotCueSlot(payload?.slot)
      const sec = normalizeSongHotCueSec(payload?.sec, payload?.durationSec)
      if (!filePath || slot === null || sec === null)
        return { filePath, hotCues: [] as ISongHotCue[] }

      const current = await loadSharedSongHotCueDefinition(filePath)
      const hotCues =
        payload?.isLoop &&
        normalizeSongHotCueSec(payload?.loopEndSec, payload?.durationSec) !== null
          ? upsertSongHotCueDefinition(
              current?.hotCues,
              {
                slot,
                sec,
                isLoop: true,
                loopEndSec: payload?.loopEndSec
              },
              payload?.durationSec
            )
          : upsertSongHotCue(current?.hotCues, slot, sec, payload?.durationSec)
      const persisted = (await persistSharedSongHotCueDefinition({
        filePath,
        hotCues
      })) || { filePath, hotCues }

      upsertMixtapeItemHotCuesByFilePath([{ filePath, hotCues: persisted.hotCues }])
      emitSongHotCuesUpdated(persisted)
      return persisted
    }
  )

  ipcMain.handle(
    'song:delete-hot-cue',
    async (_event, payload?: { filePath?: string; slot?: number; durationSec?: number }) => {
      assertLibraryMergeMutationAllowed()
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const slot = normalizeSongHotCueSlot(payload?.slot)
      if (!filePath || slot === null) return { filePath, hotCues: [] as ISongHotCue[] }

      const current = await loadSharedSongHotCueDefinition(filePath)
      const hotCues = removeSongHotCue(current?.hotCues, slot, payload?.durationSec)
      const persisted = (await persistSharedSongHotCueDefinition({
        filePath,
        hotCues
      })) || { filePath, hotCues }

      upsertMixtapeItemHotCuesByFilePath([{ filePath, hotCues: persisted.hotCues }])
      emitSongHotCuesUpdated(persisted)
      return persisted
    }
  )

  ipcMain.handle(
    'song:copy-cue-definitions-by-file-path',
    async (
      _event,
      payload?: {
        entries?: Array<{
          filePath?: string
          hotCues?: ISongHotCue[]
          memoryCues?: ISongMemoryCue[]
        }>
      }
    ) => {
      assertLibraryMergeMutationAllowed()
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      let hotCueUpdated = 0
      let memoryCueUpdated = 0

      for (const entry of entries) {
        const filePath = typeof entry?.filePath === 'string' ? entry.filePath.trim() : ''
        if (!filePath) continue

        const hotCues = normalizeSongHotCues(entry?.hotCues)
        if (hotCues.length > 0) {
          const persistedHotCues = await persistSharedSongHotCueDefinition({
            filePath,
            hotCues
          })
          if (persistedHotCues?.hotCues?.length) {
            upsertMixtapeItemHotCuesByFilePath([{ filePath, hotCues: persistedHotCues.hotCues }])
            emitSongHotCuesUpdated(persistedHotCues)
            hotCueUpdated += 1
          }
        }

        const memoryCues = normalizeSongMemoryCues(entry?.memoryCues)
        if (memoryCues.length > 0) {
          const persistedMemoryCues = await persistSharedSongMemoryCueDefinition({
            filePath,
            memoryCues
          })
          if (persistedMemoryCues?.memoryCues?.length) {
            upsertMixtapeItemMemoryCuesByFilePath([
              { filePath, memoryCues: persistedMemoryCues.memoryCues }
            ])
            emitSongMemoryCuesUpdated(persistedMemoryCues)
            memoryCueUpdated += 1
          }
        }
      }

      return {
        hotCueUpdated,
        memoryCueUpdated
      }
    }
  )

  ipcMain.handle(
    'song:copy-analysis-fields-by-file-path',
    async (
      _event,
      payload?: {
        entries?: Array<{
          filePath?: string
          sourceSong?: Partial<ISongInfo>
        }>
      }
    ) => {
      assertLibraryMergeMutationAllowed()
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      let analysisUpdated = 0

      for (const entry of entries) {
        const filePath = typeof entry?.filePath === 'string' ? entry.filePath.trim() : ''
        if (!filePath) continue
        const analysisFields = copyAnalysisFields(entry?.sourceSong)
        if (!hasAnalysisFields(analysisFields)) continue

        const songListRoot = await findSongListRoot(path.dirname(filePath))
        if (!songListRoot) continue

        let stat: { size: number; mtimeMs: number } | null = null
        try {
          const fileStat = await fs.stat(filePath)
          stat = { size: fileStat.size, mtimeMs: fileStat.mtimeMs }
        } catch {
          continue
        }

        const existing = await LibraryCacheDb.loadSongCacheEntry(songListRoot, filePath)
        const nextInfo = applyLiteDefaults(
          existing?.info ? { ...existing.info } : buildLiteSongInfo(filePath),
          filePath
        )
        Object.assign(nextInfo, analysisFields)
        if (existing?.info?.analysisOnly === false) {
          nextInfo.analysisOnly = false
        } else if (!existing?.info && nextInfo.analysisOnly === undefined) {
          nextInfo.analysisOnly = true
        }

        const updated = await LibraryCacheDb.upsertSongCacheEntry(songListRoot, filePath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          info: nextInfo
        })
        if (updated) analysisUpdated += 1
      }

      return {
        analysisUpdated
      }
    }
  )
}
