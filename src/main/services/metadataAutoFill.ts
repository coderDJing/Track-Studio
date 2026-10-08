import path = require('path')
import mainWindow from '../window/mainWindow'
import { log } from '../log'
import {
  IMetadataAutoFillRequest,
  IMetadataAutoFillSummary,
  IMetadataAutoFillItemResult,
  IMusicBrainzMatch,
  IMusicBrainzSearchPayload,
  IMusicBrainzSuggestionResult,
  ITrackMetadataUpdatePayload
} from '../../types/globals'
import { readTrackMetadata, updateTrackMetadata } from './metadataEditor'
import {
  matchTrackWithAcoustId,
  cancelAcoustIdRequests,
  hasEffectiveAcoustIdClientKey
} from './acoustId'
import {
  searchMusicBrainz,
  fetchMusicBrainzSuggestion,
  cancelMusicBrainzRequests
} from './musicBrainz'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import store from '../store'
import { createStageDiagnostics } from './stageDiagnostics'

type ProgressEmitter = (
  titleKey: string,
  now: number,
  total: number,
  options?: { isInitial?: boolean; extras?: Record<string, unknown> }
) => void

function createProgressEmitter(
  progressId: string,
  baseExtras?: Record<string, unknown>
): ProgressEmitter {
  return (titleKey, now, total, options) => {
    if (!mainWindow.instance) return
    mainWindow.instance.webContents.send('progressSet', {
      id: progressId,
      titleKey,
      now,
      total,
      isInitial: !!options?.isInitial,
      ...(baseExtras || {}),
      ...(options?.extras || {})
    })
  }
}

