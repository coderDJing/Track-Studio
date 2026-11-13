import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type DemucsBaseModelName = 'htdemucs' | 'mdx_extra_q'

export type DemucsBaseModelFile = {
  name: string
  url: string
  sha256: string
}

export type DemucsBaseModelEntry = {
  name: DemucsBaseModelName
  yaml: string
  files: DemucsBaseModelFile[]
}

export type DemucsBaseModelManifest = {
  models: DemucsBaseModelEntry[]
}

export type DemucsBaseModelFetchResponse = {
  ok: boolean
  status: number
  contentLength: number
  body: Readable | null
}

export type FetchDemucsBaseModelAsset = (url: string) => Promise<DemucsBaseModelFetchResponse>

export type DemucsBaseModelProgress = {
  modelName: DemucsBaseModelName
  status: 'downloading' | 'installing'
  percent: number
  downloadedBytes: number
  totalBytes: number
}

export type DemucsBaseModelVerifyResult = {
  ok: boolean
  reason: string
}

export type DemucsBaseModelEnsurerParams = {
  modelsRoot: string
  manifest: DemucsBaseModelManifest
  fetchAsset: FetchDemucsBaseModelAsset
  vendorRoot?: string | null
  onProgress?: (progress: DemucsBaseModelProgress) => void
}

export class DemucsBaseModelDownloadError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DemucsBaseModelDownloadError'
    this.code = code
  }
}

export const isDemucsBaseModelName = (value: unknown): value is DemucsBaseModelName =>
  value === 'htdemucs' || value === 'mdx_extra_q'

const normalizeFileName = (value: unknown): string => {
  const name = String(value || '').trim()
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) return ''
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : ''
}

const normalizeSha256 = (value: unknown): string => {
  const sha = String(value || '')
    .trim()
    .toLowerCase()
  return /^[a-f0-9]{64}$/.test(sha) ? sha : ''
}

export const normalizeDemucsBaseModelEntry = (value: unknown): DemucsBaseModelEntry | null => {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const name = source.name
  if (!isDemucsBaseModelName(name)) return null
  const yaml = typeof source.yaml === 'string' && source.yaml.trim() ? source.yaml : ''
  if (!yaml) return null
  const rawFiles = Array.isArray(source.files) ? source.files : []
  const files: DemucsBaseModelFile[] = []
  for (const rawFile of rawFiles) {
    if (!rawFile || typeof rawFile !== 'object') continue
    const file = rawFile as Record<string, unknown>
    const fileName = normalizeFileName(file.name)
    const url = String(file.url || '').trim()
    const sha256 = normalizeSha256(file.sha256)
    if (!fileName || !/^https:\/\//i.test(url) || !sha256) continue
    files.push({ name: fileName, url, sha256 })
  }
  const expectedFileCount = name === 'htdemucs' ? 1 : 4
  return files.length === expectedFileCount ? { name, yaml, files } : null
}

const computeSha256 = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

export const verifyDemucsBaseModelRepo = async (
  repoDir: string,
  entry: DemucsBaseModelEntry
): Promise<DemucsBaseModelVerifyResult> => {
  try {
    const yamlPath = path.join(repoDir, `${entry.name}.yaml`)
    if (!(await fileExists(yamlPath))) {
      return { ok: false, reason: 'yaml-missing' }
    }
    const yaml = await fs.promises.readFile(yamlPath, 'utf8')
    if (yaml !== entry.yaml) {
      return { ok: false, reason: 'yaml-mismatch' }
    }
    for (const file of entry.files) {
      const targetPath = path.join(repoDir, file.name)
      if (!(await fileExists(targetPath))) {
        return { ok: false, reason: `weight-missing:${file.name}` }
      }
      const actualSha256 = await computeSha256(targetPath)
      if (actualSha256 !== file.sha256) {
        return { ok: false, reason: `sha256-mismatch:${file.name}` }
      }
    }
    return { ok: true, reason: 'ok' }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

const downloadFile = async (params: {
  file: DemucsBaseModelFile
  targetPath: string
  fileIndex: number
  fileCount: number
  completedBytes: number
  totalKnownBytes: number
  fetchAsset: FetchDemucsBaseModelAsset
  onProgress?: (progress: DemucsBaseModelProgress) => void
  modelName: DemucsBaseModelName
}): Promise<{ downloadedBytes: number; totalBytes: number }> => {
  const {
    file,
    targetPath,
    fileIndex,
    fileCount,
    completedBytes,
    fetchAsset,
    onProgress,
    modelName
  } = params
  let totalKnownBytes = params.totalKnownBytes
  const response = await fetchAsset(file.url)
  if (!response.ok || !response.body) {
    throw new DemucsBaseModelDownloadError(
      'DOWNLOAD_FAILED',
      `model file download failed: HTTP ${response.status} (${file.name})`
    )
  }
  totalKnownBytes += Math.max(0, Number(response.contentLength) || 0)
  const writer = fs.createWriteStream(targetPath)
  let fileBytes = 0
  const emit = () => {
    const fileFraction =
      response.contentLength > 0 ? Math.min(1, fileBytes / response.contentLength) : 0
    onProgress?.({
      modelName,
      status: 'downloading',
      percent: Math.min(99, Math.floor(((fileIndex + fileFraction) / fileCount) * 100)),
      downloadedBytes: completedBytes + fileBytes,
      totalBytes: totalKnownBytes
    })
  }
  try {
    emit()
    const meter = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding: BufferEncoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        fileBytes += buffer.byteLength
        emit()
        callback(null, buffer)
      }
    })
    await pipeline(response.body, meter, writer)
  } catch (error) {
    writer.destroy()
    throw error
  }
  const downloadedBytes = completedBytes + fileBytes
  return { downloadedBytes, totalBytes: totalKnownBytes }
}

