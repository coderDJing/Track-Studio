import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici'
import { resolveInstalledDemucsPlatformRootPath } from '../demucs'
import { createStemError, normalizeText, runProcess } from './mixtapeStemSeparationShared'
import type {
  MixtapeStemRuntimeDownloadState,
  RuntimeAssetEntry
} from './mixtapeStemRuntimeDownload'

type RuntimeInstallProgress = Partial<MixtapeStemRuntimeDownloadState>

export type VerifiedArchiveEntry = {
  archiveName: string
  archiveUrl: string
  archiveSha256: string
  archiveSize: number
  archiveParts?: Array<{
    index: number
    archiveName: string
    archiveUrl: string
    archiveSha256: string
    archiveSize: number
  }>
}

export type VerifiedArchiveDownloadDeps = {
  fetchRuntimeAsset: (url: string, init?: UndiciRequestInit) => Promise<UndiciResponse>
  computeFileSha256: (filePath: string) => Promise<string>
}

type RuntimeInstallDeps = VerifiedArchiveDownloadDeps & {
  resolveRuntimeDownloadCacheDir: () => string
  resolveRuntimeInstalledVersionPath: (runtimeDir: string) => string
  resolveRuntimeProfileTitle: (profile: RuntimeAssetEntry['profile'] | '') => string
  resolveInstalledRuntimeDir: (runtimeKey: string) => string
  fileExists: (targetPath: string) => Promise<boolean>
  validateInstalledRuntime: (entry: RuntimeAssetEntry, runtimeDir: string) => Promise<void>
  readRuntimeMetaFile: (runtimeDir: string) => Promise<Record<string, unknown> | null>
  cleanupRuntimeDownloadArtifacts: (params: {
    entry: RuntimeAssetEntry
    keepArchiveName?: string
  }) => Promise<void>
  createRuntimeContentHash: (params: {
    platform: string
    profile: string
    runtimeKey: string
    pythonRelativePath: string
    runtimeMeta?: Record<string, unknown> | null
  }) => string
}

type RuntimeArchiveDownloadProgress = {
  downloadedBytes: number
  totalBytes: number
  percent: number
}

type RuntimeRangeSegment = {
  index: number
  start: number
  end: number
  path: string
}

const RUNTIME_DOWNLOAD_DEFAULT_CONCURRENCY = 4
const RUNTIME_DOWNLOAD_MAX_CONCURRENCY = 8
const RUNTIME_DOWNLOAD_DEFAULT_SEGMENT_SIZE_BYTES = 32 * 1024 * 1024
const RUNTIME_DOWNLOAD_MIN_SEGMENT_SIZE_BYTES = 8 * 1024 * 1024
const RUNTIME_DOWNLOAD_DEFAULT_IDLE_TIMEOUT_MS = 120 * 1000

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolvePositiveIntegerEnv = (name: string, fallback: number) => {
  const raw = Number.parseInt(String(process.env[name] || '').trim(), 10)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return raw
}

const resolveRangeDownloadConcurrency = () =>
  clampNumber(
    resolvePositiveIntegerEnv(
      'FRKB_DEMUCS_RUNTIME_DOWNLOAD_CONCURRENCY',
      RUNTIME_DOWNLOAD_DEFAULT_CONCURRENCY
    ),
    1,
    RUNTIME_DOWNLOAD_MAX_CONCURRENCY
  )

const resolveRangeSegmentSizeBytes = () =>
  Math.max(
    RUNTIME_DOWNLOAD_MIN_SEGMENT_SIZE_BYTES,
    resolvePositiveIntegerEnv(
      'FRKB_DEMUCS_RUNTIME_DOWNLOAD_SEGMENT_SIZE_BYTES',
      RUNTIME_DOWNLOAD_DEFAULT_SEGMENT_SIZE_BYTES
    )
  )

const resolveDownloadIdleTimeoutMs = () =>
  Math.max(
    30 * 1000,
    resolvePositiveIntegerEnv(
      'FRKB_DEMUCS_RUNTIME_DOWNLOAD_IDLE_TIMEOUT_MS',
      RUNTIME_DOWNLOAD_DEFAULT_IDLE_TIMEOUT_MS
    )
  )

