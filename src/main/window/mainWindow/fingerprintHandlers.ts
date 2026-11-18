import { ipcMain, type BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../../store'
import FingerprintStore from '../../fingerprintStore'
import { collectFilesWithExtensions, getSongsAnalyseResult } from '../../utils'
import { assertLibraryMergeMutationAllowed } from '../../services/libraryMerge/runtime'
import type { SendProgress } from './progress'

interface RegisterFingerprintHandlersOptions {
  sendProgress: SendProgress
  getWindow: () => BrowserWindow | null
}

type FingerprintSummary = {
  startAt: string
  endAt: string
  durationMs: number
  scannedCount: number
  analyzeFailedCount: number
  duplicatesRemovedCount: number
  fingerprintAddedCount: number
  fingerprintTotalBefore: number
  fingerprintTotalAfter: number
  fingerprintMode?: 'pcm' | 'file'
  importedToPlaylistCount?: number
  fingerprintAlreadyExistingCount?: number
  isComparisonSongFingerprint?: boolean
  isPushSongFingerprintLibrary?: boolean
  hideOverviewSection?: boolean
}

const getFingerprintMode = (): 'pcm' | 'file' =>
  store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'

export function registerFingerprintHandlers({
  sendProgress,
  getWindow
}: RegisterFingerprintHandlersOptions) {
  ipcMain.on('addSongFingerprint', async (_e, folderPath: string[]) => {
    assertLibraryMergeMutationAllowed()
    const progressId = `fingerprints_${Date.now()}`
    const fingerprintStartAt = Date.now()
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.scanningFiles',
      now: 0,
      total: 1,
      isInitial: true
    })
    const songFileUrls = (
      await Promise.all(
        folderPath.map((item) => collectFilesWithExtensions(item, store.settingConfig.audioExt))
      )
    ).flat()
    sendProgress({ id: progressId, titleKey: 'fingerprints.scanningFiles', now: 1, total: 1 })
    if (songFileUrls.length === 0) {
      sendProgress({ id: progressId, dismiss: true })
      getWindow()?.webContents.send('noAudioFileWasScanned', progressId)
      return
    }
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.analyzeInit',
      now: 0,
      total: songFileUrls.length
    })
    const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
      songFileUrls,
      (resultLength: number) => {
        sendProgress({
          id: progressId,
          titleKey: 'fingerprints.analyzingFingerprints',
          now: resultLength,
          total: songFileUrls.length
        })
      }
    )
    const uniqueFingerprints = new Set(songsAnalyseResult.map((item) => item.sha256_Hash))
    const removeDuplicatesFingerprintResults = Array.from(uniqueFingerprints)
    const beforeSongFingerprintListLength = store.songFingerprintList.length
    await FingerprintStore.unionFingerprintList(
      removeDuplicatesFingerprintResults,
      getFingerprintMode()
    )
    const fingerprintEndAt = Date.now()
    const duplicatesRemovedCount =
      songFileUrls.length -
      (store.songFingerprintList.length - beforeSongFingerprintListLength) -
      errorSongsAnalyseResult.length
    const fingerprintSummary = {
      startAt: new Date(fingerprintStartAt).toISOString(),
      endAt: new Date(fingerprintEndAt).toISOString(),
      durationMs: fingerprintEndAt - fingerprintStartAt,
      scannedCount: songFileUrls.length,
      analyzeFailedCount: errorSongsAnalyseResult.length,
      duplicatesRemovedCount,
      fingerprintAddedCount: store.songFingerprintList.length - beforeSongFingerprintListLength,
      fingerprintTotalBefore: beforeSongFingerprintListLength,
      fingerprintTotalAfter: store.songFingerprintList.length,
      fingerprintMode: getFingerprintMode()
    }
    sendProgress({ id: progressId, dismiss: true })
    getWindow()?.webContents.send('addSongFingerprintFinished', fingerprintSummary, progressId)
  })

  ipcMain.handle('fingerprints:addExistingFromPaths', async (_event, payload) => {
    assertLibraryMergeMutationAllowed()
    const rawInput = Array.isArray(payload?.filePaths) ? (payload.filePaths as unknown[]) : []
    const normalizedPaths: string[] = Array.from(
      new Set(
        rawInput
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .map((p) => path.normalize(p))
      )
    )
    const audioExts = new Set(
      (store.settingConfig?.audioExt || []).map((ext: string) => ext.toLowerCase())
    )
    const eligibilityResults = await Promise.all(
      normalizedPaths.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath)
          if (!stats.isFile()) return null
          const ext = path.extname(filePath).toLowerCase()
          if (!audioExts.has(ext)) return null
          return filePath
        } catch {
          return null
        }
      })
    )
    const eligiblePaths = eligibilityResults.filter((p): p is string => typeof p === 'string')
    if (eligiblePaths.length === 0) {
      throw new Error('NO_ELIGIBLE_AUDIO')
    }
    const progressId = `fingerprints_${Date.now()}`
    const fingerprintStartAt = Date.now()
    const finalize = (summary: FingerprintSummary | null) => {
      sendProgress({ id: progressId, dismiss: true })
      getWindow()?.webContents.send('fingerprints:addExistingFinished', summary, progressId)
    }
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.scanningFiles',
      now: 0,
      total: 1,
      isInitial: true
    })
    sendProgress({
      id: progressId,
      titleKey: 'fingerprints.scanningFiles',
      now: 1,
      total: 1
    })
    try {
      sendProgress({
        id: progressId,
        titleKey: 'fingerprints.analyzeInit',
        now: 0,
        total: eligiblePaths.length
      })
      const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
        eligiblePaths,
        (resultLength: number) => {
          sendProgress({
            id: progressId,
            titleKey: 'fingerprints.analyzingFingerprints',
            now: resultLength,
            total: eligiblePaths.length
          })
        }
      )
      const fingerprintMode = getFingerprintMode()
      const beforeSongFingerprintListLength = store.songFingerprintList.length
      const existingSet = new Set(store.songFingerprintList)
      const uniqueFingerprints = Array.from(
        new Set(
          songsAnalyseResult
            .map((item) => item?.sha256_Hash)
            .filter((sha): sha is string => typeof sha === 'string' && sha.length > 0)
        )
      )
      let fingerprintAlreadyExistingCount = 0
      for (const fingerprint of uniqueFingerprints) {
        if (existingSet.has(fingerprint)) fingerprintAlreadyExistingCount++
      }
      await FingerprintStore.unionFingerprintList(uniqueFingerprints, fingerprintMode)
      const fingerprintEndAt = Date.now()
      const fingerprintAddedCount =
        store.songFingerprintList.length - beforeSongFingerprintListLength
      const duplicatesRemovedCount = Math.max(
        0,
        songsAnalyseResult.length - uniqueFingerprints.length
      )
      const errorCount = Array.isArray(errorSongsAnalyseResult) ? errorSongsAnalyseResult.length : 0
      const summary = {
        startAt: new Date(fingerprintStartAt).toISOString(),
        endAt: new Date(fingerprintEndAt).toISOString(),
        durationMs: fingerprintEndAt - fingerprintStartAt,
        scannedCount: eligiblePaths.length,
        analyzeFailedCount: errorCount,
        importedToPlaylistCount: 0,
        duplicatesRemovedCount,
        fingerprintAddedCount,
        fingerprintAlreadyExistingCount,
        fingerprintTotalBefore: beforeSongFingerprintListLength,
        fingerprintTotalAfter: store.songFingerprintList.length,
        isComparisonSongFingerprint: false,
        isPushSongFingerprintLibrary: true,
        hideOverviewSection: true
      }
      finalize(summary)
      return { ok: true }
    } catch (error) {
      finalize(null)
      throw error
    }
  })
}
