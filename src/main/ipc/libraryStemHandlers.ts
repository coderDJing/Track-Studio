import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  enqueueLibraryStemJob,
  getLibraryStemStatusSnapshot,
  cancelLibraryStemJob,
  type LibraryStemStatusSnapshot
} from '../services/libraryStemSeparationService'
import { readLibraryStemPreviewWaveform } from '../services/libraryStemPreviewWaveform'
import { getStoreTrackDisplayName } from '../netease/library'

type StemId = 'vocal' | 'inst' | 'bass' | 'drums'

const STEM_IDS: StemId[] = ['vocal', 'inst', 'bass', 'drums']

const normalizeText = (value: unknown, maxLen = 4000) => {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLen) : ''
}

const toSafeFileName = (value: string) =>
  normalizeText(value, 160)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim() || 'stem'

const resolveStemPaths = (snapshot: LibraryStemStatusSnapshot) => ({
  vocal: snapshot.vocalPath,
  inst: snapshot.instPath,
  bass: snapshot.bassPath,
  drums: snapshot.drumsPath
})

const resolveUnusedPath = async (basePath: string, isDirectory: boolean): Promise<string> => {
  const extension = isDirectory ? '' : path.extname(basePath)
  const baseName = isDirectory ? basePath : basePath.slice(0, -extension.length)
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? basePath : `${baseName} (${index + 1})${extension}`
    try {
      await fs.promises.access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('STEM_EXPORT_NAME_EXHAUSTED')
}

export function registerLibraryStemHandlers() {
  ipcMain.handle(
    'library-stem:get-status',
    async (_event, payload?: { filePath?: unknown; model?: unknown }) => {
      return await getLibraryStemStatusSnapshot(normalizeText(payload?.filePath), payload?.model)
    }
  )

  ipcMain.handle(
    'library-stem:start',
    async (_event, payload?: { filePath?: unknown; model?: unknown }) => {
      return await enqueueLibraryStemJob({
        filePath: normalizeText(payload?.filePath),
        model: payload?.model
      })
    }
  )

  ipcMain.handle(
    'library-stem:cancel',
    async (_event, payload?: { filePath?: unknown; model?: unknown }) => {
      return await cancelLibraryStemJob({
        filePath: normalizeText(payload?.filePath),
        model: payload?.model
      })
    }
  )

  ipcMain.handle(
    'library-stem:preview-waveforms',
    async (_event, payload?: { filePath?: unknown; model?: unknown }) => {
      const snapshot = await getLibraryStemStatusSnapshot(
        normalizeText(payload?.filePath),
        payload?.model
      )
      if (snapshot.status !== 'ready') return { stems: {} }

      const stemPaths = resolveStemPaths(snapshot)
      const stems: Partial<Record<StemId, { peaks: number[] }>> = {}
      for (const stemId of STEM_IDS) {
        const stemPath = stemPaths[stemId]
        if (!stemPath) continue
        const waveform = await readLibraryStemPreviewWaveform(stemPath).catch(() => null)
        if (waveform) stems[stemId] = waveform
      }
      return { stems }
    }
  )

  ipcMain.handle(
    'library-stem:export',
    async (event, payload?: { filePath?: unknown; model?: unknown; stem?: unknown }) => {
      const filePath = normalizeText(payload?.filePath)
      const selectedStem = normalizeText(payload?.stem, 16)
      const selectedIds =
        selectedStem === 'all' ? STEM_IDS : STEM_IDS.filter((stemId) => stemId === selectedStem)
      if (!selectedIds.length) {
        throw new Error('STEM_EXPORT_INVALID_SELECTION')
      }

      const snapshot = await getLibraryStemStatusSnapshot(filePath, payload?.model)
      if (snapshot.status !== 'ready') {
        throw new Error('STEM_EXPORT_NOT_READY')
      }
      const stemPaths = resolveStemPaths(snapshot)
      if (selectedIds.some((stemId) => !stemPaths[stemId])) {
        throw new Error('STEM_EXPORT_ASSET_MISSING')
      }

      const owner = BrowserWindow.fromWebContents(event.sender) || undefined
      const dialogOptions: OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory']
      }
      const selection = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (selection.canceled || !selection.filePaths[0]) {
        return { canceled: true, exportedPaths: [] as string[] }
      }

      // `.store` 里是 `<songId>.<ext>`，直接拿去命名只会得到一串数字；
      // 网易云曲目优先用「艺人 - 标题」，其他来源仍用原文件名。
      const sourceName = toSafeFileName(
        getStoreTrackDisplayName(snapshot.filePath) || path.parse(snapshot.filePath).name
      )
      const destinationRoot = selection.filePaths[0]
      const outputDir =
        selectedIds.length === STEM_IDS.length
          ? await resolveUnusedPath(path.join(destinationRoot, `${sourceName}_stems`), true)
          : destinationRoot
      await fs.promises.mkdir(outputDir, { recursive: true })

      const exportedPaths: string[] = []
      for (const stemId of selectedIds) {
        const sourcePath = stemPaths[stemId]
        if (!sourcePath) continue
        const outputPath = await resolveUnusedPath(
          path.join(outputDir, `${sourceName}_${stemId}.wav`),
          false
        )
        await fs.promises.copyFile(sourcePath, outputPath)
        exportedPaths.push(outputPath)
      }
      return { canceled: false, exportedPaths }
    }
  )
}
