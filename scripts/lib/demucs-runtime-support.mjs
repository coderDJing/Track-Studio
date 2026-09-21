import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'

const REMOTE_ASSET_STATE_FILE = '.frkb-runtime-asset.json'
let runtimeDownloadProxyInitialized = false
let runtimeDownloadProxyDispatcher
let runtimeDownloadProxySource = ''
let runtimeFetch = globalThis.fetch

const buildPortableRuntimeCopyOptions = () => ({
  recursive: true,
  force: true,
  ...(process.platform === 'darwin' ? { verbatimSymlinks: true } : {})
})

const formatErrorWithCause = (error, toShortText) => {
  const parts = []
  let current = error
  while (current) {
    const text =
      current instanceof Error
        ? String(current.message || current.name || '').trim()
        : String(current || '').trim()
    if (text && !parts.includes(text)) {
      parts.push(text)
    }
    current = current instanceof Error ? current.cause : null
  }
  return toShortText(parts.join(' <- ') || 'unknown')
}

export const readJsonFileIfExists = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const resolveRemoteAssetStatePath = (runtimeDir) => path.join(runtimeDir, REMOTE_ASSET_STATE_FILE)

const readRemoteAssetState = (runtimeDir) => {
  const state = readJsonFileIfExists(resolveRemoteAssetStatePath(runtimeDir))
  return state && typeof state === 'object' ? state : null
}

const writeRemoteAssetState = (runtimeDir, entry) => {
  const state = {
    platform: String(entry?.platform || '').trim(),
    profile: String(entry?.profile || '').trim(),
    runtimeKey: String(entry?.runtimeKey || '').trim(),
    version: String(entry?.version || '').trim(),
    archiveName: String(entry?.archiveName || '').trim(),
    archiveUrl: String(entry?.archiveUrl || '').trim(),
    archiveSha256: String(entry?.archiveSha256 || '')
      .trim()
      .toLowerCase(),
    installedAt: new Date().toISOString()
  }
  fs.writeFileSync(
    resolveRemoteAssetStatePath(runtimeDir),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8'
  )
}

const isRemoteAssetStateCurrent = (runtimeDir, entry, normalizeRelativePath) => {
  const pythonRelativePath = normalizeRelativePath(entry?.pythonRelativePath || '')
  if (!pythonRelativePath) return false
  const pythonPath = path.join(runtimeDir, pythonRelativePath)
  if (!fs.existsSync(pythonPath)) return false

  const state = readRemoteAssetState(runtimeDir)
  if (!state) return false
  const runtimeKey = String(state?.runtimeKey || '').trim()
  const profile = String(state?.profile || '').trim()
  const version = String(state?.version || '').trim()
  const archiveSha256 = String(state?.archiveSha256 || '')
    .trim()
    .toLowerCase()
  return (
    runtimeKey === String(entry?.runtimeKey || '').trim() &&
    profile === String(entry?.profile || '').trim() &&
    version === String(entry?.version || '').trim() &&
    archiveSha256 ===
      String(entry?.archiveSha256 || '')
        .trim()
        .toLowerCase()
  )
}

const formatByteSize = (value) => {
  const normalizedValue = Number(value) || 0
  if (normalizedValue <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = normalizedValue
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  const precision = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(precision)} ${units[unitIndex]}`
}

const formatDuration = (valueMs) => {
  const normalizedValueMs = Math.max(0, Number(valueMs) || 0)
  const totalSeconds = Math.round(normalizedValueMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const normalizeProxyUrl = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.startsWith('http://') || text.startsWith('https://') ? text : `http://${text}`
}

