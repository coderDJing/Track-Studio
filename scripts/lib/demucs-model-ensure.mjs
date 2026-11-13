import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  createConsoleDownloadProgressReporter,
  fetchWithRuntimeProxy,
  formatErrorWithCause
} from './demucs-runtime-support.mjs'

const normalizeModelName = (value) => {
  const modelName = String(value || '').trim()
  if (!modelName) return ''
  return /^[a-zA-Z0-9_-]+$/.test(modelName) ? modelName : ''
}

const normalizeFileName = (value) => {
  const fileName = String(value || '').trim()
  if (!fileName) return ''
  return /^[a-zA-Z0-9._-]+$/.test(fileName) ? fileName : ''
}

const normalizeRelativePath = (value) => {
  const relativePath = String(value || '')
    .trim()
    .replace(/\\/g, '/')
  if (!relativePath) return ''
  if (relativePath.startsWith('/')) return ''
  if (relativePath.includes('..')) return ''
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativePath)) return ''
  return relativePath
}

const normalizeUrl = (value) => {
  const url = String(value || '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return ''
  return url
}

const computeFileSha256 = async (filePath) => {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const waitForWriterDrain = async (writer) =>
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      writer.off('error', onError)
      resolve()
    }
    const onError = (error) => {
      writer.off('drain', onDrain)
      reject(error)
    }
    writer.once('drain', onDrain)
    writer.once('error', onError)
  })

const closeWriter = async (writer) =>
  await new Promise((resolve, reject) => {
    const onFinish = () => {
      writer.off('error', onError)
      resolve()
    }
    const onError = (error) => {
      writer.off('finish', onFinish)
      reject(error)
    }
    writer.once('finish', onFinish)
    writer.once('error', onError)
    writer.end()
  })

const parseModelManifest = (modelManifestPath) => {
  const raw = fs.readFileSync(modelManifestPath, 'utf8')
  const parsed = JSON.parse(raw)
  const modelEntries = Array.isArray(parsed?.models) ? parsed.models : []
  return modelEntries
    .map((entry) => {
      const modelName = normalizeModelName(entry?.name)
      const yaml = typeof entry?.yaml === 'string' ? entry.yaml : ''
      const files = Array.isArray(entry?.files)
        ? entry.files
            .map((file) => ({
              name: normalizeFileName(file?.name),
              url: normalizeUrl(file?.url),
              sha256: String(file?.sha256 || '')
                .trim()
                .toLowerCase()
            }))
            .filter((file) => !!file.name && !!file.url)
        : []
      return {
        name: modelName,
        yaml,
        files
      }
    })
    .filter((entry) => !!entry.name && !!entry.yaml)
}

const resolveRequestedModels = (manifestEntries, modelsArg) => {
  const requestedModels = String(modelsArg || '')
    .split(',')
    .map((item) => normalizeModelName(item))
    .filter(Boolean)
  if (requestedModels.length === 0) {
    return {
      selectedModels: manifestEntries,
      unknownModels: []
    }
  }
  const availableModelSet = new Set(manifestEntries.map((entry) => entry.name))
  const selectedModelSet = new Set(requestedModels)
  return {
    selectedModels: manifestEntries.filter((entry) => selectedModelSet.has(entry.name)),
    unknownModels: requestedModels.filter((item) => !availableModelSet.has(item))
  }
}

const parsePositiveInteger = (value, fallback) => {
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded <= 0) return fallback
  return rounded
}

export const downloadToFile = async ({
  url,
  targetPath,
  timeoutSec,
  retries,
  toShortText,
  fetchImpl = fetchWithRuntimeProxy
}) => {
  const timeoutMs = timeoutSec * 1000
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let writer = null
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow'
      })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }
      const totalBytes = Number(response.headers.get('content-length') || 0)
      const reportProgress = createConsoleDownloadProgressReporter({
        label: `model file ${path.basename(targetPath)}`,
        totalBytes
      })
      writer = fs.createWriteStream(tempPath)
      let downloadedBytes = 0
      for await (const chunk of Readable.fromWeb(response.body)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        downloadedBytes += buffer.byteLength
        if (!writer.write(buffer)) {
          await waitForWriterDrain(writer)
        }
        reportProgress({ downloadedBytes })
      }
      await closeWriter(writer)
      reportProgress({ downloadedBytes, done: true })
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true })
      }
      fs.renameSync(tempPath, targetPath)
      clearTimeout(timer)
      return
    } catch (error) {
      clearTimeout(timer)
      try {
        writer?.destroy()
      } catch {}
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
      lastError = error
      if (attempt < retries) {
        console.warn(
          `[demucs-runtime-ensure] Download retry (${attempt}/${retries}): ${path.basename(targetPath)} -> ${formatErrorWithCause(
            error,
            toShortText
          )}`
        )
      }
    }
  }
  const reason = formatErrorWithCause(lastError, toShortText)
  throw new Error(`[demucs-runtime-ensure] Download failed: ${url} (${reason || 'unknown'})`)
}

