import { app, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'fs-extra'
import child_process from 'node:child_process'
import { log } from '../log'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from '../ffmpeg'
import { registerChildProcess } from '../services/childProcessRegistry'
import { setSongListTrackNumbersByOrder } from '../services/playlistTrackNumbers'
import { getCoreFsDirName } from '../coreLibraries'
import { resolveLibraryPath } from '../utils'
import store from '../store'
import { decodeAudioShared } from '../services/audioDecodePool'
import { AUDIO_EDIT_MAX_DURATION_SEC, type AudioEditClip } from '@shared/audioEditTimeline'
import type { ISongHotCue, ISongMemoryCue } from '../../types/globals'
import { normalizeSongHotCues } from '../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'
import {
  encodeInterleavedPcmToWavBytes,
  renderAudioEditClipsToInterleavedPcm
} from '@shared/audioEditPcm'
import { parseSongEditBaseTitle, resolveUniqueSongEditVersion } from '../services/songEditDest'
import { persistSharedSongHotCueDefinition } from '../services/sharedSongHotCues'
import { persistSharedSongMemoryCueDefinition } from '../services/sharedSongMemoryCues'
import {
  upsertMixtapeItemHotCuesByFilePath,
  upsertMixtapeItemMemoryCuesByFilePath
} from '../mixtapeDb'
import { emitSongHotCuesUpdated } from '../services/songHotCueEvents'
import { emitSongMemoryCuesUpdated } from '../services/songMemoryCueEvents'
import { scheduleCuratedLibrarySyncIfUnderCurated } from '../cloudSyncScheduler'
import { normalizeFilePathForComparison } from '../../shared/filePathComparison'

const sameFilePath = (left: string, right: string): boolean =>
  normalizeFilePathForComparison(path.resolve(left), process.platform === 'win32') ===
  normalizeFilePathForComparison(path.resolve(right), process.platform === 'win32')

const isPathInside = (rootDir: string, targetPath: string) => {
  const relative = path.relative(rootDir, targetPath)
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

const assertWritableSongEditFile = (filePath: string) => {
  const abs = path.resolve(filePath)
  const dbRoot = path.resolve(String(store.databaseDir || ''))
  if (!dbRoot) throw new Error('资料库未配置')
  const libraryRoot = path.join(dbRoot, 'library')
  const allowed = (['FilterLibrary', 'CuratedLibrary'] as const).some((name) =>
    isPathInside(path.join(libraryRoot, getCoreFsDirName(name)), abs)
  )
  if (!allowed) throw new Error('只能保存 Filter / Curated 资料库中的歌曲')
}

const spawnFfmpeg = (ffmpegPath: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
    registerChildProcess(child, 'song-edit:ffmpeg')
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.on('error', (error) => reject(error))
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`ffmpeg exited ${code} ${stderr.trim()}`.trim()))
    })
  })