const resolveProxyUrlFromWindowsRegistry = () => {
  if (process.platform !== 'win32') return ''
  try {
    const enableResult = spawnSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable'
      ],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    )
    const enableOutput = String(enableResult.stdout || '')
    const enableMatch = enableOutput.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/i)
    const proxyEnabled = enableMatch && Number.parseInt(enableMatch[1], 16) === 1
    if (!proxyEnabled) return ''

    const serverResult = spawnSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer'
      ],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    )
    const serverOutput = String(serverResult.stdout || '')
    const serverMatch = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
    const proxyServer = String(serverMatch?.[1] || '').trim()
    if (!proxyServer) return ''
    if (proxyServer.includes('=')) {
      const parts = proxyServer.split(';')
      for (const part of parts) {
        if (part.startsWith('https=')) {
          return normalizeProxyUrl(part.slice(6))
        }
      }
      for (const part of parts) {
        if (part.startsWith('http=')) {
          return normalizeProxyUrl(part.slice(5))
        }
      }
    }
    return normalizeProxyUrl(proxyServer)
  } catch {
    return ''
  }
}

const resolveRuntimeDownloadProxyUrl = () => {
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  if (envProxy) return normalizeProxyUrl(envProxy)
  return resolveProxyUrlFromWindowsRegistry()
}

const ensureRuntimeDownloadProxyInitialized = async () => {
  if (runtimeDownloadProxyInitialized) return
  runtimeDownloadProxyInitialized = true
  const proxyUrl = resolveRuntimeDownloadProxyUrl()
  if (!proxyUrl) return
  let ProxyAgent = null
  try {
    const undiciModule = await import('undici')
    ProxyAgent = undiciModule.ProxyAgent || null
    // A dispatcher must come from the same undici implementation as fetch.
    // Node's built-in fetch uses its bundled undici, which can differ from
    // the project's installed version.
    runtimeFetch = undiciModule.fetch || runtimeFetch
  } catch (error) {
    console.warn(
      `[demucs-runtime-ensure] Proxy support unavailable (undici missing): ${
        error instanceof Error ? error.message : String(error || 'unknown')
      }`
    )
    return
  }
  if (!ProxyAgent) return
  runtimeDownloadProxySource =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
      ? 'env'
      : 'system'
  runtimeDownloadProxyDispatcher = new ProxyAgent(proxyUrl)
  console.log(
    `[demucs-runtime-ensure] Runtime download proxy enabled (${runtimeDownloadProxySource})`
  )
}

export const fetchWithRuntimeProxy = async (url, init = {}) => {
  await ensureRuntimeDownloadProxyInitialized()
  const requestInit = {
    ...init
  }
  if (runtimeDownloadProxyDispatcher) {
    requestInit.dispatcher = runtimeDownloadProxyDispatcher
  }
  return await runtimeFetch(url, requestInit)
}

export const createConsoleDownloadProgressReporter = ({ label, totalBytes }) => {
  const normalizedTotalBytes = Math.max(0, Number(totalBytes) || 0)
  let lastLineLength = 0
  let lastLoggedAt = 0
  let lastLoggedPercent = -1
  let startedAt = 0

  const renderText = (downloadedBytes) => {
    const normalizedDownloadedBytes = Math.max(0, Number(downloadedBytes) || 0)
    if (!startedAt) startedAt = Date.now()
    const elapsedMs = Math.max(1, Date.now() - startedAt)
    const speedBytesPerSecond =
      normalizedDownloadedBytes > 0 ? normalizedDownloadedBytes / (elapsedMs / 1000) : 0
    const speedText = speedBytesPerSecond > 0 ? `${formatByteSize(speedBytesPerSecond)}/s` : '--/s'
    if (normalizedTotalBytes > 0) {
      const percent = Math.min(
        100,
        Math.round((normalizedDownloadedBytes / normalizedTotalBytes) * 100)
      )
      const remainingBytes = Math.max(0, normalizedTotalBytes - normalizedDownloadedBytes)
      const etaMs =
        speedBytesPerSecond > 0 ? Math.round((remainingBytes / speedBytesPerSecond) * 1000) : 0
      return `[demucs-runtime-ensure] Downloading ${label}: ${percent}% (${formatByteSize(normalizedDownloadedBytes)}/${formatByteSize(normalizedTotalBytes)}, ${speedText}, ETA ${formatDuration(etaMs)})`
    }
    return `[demucs-runtime-ensure] Downloading ${label}: ${formatByteSize(normalizedDownloadedBytes)} (${speedText})`
  }

  return ({ downloadedBytes, done = false }) => {
    const normalizedDownloadedBytes = Math.max(0, Number(downloadedBytes) || 0)
    const percent =
      normalizedTotalBytes > 0
        ? Math.min(100, Math.round((normalizedDownloadedBytes / normalizedTotalBytes) * 100))
        : -1
    const now = Date.now()
    const shouldLog =
      done ||
      (normalizedTotalBytes > 0 && percent >= lastLoggedPercent + 5) ||
      now - lastLoggedAt >= 1000

    if (!shouldLog) return

    const text = renderText(normalizedDownloadedBytes)
    if (process.stdout.isTTY) {
      const paddedText =
        text.length < lastLineLength ? `${text}${' '.repeat(lastLineLength - text.length)}` : text
      process.stdout.write(`\r${paddedText}`)
      lastLineLength = paddedText.length
      if (done) {
        process.stdout.write('\n')
      }
    } else {
      console.log(text)
    }

    lastLoggedAt = now
    if (percent >= 0) {
      lastLoggedPercent = percent
    }
  }
}