const ensureModelYaml = (modelsDir, modelEntry) => {
  const yamlPath = path.resolve(modelsDir, `${modelEntry.name}.yaml`)
  const expectedYaml = String(modelEntry.yaml || '')
  const currentYaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : ''
  if (currentYaml === expectedYaml) return
  fs.writeFileSync(yamlPath, expectedYaml, 'utf8')
}

const ensureModelFile = async ({
  modelsDir,
  modelName,
  modelFile,
  retries,
  timeoutSec,
  toShortText
}) => {
  const relativePath = normalizeRelativePath(modelFile.name)
  if (!relativePath) {
    throw new Error(
      `[demucs-runtime-ensure] Invalid model file path: ${modelFile.name || '<empty>'}`
    )
  }

  const targetPath = path.resolve(modelsDir, relativePath)
  const relativeToModelsDir = path.relative(modelsDir, targetPath)
  if (
    !relativeToModelsDir ||
    relativeToModelsDir.startsWith('..') ||
    path.isAbsolute(relativeToModelsDir)
  ) {
    throw new Error(`[demucs-runtime-ensure] Illegal model file path: ${modelFile.name}`)
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  let needsDownload = !fs.existsSync(targetPath)
  if (!needsDownload && modelFile.sha256) {
    const existingHash = await computeFileSha256(targetPath)
    if (existingHash !== modelFile.sha256) {
      console.warn(
        `[demucs-runtime-ensure] Hash mismatch, re-downloading: ${modelName}/${relativePath}`
      )
      needsDownload = true
    }
  }

  if (needsDownload) {
    console.log(`[demucs-runtime-ensure] Fetching model file: ${modelName}/${relativePath}`)
    await downloadToFile({
      url: modelFile.url,
      targetPath,
      timeoutSec,
      retries,
      toShortText
    })
  }

  if (modelFile.sha256) {
    const downloadedHash = await computeFileSha256(targetPath)
    if (downloadedHash !== modelFile.sha256) {
      throw new Error(
        `[demucs-runtime-ensure] SHA256 mismatch after download: ${modelName}/${relativePath}`
      )
    }
  }
}

export const ensureDemucsModels = async ({
  runtimeRoot,
  modelManifestPath,
  modelsArg,
  modelRetriesArg,
  modelTimeoutSecArg,
  toShortText
}) => {
  const modelEntries = parseModelManifest(modelManifestPath)
  if (modelEntries.length === 0) {
    console.log('[demucs-runtime-ensure] No models declared, skip')
    return
  }

  const { selectedModels, unknownModels } = resolveRequestedModels(modelEntries, modelsArg)
  if (unknownModels.length > 0) {
    console.warn(`[demucs-runtime-ensure] Unknown models ignored: ${unknownModels.join(', ')}`)
  }
  if (selectedModels.length === 0) {
    console.log('[demucs-runtime-ensure] No matching models selected, skip')
    return
  }

  const retries = parsePositiveInteger(modelRetriesArg, 3)
  const timeoutSec = parsePositiveInteger(modelTimeoutSecArg, 600)
  const modelsDir = path.resolve(runtimeRoot, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })

  for (const modelEntry of selectedModels) {
    ensureModelYaml(modelsDir, modelEntry)
    for (const modelFile of modelEntry.files) {
      await ensureModelFile({
        modelsDir,
        modelName: modelEntry.name,
        modelFile,
        retries,
        timeoutSec,
        toShortText
      })
    }
  }
}
