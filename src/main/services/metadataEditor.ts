import path = require('path')
import os = require('os')
import fs = require('fs-extra')
import child_process = require('child_process')
import { v4 as uuidV4 } from 'uuid'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from '../ffmpeg'
import { ISongInfo, ITrackMetadataDetail, ITrackMetadataUpdatePayload } from '../../types/globals'
import { extFromMime } from './covers'
import { writeWavRiffInfoWindows, readWavRiffInfoWindows } from './wavRiffInfo'
import { updateSongCacheEntry, purgeCoverCacheForTrack, findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { IAudioMetadata, IPicture } from 'music-metadata'
import { updateSetItemFilePathReferences } from '../setListDb'
import { notifyCuratedFilePathChanged } from '../curatedLibrarySync/identityDb'
import { registerChildProcess } from './childProcessRegistry'

async function parseMetadata(filePath: string) {
  const mm = await import('music-metadata')
  return mm.parseFile(filePath)
}

function convertSecondsToMinutesSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  const minutesStr = minutes.toString().padStart(2, '0')
  const secondsStr = remainingSeconds.toString().padStart(2, '0')
  return `${minutesStr}:${secondsStr}`
}

type FfmpegMetadataError = Error & {
  code: 'FFMPEG_METADATA_FAILED'
  exitCode?: number
  stderr?: string
}

type WavRiffInfo = NonNullable<Awaited<ReturnType<typeof readWavRiffInfoWindows>>>

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) return text
      continue
    }
    if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
      const text = item.text.trim()
      if (text) return text
    }
  }
  return undefined
}

function extractLyricsText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (!Array.isArray(value)) return undefined
  const lines = value
    .map((item) =>
      item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'
        ? item.text.trim()
        : ''
    )
    .filter(Boolean)
  return lines.length ? lines.join('\n') : undefined
}

function mergeWavInfoMetadata(metadata: IAudioMetadata, info: WavRiffInfo): IAudioMetadata {
  const prefer = <T extends string | undefined>(primary: T, fallback: T): T => {
    const p = typeof primary === 'string' ? primary.trim() : ''
    const f = typeof fallback === 'string' ? fallback.trim() : ''
    if (f && (!p || /^[\x00-\x7F]+$/.test(p))) return fallback as T
    return primary
  }
  const currentGenre = Array.isArray(metadata.common.genre) ? metadata.common.genre : undefined
  const currentComment = firstString(metadata.common.comment)
  const nextGenre = currentGenre?.length ? currentGenre : info.genre ? [info.genre] : currentGenre
  const nextComment =
    currentComment || !info.comment ? metadata.common.comment : [{ text: info.comment }]

  return {
    ...metadata,
    common: {
      ...metadata.common,
      title: prefer(metadata.common.title, info.title),
      artist: prefer(metadata.common.artist, info.artist),
      album: prefer(metadata.common.album, info.album),
      genre: nextGenre,
      date: metadata.common.date ?? info.date,
      comment: nextComment
    }
  }
}

function buildSongInfo(filePath: string, metadata: IAudioMetadata): ISongInfo {
  const durationSeconds = metadata.format?.duration
  const duration =
    typeof durationSeconds === 'number' && durationSeconds >= 0
      ? convertSecondsToMinutesSeconds(Math.round(durationSeconds))
      : '00:00'
  const baseName = path.basename(filePath)
  const ext = path.extname(filePath)
  const normalizedExt = ext ? ext.slice(1).toUpperCase() : ''
  const fallbackFormat =
    typeof metadata.format?.container === 'string' && metadata.format.container.trim() !== ''
      ? metadata.format.container.trim().toUpperCase()
      : ''
  const fileFormat = normalizedExt || fallbackFormat

  return {
    filePath,
    fileName: baseName,
    fileFormat,
    cover: null,
    title:
      metadata.common?.title && metadata.common.title.trim() !== ''
        ? metadata.common.title
        : baseName,
    artist: metadata.common?.artist,
    album: metadata.common?.album,
    duration,
    genre: firstString(metadata.common?.genre),
    label: firstString(metadata.common?.label),
    bitrate: metadata.format?.bitrate,
    container: metadata.format?.container
  }
}

function convertCoverToDataUrl(picture: IPicture | null | undefined): {
  dataUrl: string
  format?: string
} | null {
  if (!picture || !picture.data) return null
  const mime = picture.format || 'image/jpeg'
  const buffer = Buffer.from(picture.data)
  if (!buffer.length) return null
  const base64 = buffer.toString('base64')
  return {
    dataUrl: `data:${mime};base64,${base64}`,
    format: picture.format
  }
}

