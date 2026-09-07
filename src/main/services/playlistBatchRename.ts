import path = require('path')
import fs = require('fs-extra')
import { getKeyDisplayText } from '../../shared/keyDisplay'
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import store from '../store'
import { findSongListRoot, transferTrackCaches } from './cacheMaintenance'
import { replaceMixtapeFilePath } from '../mixtapeDb'
import { remapKeyAnalysisTrackedPath } from './keyAnalysisQueue'
import { readTrackMetadata, readTrackSongInfo } from './metadataEditor'
import { updateSetItemFilePathReferences } from '../setListDb'
import { notifyCuratedFilePathChanged } from '../curatedLibrarySync/identityDb'
import type {
  IBatchRenameExecutionRequestItem,
  IBatchRenameExecutionResult,
  IBatchRenameExecutionResultItem,
  IBatchRenameExecutionStatus,
  IBatchRenamePreviewItem,
  IBatchRenamePreviewResult,
  IBatchRenameTemplateSegment,
  IBatchRenameTemplateToken,
  IBatchRenameTrackInput,
  ISongInfo,
  ITrackMetadataDetail
} from '../../types/globals'

type PreviewContext = {
  locale: 'zh-CN' | 'en-US'
  keyDisplayStyle: 'Classic' | 'Camelot'
}

type ResolvedTrackRender = {
  input: IBatchRenameTrackInput
  detail: ITrackMetadataDetail | null
  originalFileName: string
  desiredBaseName: string
  ext: string
  dirPath: string
  sourceExists: boolean
}

type CancelState = {
  cancelled: boolean
}

const cancelStates = new Map<string, CancelState>()

export function isPlaylistBatchRenameBusy(): boolean {
  return cancelStates.size > 0
}

const EXTRA_DETAIL_TOKENS = new Set<IBatchRenameTemplateToken>([
  'albumArtist',
  'year',
  'trackNo',
  'discNo',
  'comment'
])

const WINDOWS_RESERVED_NAMES = new Set(
  [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9'
  ].map((item) => item.toUpperCase())
)

const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*\u0000-\u001F]/
const INVALID_MAC_CHARS = /[:/\u0000]/
const MAX_FILE_NAME_LENGTH = 255
const MAX_WINDOWS_PATH_LENGTH = 259
const MAX_MAC_PATH_LENGTH = 1023

const normalizeComparablePath = (value: string) => {
  const resolved = path.resolve(value || '')
  return resolved.toLocaleLowerCase()
}

const getPreviewContext = (): PreviewContext => ({
  locale: store.settingConfig?.language === 'enUS' ? 'en-US' : 'zh-CN',
  keyDisplayStyle: store.settingConfig?.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
})

const getPlaceholder = (context: PreviewContext) =>
  context.locale === 'en-US' ? 'unknown' : '未知'

const normalizeText = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const formatBpmDisplay = (value: unknown, fallback: string) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return numeric.toFixed(2)
}

const formatDurationDisplay = (value: unknown, fallback: string) => {
  const raw = normalizeText(value)
  if (!raw) return fallback
  const parts = raw.split(':')
  if (parts.length === 2) {
    const minutes = String(Number(parts[0]) || 0).padStart(2, '0')
    const seconds = String(Number(parts[1]) || 0).padStart(2, '0')
    return `${minutes}m${seconds}s`
  }
  if (parts.length === 3) {
    const hours = String(Number(parts[0]) || 0).padStart(2, '0')
    const minutes = String(Number(parts[1]) || 0).padStart(2, '0')
    const seconds = String(Number(parts[2]) || 0).padStart(2, '0')
    return `${hours}h${minutes}m${seconds}s`
  }
  return fallback
}

const formatNumericOrder = (value: number | null | undefined, fallback: string) => {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback
  return String(Math.floor(value)).padStart(2, '0')
}

const normalizeYearText = (value: unknown, fallback: string) => {
  const raw = normalizeText(value)
  if (!raw) return fallback
  const match = raw.match(/\b(\d{4})\b/)
  return match?.[1] || raw
}

