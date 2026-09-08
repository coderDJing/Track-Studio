import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { log } from '../../log'
import { registerChildProcess, terminateChildProcess } from '../childProcessRegistry'
import type {
  RekordboxDesktopHelperError,
  RekordboxDesktopHelperProgressPayload,
  RekordboxDesktopLibraryErrorCode
} from './types'

const ENV_RUNTIME_ROOT = 'FRKB_REKORDBOX_DESKTOP_RUNTIME_ROOT'
const ENV_PYTHON = 'FRKB_REKORDBOX_DESKTOP_PYTHON'
const ENV_BRIDGE = 'FRKB_REKORDBOX_DESKTOP_BRIDGE'

type RekordboxDesktopHelperCommand =
  | 'probe'
  | 'probe-write'
  | 'load-tree'
  | 'load-playlist-tracks'
  | 'create-empty-playlist'
  | 'move-playlist'
  | 'rename-playlist'
  | 'delete-playlist'
  | 'remove-playlist-tracks'
  | 'reorder-playlist-tracks'
  | 'create-playlist'
  | 'append-playlist'
  | 'create-folder'

type RekordboxDesktopHelperRequest<TPayload> = {
  command: RekordboxDesktopHelperCommand
  payload: TPayload
}

type RekordboxDesktopHelperResponse<TResult> =
  | {
      ok: true
      result: TResult
    }
  | {
      ok: false
      error?: RekordboxDesktopHelperError
    }

type RekordboxDesktopHelperProgressEvent = {
  event?: string
  payload?: RekordboxDesktopHelperProgressPayload
}

type RunRekordboxDesktopHelperOptions = {
  onProgress?: (payload: RekordboxDesktopHelperProgressPayload) => void
  timeoutMs?: number
}

type ResolvedPythonCommand = {
  command: string
  args: string[]
  runtimeSource: 'bundled' | 'env-python' | 'dev-launcher'
}

const BENIGN_STDERR_PATTERNS = [/pyrekordbox\.db6\.database:WARNING\s+-\s+Rekordbox is running!/i]

const sanitizeHelperStderr = (stderr: string) =>
  String(stderr || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n')

const normalizeFsPath = (value: string) => {
  const normalized = String(value || '').trim()
  return normalized ? path.normalize(normalized) : ''
}

const resolveDesktopRuntimePlatformDir = () => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return ''
}

const resolveDevAppRootCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()

  const addCandidate = (candidate: string) => {
    const normalized = normalizeFsPath(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  addCandidate(process.cwd())
  try {
    addCandidate(app.getAppPath())
  } catch {}
  addCandidate(path.resolve(__dirname, '../../..'))
  addCandidate(path.resolve(__dirname, '../../../..'))

  return candidates
}

const resolveDefaultRuntimeRootPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'rekordboxDesktopRuntime')
  }
  const appRootCandidates = resolveDevAppRootCandidates()
  for (const appRoot of appRootCandidates) {
    const runtimeRoot = path.join(appRoot, 'vendor', 'rekordbox-desktop-runtime')
    if (fs.existsSync(runtimeRoot)) return runtimeRoot
  }
  return path.join(appRootCandidates[0] || process.cwd(), 'vendor', 'rekordbox-desktop-runtime')
}

const resolveRuntimeRootCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidate: string) => {
    const normalized = normalizeFsPath(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  addCandidate(process.env[ENV_RUNTIME_ROOT] || '')
  addCandidate(resolveDefaultRuntimeRootPath())
  return candidates
}

const resolveBundledRuntimeDir = () => {
  const platformDir = resolveDesktopRuntimePlatformDir()
  if (!platformDir) return ''
  for (const rootPath of resolveRuntimeRootCandidates()) {
    const runtimeDir = path.join(rootPath, platformDir, 'python')
    if (fs.existsSync(runtimeDir)) return runtimeDir
  }
  return path.join(resolveDefaultRuntimeRootPath(), platformDir, 'python')
}

const resolveBundledPythonPath = (runtimeDir: string) => {
  if (!runtimeDir) return ''
  if (process.platform === 'win32') {
    const rootPython = path.join(runtimeDir, 'python.exe')
    if (fs.existsSync(rootPython)) return rootPython
    const scriptsPython = path.join(runtimeDir, 'Scripts', 'python.exe')
    if (fs.existsSync(scriptsPython)) return scriptsPython
    return rootPython
  }
  const binPython3 = path.join(runtimeDir, 'bin', 'python3')
  if (fs.existsSync(binPython3)) return binPython3
  const binPython = path.join(runtimeDir, 'bin', 'python')
  if (fs.existsSync(binPython)) return binPython
  return binPython3
}

const resolveBridgeScriptCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidate: string) => {
    const normalized = normalizeFsPath(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  addCandidate(process.env[ENV_BRIDGE] || '')
  if (app.isPackaged) {
    addCandidate(
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'resources',
        'rekordboxDesktopLibrary',
        'bridge.py'
      )
    )
    addCandidate(path.join(process.resourcesPath, 'rekordboxDesktopLibrary', 'bridge.py'))
  } else {
    for (const appRoot of resolveDevAppRootCandidates()) {
      addCandidate(path.join(appRoot, 'resources', 'rekordboxDesktopLibrary', 'bridge.py'))
    }
  }
  return candidates
}