function buildDetail(filePath: string, metadata: IAudioMetadata): ITrackMetadataDetail {
  const baseName = path.basename(filePath)
  const dotIndex = baseName.lastIndexOf('.')
  const nameWithoutExt = dotIndex >= 0 ? baseName.slice(0, dotIndex) : baseName
  const extension = dotIndex >= 0 ? baseName.slice(dotIndex) : ''
  const pictureSource = Array.isArray(metadata.common?.picture) ? metadata.common.picture[0] : null
  const durationSeconds =
    typeof metadata.format?.duration === 'number' ? Math.round(metadata.format.duration) : undefined

  return {
    filePath,
    fileName: nameWithoutExt,
    fileExtension: extension,
    durationSeconds,
    title: typeof metadata.common?.title === 'string' ? metadata.common.title : undefined,
    artist: typeof metadata.common?.artist === 'string' ? metadata.common.artist : undefined,
    album: typeof metadata.common?.album === 'string' ? metadata.common.album : undefined,
    albumArtist: metadata.common?.albumartist,
    trackNo: metadata.common?.track?.no ?? undefined,
    trackTotal: metadata.common?.track?.of ?? undefined,
    discNo: metadata.common?.disk?.no ?? undefined,
    discTotal: metadata.common?.disk?.of ?? undefined,
    year: metadata.common?.year ? String(metadata.common.year) : metadata.common?.date,
    genre: firstString(metadata.common?.genre),
    composer: firstString(metadata.common?.composer),
    lyricist: firstString(metadata.common?.lyricist) ?? firstString(metadata.common?.writer),
    label: firstString(metadata.common?.label),
    isrc: firstString(metadata.common?.isrc),
    comment: firstString(metadata.common?.comment),
    lyrics: extractLyricsText(metadata.common?.lyrics),
    cover: convertCoverToDataUrl(pictureSource)
  }
}

function sanitizeMetadataValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.replace(/\u0000/g, '').trim()
}

function summarizeFfmpegStderr(output?: string): string {
  if (!output) return ''
  return output
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5)
    .join(' | ')
    .slice(0, 500)
}

function createFfmpegError(code: number | null, stderr?: string): Error {
  const err = new Error('FFMPEG_METADATA_FAILED') as FfmpegMetadataError
  err.code = 'FFMPEG_METADATA_FAILED'
  err.exitCode = code ?? undefined
  err.stderr = summarizeFfmpegStderr(stderr)
  return err
}

function buildFfmpegArgs(
  filePath: string,
  destPath: string,
  payload: ITrackMetadataUpdatePayload,
  coverPath?: string | null
) {
  const args: string[] = ['-y', '-i', filePath]
  const ext = path.extname(filePath).toLowerCase()
  // WAV 不支持封面写入，直接忽略封面输入避免 FFmpeg 报错
  const coverInputEnabled = !!coverPath && ext !== '.wav'

  if (coverInputEnabled) {
    args.push('-i', coverPath)
  }

  args.push('-map_metadata', '-1')
  args.push('-map', '0:a?')

  if (coverInputEnabled) {
    args.push('-map', '1:0')
  }

  args.push('-c:a', 'copy')

  if (ext === '.mp3') {
    args.push('-id3v2_version', '3')
  }
  if (ext === '.wav') {
    // WAV 默认 RIFF LIST/INFO 非 Unicode，这里启用 ID3v2.3
    args.push('-write_id3v2', '1')
    args.push('-id3v2_version', '3')
  }
  if (ext === '.aif' || ext === '.aiff') {
    args.push('-write_id3v2', '1')
    args.push('-id3v2_version', '3')
  }

  if (coverInputEnabled) {
    args.push('-disposition:v:0', 'attached_pic')
    args.push('-metadata:s:v:0', 'title=Album cover')
    args.push('-metadata:s:v:0', 'comment=Cover (front)')
  }

  const entries: Array<[string, string | undefined]> = [
    ['title', sanitizeMetadataValue(payload.title)],
    ['artist', sanitizeMetadataValue(payload.artist)],
    ['album', sanitizeMetadataValue(payload.album)],
    ['album_artist', sanitizeMetadataValue(payload.albumArtist)],
    ['genre', sanitizeMetadataValue(payload.genre)],
    ['date', sanitizeMetadataValue(payload.year)],
    ['composer', sanitizeMetadataValue(payload.composer)],
    ['lyricist', sanitizeMetadataValue(payload.lyricist)],
    ['publisher', sanitizeMetadataValue(payload.label)],
    ['isrc', sanitizeMetadataValue(payload.isrc)],
    ['comment', sanitizeMetadataValue(payload.comment)],
    ['lyrics', sanitizeMetadataValue(payload.lyrics)]
  ]

  const trackParts: string[] = []
  if (typeof payload.trackNo === 'number' && payload.trackNo > 0) {
    trackParts.push(String(payload.trackNo))
  }
  if (typeof payload.trackTotal === 'number' && payload.trackTotal > 0) {
    if (!trackParts.length) trackParts.push('')
    trackParts[1] = String(payload.trackTotal)
  }
  if (trackParts.length) entries.push(['track', trackParts.join('/')])

  const discParts: string[] = []
  if (typeof payload.discNo === 'number' && payload.discNo > 0) {
    discParts.push(String(payload.discNo))
  }
  if (typeof payload.discTotal === 'number' && payload.discTotal > 0) {
    if (!discParts.length) discParts.push('')
    discParts[1] = String(payload.discTotal)
  }
  if (discParts.length) entries.push(['disc', discParts.join('/')])

  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') {
      args.push('-metadata', `${key}=${value}`)
    }
  }

  args.push(destPath)
  return args
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/)
  if (!match) {
    throw new Error('Invalid data URL')
  }
  const mime = match[1] || 'image/jpeg'
  const base64 = match[2]
  return { buffer: Buffer.from(base64, 'base64'), mime }
}