const encoderArgsForExt = (ext: string) => {
  const normalized = ext.replace(/^\./, '').toLowerCase()
  if (normalized === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3']
  if (normalized === 'flac') return ['-c:a', 'flac']
  if (normalized === 'wav' || normalized === 'wave') return ['-c:a', 'pcm_s16le']
  if (normalized === 'aif' || normalized === 'aiff') return ['-c:a', 'pcm_s16le']
  if (normalized === 'm4a' || normalized === 'aac' || normalized === 'mp4') {
    return ['-c:a', 'aac', '-b:a', '256k']
  }
  return ['-c:a', 'flac']
}

type SongEditCommitPayload = {
  sessionId?: string
  sourceFilePath?: string
  listRoot?: string
  songListUUID?: string
  target?: 'overwrite' | 'new-version'
  outputFormat?: 'original' | 'wav'
  clips?: Array<{ sourceStartSec?: number; sourceEndSec?: number }>
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  title?: string
  insertAfterFilePath?: string
  existingNames?: string[]
  orderedFilePaths?: string[]
}

type SongEditSourceSnapshot = {
  sourceFilePath: string
  snapshotPath: string
}

const songEditSourceSnapshots = new Map<string, SongEditSourceSnapshot>()
const resolveSongEditSnapshotDir = () => path.join(app.getPath('temp'), 'frkb-song-edit-sources')
let sourceSnapshotCleanupPromise: Promise<void> | null = null

const normalizeSongEditSessionId = (value: unknown) => {
  const sessionId = String(value || '').trim()
  return /^[a-zA-Z0-9-]{8,80}$/.test(sessionId) ? sessionId : ''
}

const releaseSongEditSourceSnapshot = async (sessionId: string) => {
  const snapshot = songEditSourceSnapshots.get(sessionId)
  songEditSourceSnapshots.delete(sessionId)
  if (snapshot) await fs.remove(snapshot.snapshotPath).catch(() => undefined)
}

const ensureSongEditSourceSnapshot = async (sessionId: string, sourceFilePath: string) => {
  const existing = songEditSourceSnapshots.get(sessionId)
  if (existing) {
    if (!sameFilePath(existing.sourceFilePath, sourceFilePath)) {
      throw new Error('编辑会话源文件不匹配')
    }
    return existing.snapshotPath
  }
  if (sourceSnapshotCleanupPromise) await sourceSnapshotCleanupPromise
  const snapshotDir = resolveSongEditSnapshotDir()
  await fs.ensureDir(snapshotDir)
  const snapshotPath = path.join(
    snapshotDir,
    `${sessionId}${path.extname(sourceFilePath).toLowerCase()}`
  )
  await fs.copy(sourceFilePath, snapshotPath, { overwrite: true })
  songEditSourceSnapshots.set(sessionId, { sourceFilePath, snapshotPath })
  return snapshotPath
}

const toFloat32Pcm = (pcmData: Buffer) => {
  const samples = Math.floor(pcmData.byteLength / 4)
  const copy = new Float32Array(samples)
  if (pcmData.byteOffset % 4 === 0) {
    copy.set(new Float32Array(pcmData.buffer, pcmData.byteOffset, samples))
    return copy
  }
  const aligned = Buffer.from(pcmData)
  copy.set(new Float32Array(aligned.buffer, aligned.byteOffset, samples))
  return copy
}

const normalizeCommitClips = (rawClips: SongEditCommitPayload['clips']): AudioEditClip[] => {
  if (!Array.isArray(rawClips)) return []
  const clips: AudioEditClip[] = []
  for (const raw of rawClips) {
    const sourceStartSec = Number(raw?.sourceStartSec)
    const sourceEndSec = Number(raw?.sourceEndSec)
    if (!Number.isFinite(sourceStartSec) || !Number.isFinite(sourceEndSec)) continue
    if (sourceEndSec - sourceStartSec <= 0) continue
    clips.push({
      id: `clip-${clips.length + 1}`,
      sourceStartSec,
      sourceEndSec
    })
  }
  return clips
}

export const registerSongEditHandlers = () => {
  sourceSnapshotCleanupPromise = fs.emptyDir(resolveSongEditSnapshotDir()).catch(() => undefined)

  ipcMain.handle('song-edit:release-session', async (_e, rawSessionId: unknown) => {
    const sessionId = normalizeSongEditSessionId(rawSessionId)
    if (sessionId) await releaseSongEditSourceSnapshot(sessionId)
    return true
  })

  ipcMain.handle('song-edit:commit', async (_e, payload: SongEditCommitPayload) => {
    const commit = async () => {
      const sessionId = normalizeSongEditSessionId(payload?.sessionId)
      const sourceFilePath = path.resolve(String(payload?.sourceFilePath || '').trim())
      const listRootInput = String(payload?.listRoot || '').trim()
      const clips = normalizeCommitClips(payload?.clips)
      if (!sourceFilePath || !clips.length) throw new Error('缺少保存数据')
      if (clips.length > 20000) throw new Error('片段过多')
      assertWritableSongEditFile(sourceFilePath)
      if (!(await fs.pathExists(sourceFilePath))) throw new Error('源文件不存在')
      const listRoot = listRootInput
        ? resolveLibraryPath(listRootInput).absPath
        : path.dirname(sourceFilePath)
      const originalExt = path.extname(sourceFilePath).replace(/^\./, '').toLowerCase() || 'wav'
      const outputFormat = payload?.outputFormat === 'wav' ? 'wav' : 'original'
      const nextExt = outputFormat === 'wav' ? 'wav' : originalExt
      const canOverwrite = payload?.target === 'overwrite' && nextExt === originalExt
      const sourceDir = path.dirname(sourceFilePath)
      const snapshot = sessionId ? songEditSourceSnapshots.get(sessionId) : null
      if (snapshot && !sameFilePath(snapshot.sourceFilePath, sourceFilePath)) {
        throw new Error('编辑会话源文件不匹配')
      }
      const renderSourceFilePath =
        canOverwrite && sessionId
          ? await ensureSongEditSourceSnapshot(sessionId, sourceFilePath)
          : snapshot?.snapshotPath || sourceFilePath
      const decoded = await decodeAudioShared(renderSourceFilePath, {
        analyzeKey: false,
        needWaveform: false,
        needRawWaveform: false,
        traceLabel: 'song-edit:commit',
        priority: 'high'
      })
      const channels = Math.max(1, Number(decoded.channels) || 1)
      const sampleRate = Number(decoded.sampleRate) || 44100
      const totalFrames =
        Number(decoded.totalFrames) || Math.floor(decoded.pcmData.byteLength / 4 / channels)
      const sourcePcm = toFloat32Pcm(decoded.pcmData)
      const rendered = renderAudioEditClipsToInterleavedPcm(
        sourcePcm,
        totalFrames,
        channels,
        sampleRate,
        clips
      )
      if (rendered.frameCount / rendered.sampleRate > AUDIO_EDIT_MAX_DURATION_SEC) {
        throw new Error('duration')
      }
      const wavBytes = encodeInterleavedPcmToWavBytes(
        rendered.pcm,
        rendered.sampleRate,
        rendered.channels
      )
      const diskFileNames = (await fs.readdir(sourceDir)).filter((name) => !name.startsWith('.'))
      const version = resolveUniqueSongEditVersion({
        baseTitle: parseSongEditBaseTitle(
          String(payload?.title || path.basename(sourceFilePath, path.extname(sourceFilePath)))
        ),
        outputExt: nextExt,
        existingNames: Array.isArray(payload?.existingNames) ? payload.existingNames : [],
        diskFileNames
      })
      const destFileName = canOverwrite ? path.basename(sourceFilePath) : version.destFileName
      let destPath = canOverwrite ? sourceFilePath : path.join(sourceDir, destFileName)
      if (!canOverwrite) {
        assertWritableSongEditFile(destPath)
        if (!sameFilePath(path.dirname(destPath), sourceDir)) {
          throw new Error('保存路径不合法')
        }
        if (await fs.pathExists(destPath)) {
          const latestNames = (await fs.readdir(sourceDir)).filter((name) => !name.startsWith('.'))
          const retry = resolveUniqueSongEditVersion({
            baseTitle: version.baseTitle,
            outputExt: nextExt,
            existingNames: Array.isArray(payload?.existingNames) ? payload.existingNames : [],
            diskFileNames: latestNames
          })
          Object.assign(version, retry)
          destPath = path.join(sourceDir, retry.destFileName)
        }
      }
      const tempWavPath = path.join(sourceDir, `.frkb-song-edit-${Date.now()}.wav`)
      const tempOutPath = canOverwrite
        ? path.join(sourceDir, `.frkb-song-edit-out-${Date.now()}.${nextExt}`)
        : destPath

      const ffmpegPath = resolveBundledFfmpegPath()
      await ensureExecutableOnMac(ffmpegPath)
      await fs.writeFile(
        tempWavPath,
        Buffer.from(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength)
      )
      try {
        const args = [
          '-hide_banner',
          '-y',
          '-i',
          tempWavPath,
          '-i',
          sourceFilePath,
          '-map',
          '0:a',
          '-map_metadata',
          '1',
          ...(!canOverwrite ? ['-metadata', `title=${version.versionTitle}`] : []),
          ...encoderArgsForExt(nextExt),
          tempOutPath
        ]
        await spawnFfmpeg(ffmpegPath, args)
        if (canOverwrite && tempOutPath !== destPath) {
          await fs.move(tempOutPath, destPath, { overwrite: true })
        }
      } finally {
        await fs.remove(tempWavPath).catch(() => undefined)
        if (tempOutPath !== destPath) await fs.remove(tempOutPath).catch(() => undefined)
      }

      if (Array.isArray(payload?.hotCues)) {
        const hotCues = normalizeSongHotCues(payload.hotCues)
        const persisted = (await persistSharedSongHotCueDefinition({
          filePath: destPath,
          hotCues
        })) || {
          filePath: destPath,
          hotCues
        }
        upsertMixtapeItemHotCuesByFilePath([{ filePath: destPath, hotCues: persisted.hotCues }])
        emitSongHotCuesUpdated(persisted)
      }
      if (Array.isArray(payload?.memoryCues)) {
        const memoryCues = normalizeSongMemoryCues(payload.memoryCues)
        const persisted = (await persistSharedSongMemoryCueDefinition({
          filePath: destPath,
          memoryCues
        })) || {
          filePath: destPath,
          memoryCues
        }
        upsertMixtapeItemMemoryCuesByFilePath([
          { filePath: destPath, memoryCues: persisted.memoryCues }
        ])
        emitSongMemoryCuesUpdated(persisted)
      }

      if (!canOverwrite) {
        const orderedFilePaths = Array.isArray(payload?.orderedFilePaths)
          ? payload.orderedFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
          : []
        if (!orderedFilePaths.some((item) => sameFilePath(item, destPath))) {
          const insertAfter = String(payload?.insertAfterFilePath || sourceFilePath)
          const insertIndex = orderedFilePaths.findIndex((item) => sameFilePath(item, insertAfter))
          if (insertIndex >= 0) orderedFilePaths.splice(insertIndex + 1, 0, destPath)
          else orderedFilePaths.push(destPath)
        }
        try {
          await setSongListTrackNumbersByOrder({
            listRoot,
            orderedFilePaths
          })
        } catch (error) {
          log.error('song-edit:commit track number update failed', error)
        }
      }

      scheduleCuratedLibrarySyncIfUnderCurated([sourceFilePath, destPath, listRoot])
      return {
        outputFilePath: destPath,
        outputTitle: canOverwrite
          ? String(payload?.title || version.baseTitle)
          : version.versionTitle,
        overwritten: canOverwrite
      }
    }
    try {
      return await commit()
    } catch (error) {
      log.error('song-edit:commit 保存歌曲编辑失败', error)
      throw error
    }
  })
}