const resolveSegmentValue = (
  token: IBatchRenameTemplateToken,
  track: IBatchRenameTrackInput,
  detail: ITrackMetadataDetail | null,
  context: PreviewContext
) => {
  const fallback = getPlaceholder(context)
  const ext = path.extname(track.filePath || '')
  const baseName = path.basename(track.filePath || '', ext)
  switch (token) {
    case 'title':
      return normalizeText(track.title) || fallback
    case 'artist':
      return normalizeText(track.artist) || fallback
    case 'bpm':
      return formatBpmDisplay(track.bpm, fallback)
    case 'key': {
      const text = normalizeText(track.key)
      return text ? getKeyDisplayText(text, context.keyDisplayStyle) : fallback
    }
    case 'album':
      return normalizeText(track.album) || fallback
    case 'genre':
      return normalizeText(track.genre) || fallback
    case 'label':
      return normalizeText(track.label) || fallback
    case 'year':
      return normalizeYearText(detail?.year, fallback)
    case 'trackNo':
      return formatNumericOrder(detail?.trackNo ?? undefined, fallback)
    case 'fileName':
      return normalizeText(baseName) || fallback
    case 'albumArtist':
      return normalizeText(detail?.albumArtist) || fallback
    case 'discNo':
      return formatNumericOrder(detail?.discNo ?? undefined, fallback)
    case 'comment':
      return normalizeText(detail?.comment) || fallback
    case 'duration':
      return formatDurationDisplay(track.duration, fallback)
    default:
      return fallback
  }
}

const buildRenderedBaseName = (
  segments: IBatchRenameTemplateSegment[],
  track: IBatchRenameTrackInput,
  detail: ITrackMetadataDetail | null,
  context: PreviewContext
) =>
  segments
    .map((segment) => {
      if (segment.type === 'text') {
        return segment.value || ''
      }
      return resolveSegmentValue(segment.token, track, detail, context)
    })
    .join('')

const validateBaseName = (
  baseName: string
): Extract<IBatchRenamePreviewItem['status'], 'invalid_chars' | 'invalid_name'> | null => {
  if (!baseName) return 'invalid_name'
  if (baseName === '.' || baseName === '..') return 'invalid_name'
  if (process.platform === 'win32') {
    if (INVALID_WINDOWS_CHARS.test(baseName)) return 'invalid_chars'
    if (/[ .]$/.test(baseName)) return 'invalid_name'
    if (WINDOWS_RESERVED_NAMES.has(baseName.toUpperCase())) return 'invalid_name'
    return null
  }
  if (process.platform === 'darwin') {
    if (INVALID_MAC_CHARS.test(baseName)) return 'invalid_chars'
    return null
  }
  return null
}

const isPathTooLong = (targetPath: string) => {
  const fileName = path.basename(targetPath)
  if (fileName.length > MAX_FILE_NAME_LENGTH) return true
  if (process.platform === 'win32') {
    return targetPath.length > MAX_WINDOWS_PATH_LENGTH
  }
  if (process.platform === 'darwin') {
    return targetPath.length > MAX_MAC_PATH_LENGTH
  }
  return false
}

const resolveSuffixFileName = (baseName: string, ext: string, suffix: number) =>
  suffix <= 0 ? `${baseName}${ext}` : `${baseName} (${suffix})${ext}`

const needsExtraMetadata = (segments: IBatchRenameTemplateSegment[]) =>
  segments.some((segment) => segment.type === 'token' && EXTRA_DETAIL_TOKENS.has(segment.token))

const resolveTrackRenderData = async (
  tracks: IBatchRenameTrackInput[],
  segments: IBatchRenameTemplateSegment[],
  context: PreviewContext
): Promise<ResolvedTrackRender[]> => {
  const shouldLoadDetail = needsExtraMetadata(segments)
  const result: ResolvedTrackRender[] = []
  for (const track of tracks) {
    let detail: ITrackMetadataDetail | null = null
    if (shouldLoadDetail) {
      try {
        detail = await readTrackMetadata(track.filePath)
      } catch {
        detail = null
      }
    }
    let sourceExists = false
    try {
      sourceExists = await fs.pathExists(track.filePath)
    } catch {
      sourceExists = false
    }
    result.push({
      input: track,
      detail,
      originalFileName: path.basename(track.filePath || ''),
      desiredBaseName: buildRenderedBaseName(segments, track, detail, context),
      ext: path.extname(track.filePath || ''),
      dirPath: path.dirname(track.filePath || ''),
      sourceExists
    })
  }
  return result
}