async function writeTempFile(buffer: Buffer, extension: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-meta-'))
  const target = path.join(dir, `${uuidV4()}${extension}`)
  await fs.outputFile(target, buffer)
  return target
}

export async function readTrackMetadata(filePath: string): Promise<ITrackMetadataDetail | null> {
  try {
    const metadata = await parseMetadata(filePath)
    // Windows 下 WAV：尝试用 GBK 读取 LIST/INFO，并与 ID3 合并显示（优先 ID3）
    if (process.platform === 'win32' && path.extname(filePath).toLowerCase() === '.wav') {
      try {
        const info = await readWavRiffInfoWindows(filePath)
        if (info) {
          const patched = mergeWavInfoMetadata(metadata, info)
          return buildDetail(filePath, patched)
        }
      } catch {}
    }
    return buildDetail(filePath, metadata)
  } catch (err) {
    return null
  }
}

export async function readTrackSongInfo(filePath: string): Promise<ISongInfo | null> {
  try {
    const metadata = await parseMetadata(filePath)
    let songInfoMeta = metadata
    if (process.platform === 'win32' && path.extname(filePath).toLowerCase() === '.wav') {
      try {
        const info = await readWavRiffInfoWindows(filePath)
        if (info) {
          songInfoMeta = mergeWavInfoMetadata(metadata, info)
        }
      } catch {}
    }
    return buildSongInfo(filePath, songInfoMeta)
  } catch {
    return null
  }
}