function normalizeText(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

type ErrorLike = {
  message?: unknown
  code?: unknown
  stderr?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getErrorLike = (value: unknown): ErrorLike | undefined =>
  isRecord(value) ? (value as ErrorLike) : undefined

function buildSearchPayload(detail: {
  filePath: string
  title?: string
  artist?: string
  album?: string
  durationSeconds?: number
}): IMusicBrainzSearchPayload | null {
  const title = normalizeText(detail.title)
  const artist = normalizeText(detail.artist)
  const durationSeconds =
    typeof detail.durationSeconds === 'number' && detail.durationSeconds > 0
      ? detail.durationSeconds
      : undefined
  let album = normalizeText(detail.album)
  if (title || artist) {
    // 默认不附带专辑，除非标题和艺人都缺失
    album = undefined
  }
  if (!title && !artist && !album && !durationSeconds) return null
  return {
    filePath: detail.filePath,
    title,
    artist,
    album,
    durationSeconds
  }
}

function buildUpdatePayload(
  filePath: string,
  suggestion: IMusicBrainzSuggestionResult['suggestion']
): ITrackMetadataUpdatePayload | null {
  const payload: ITrackMetadataUpdatePayload = {
    filePath
  }
  const assignString = (key: keyof ITrackMetadataUpdatePayload, value?: string | null) => {
    const normalized = normalizeText(value ?? undefined)
    if (normalized !== undefined) {
      Reflect.set(payload, key, normalized)
    }
  }
  assignString('title', suggestion.title)
  assignString('artist', suggestion.artist)
  assignString('album', suggestion.album)
  assignString('albumArtist', suggestion.albumArtist)
  assignString('year', suggestion.year)
  assignString('genre', suggestion.genre)
  assignString('label', suggestion.label)
  assignString('isrc', suggestion.isrc)
  if (typeof suggestion.trackNo === 'number') payload.trackNo = suggestion.trackNo
  if (typeof suggestion.trackTotal === 'number') payload.trackTotal = suggestion.trackTotal
  if (typeof suggestion.discNo === 'number') payload.discNo = suggestion.discNo
  if (typeof suggestion.discTotal === 'number') payload.discTotal = suggestion.discTotal

  if (suggestion.coverDataUrl) {
    payload.coverDataUrl = suggestion.coverDataUrl
  }

  const hasAnyField = Object.keys(payload).some((key) => key !== 'filePath')
  if (!hasAnyField) return null
  return payload
}

function summarizeErrorMessage(err: unknown): string {
  const error = getErrorLike(err)
  const message =
    typeof error?.message === 'string'
      ? error.message.trim()
      : typeof err === 'string'
        ? err.trim()
        : ''
  if (message) {
    return message
  }
  if (typeof error?.code === 'string') return error.code
  return 'UNKNOWN'
}

const isCancelledError = (err: unknown) => {
  const code = summarizeErrorMessage(err)
  return code === 'MUSICBRAINZ_ABORTED' || code === 'ACOUSTID_ABORTED'
}

const cancelTokens = new Map<string, { cancelled: boolean }>()

export function isMetadataAutoFillBusy(): boolean {
  return cancelTokens.size > 0
}

function createCancelToken(progressId: string) {
  const token = { cancelled: false }
  cancelTokens.set(progressId, token)
  return token
}

export function cancelMetadataAutoFill(progressId?: string) {
  if (!progressId) return
  const token = cancelTokens.get(progressId)
  if (token) token.cancelled = true
  // 终止在途请求以尽快落地取消
  cancelMusicBrainzRequests()
  cancelAcoustIdRequests()
}

export function cancelAllMetadataAutoFill() {
  for (const token of cancelTokens.values()) {
    token.cancelled = true
  }
  cancelMusicBrainzRequests()
  cancelAcoustIdRequests()
}

export async function waitForMetadataAutoFillIdle(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (cancelTokens.size > 0) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

export async function autoFillTrackMetadata(
  payload: IMetadataAutoFillRequest
): Promise<IMetadataAutoFillSummary> {
  const uniquePaths = Array.from(
    new Set(
      (payload?.filePaths || [])
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => path.resolve(p))
    )
  )
  const progressId = payload?.progressId || `metadata_auto_${Date.now()}`
  const cancelToken = createCancelToken(progressId)
  const progressExtras = {
    cancelable: true,
    cancelChannel: 'metadata:autoFill:cancel',
    cancelPayload: progressId
  }
  const pushProgress = createProgressEmitter(progressId, progressExtras)
  const summary: IMetadataAutoFillSummary = {
    total: uniquePaths.length,
    applied: 0,
    fingerprintApplied: 0,
    searchApplied: 0,
    noMatch: 0,
    skipped: 0,
    cancelled: 0,
    errors: 0,
    durationMs: 0,
    progressId,
    items: []
  }
  const startedAt = Date.now()
  let cancelled = false
  const markItemCancelled = (item: IMetadataAutoFillItemResult) => {
    item.status = 'cancelled'
    item.messageCode = 'CANCELLED'
    summary.cancelled++
    cancelled = true
    cancelToken.cancelled = true
  }
  try {
    if (uniquePaths.length === 0) {
      pushProgress('metadata.autoFillProgressFinished', 1, 1, { isInitial: true })
      return summary
    }

    pushProgress('metadata.autoFillProgressPreparing', 0, uniquePaths.length, { isInitial: true })

    let fingerprintDisabledCode: string | null = hasEffectiveAcoustIdClientKey()
      ? null
      : 'ACOUSTID_CLIENT_MISSING'

    for (let idx = 0; idx < uniquePaths.length; idx++) {
      if (cancelToken.cancelled) {
        cancelled = true
        break
      }
      const filePath = uniquePaths[idx]
      const item: IMetadataAutoFillItemResult = {
        filePath,
        displayName: path.basename(filePath),
        status: 'skipped'
      }
      summary.items.push(item)
      const diagnostics = createStageDiagnostics('metadata-auto-perf', {
        progressId,
        itemIndex: idx + 1,
        itemCount: uniquePaths.length,
        fileName: path.basename(filePath)
      })
      try {
        const detail = await diagnostics.measure('read-metadata', () => readTrackMetadata(filePath))
        if (!detail) {
          item.status = 'error'
          item.messageCode = 'READ_FAILED'
          summary.errors++
          continue
        }
        item.displayName =
          normalizeText(detail.title) || normalizeText(detail.fileName) || item.displayName

        // Check if track was already auto-filled and skip if setting is enabled
        const skipCompleted = store.settingConfig?.autoFillSkipCompleted !== false
        if (skipCompleted) {
          try {
            const listRoot = await diagnostics.measure('resolve-cache-root', () =>
              findSongListRoot(path.dirname(filePath))
            )
            if (listRoot) {
              const cached = await diagnostics.measure('read-completed-flag', () =>
                LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
              )
              if (cached?.info?.autoFilled) {
                item.status = 'skipped'
                item.messageCode = 'ALREADY_FILLED'
                summary.skipped++
                continue
              }
            }
          } catch {}
        }

        let match: IMusicBrainzMatch | null = null
        let method: 'fingerprint' | 'search' | undefined

        if (fingerprintDisabledCode === null) {
          try {
            const matches = await diagnostics.measure(
              'acoustid-match',
              () => matchTrackWithAcoustId({ filePath, durationSeconds: detail.durationSeconds }),
              15_000
            )
            if (matches && matches.length > 0) {
              match = matches[0]
              method = 'fingerprint'
            }
          } catch (err: unknown) {
            if (isCancelledError(err)) {
              markItemCancelled(item)
              break
            }
            const code = summarizeErrorMessage(err)
            if (
              code === 'ACOUSTID_CLIENT_MISSING' ||
              code === 'ACOUSTID_CHROMAPRINT_UNAVAILABLE' ||
              code === 'ACOUSTID_CLIENT_INVALID'
            ) {
              fingerprintDisabledCode = code
            }
          }
        }

        if (!match) {
          const searchPayload = buildSearchPayload(detail)
          if (!searchPayload) {
            summary.skipped++
            item.status = 'skipped'
            item.messageCode = 'NO_QUERY'
            continue
          }
          try {
            const matches = await diagnostics.measure(
              'musicbrainz-search',
              () => searchMusicBrainz(searchPayload),
              15_000
            )
            if (matches && matches.length > 0) {
              match = matches[0]
              method = 'search'
            }
          } catch (err: unknown) {
            if (isCancelledError(err)) {
              markItemCancelled(item)
              break
            }
            log.error('[metadata-auto] musicbrainz search failed', {
              filePath,
              error: summarizeErrorMessage(err)
            })
            summary.errors++
            item.status = 'error'
            item.messageCode = 'SEARCH_FAILED'
            item.messageDetail = summarizeErrorMessage(err)
            continue
          }
        }

        if (!match) {
          summary.noMatch++
          item.status = 'no-match'
          item.messageCode = 'NO_RESULT'
          continue
        }

        let suggestion: IMusicBrainzSuggestionResult | null = null
        try {
          const matchedTrack = match
          suggestion = await diagnostics.measure(
            'fetch-suggestion',
            () =>
              fetchMusicBrainzSuggestion({
                recordingId: matchedTrack.recordingId,
                releaseId: matchedTrack.releaseId,
                allowFallback: true,
                cancelToken
              }),
            15_000
          )
        } catch (err: unknown) {
          if (isCancelledError(err)) {
            markItemCancelled(item)
            break
          }
          log.error('[metadata-auto] fetch suggestion failed', {
            filePath,
            recordingId: match.recordingId,
            error: summarizeErrorMessage(err)
          })
          summary.errors++
          item.status = 'error'
          item.method = method
          item.messageCode = 'SUGGESTION_FAILED'
          item.messageDetail = summarizeErrorMessage(err)
          continue
        }

        const updatePayload = suggestion
          ? buildUpdatePayload(filePath, suggestion.suggestion)
          : null
        if (!suggestion || !updatePayload) {
          summary.noMatch++
          item.status = 'no-match'
          item.method = method
          item.messageCode = 'SUGGESTION_EMPTY'
          continue
        }

        try {
          const result = await diagnostics.measure('update-metadata', () =>
            updateTrackMetadata(updatePayload)
          )
          item.status = 'applied'
          item.method = method
          item.updatedSongInfo = result.songInfo
          item.oldFilePath = result.renamedFrom
          item.messageCode = 'SUCCESS'
          summary.applied++
          if (method === 'fingerprint') {
            summary.fingerprintApplied++
          } else {
            summary.searchApplied++
          }

          // Mark track as auto-filled in cache
          // Only mark as fully auto-filled if cover was also fetched successfully
          // If cover is missing, don't mark as auto-filled so it will be retried next time
          const hasCover = !!suggestion.suggestion.coverDataUrl
          try {
            const listRoot = await diagnostics.measure('resolve-updated-cache-root', () =>
              findSongListRoot(path.dirname(result.songInfo.filePath))
            )
            if (listRoot) {
              const cached = await diagnostics.measure('read-updated-cache', () =>
                LibraryCacheDb.loadSongCacheEntry(listRoot, result.songInfo.filePath)
              )
              if (cached?.info) {
                // Only mark as auto-filled if cover was successfully fetched
                // This ensures tracks without covers will be retried on next auto-fill
                cached.info.autoFilled = hasCover
                await diagnostics.measure('mark-completed', () =>
                  LibraryCacheDb.upsertSongCacheEntry(listRoot, result.songInfo.filePath, cached)
                )
              }
            }
          } catch {}
        } catch (err: unknown) {
          if (isCancelledError(err)) {
            markItemCancelled(item)
            break
          }
          const error = getErrorLike(err)
          log.error('[metadata-auto] update metadata failed', {
            filePath,
            error: summarizeErrorMessage(err),
            code: error?.code
          })
          summary.errors++
          item.status = 'error'
          item.method = method
          if (error?.code === 'FFMPEG_METADATA_FAILED') {
            item.messageCode = 'FFMPEG_METADATA_FAILED'
            const detail =
              typeof error?.stderr === 'string' && error.stderr.trim()
                ? error.stderr.trim()
                : summarizeErrorMessage(err)
            item.messageDetail = detail
          } else {
            item.messageCode = 'UPDATE_FAILED'
            item.messageDetail = summarizeErrorMessage(err)
          }
        }
      } catch (err: unknown) {
        if (isCancelledError(err)) {
          markItemCancelled(item)
          break
        }
        log.error('[metadata-auto] unexpected error', {
          filePath,
          error: summarizeErrorMessage(err)
        })
        summary.errors++
        item.status = 'error'
        item.messageCode = 'UNKNOWN'
        item.messageDetail = summarizeErrorMessage(err)
      } finally {
        pushProgress('metadata.autoFillProgressRunning', idx + 1, uniquePaths.length)
      }
    }

    // updateTrackMetadata 已逐首清理封面缓存，整批结束时无需再次遍历清理。

    summary.durationMs = Date.now() - startedAt
    pushProgress('metadata.autoFillProgressFinished', uniquePaths.length, uniquePaths.length, {
      extras: { cancelled }
    })
    return summary
  } finally {
    cancelTokens.delete(progressId)
  }
}
