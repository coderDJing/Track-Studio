import path from 'node:path'
import os from 'node:os'
import fs from 'fs-extra'
import child_process = require('child_process')
import { v4 as uuidV4 } from 'uuid'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from '../ffmpeg'
import { registerChildProcess } from '../services/childProcessRegistry'
import { fetchNeteaseCdn } from './cdn'
import { log } from '../log'

/**
 * 给下载下来的文件写标签和内嵌封面。
 *
 * 为什么非写不可：文件出了这个库就不再受我们管——导出到 U 盘、拖进 Rekordbox、
 * 发给别人。那时候标题/艺人/封面只能来自文件本身，库里的表带不走。
 *
 * 全程 best-effort：ffmpeg 缺失、编码器不支持、封面下载失败都只记日志，
 * 绝不让"写标签"失败连带把一次成功的下载判成失败。
 */

export type DownloadTagPayload = {
  title: string
  artist: string
  album: string
  coverUrl: string
}

const COVER_MAX_BYTES = 8 * 1024 * 1024

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(resolveBundledFfmpegPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    registerChildProcess(child)
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpeg exit ${String(code ?? '')}`))
    })
  })
}

async function downloadCover(coverUrl: string, dir: string): Promise<string | null> {
  try {
    const response = await fetchNeteaseCdn(coverUrl, { retries: 1 })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > COVER_MAX_BYTES) return null
    // 封面永远是 jpg/png，扩展名只影响 ffmpeg 的探测，给个保守值即可
    const filePath = path.join(dir, `${uuidV4()}.jpg`)
    await fs.writeFile(filePath, buffer)
    return filePath
  } catch {
    return null
  }
}

const sanitize = (value: string): string =>
  String(value || '')
    .replace(/[\r\n]/g, ' ')
    .trim()

/** 在原文件上原地重写标签（ffmpeg 输出到临时文件，成功后替换） */
export async function applyDownloadTags(
  filePath: string,
  payload: DownloadTagPayload
): Promise<void> {
  const title = sanitize(payload.title)
  const artist = sanitize(payload.artist)
  const album = sanitize(payload.album)
  if (!title && !artist && !album && !payload.coverUrl) return

  const ext = path.extname(filePath)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-netease-tag-'))
  const outputPath = path.join(path.dirname(filePath), `.${uuidV4()}${ext}`)
  let coverPath: string | null = null
  try {
    await ensureExecutableOnMac(resolveBundledFfmpegPath())
    if (payload.coverUrl && ext.toLowerCase() !== '.wav') {
      coverPath = await downloadCover(payload.coverUrl, tempDir)
    }

    const args: string[] = ['-y', '-i', filePath]
    if (coverPath) args.push('-i', coverPath)
    // 丢掉原来的元数据：网易云直链偶尔带一些半成品 tag，留着会和新写的混在一起
    args.push('-map_metadata', '-1', '-map', '0:a?')
    if (coverPath) args.push('-map', '1:0')
    args.push('-c', 'copy')
    if (ext.toLowerCase() === '.mp3') args.push('-id3v2_version', '3')
    if (coverPath) {
      args.push('-disposition:v:0', 'attached_pic')
      args.push('-metadata:s:v:0', 'title=Album cover')
      args.push('-metadata:s:v:0', 'comment=Cover (front)')
    }
    if (title) args.push('-metadata', `title=${title}`)
    if (artist) args.push('-metadata', `artist=${artist}`)
    if (album) args.push('-metadata', `album=${album}`)
    args.push(outputPath)

    await runFfmpeg(args)
    const stat = await fs.stat(outputPath)
    if (stat.size <= 0) throw new Error('标签写入产出为空文件')
    // 先删原文件再改名：Windows 上 rename 不能覆盖已有文件
    await fs.remove(filePath)
    await fs.rename(outputPath, filePath)
  } catch (error) {
    log.warn('[netease] 写标签/封面失败，保留原始文件', error)
    await fs.remove(outputPath).catch(() => {})
  } finally {
    await fs.remove(tempDir).catch(() => {})
  }
}