export async function updateTrackMetadata(
  payload: ITrackMetadataUpdatePayload
): Promise<{ songInfo: ISongInfo; detail: ITrackMetadataDetail; renamedFrom?: string }> {
  let filePath = payload.filePath
  const originalFilePath = filePath
  const ext = path.extname(filePath)
  const lowerExt = ext.toLowerCase()
  const ffmpegPath = resolveBundledFfmpegPath()
  await ensureExecutableOnMac(ffmpegPath)

  const tempOutput = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, ext)}.metadata-edit.${uuidV4()}${ext}`
  )

  let coverTempPath: string | null = null
  let originalMetadata: IAudioMetadata | null = null
  try {
    try {
      originalMetadata = await parseMetadata(filePath)
    } catch {
      originalMetadata = null
    }
    const newBaseName = typeof payload.newBaseName === 'string' ? payload.newBaseName.trim() : ''
    if (newBaseName && newBaseName !== path.basename(filePath, ext)) {
      const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
      if (invalidCharsRegex.test(newBaseName)) {
        throw new Error('INVALID_FILE_NAME')
      }
      if (newBaseName === '.' || newBaseName === '..' || /[ .]$/.test(newBaseName)) {
        throw new Error('INVALID_FILE_NAME')
      }
      const dir = path.dirname(filePath)
      const targetPath = path.join(dir, `${newBaseName}${ext}`)
      const exists = await fs.pathExists(targetPath)
      if (exists) {
        throw new Error('FILE_NAME_EXISTS')
      }
      await fs.rename(filePath, targetPath)
      filePath = targetPath
      payload.filePath = targetPath
    }

    const coverDataUrl = payload.coverDataUrl
    // WAV 不写入封面，避免因封面编码器缺失导致整体失败
    const coverAllowed =
      typeof coverDataUrl === 'string' && coverDataUrl !== '' && lowerExt !== '.wav'
    if (coverAllowed) {
      const { buffer, mime } = dataUrlToBuffer(coverDataUrl)
      const extension = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg'
      coverTempPath = await writeTempFile(buffer, extension)
    }

    const args = buildFfmpegArgs(filePath, tempOutput, payload, coverTempPath)
    await new Promise<void>((resolve, reject) => {
      const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
      registerChildProcess(child, 'metadata-editor:ffmpeg')
      let stderrOutput = ''
      child.stderr?.on('data', (chunk) => {
        if (stderrOutput.length < 8000) {
          stderrOutput += chunk.toString()
        }
      })
      child.on('error', (err) => {
        reject(createFfmpegError(null, stderrOutput || err?.message))
      })
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(createFfmpegError(code ?? null, stderrOutput))
      })
    })

    await fs.move(tempOutput, filePath, { overwrite: true })

    // Windows: WAV 写入 LIST/INFO（GBK），与 ID3v2.3 同步
    try {
      if (process.platform === 'win32' && lowerExt === '.wav') {
        await writeWavRiffInfoWindows(filePath, {
          title: payload.title,
          artist: payload.artist,
          album: payload.album,
          genre: payload.genre,
          date: payload.year,
          comment: payload.comment
        })
      }
    } catch {}

    // 如果没有提供新的封面但原文件包含封面，尝试从备份恢复
    if (!payload.coverDataUrl && originalMetadata && lowerExt !== '.wav') {
      try {
        const originalCover = (await import('music-metadata')).selectCover(
          originalMetadata.common?.picture
        )
        const currentMetadata = await parseMetadata(filePath)
        const currentCover = (await import('music-metadata')).selectCover(
          currentMetadata.common?.picture
        )

        if (originalCover && !currentCover) {
          const coverBuffer = Buffer.isBuffer(originalCover.data)
            ? originalCover.data
            : Buffer.from(originalCover.data)
          if (coverBuffer.length > 0) {
            const coverMime = originalCover.format || 'image/jpeg'
            const extension = extFromMime(coverMime)
            coverTempPath = await writeTempFile(coverBuffer, extension)
            const patchOutput = path.join(
              path.dirname(filePath),
              `.${path.basename(filePath, ext)}.metadata-cover.${uuidV4()}${ext}`
            )
            try {
              const patchArgs = buildFfmpegArgs(
                filePath,
                patchOutput,
                {
                  ...payload,
                  coverDataUrl: undefined
                },
                coverTempPath
              )
              await new Promise<void>((resolve, reject) => {
                const child = child_process.spawn(ffmpegPath, patchArgs, { windowsHide: true })
                registerChildProcess(child, 'metadata-editor:ffmpeg-cover-restore')
                let stderrOutput = ''
                child.stderr?.on('data', (chunk) => {
                  if (stderrOutput.length < 8000) {
                    stderrOutput += chunk.toString()
                  }
                })
                child.on('error', (err) => {
                  reject(createFfmpegError(null, stderrOutput || err?.message))
                })
                child.on('exit', (code) => {
                  if (code === 0) resolve()
                  else reject(createFfmpegError(code ?? null, stderrOutput))
                })
              })
              await fs.move(patchOutput, filePath, { overwrite: true })
            } catch {
            } finally {
              try {
                if (await fs.pathExists(patchOutput)) {
                  await fs.remove(patchOutput)
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    const metadata = await parseMetadata(filePath)
    // 构造返回给列表的简要信息时，也应用与读取时相同的 WAV INFO 合并逻辑，避免出现 '0!0!0!'
    let songInfoMeta = metadata
    if (process.platform === 'win32' && lowerExt === '.wav') {
      try {
        const info = await readWavRiffInfoWindows(filePath)
        if (info) {
          songInfoMeta = mergeWavInfoMetadata(metadata, info)
        }
      } catch {}
    }
    const songInfo = buildSongInfo(filePath, songInfoMeta)
    const renamedFrom = originalFilePath === filePath ? undefined : originalFilePath
    await updateSongCacheEntry(filePath, songInfo, renamedFrom)
    await purgeCoverCacheForTrack(filePath, renamedFrom)
    if (renamedFrom) {
      updateSetItemFilePathReferences(renamedFrom, filePath)
      notifyCuratedFilePathChanged(renamedFrom, filePath)
    }

    // Mark track as auto-filled if requested (from MusicBrainz search)
    if (payload.markAsAutoFilled) {
      try {
        const listRoot = await findSongListRoot(path.dirname(filePath))
        if (listRoot) {
          const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
          if (cached?.info) {
            cached.info.autoFilled = true
            await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, cached)
          }
        }
      } catch {}
    }

    return {
      songInfo,
      detail: buildDetail(filePath, metadata),
      renamedFrom
    }
  } finally {
    try {
      if (coverTempPath) {
        const coverDir = path.dirname(coverTempPath)
        if (await fs.pathExists(coverDir)) {
          await fs.remove(coverDir)
        }
      }
    } catch {}
    try {
      if (await fs.pathExists(tempOutput)) {
        await fs.remove(tempOutput)
      }
    } catch {}
  }
}