const buildPreviewItems = async (
  tracks: IBatchRenameTrackInput[],
  segments: IBatchRenameTemplateSegment[]
): Promise<IBatchRenamePreviewResult> => {
  const context = getPreviewContext()
  const renderData = await resolveTrackRenderData(tracks, segments, context)
  const items = renderData.map((entry) => ({
    id: `${entry.input.order}:${entry.input.filePath}`,
    order: entry.input.order,
    songListUUID: entry.input.songListUUID,
    filePath: entry.input.filePath,
    originalFileName: entry.originalFileName,
    targetBaseName: entry.desiredBaseName,
    targetFileName: resolveSuffixFileName(entry.desiredBaseName, entry.ext, 0),
    status: (() => {
      if (!entry.sourceExists) return 'source_missing' as const
      const desiredStatus = validateBaseName(entry.desiredBaseName)
      if (desiredStatus) return desiredStatus
      const directTarget = path.join(entry.dirPath, `${entry.desiredBaseName}${entry.ext}`)
      if (isPathTooLong(directTarget)) return 'too_long' as const
      if (`${entry.desiredBaseName}${entry.ext}` === entry.originalFileName)
        return 'unchanged' as const
      return 'executable' as const
    })(),
    track: entry.input
  }))

  const entriesByDir = new Map<string, Array<{ item: IBatchRenamePreviewItem; ext: string }>>()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.status !== 'executable') continue
    const ext = renderData[index].ext
    const dirPath = renderData[index].dirPath
    const list = entriesByDir.get(dirPath)
    if (list) {
      list.push({ item, ext })
    } else {
      entriesByDir.set(dirPath, [{ item, ext }])
    }
  }

  for (const [dirPath, dirItems] of entriesByDir.entries()) {
    let existingFileNames: string[] = []
    try {
      existingFileNames = await fs.readdir(dirPath)
    } catch {
      existingFileNames = []
    }
    const existingNames = new Set(
      existingFileNames.map((name) => normalizeComparablePath(path.join(dirPath, name)))
    )
    const movingSourceNames = new Set(
      dirItems.map(({ item }) => normalizeComparablePath(item.filePath))
    )
    const assignedTargetNames = new Set<string>()

    for (const { item, ext } of dirItems) {
      let suffix = 0
      let assigned = false
      while (!assigned) {
        const candidate = resolveSuffixFileName(item.targetBaseName, ext, suffix)
        const candidatePath = path.join(dirPath, candidate)
        if (isPathTooLong(candidatePath)) {
          item.status = 'too_long'
          item.targetFileName = candidate
          break
        }
        const normalizedCandidatePath = normalizeComparablePath(candidatePath)
        const normalizedSourcePath = normalizeComparablePath(item.filePath)
        const existsOnDisk = existingNames.has(normalizedCandidatePath)
        const occupiedByAssigned = assignedTargetNames.has(normalizedCandidatePath)
        const candidateIsOwnSource = normalizedCandidatePath === normalizedSourcePath
        const freedByRenamingSource = movingSourceNames.has(normalizedCandidatePath)
        const occupied =
          occupiedByAssigned || (existsOnDisk && !candidateIsOwnSource && !freedByRenamingSource)
        if (!occupied) {
          item.targetFileName = candidate
          if (candidate === item.originalFileName) {
            item.status = 'unchanged'
          }
          assignedTargetNames.add(normalizedCandidatePath)
          assigned = true
          continue
        }
        suffix += 1
        if (suffix > 9999) {
          item.status = 'invalid_name'
          break
        }
      }
    }
  }

  return { items }
}

const pushProgress = (
  taskId: string,
  titleKey: string,
  now: number,
  total: number,
  options?: {
    noProgress?: boolean
    dismiss?: boolean
    cancelable?: boolean
  }
) => {
  mainWindow.instance?.webContents.send('progressSet', {
    id: taskId,
    titleKey,
    now,
    total,
    isInitial: now === 0,
    noProgress: options?.noProgress,
    dismiss: options?.dismiss,
    cancelable: options?.cancelable,
    cancelChannel: options?.cancelable ? 'playlist:batchRename:cancel' : undefined,
    cancelPayload: options?.cancelable ? { taskId } : undefined
  })
}

const mapRenameError = (error: unknown): IBatchRenameExecutionStatus => {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if (code === 'EBUSY') return 'file_in_use'
  if (code === 'EPERM' || code === 'EACCES') return 'permission_denied'
  return 'failed'
}