const createDownloadIdleController = () => {
  const controller = new AbortController()
  const idleTimeoutMs = resolveDownloadIdleTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      controller.abort()
    }, idleTimeoutMs)
    timer.unref?.()
  }

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  refresh()
  return {
    signal: controller.signal,
    refresh,
    clear
  }
}

const getFileSize = async (targetPath: string) => {
  try {
    const stat = await fs.promises.stat(targetPath)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

const cancelResponseBody = async (response: UndiciResponse) => {
  try {
    await response.body?.cancel()
  } catch {}
}

const createRangeHeader = (start: number, end?: number) =>
  typeof end === 'number' ? `bytes=${start}-${end}` : `bytes=${start}-`

const resolveRuntimeDownloadPercent = (downloadedBytes: number, totalBytes: number) =>
  totalBytes > 0
    ? Math.max(0, Math.min(90, Math.round((downloadedBytes / totalBytes) * 900) / 10))
    : 0

const downloadRuntimeArchivePart = async (
  deps: VerifiedArchiveDownloadDeps,
  params: {
    archiveUrl: string
    archivePath: string
    archiveSha256: string
    archiveSize: number
  },
  onProgress?: (payload: { downloadedBytes: number; totalBytes: number }) => void
) => {
  let cachedSize = await getFileSize(params.archivePath)
  if (params.archiveSize > 0 && cachedSize === params.archiveSize) {
    const archiveSha256 = await deps.computeFileSha256(params.archivePath)
    if (archiveSha256 === params.archiveSha256) {
      onProgress?.({
        downloadedBytes: params.archiveSize,
        totalBytes: params.archiveSize
      })
      return
    }
    await fs.promises.rm(params.archivePath, { force: true }).catch(() => {})
    cachedSize = 0
  }

  let existingBytes = params.archiveSize > 0 ? Math.min(cachedSize, params.archiveSize) : cachedSize
  if (cachedSize > existingBytes) {
    await fs.promises.rm(params.archivePath, { force: true }).catch(() => {})
    existingBytes = 0
  }

  const idle = createDownloadIdleController()
  let writer: fs.WriteStream | null = null
  try {
    const requestInit: UndiciRequestInit = {
      signal: idle.signal
    }
    if (existingBytes > 0) {
      requestInit.headers = {
        Range: createRangeHeader(existingBytes)
      }
    }
    const response = await deps.fetchRuntimeAsset(params.archiveUrl, requestInit)
    if (existingBytes > 0 && response.status !== 206) {
      await cancelResponseBody(response)
      throw new Error(`resume range request failed: HTTP ${response.status}`)
    }
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status}`)
    }
    const remainingBytes =
      params.archiveSize > 0 ? Math.max(0, params.archiveSize - existingBytes) : 0
    const expectedBytes = Math.max(
      0,
      Number(response.headers.get('content-length') || 0) || remainingBytes
    )
    writer = fs.createWriteStream(params.archivePath, {
      flags: existingBytes > 0 ? 'a' : 'w'
    })
    let receivedBytes = 0
    for await (const chunk of Readable.fromWeb(response.body as unknown as NodeReadableStream)) {
      idle.refresh()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.byteLength
      if (!writer.write(buffer)) {
        await once(writer, 'drain')
      }
      onProgress?.({
        downloadedBytes: existingBytes + receivedBytes,
        totalBytes: params.archiveSize || existingBytes + expectedBytes
      })
    }
    writer.end()
    await once(writer, 'finish')
    const archiveStat = await fs.promises.stat(params.archivePath)
    if (params.archiveSize > 0 && archiveStat.size !== params.archiveSize) {
      throw new Error(
        `download size mismatch: expected=${params.archiveSize} actual=${archiveStat.size}`
      )
    }
    const archiveSha256 = await deps.computeFileSha256(params.archivePath)
    if (archiveSha256 !== params.archiveSha256) {
      throw new Error(
        `download sha256 mismatch: expected=${params.archiveSha256} actual=${archiveSha256}`
      )
    }
  } catch (error) {
    writer?.destroy()
    throw error
  } finally {
    idle.clear()
  }
}

const tryUseCachedRuntimeArchive = async (
  deps: VerifiedArchiveDownloadDeps,
  params: {
    archivePath: string
    archiveSha256: string
    archiveSize: number
  },
  onProgress?: (payload: RuntimeArchiveDownloadProgress) => void
) => {
  const cachedSize = await getFileSize(params.archivePath)
  if (!cachedSize) return false
  if (params.archiveSize > 0 && cachedSize !== params.archiveSize) {
    await fs.promises.rm(params.archivePath, { force: true }).catch(() => {})
    return false
  }
  const archiveSha256 = await deps.computeFileSha256(params.archivePath)
  if (archiveSha256 !== params.archiveSha256) {
    await fs.promises.rm(params.archivePath, { force: true }).catch(() => {})
    return false
  }
  onProgress?.({
    downloadedBytes: cachedSize,
    totalBytes: params.archiveSize || cachedSize,
    percent: 90
  })
  return true
}

const probeRuntimeArchiveRangeSupport = async (
  deps: VerifiedArchiveDownloadDeps,
  archiveUrl: string
) => {
  const idle = createDownloadIdleController()
  try {
    const response = await deps.fetchRuntimeAsset(archiveUrl, {
      headers: {
        Range: createRangeHeader(0, 0)
      },
      signal: idle.signal
    })
    const contentRange = response.headers.get('content-range') || ''
    const supported = response.status === 206 && /^bytes\s+0-0\//i.test(contentRange)
    await cancelResponseBody(response)
    return supported
  } catch {
    return false
  } finally {
    idle.clear()
  }
}

const createRuntimeRangeSegments = (
  archivePath: string,
  totalBytes: number,
  segmentSizeBytes: number
): RuntimeRangeSegment[] => {
  const segments: RuntimeRangeSegment[] = []
  let start = 0
  while (start < totalBytes) {
    const end = Math.min(totalBytes - 1, start + segmentSizeBytes - 1)
    const index = segments.length
    segments.push({
      index,
      start,
      end,
      path: `${archivePath}.segment-${String(index + 1).padStart(4, '0')}`
    })
    start = end + 1
  }
  return segments
}

const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
) => {
  let nextIndex = 0
  let firstError: unknown = null
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const runners = Array.from({ length: workerCount }, async () => {
    while (!firstError) {
      const currentIndex = nextIndex
      nextIndex += 1
      const item = items[currentIndex]
      if (!item) return
      try {
        await worker(item)
      } catch (error) {
        firstError = error
        throw error
      }
    }
  })
  await Promise.allSettled(runners)
  if (firstError) throw firstError
}

const downloadRuntimeArchiveRangeSegment = async (
  deps: VerifiedArchiveDownloadDeps,
  params: {
    archiveUrl: string
    segment: RuntimeRangeSegment
  },
  onSegmentProgress: (index: number, downloadedBytes: number) => void
) => {
  const { segment } = params
  const segmentSize = segment.end - segment.start + 1
  let cachedSize = Math.min(await getFileSize(segment.path), segmentSize)
  if ((await getFileSize(segment.path)) > segmentSize) {
    await fs.promises.rm(segment.path, { force: true }).catch(() => {})
    cachedSize = 0
  }
  onSegmentProgress(segment.index, cachedSize)
  if (cachedSize === segmentSize) {
    return
  }

  const rangeStart = segment.start + cachedSize
  const idle = createDownloadIdleController()
  let writer: fs.WriteStream | null = null
  try {
    const response = await deps.fetchRuntimeAsset(params.archiveUrl, {
      headers: {
        Range: createRangeHeader(rangeStart, segment.end)
      },
      signal: idle.signal
    })
    if (response.status !== 206 || !response.body) {
      await cancelResponseBody(response)
      throw new Error(`range segment request failed: HTTP ${response.status}`)
    }
    writer = fs.createWriteStream(segment.path, {
      flags: cachedSize > 0 ? 'a' : 'w'
    })
    let receivedBytes = 0
    for await (const chunk of Readable.fromWeb(response.body as unknown as NodeReadableStream)) {
      idle.refresh()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.byteLength
      if (!writer.write(buffer)) {
        await once(writer, 'drain')
      }
      onSegmentProgress(segment.index, cachedSize + receivedBytes)
    }
    writer.end()
    await once(writer, 'finish')
    const finalSize = await getFileSize(segment.path)
    if (finalSize !== segmentSize) {
      throw new Error(`range segment size mismatch: expected=${segmentSize} actual=${finalSize}`)
    }
  } catch (error) {
    writer?.destroy()
    throw error
  } finally {
    idle.clear()
  }
}

const combineRuntimeRangeSegments = async (
  archivePath: string,
  segments: RuntimeRangeSegment[]
) => {
  await fs.promises.rm(archivePath, { force: true }).catch(() => {})
  let writer: fs.WriteStream | null = fs.createWriteStream(archivePath, { flags: 'w' })
  try {
    for (const segment of segments) {
      const expectedSize = segment.end - segment.start + 1
      const actualSize = await getFileSize(segment.path)
      if (actualSize !== expectedSize) {
        throw new Error(
          `range segment missing before combine: index=${segment.index} expected=${expectedSize} actual=${actualSize}`
        )
      }
      const reader = fs.createReadStream(segment.path)
      for await (const chunk of reader) {
        if (!writer.write(chunk)) {
          await once(writer, 'drain')
        }
      }
    }
    writer.end()
    await once(writer, 'finish')
    writer = null
  } catch (error) {
    writer?.destroy()
    throw error
  }
}

const downloadRuntimeArchiveWithRangeSegments = async (
  deps: VerifiedArchiveDownloadDeps,
  entry: VerifiedArchiveEntry,
  archivePath: string,
  onProgress?: (payload: RuntimeArchiveDownloadProgress) => void
) => {
  const totalBytes = Math.max(0, Number(entry.archiveSize) || 0)
  const concurrency = resolveRangeDownloadConcurrency()
  const segmentSizeBytes = resolveRangeSegmentSizeBytes()
  const segments = createRuntimeRangeSegments(archivePath, totalBytes, segmentSizeBytes)
  const progressBySegment = new Map<number, number>()
  const emitProgress = () => {
    const downloadedBytes = Array.from(progressBySegment.values()).reduce(
      (sum, value) => sum + value,
      0
    )
    const percent = resolveRuntimeDownloadPercent(downloadedBytes, totalBytes)
    onProgress?.({
      downloadedBytes,
      totalBytes,
      percent
    })
  }
  const onSegmentProgress = (index: number, downloadedBytes: number) => {
    progressBySegment.set(index, downloadedBytes)
    emitProgress()
  }

  await fs.promises.rm(archivePath, { force: true }).catch(() => {})
  await runWithConcurrency(segments, concurrency, async (segment) => {
    await downloadRuntimeArchiveRangeSegment(
      deps,
      {
        archiveUrl: entry.archiveUrl,
        segment
      },
      onSegmentProgress
    )
  })
  await combineRuntimeRangeSegments(archivePath, segments)
  const archiveStat = await fs.promises.stat(archivePath)
  if (archiveStat.size !== totalBytes) {
    throw new Error(
      `range archive size mismatch: expected=${totalBytes} actual=${archiveStat.size}`
    )
  }
  const archiveSha256 = await deps.computeFileSha256(archivePath)
  if (archiveSha256 !== entry.archiveSha256) {
    await fs.promises.rm(archivePath, { force: true }).catch(() => {})
    await Promise.all(segments.map((segment) => fs.promises.rm(segment.path, { force: true })))
    throw new Error(
      `range archive sha256 mismatch: expected=${entry.archiveSha256} actual=${archiveSha256}`
    )
  }
  await Promise.all(segments.map((segment) => fs.promises.rm(segment.path, { force: true })))
}

export const downloadVerifiedArchive = async (
  deps: VerifiedArchiveDownloadDeps,
  entry: VerifiedArchiveEntry,
  archivePath: string,
  onProgress?: (payload: { downloadedBytes: number; totalBytes: number; percent: number }) => void
) => {
  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true })
  const archiveParts = Array.isArray(entry.archiveParts) ? entry.archiveParts : []
  const totalBytes = Math.max(0, Number(entry.archiveSize) || 0)
  if (
    await tryUseCachedRuntimeArchive(
      deps,
      {
        archivePath,
        archiveSha256: entry.archiveSha256,
        archiveSize: entry.archiveSize
      },
      onProgress
    )
  ) {
    return
  }
  if (archiveParts.length > 0) {
    let downloadedBytes = 0
    await fs.promises.rm(archivePath, { force: true }).catch(() => {})
    for (const part of archiveParts.sort((a, b) => Number(a.index) - Number(b.index))) {
      const partPath = `${archivePath}.part-${part.index}`
      await downloadRuntimeArchivePart(
        deps,
        {
          archiveUrl: part.archiveUrl,
          archivePath: partPath,
          archiveSha256: part.archiveSha256,
          archiveSize: part.archiveSize
        },
        (progress) => {
          const nextDownloaded = downloadedBytes + progress.downloadedBytes
          const percent = resolveRuntimeDownloadPercent(nextDownloaded, totalBytes)
          onProgress?.({
            downloadedBytes: nextDownloaded,
            totalBytes,
            percent
          })
        }
      )
      const writer = fs.createWriteStream(archivePath, {
        flags: downloadedBytes > 0 ? 'a' : 'w'
      })
      const reader = fs.createReadStream(partPath)
      for await (const chunk of reader) {
        if (!writer.write(chunk)) {
          await once(writer, 'drain')
        }
      }
      writer.end()
      await once(writer, 'finish')
      downloadedBytes += Number(part.archiveSize) || 0
      await fs.promises.rm(partPath, { force: true }).catch(() => {})
    }
    return
  }

  const rangeConcurrency = resolveRangeDownloadConcurrency()
  const shouldUseRangeSegments =
    totalBytes >= RUNTIME_DOWNLOAD_MIN_SEGMENT_SIZE_BYTES * 2 && rangeConcurrency > 1
  if (shouldUseRangeSegments) {
    const rangeSupported = await probeRuntimeArchiveRangeSupport(deps, entry.archiveUrl)
    if (rangeSupported) {
      await downloadRuntimeArchiveWithRangeSegments(deps, entry, archivePath, onProgress)
      return
    }
  }

  await downloadRuntimeArchivePart(
    deps,
    {
      archiveUrl: entry.archiveUrl,
      archivePath,
      archiveSha256: entry.archiveSha256,
      archiveSize: entry.archiveSize
    },
    (progress) => {
      const percent = resolveRuntimeDownloadPercent(progress.downloadedBytes, totalBytes)
      onProgress?.({
        downloadedBytes: progress.downloadedBytes,
        totalBytes,
        percent
      })
    }
  )
}

export const extractVerifiedArchive = async (archivePath: string, outputDir: string) => {
  await fs.promises.mkdir(outputDir, { recursive: true })
  if (process.platform === 'win32') {
    await runProcess('tar.exe', ['-xf', archivePath, '-C', outputDir], {
      timeoutMs: 30 * 60 * 1000,
      traceLabel: 'mixtape-stem-runtime-extract'
    })
    return
  }
  if (process.platform === 'darwin') {
    await runProcess('ditto', ['-x', '-k', archivePath, outputDir], {
      timeoutMs: 30 * 60 * 1000,
      traceLabel: 'mixtape-stem-runtime-extract'
    })
    return
  }
  await runProcess('unzip', ['-q', archivePath, '-d', outputDir], {
    timeoutMs: 30 * 60 * 1000,
    traceLabel: 'mixtape-stem-runtime-extract'
  })
}

export const installRuntimeFromManifestEntry = async (
  entry: RuntimeAssetEntry,
  deps: RuntimeInstallDeps,
  onState?: (patch: RuntimeInstallProgress) => void
) => {
  const downloadCacheDir = deps.resolveRuntimeDownloadCacheDir()
  const archivePath = path.join(downloadCacheDir, entry.archiveName)
  const platformRoot = resolveInstalledDemucsPlatformRootPath()
  const runtimeDir = deps.resolveInstalledRuntimeDir(entry.runtimeKey)
  const versionPath = deps.resolveRuntimeInstalledVersionPath(runtimeDir)
  const tempExtractRoot = path.join(downloadCacheDir, `extract-${entry.profile}-${Date.now()}`)

  onState?.({
    status: 'downloading',
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    totalBytes: entry.archiveSize,
    downloadedBytes: 0,
    percent: 0,
    title: deps.resolveRuntimeProfileTitle(entry.profile),
    message: `正在下载 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
    error: ''
  })
  await downloadVerifiedArchive(deps, entry, archivePath, (progress) => {
    onState?.({
      status: 'downloading',
      profile: entry.profile,
      runtimeKey: entry.runtimeKey,
      version: entry.version,
      archiveSize: entry.archiveSize,
      totalBytes: progress.totalBytes || entry.archiveSize,
      downloadedBytes: progress.downloadedBytes,
      percent: progress.percent,
      title: deps.resolveRuntimeProfileTitle(entry.profile),
      message: `正在下载 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
      error: ''
    })
  })
  const archiveStat = await fs.promises.stat(archivePath)
  if (entry.archiveSize > 0 && archiveStat.size !== entry.archiveSize) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包大小校验失败: expected=${entry.archiveSize} actual=${archiveStat.size}`
    )
  }
  const archiveSha256 = await deps.computeFileSha256(archivePath)
  if (archiveSha256 !== entry.archiveSha256) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包哈希校验失败: expected=${entry.archiveSha256} actual=${archiveSha256}`
    )
  }

  await fs.promises.rm(tempExtractRoot, { recursive: true, force: true }).catch(() => {})
  onState?.({
    status: 'extracting',
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    totalBytes: entry.archiveSize,
    downloadedBytes: entry.archiveSize,
    percent: 94,
    title: deps.resolveRuntimeProfileTitle(entry.profile),
    message: `正在解压 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`,
    error: ''
  })
  await extractVerifiedArchive(archivePath, tempExtractRoot)
  const extractedRuntimeDir = path.join(tempExtractRoot, entry.runtimeKey)
  const extractedPythonPath = path.join(extractedRuntimeDir, entry.pythonRelativePath)
  if (!(await deps.fileExists(extractedPythonPath))) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包缺少 Python: ${entry.pythonRelativePath}`
    )
  }

  // Validate before removing the working installation.
  await deps.validateInstalledRuntime(entry, extractedRuntimeDir)
  await fs.promises.mkdir(platformRoot, { recursive: true })
  onState?.({
    status: 'extracting',
    percent: 98,
    message: `正在启用 ${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件`
  })
  const backupDir = `${runtimeDir}.previous-${Date.now()}`
  const hadPrevious = await deps.fileExists(runtimeDir)
  if (hadPrevious) await fs.promises.rename(runtimeDir, backupDir)
  try {
    await fs.promises.rename(extractedRuntimeDir, runtimeDir)
    await deps.validateInstalledRuntime(entry, runtimeDir)
  } catch (error) {
    await fs.promises.rm(runtimeDir, { recursive: true, force: true }).catch(() => {})
    if (hadPrevious) await fs.promises.rename(backupDir, runtimeDir)
    throw error
  }
  if (hadPrevious) await fs.promises.rm(backupDir, { recursive: true, force: true })
  const runtimeMeta = await deps.readRuntimeMetaFile(runtimeDir)
  await fs.promises.writeFile(
    versionPath,
    `${JSON.stringify(
      {
        profile: entry.profile,
        runtimeKey: entry.runtimeKey,
        version: entry.version,
        archiveUrl: entry.archiveUrl,
        archiveSha256: entry.archiveSha256,
        contentHash:
          normalizeText(entry.contentHash, 120).toLowerCase() ||
          deps.createRuntimeContentHash({
            platform: entry.platform,
            profile: entry.profile,
            runtimeKey: entry.runtimeKey,
            pythonRelativePath: entry.pythonRelativePath,
            runtimeMeta
          }),
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await fs.promises.rm(tempExtractRoot, { recursive: true, force: true }).catch(() => {})
  await deps
    .cleanupRuntimeDownloadArtifacts({
      entry
    })
    .catch(() => {})
  onState?.({
    status: 'ready',
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    totalBytes: entry.archiveSize,
    downloadedBytes: entry.archiveSize,
    percent: 100,
    title: deps.resolveRuntimeProfileTitle(entry.profile),
    message: `${deps.resolveRuntimeProfileTitle(entry.profile)} 加速组件已就绪`,
    error: ''
  })
}
