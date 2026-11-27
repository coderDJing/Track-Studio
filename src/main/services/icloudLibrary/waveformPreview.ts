import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import type { WaveformListPreviewData } from '../../../shared/waveformSurfaceCache'
import {
  buildWaveformSurfaceCacheDataFromUnifiedDisplay,
  normalizeWaveformSurfaceData
} from '../../../shared/waveformSurfaceCache'
import { buildUnifiedDisplayWaveformDetailFromPersistedMixxx } from '../../../shared/unifiedDisplayWaveform'
import * as LibraryCacheDb from '../../libraryCacheDb'
import {
  audioName,
  boundedPath,
  isLegacyPlaceholder,
  requireLocal,
  type ResidencyReader
} from './files'
import { buildListPreviewFromAudioBuffer } from './listPreviewFromAudio'

const MAX_AUDIO_BYTES = 120 * 1024 * 1024

export type IcloudWaveformPreviewItem = {
  relativePath: string
  data?: WaveformListPreviewData | null
}

export type IcloudWaveformPreviewReader = (
  root: string,
  paths: string[],
  signal: AbortSignal,
  rootIdentity: string,
  cacheDir: string
) => Promise<IcloudWaveformPreviewItem[]>

const surfaceFields = [
  'detailPeakTop',
  'detailPeakBottom',
  'detailBody',
  'colorIndex',
  'colorLow',
  'colorMid',
  'colorHigh',
  'colorRed',
  'colorGreen',
  'colorBlue',
  'overviewTop',
  'overviewBottom'
] as const

const toBase64 = (value: Uint8Array) => Buffer.from(value).toString('base64')

const serializePreview = (data: WaveformListPreviewData) => ({
  surfaceKind: data.surfaceKind,
  version: data.version,
  parameterVersion: data.parameterVersion,
  duration: data.duration,
  sampleRate: data.sampleRate,
  detailRate: data.detailRate,
  overviewRate: data.overviewRate,
  bodyRateDivisor: data.bodyRateDivisor,
  colorRateDivisor: data.colorRateDivisor,
  ...Object.fromEntries(surfaceFields.map((field) => [field, toBase64(data[field])]))
})

const deserializePreview = (value: unknown): WaveformListPreviewData | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const arrays = Object.fromEntries(
    surfaceFields.map((field) => {
      const raw = record[field]
      return [
        field,
        typeof raw === 'string' ? new Uint8Array(Buffer.from(raw, 'base64')) : new Uint8Array()
      ]
    })
  )
  return normalizeWaveformSurfaceData(
    {
      ...record,
      ...arrays
    },
    'listPreview'
  )
}

const cacheName = (rootIdentity: string, relative: string, signature: string) =>
  `${createHash('sha256').update(`${rootIdentity}\0${relative}\0${signature}`).digest('hex')}.json`

const assertCacheDir = (cacheDir: string, root: string) => {
  const resolved = path.resolve(cacheDir)
  const cloudRoot = path.resolve(root)
  if (!resolved || resolved === cloudRoot || resolved.startsWith(cloudRoot + path.sep)) {
    throw new Error('boundary')
  }
  return resolved
}

const signatureOf = (info: Awaited<ReturnType<typeof fs.lstat>>) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`

async function analyzedListPreview(file: string): Promise<WaveformListPreviewData | null> {
  try {
    const info = await fs.stat(file)
    const waveform = await LibraryCacheDb.loadExternalAnalysisWaveformCacheDataByFilePath(file, {
      size: info.size,
      mtimeMs: info.mtimeMs
    })
    if (!waveform) return null
    const unified = buildUnifiedDisplayWaveformDetailFromPersistedMixxx(waveform)
    return buildWaveformSurfaceCacheDataFromUnifiedDisplay(unified)?.listPreview || null
  } catch {
    return null
  }
}

async function stamp(root: string, relative: string, residency: ResidencyReader) {
  if (!audioName(relative) || isLegacyPlaceholder(relative)) throw new Error('invalid')
  const file = await boundedPath(root, relative, residency)
  await requireLocal(file, residency)
  const info = await fs.lstat(file)
  if (!info.isFile()) throw new Error('invalid')
  return { file, signature: signatureOf(info) }
}

async function readCache(cacheDir: string, name: string) {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(cacheDir, name), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const record = raw as { signature?: unknown; data?: unknown }
    if (typeof record.signature !== 'string') return null
    const data = deserializePreview(record.data)
    return data ? { signature: record.signature, data } : null
  } catch {
    return null
  }
}

async function writeCache(
  cacheDir: string,
  name: string,
  signature: string,
  data: WaveformListPreviewData
) {
  await fs.mkdir(cacheDir, { recursive: true })
  const dest = path.join(cacheDir, name)
  const tmp = `${dest}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ signature, data: serializePreview(data) }))
  await fs.rename(tmp, dest)
}

export async function readIcloudWaveformPreview(
  root: string,
  relative: string,
  residency: ResidencyReader,
  rootIdentity: string | undefined,
  cacheDir: string,
  signal?: AbortSignal
): Promise<WaveformListPreviewData | null> {
  if (signal?.aborted) throw new Error('cancelled')
  const safeCache = assertCacheDir(cacheDir, root)
  const rootInfo = await fs.lstat(root)
  const identity = `${root}:${rootInfo.dev}:${rootInfo.ino}`
  if (!rootInfo.isDirectory() || (rootIdentity && identity !== rootIdentity))
    throw new Error('boundary')
  const { file, signature } = await stamp(root, relative, residency)
  const analyzed = await analyzedListPreview(file)
  if (analyzed) return analyzed
  const name = cacheName(identity, relative, signature)
  const cached = await readCache(safeCache, name)
  if (cached?.signature === signature) return cached.data
  if (signal?.aborted) throw new Error('cancelled')
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let buffer: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_AUDIO_BYTES) return null
    buffer = Buffer.alloc(Number(info.size))
    await handle.read(buffer, 0, buffer.length, 0)
  } finally {
    await handle.close()
  }
  if (signal?.aborted) throw new Error('cancelled')
  if ((await stamp(root, relative, residency)).signature !== signature) return null
  const data = buildListPreviewFromAudioBuffer(buffer)
  if (!data) return null
  await writeCache(safeCache, name, signature, data)
  return data
}

export function createIcloudWaveformPreviewCache(
  residency: ResidencyReader,
  cacheDir: string,
  reader: IcloudWaveformPreviewReader = async (root, paths, signal, identity, dest) => {
    const items: IcloudWaveformPreviewItem[] = []
    for (const relativePath of paths) {
      if (signal.aborted) throw new Error('cancelled')
      try {
        items.push({
          relativePath,
          data: await readIcloudWaveformPreview(
            root,
            relativePath,
            residency,
            identity,
            dest,
            signal
          )
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'cancelled') throw error
        items.push({ relativePath, data: null })
      }
    }
    return items
  }
) {
  let active = 0
  async function read(
    root: string,
    paths: string[],
    scope: string,
    signal: AbortSignal,
    expectedRoot?: string
  ) {
    if (active >= 2) throw new Error('busy')
    active++
    try {
      const info = await fs.lstat(root)
      const rootIdentity = `${root}:${info.dev}:${info.ino}`
      if (!info.isDirectory() || (expectedRoot && rootIdentity !== expectedRoot))
        throw new Error('boundary')
      return await reader(root, paths, signal, rootIdentity, assertCacheDir(cacheDir, root))
    } finally {
      active--
    }
  }
  return { read }
}