const partitionComponentOrder = (items: IBatchRenameExecutionRequestItem[]) => {
  const validItems = [...items].sort((a, b) => a.order - b.order)
  const bySource = new Map<string, IBatchRenameExecutionRequestItem>()
  for (const item of validItems) {
    bySource.set(normalizeComparablePath(item.filePath), item)
  }
  const adjacency = new Map<string, Set<string>>()
  for (const item of validItems) {
    const key = normalizeComparablePath(item.filePath)
    adjacency.set(key, adjacency.get(key) || new Set())
    const targetPath = normalizeComparablePath(
      path.join(path.dirname(item.filePath), item.targetFileName)
    )
    const dependency = bySource.get(targetPath)
    if (!dependency || dependency.id === item.id) continue
    adjacency.get(key)?.add(normalizeComparablePath(dependency.filePath))
    const dependencyKey = normalizeComparablePath(dependency.filePath)
    adjacency.set(dependencyKey, adjacency.get(dependencyKey) || new Set())
    adjacency.get(dependencyKey)?.add(key)
  }
  const visited = new Set<string>()
  const components: IBatchRenameExecutionRequestItem[][] = []
  for (const item of validItems) {
    const key = normalizeComparablePath(item.filePath)
    if (visited.has(key)) continue
    const queue = [key]
    const members: IBatchRenameExecutionRequestItem[] = []
    visited.add(key)
    while (queue.length > 0) {
      const current = queue.shift() as string
      const currentItem = bySource.get(current)
      if (currentItem) members.push(currentItem)
      const nextList = adjacency.get(current) || new Set()
      for (const nextKey of nextList) {
        if (visited.has(nextKey)) continue
        visited.add(nextKey)
        queue.push(nextKey)
      }
    }
    members.sort((left, right) => left.order - right.order)
    components.push(members)
  }
  components.sort((left, right) => left[0].order - right[0].order)
  return components
}

const createTempRenameTarget = async (sourcePath: string) => {
  const dirPath = path.dirname(sourcePath)
  const ext = path.extname(sourcePath)
  const baseName = path.basename(sourcePath, ext)
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(
      dirPath,
      `.${baseName}.frkb-batch-rename.${Date.now()}.${index}${ext}`
    )
    if (!(await fs.pathExists(candidate))) {
      return candidate
    }
  }
  throw new Error('BATCH_RENAME_TEMP_TARGET_FAILED')
}

const finalizeUpdatedSong = async (oldFilePath: string, newFilePath: string) => {
  const songInfo = await readTrackSongInfo(newFilePath)
  if (!songInfo) {
    return null
  }
  const fromRoot = await findSongListRoot(path.dirname(oldFilePath))
  const toRoot = await findSongListRoot(path.dirname(newFilePath))
  await transferTrackCaches({
    fromRoot,
    toRoot,
    fromPath: oldFilePath,
    toPath: newFilePath
  })
  remapKeyAnalysisTrackedPath(oldFilePath, newFilePath)
  replaceMixtapeFilePath(oldFilePath, newFilePath)
  updateSetItemFilePathReferences(oldFilePath, newFilePath)
  notifyCuratedFilePathChanged(oldFilePath, newFilePath)
  return songInfo
}

export async function previewPlaylistBatchRename(
  tracks: IBatchRenameTrackInput[],
  segments: IBatchRenameTemplateSegment[]
): Promise<IBatchRenamePreviewResult> {
  return await buildPreviewItems(tracks, segments)
}

export function cancelPlaylistBatchRename(taskId: string): boolean {
  const state = cancelStates.get(taskId)
  if (!state) return false
  state.cancelled = true
  return true
}