export const probeRuntimeModules = ({
  pythonPath,
  runtimeDir,
  buildRuntimeEnv,
  runQuiet,
  toShortText
}) => {
  const env = buildRuntimeEnv(runtimeDir)
  const result = runQuiet(
    pythonPath,
    [
      '-c',
      [
        'import json',
        'payload = {"demucs": False, "torch": False, "torchaudio": False, "onnxruntime": False, "torch_directml": False, "onnxruntime_directml_provider": False, "torch_version": "", "xpu_backend": False, "xpu_available": False, "beat_this": False, "beat_this_version": "", "soxr": False, "rotary_embedding_torch": False}',
        'try:',
        '  import demucs',
        '  payload["demucs"] = True',
        'except Exception as exc:',
        '  payload["demucs_error"] = str(exc)',
        'try:',
        '  import torch',
        '  payload["torch"] = True',
        '  payload["torch_version"] = str(getattr(torch, "__version__", ""))',
        '  xpu_api = getattr(torch, "xpu", None)',
        '  payload["xpu_backend"] = bool(xpu_api) and ("+cpu" not in payload["torch_version"].lower())',
        '  try:',
        '    payload["xpu_available"] = bool(payload["xpu_backend"] and xpu_api and xpu_api.is_available())',
        '  except Exception as exc:',
        '    payload["xpu_available_error"] = str(exc)',
        'except Exception as exc:',
        '  payload["torch_error"] = str(exc)',
        'try:',
        '  import torchaudio',
        '  payload["torchaudio"] = True',
        'except Exception as exc:',
        '  payload["torchaudio_error"] = str(exc)',
        'try:',
        '  import onnxruntime as ort',
        '  payload["onnxruntime"] = True',
        '  providers = list(ort.get_available_providers())',
        '  payload["onnxruntime_directml_provider"] = "DmlExecutionProvider" in providers',
        'except Exception as exc:',
        '  payload["onnxruntime_error"] = str(exc)',
        'try:',
        '  import torch_directml',
        '  payload["torch_directml"] = True',
        'except Exception as exc:',
        '  payload["torch_directml_error"] = str(exc)',
        'try:',
        '  import importlib.metadata as _metadata',
        '  import beat_this',
        '  payload["beat_this"] = True',
        '  payload["beat_this_version"] = str(_metadata.version("beat-this"))',
        'except Exception as exc:',
        '  payload["beat_this_error"] = str(exc)',
        'try:',
        '  import soxr',
        '  payload["soxr"] = True',
        'except Exception as exc:',
        '  payload["soxr_error"] = str(exc)',
        'try:',
        '  import rotary_embedding_torch',
        '  payload["rotary_embedding_torch"] = True',
        'except Exception as exc:',
        '  payload["rotary_embedding_torch_error"] = str(exc)',
        'print(json.dumps(payload))'
      ].join('\n')
    ],
    {
      // XPU 版 torch 首次 import 实测约 19s，机器繁忙/杀软扫描时 20s 不够用，
      // 超时会误判运行时损坏并触发整包重下，放宽到 60s。
      timeout: 60_000,
      env
    }
  )
  if (result.status !== 0) {
    return {
      ok: false,
      payload: null,
      error: toShortText(result.stderr || result.stdout || `probe exit ${result.status ?? -1}`)
    }
  }
  const stdout = String(result.stdout || '')
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const lastLine = lines.at(-1) || ''
  if (!lastLine) {
    return {
      ok: false,
      payload: null,
      error: 'probe output empty'
    }
  }
  try {
    const payload = JSON.parse(lastLine)
    return {
      ok: true,
      payload,
      error: ''
    }
  } catch (error) {
    return {
      ok: false,
      payload: null,
      error: toShortText(error instanceof Error ? error.message : String(error || ''))
    }
  }
}