const resolveBridgeScriptPath = () => {
  const candidates = resolveBridgeScriptCandidates()
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0] || ''
}

const resolvePythonCommand = (): ResolvedPythonCommand | null => {
  const envPython = normalizeFsPath(process.env[ENV_PYTHON] || '')
  if (envPython && fs.existsSync(envPython)) {
    return {
      command: envPython,
      args: [],
      runtimeSource: 'env-python'
    }
  }

  const bundledRuntimeDir = resolveBundledRuntimeDir()
  const bundledPythonPath = resolveBundledPythonPath(bundledRuntimeDir)
  if (bundledPythonPath && fs.existsSync(bundledPythonPath)) {
    return {
      command: bundledPythonPath,
      args: [],
      runtimeSource: 'bundled'
    }
  }

  if (!app.isPackaged) {
    if (process.platform === 'win32') {
      return {
        command: 'py',
        args: ['-3.11'],
        runtimeSource: 'dev-launcher'
      }
    }
    return {
      command: 'python3',
      args: [],
      runtimeSource: 'dev-launcher'
    }
  }

  return null
}

const createHelperError = (
  message: string,
  code: RekordboxDesktopLibraryErrorCode
): Error & RekordboxDesktopHelperError => {
  const error = new Error(message) as Error & RekordboxDesktopHelperError
  error.name = 'RekordboxDesktopLibraryError'
  error.code = code
  return error
}

const HELPER_IDLE_TIMEOUT_MS = 60_000
const HELPER_PROBE_TIMEOUT_MS = 15_000
const HELPER_COMMAND_TIMEOUT_MS = 120_000

const resolveHelperCommandTimeout = (
  command: RekordboxDesktopHelperCommand,
  configuredTimeoutMs?: number
) => {
  if (Number.isFinite(configuredTimeoutMs) && Number(configuredTimeoutMs) > 0) {
    return Math.max(1_000, Math.round(Number(configuredTimeoutMs)))
  }
  return command === 'probe' || command === 'probe-write'
    ? HELPER_PROBE_TIMEOUT_MS
    : HELPER_COMMAND_TIMEOUT_MS
}