const swapIntoPlace = async (stagingDir: string, finalDir: string): Promise<void> => {
  await fs.promises.mkdir(path.dirname(finalDir), { recursive: true })
  const backupDir = `${finalDir}.backup-${process.pid}-${Date.now()}`
  const hadExisting = await fileExists(finalDir)
  if (hadExisting) {
    await fs.promises.rename(finalDir, backupDir)
  }
  try {
    await fs.promises.rename(stagingDir, finalDir)
  } catch (error) {
    if (hadExisting && !(await fileExists(finalDir))) {
      await fs.promises.rename(backupDir, finalDir).catch(() => {})
    }
    throw error
  }
  if (hadExisting) {
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {})
  }
}

const ensureModel = async (
  params: DemucsBaseModelEnsurerParams,
  modelName: DemucsBaseModelName
): Promise<string> => {
  const entry = params.manifest.models.find((item) => item.name === modelName)
  if (!entry) {
    throw new DemucsBaseModelDownloadError(
      'MANIFEST_MISSING',
      `embedded model manifest is missing ${modelName}`
    )
  }
  const vendorRoot = params.vendorRoot ? String(params.vendorRoot).trim() : ''
  if (vendorRoot) {
    const vendorResult = await verifyDemucsBaseModelRepo(vendorRoot, entry)
    if (vendorResult.ok) return vendorRoot
  }

  const finalDir = path.join(params.modelsRoot, modelName)
  const installedResult = await verifyDemucsBaseModelRepo(finalDir, entry)
  if (installedResult.ok) return finalDir

  const stagingRoot = path.join(params.modelsRoot, '.staging')
  const stagingDir = path.join(
    stagingRoot,
    `${modelName}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.promises.mkdir(stagingDir, { recursive: true })
  let downloadedBytes = 0
  let totalBytes = 0
  try {
    for (let index = 0; index < entry.files.length; index += 1) {
      const file = entry.files[index]
      const result = await downloadFile({
        file,
        targetPath: path.join(stagingDir, file.name),
        fileIndex: index,
        fileCount: entry.files.length,
        completedBytes: downloadedBytes,
        totalKnownBytes: totalBytes,
        fetchAsset: params.fetchAsset,
        onProgress: params.onProgress,
        modelName
      })
      downloadedBytes = result.downloadedBytes
      totalBytes = result.totalBytes
    }
    await fs.promises.writeFile(path.join(stagingDir, `${entry.name}.yaml`), entry.yaml, 'utf8')
    const stagedResult = await verifyDemucsBaseModelRepo(stagingDir, entry)
    if (!stagedResult.ok) {
      throw new DemucsBaseModelDownloadError(
        'VERIFY_FAILED',
        `downloaded model verification failed: ${stagedResult.reason}`
      )
    }
    params.onProgress?.({
      modelName,
      status: 'installing',
      percent: 100,
      downloadedBytes,
      totalBytes: Math.max(downloadedBytes, totalBytes)
    })
    await swapIntoPlace(stagingDir, finalDir)
    return finalDir
  } finally {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

export const createDemucsBaseModelEnsurer = (
  params: DemucsBaseModelEnsurerParams
): ((modelName: DemucsBaseModelName) => Promise<string>) => {
  const inFlight = new Map<DemucsBaseModelName, Promise<string>>()
  return (modelName) => {
    const existing = inFlight.get(modelName)
    if (existing) return existing
    const task = ensureModel(params, modelName)
    inFlight.set(modelName, task)
    void task.then(
      () => {
        if (inFlight.get(modelName) === task) inFlight.delete(modelName)
      },
      () => {
        if (inFlight.get(modelName) === task) inFlight.delete(modelName)
      }
    )
    return task
  }
}