const readRuntimeAssetManifest = async ({
  preferRemoteAssets,
  runtimeAssetManifestUrl,
  toShortText
}) => {
  if (!preferRemoteAssets) return null
  try {
    const response = await fetchWithRuntimeProxy(runtimeAssetManifestUrl, {
      headers: {
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const manifest = await response.json()
    if (!manifest || !Array.isArray(manifest.assets)) {
      throw new Error('manifest assets missing')
    }
    return manifest
  } catch (error) {
    console.warn(
      `[demucs-runtime-ensure] Runtime asset manifest unavailable: ${formatErrorWithCause(
        error,
        toShortText
      )}`
    )
    return null
  }
}

const resolveRuntimeAssetEntry = (manifest, platformArg, profileName) => {
  if (!manifest || !Array.isArray(manifest.assets)) return null
  return (
    manifest.assets.find(
      (item) =>
        String(item?.platform || '').trim() === platformArg &&
        String(item?.profile || '').trim() === profileName
    ) || null
  )
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

const downloadRuntimeAssetArchive = async (entry, archivePath, profileName) => {
  const response = await fetchWithRuntimeProxy(String(entry.archiveUrl || ''))
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  const totalBytes =
    Number(response.headers.get('content-length') || 0) || Number(entry?.archiveSize) || 0
  const reportProgress = createConsoleDownloadProgressReporter({
    label:
      `runtime asset (${profileName}) ` +
      (String(entry?.archiveName || path.basename(archivePath)).trim() ||
        path.basename(archivePath)),
    totalBytes
  })
  const writer = fs.createWriteStream(archivePath)
  let downloadedBytes = 0

  try {
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
  } catch (error) {
    writer.destroy()
    fs.rmSync(archivePath, { force: true })
    throw error
  }
}

const extractRuntimeAssetArchive = ({ archivePath, targetDir, run }) => {
  fs.mkdirSync(targetDir, { recursive: true })
  if (process.platform === 'win32') {
    run('tar.exe', ['-xf', archivePath, '-C', targetDir])
    return
  }
  if (process.platform === 'darwin') {
    run('ditto', ['-x', '-k', archivePath, targetDir])
    return
  }
  run('unzip', ['-q', archivePath, '-d', targetDir])
}

const installRuntimeProfileFromAsset = async ({
  entry,
  profileName,
  runtimeDir,
  runtimeRoot,
  run,
  normalizeSha256,
  normalizeRelativePath,
  computeFileSha256
}) => {
  const archiveName = String(entry?.archiveName || '').trim()
  const archiveSha256 = normalizeSha256(entry?.archiveSha256)
  const archiveSize = Number(entry?.archiveSize) || 0
  const runtimeKey = String(entry?.runtimeKey || '').trim()
  const pythonRelativePath = normalizeRelativePath(entry?.pythonRelativePath || '')
  if (!archiveName || !archiveSha256 || !runtimeKey || !pythonRelativePath) {
    throw new Error(`asset metadata invalid (${profileName})`)
  }

  const downloadCacheDir = path.resolve(runtimeRoot, '.downloads')
  const archivePath = path.join(downloadCacheDir, archiveName)
  const extractRoot = path.join(downloadCacheDir, `extract-${profileName}-${Date.now()}`)
  const extractedRuntimeDir = path.join(extractRoot, runtimeKey)
  const extractedPythonPath = path.join(extractedRuntimeDir, pythonRelativePath)

  console.log(
    `[demucs-runtime-ensure] Downloading runtime asset (${profileName}) from GitHub release`
  )
  await downloadRuntimeAssetArchive(entry, archivePath, profileName)
  const stat = fs.statSync(archivePath)
  if (archiveSize > 0 && stat.size !== archiveSize) {
    throw new Error(
      `runtime asset size mismatch (${profileName}): expected=${archiveSize} actual=${stat.size}`
    )
  }
  console.log(
    `[demucs-runtime-ensure] Verifying runtime asset (${profileName}) ${archiveName} (${formatByteSize(stat.size)})`
  )
  const actualSha256 = await computeFileSha256(archivePath)
  if (actualSha256 !== archiveSha256) {
    throw new Error(
      `runtime asset sha256 mismatch (${profileName}): expected=${archiveSha256} actual=${actualSha256}`
    )
  }

  fs.rmSync(extractRoot, { recursive: true, force: true })
  console.log(`[demucs-runtime-ensure] Extracting runtime asset (${profileName}) -> ${extractRoot}`)
  extractRuntimeAssetArchive({ archivePath, targetDir: extractRoot, run })
  if (!fs.existsSync(extractedPythonPath)) {
    throw new Error(`runtime asset python missing (${profileName}): ${pythonRelativePath}`)
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true })
  try {
    fs.renameSync(extractedRuntimeDir, runtimeDir)
  } catch (error) {
    const errorCode = String(error?.code || '')
      .trim()
      .toUpperCase()
    if (!['EPERM', 'EACCES', 'EXDEV', 'EEXIST', 'ENOTEMPTY'].includes(errorCode)) {
      throw error
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true })
    fs.cpSync(extractedRuntimeDir, runtimeDir, buildPortableRuntimeCopyOptions())
    fs.rmSync(extractedRuntimeDir, { recursive: true, force: true })
  }
  writeRemoteAssetState(runtimeDir, entry)
  fs.rmSync(extractRoot, { recursive: true, force: true })
  console.log(`[demucs-runtime-ensure] Installed runtime asset (${profileName}) -> ${runtimeDir}`)
  return true
}

export const createRemoteRuntimeAssetInstaller = ({
  preferRemoteAssets,
  syncRemoteAssets,
  runtimeAssetManifestUrl,
  platformArg,
  runtimeRoot,
  run,
  normalizeSha256,
  normalizeRelativePath,
  computeFileSha256,
  toShortText
}) => {
  let manifestPromise = null

  const getRuntimeAssetManifest = async () => {
    if (!manifestPromise) {
      manifestPromise = readRuntimeAssetManifest({
        preferRemoteAssets,
        runtimeAssetManifestUrl,
        toShortText
      })
    }
    return manifestPromise
  }

  return async (profileName, runtimeDir) => {
    if (!preferRemoteAssets) return false
    const manifest = await getRuntimeAssetManifest()
    const entry = resolveRuntimeAssetEntry(manifest, platformArg, profileName)
    if (!entry) {
      if (syncRemoteAssets) {
        throw new Error(`runtime asset missing from manifest (${platformArg}/${profileName})`)
      }
      return false
    }
    // 本地资产版本已与远端一致（含 python 存在性检查）时不再重复下载；
    // 此前仅 sync 模式跳过，导致偶发 probe 失败也会整包重下。
    if (isRemoteAssetStateCurrent(runtimeDir, entry, normalizeRelativePath)) {
      console.log(`[demucs-runtime-ensure] Runtime asset already current (${profileName})`)
      return true
    }
    try {
      return await installRuntimeProfileFromAsset({
        entry,
        profileName,
        runtimeDir,
        runtimeRoot,
        run,
        normalizeSha256,
        normalizeRelativePath,
        computeFileSha256
      })
    } catch (error) {
      console.warn(
        `[demucs-runtime-ensure] Runtime asset install failed (${profileName}), fallback to local build: ${formatErrorWithCause(
          error,
          toShortText
        )}`
      )
      return false
    }
  }
}