type HelperWaiter<TResult> = {
  command: RekordboxDesktopHelperCommand
  onProgress?: (payload: RekordboxDesktopHelperProgressPayload) => void
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

class RekordboxDesktopHelperSession {
  private child: childProcess.ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private stderr = ''
  private waiter: HelperWaiter<unknown> | null = null
  private mutex = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private unregisterChild: (() => void) | null = null

  async run<TResult, TPayload extends Record<string, unknown>>(
    command: RekordboxDesktopHelperCommand,
    payload: TPayload,
    options?: RunRekordboxDesktopHelperOptions
  ): Promise<TResult> {
    const previous = this.mutex
    let releaseMutex = () => {}
    this.mutex = new Promise<void>((resolve) => {
      releaseMutex = resolve
    })
    await previous
    this.clearIdle()
    try {
      return await this.runExclusive(command, payload, options)
    } finally {
      this.scheduleIdle()
      releaseMutex()
    }
  }

  private scheduleIdle() {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      if (this.waiter) return
      this.destroyChild()
    }, HELPER_IDLE_TIMEOUT_MS)
    this.idleTimer.unref?.()
  }

  private clearIdle() {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private destroyChild() {
    const child = this.child
    this.child = null
    this.stdoutBuffer = ''
    this.stderr = ''
    this.unregisterChild?.()
    this.unregisterChild = null
    if (!child) return
    terminateChildProcess(child, 'rekordbox-desktop:persistent')
  }

  private failWaiter(error: Error) {
    const waiter = this.waiter
    this.waiter = null
    waiter?.reject(error)
  }

  private ensureChild() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child
    }

    const pythonCommand = resolvePythonCommand()
    if (!pythonCommand) {
      throw createHelperError(
        '未找到 Rekordbox Desktop Runtime 的 Python 运行时。',
        'PYTHON_RUNTIME_MISSING'
      )
    }

    const bridgePath = resolveBridgeScriptPath()
    if (!bridgePath || !fs.existsSync(bridgePath)) {
      throw createHelperError(
        `未找到 Rekordbox Desktop bridge: ${bridgePath || '<empty>'}`,
        'BRIDGE_SCRIPT_MISSING'
      )
    }

    this.destroyChild()
    const child = childProcess.spawn(
      pythonCommand.command,
      [...pythonCommand.args, bridgePath, '--persistent'],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1'
        }
      }
    )
    this.child = child
    this.unregisterChild = registerChildProcess(child, 'rekordbox-desktop:persistent')

    child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString()
      this.consumeStdoutBuffer()
    })
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString()
    })
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.failWaiter(
        createHelperError(
          `启动 Rekordbox Desktop helper 失败: ${error instanceof Error ? error.message : String(error || '')}`,
          'HELPER_RUNTIME_ERROR'
        )
      )
    })
    child.on('close', (code) => {
      if (this.child === child) {
        this.child = null
        this.unregisterChild = null
      }
      const sanitizedStderr = sanitizeHelperStderr(this.stderr.trim())
      this.stderr = ''
      this.stdoutBuffer = ''
      if (!this.waiter) return
      this.failWaiter(
        createHelperError(
          sanitizedStderr || `Rekordbox Desktop helper 意外退出（exit=${String(code ?? '')}）。`,
          'HELPER_PROTOCOL_ERROR'
        )
      )
    })
    return child
  }

  private consumeStdoutBuffer() {
    const normalizedBuffer = this.stdoutBuffer.replace(/\r\n/g, '\n')
    const segments = normalizedBuffer.split('\n')
    this.stdoutBuffer = segments.pop() || ''
    for (const segment of segments) {
      const trimmed = String(segment || '').trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as unknown
        this.handleParsedStdoutObject(parsed, trimmed)
      } catch {
        this.stdoutBuffer = trimmed
        return
      }
    }
  }

  private handleParsedStdoutObject(value: unknown, rawLine: string) {
    if (!value || typeof value !== 'object') return
    const waiter = this.waiter
    const maybeEvent = value as RekordboxDesktopHelperProgressEvent
    if (maybeEvent.event === 'progress' && maybeEvent.payload && waiter?.onProgress) {
      try {
        waiter.onProgress(maybeEvent.payload)
      } catch (error) {
        log.error('[rekordbox-desktop-library] helper progress callback failed', {
          command: waiter.command,
          error
        })
      }
      return
    }

    const maybeResponse = value as RekordboxDesktopHelperResponse<unknown>
    if (typeof maybeResponse.ok !== 'boolean') {
      log.error('[rekordbox-desktop-library] helper returned unexpected event', {
        command: waiter?.command,
        stdout: rawLine
      })
      return
    }
    if (!waiter) return
    this.waiter = null
    if (!maybeResponse.ok) {
      const helperError = maybeResponse.error
      waiter.reject(
        createHelperError(
          helperError?.message ||
            sanitizeHelperStderr(this.stderr.trim()) ||
            'Rekordbox Desktop helper 执行失败。',
          (helperError?.code || 'HELPER_RUNTIME_ERROR') as RekordboxDesktopLibraryErrorCode
        )
      )
      return
    }
    waiter.resolve(maybeResponse.result)
  }

  private runExclusive<TResult, TPayload extends Record<string, unknown>>(
    command: RekordboxDesktopHelperCommand,
    payload: TPayload,
    options?: RunRekordboxDesktopHelperOptions
  ): Promise<TResult> {
    const child = this.ensureChild()
    this.stderr = ''
    const request: RekordboxDesktopHelperRequest<TPayload> = { command, payload }
    return new Promise<TResult>((resolve, reject) => {
      const timeoutMs = resolveHelperCommandTimeout(command, options?.timeoutMs)
      const timeout = setTimeout(() => {
        if (!this.waiter || this.waiter.command !== command) return
        this.waiter = null
        reject(
          createHelperError(
            `Rekordbox Desktop helper 执行超时（command=${command}, timeoutMs=${timeoutMs}）。`,
            'HELPER_RUNTIME_ERROR'
          )
        )
        this.destroyChild()
      }, timeoutMs)
      timeout.unref?.()
      const clearCommandTimeout = () => clearTimeout(timeout)
      this.waiter = {
        command,
        onProgress: options?.onProgress,
        resolve: ((value: unknown) => {
          clearCommandTimeout()
          resolve(value as TResult)
        }) as (value: unknown) => void,
        reject: (error) => {
          clearCommandTimeout()
          reject(error)
        }
      }
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`)
      } catch (error) {
        this.waiter = null
        clearCommandTimeout()
        reject(
          createHelperError(
            `写入 Rekordbox Desktop helper 失败: ${error instanceof Error ? error.message : String(error || '')}`,
            'HELPER_RUNTIME_ERROR'
          )
        )
      }
    })
  }
}

const helperSession = new RekordboxDesktopHelperSession()

export async function runRekordboxDesktopHelper<TResult, TPayload extends Record<string, unknown>>(
  command: RekordboxDesktopHelperCommand,
  payload: TPayload,
  options?: RunRekordboxDesktopHelperOptions
): Promise<TResult> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw createHelperError('当前平台暂不支持 Rekordbox 本机库。', 'UNSUPPORTED_PLATFORM')
  }
  return await helperSession.run(command, payload, options)
}