export async function executePlaylistBatchRename(params: {
  taskId: string
  items: IBatchRenameExecutionRequestItem[]
}): Promise<IBatchRenameExecutionResult> {
  const taskId = String(params.taskId || '').trim() || `playlist_batch_rename_${Date.now()}`
  const allItems = Array.isArray(params.items)
    ? [...params.items].sort((a, b) => a.order - b.order)
    : []
  const cancelState: CancelState = { cancelled: false }
  cancelStates.set(taskId, cancelState)

  const results = new Map<string, IBatchRenameExecutionResultItem>()
  const updates: Array<{ song: ISongInfo; oldFilePath: string }> = []
  const total = allItems.length
  let successCount = 0
  let failedCount = 0
  let skippedCount = 0
  let cancelledCount = 0
  let completedCount = 0

  const recordResult = (
    item: IBatchRenameExecutionRequestItem,
    status: IBatchRenameExecutionStatus
  ) => {
    if (results.has(item.id)) return
    results.set(item.id, {
      id: item.id,
      order: item.order,
      filePath: item.filePath,
      originalFileName: item.originalFileName,
      targetFileName: item.targetFileName,
      status
    })
    if (status === 'success') {
      successCount += 1
    } else if (status === 'cancelled') {
      cancelledCount += 1
    } else if (
      status === 'hand_skipped' ||
      status === 'unchanged' ||
      status === 'invalid_chars' ||
      status === 'too_long' ||
      status === 'invalid_name'
    ) {
      skippedCount += 1
    } else {
      failedCount += 1
    }
    completedCount += 1
    pushProgress(taskId, 'batchRename.progressExecuting', completedCount, total, {
      cancelable: true
    })
  }

  pushProgress(taskId, 'batchRename.progressExecuting', 0, Math.max(total, 1), {
    cancelable: true
  })

  try {
    const executableItems: IBatchRenameExecutionRequestItem[] = []
    for (const item of allItems) {
      if (!item.selected) {
        recordResult(
          item,
          item.status === 'executable'
            ? 'hand_skipped'
            : (item.status as unknown as IBatchRenameExecutionStatus)
        )
        continue
      }
      if (item.status !== 'executable') {
        recordResult(item, item.status as unknown as IBatchRenameExecutionStatus)
        continue
      }
      if (cancelState.cancelled) {
        recordResult(item, 'cancelled')
        continue
      }
      const sourceExists = await fs.pathExists(item.filePath).catch(() => false)
      if (!sourceExists) {
        recordResult(item, 'source_missing')
        continue
      }
      executableItems.push(item)
    }

    const sourcePathSet = new Set(
      executableItems.map((item) => normalizeComparablePath(item.filePath))
    )
    const revalidatedItems: IBatchRenameExecutionRequestItem[] = []
    for (const item of executableItems) {
      const targetPath = path.join(path.dirname(item.filePath), item.targetFileName)
      const normalizedTarget = normalizeComparablePath(targetPath)
      const normalizedSource = normalizeComparablePath(item.filePath)
      if (normalizedTarget !== normalizedSource) {
        const targetExists = await fs.pathExists(targetPath).catch(() => false)
        if (targetExists && !sourcePathSet.has(normalizedTarget)) {
          recordResult(item, 'target_exists')
          continue
        }
      }
      revalidatedItems.push(item)
    }

    const components = partitionComponentOrder(revalidatedItems)
    for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
      const component = components[componentIndex]
      if (cancelState.cancelled) {
        for (const item of component) {
          recordResult(item, 'cancelled')
        }
        continue
      }

      const tempEntries: Array<{
        item: IBatchRenameExecutionRequestItem
        tempPath: string
      }> = []
      let componentPhaseFailed = false
      for (const item of component) {
        try {
          const tempPath = await createTempRenameTarget(item.filePath)
          await fs.rename(item.filePath, tempPath)
          tempEntries.push({ item, tempPath })
        } catch (error) {
          componentPhaseFailed = true
          const failureStatus = mapRenameError(error)
          log.error('[batchRename] phase1 rename failed', {
            filePath: item.filePath,
            targetFileName: item.targetFileName,
            error
          })
          for (const tempEntry of tempEntries.reverse()) {
            try {
              await fs.rename(tempEntry.tempPath, tempEntry.item.filePath)
            } catch (rollbackError) {
              log.error('[batchRename] phase1 rollback failed', {
                filePath: tempEntry.item.filePath,
                tempPath: tempEntry.tempPath,
                error: rollbackError
              })
            }
          }
          for (const componentItem of component) {
            recordResult(componentItem, componentItem.id === item.id ? failureStatus : 'failed')
          }
          break
        }
      }
      if (componentPhaseFailed) {
        continue
      }

      for (let index = 0; index < tempEntries.length; index += 1) {
        const tempEntry = tempEntries[index]
        const item = tempEntry.item
        const targetPath = path.join(path.dirname(item.filePath), item.targetFileName)
        try {
          await fs.rename(tempEntry.tempPath, targetPath)
          const updatedSong = await finalizeUpdatedSong(item.filePath, targetPath)
          if (updatedSong) {
            updates.push({
              song: updatedSong,
              oldFilePath: item.filePath
            })
          }
          recordResult(item, 'success')
        } catch (error) {
          log.error('[batchRename] phase2 rename failed', {
            tempPath: tempEntry.tempPath,
            targetPath,
            error
          })
          const failureStatus = mapRenameError(error)
          try {
            if (await fs.pathExists(tempEntry.tempPath)) {
              await fs.rename(tempEntry.tempPath, item.filePath)
            }
          } catch (rollbackError) {
            log.error('[batchRename] phase2 rollback failed', {
              tempPath: tempEntry.tempPath,
              sourcePath: item.filePath,
              error: rollbackError
            })
          }
          recordResult(item, failureStatus)
        }
      }
    }

    for (const item of allItems) {
      if (!results.has(item.id)) {
        recordResult(item, cancelState.cancelled ? 'cancelled' : 'failed')
      }
    }

    return {
      summary: {
        total,
        success: successCount,
        failed: failedCount,
        skipped: skippedCount,
        cancelled: cancelledCount
      },
      items: [...results.values()].sort((left, right) => left.order - right.order),
      updates
    }
  } finally {
    cancelStates.delete(taskId)
    pushProgress(taskId, 'batchRename.progressExecuting', 1, 1, {
      dismiss: true
    })
  }
}
