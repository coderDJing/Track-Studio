import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { readIcloudDownloadPercent } from '../../../shared/icloudLibrary'
import {
  audioName,
  boundedPath,
  isLegacyPlaceholder,
  requireLocal,
  type ResidencyReader
} from './files'

export type LocalizeStatus = 'waiting' | 'downloading' | 'ready'
export type LocalizeStatusHandler = (state: LocalizeStatus, percent?: number) => void
export type NativeLocalizeEvent =
  | { kind: 'ready' }
  | { kind: 'status'; state: Exclude<LocalizeStatus, 'ready'>; percent?: number }
  | { kind: 'failed'; error: string }
  | { kind: 'invalid' }

const LOCALIZE_ERRORS = ['offline', 'timeout', 'boundary', 'downloadFailed'] as const

export function parseNativeLocalizeEvent(raw: unknown): NativeLocalizeEvent {
  if (!raw || typeof raw !== 'object') return { kind: 'invalid' }
  const event = raw as { state?: unknown; error?: unknown; percent?: unknown }
  if (event.state === 'ready') return { kind: 'ready' }
  if (event.state === 'waiting' || event.state === 'downloading') {
    const percent = readIcloudDownloadPercent(event.percent)
    return percent == null
      ? { kind: 'status', state: event.state }
      : { kind: 'status', state: event.state, percent }
  }
  if (event.state === 'failed') {
    const error =
      typeof event.error === 'string' &&
      LOCALIZE_ERRORS.includes(event.error as (typeof LOCALIZE_ERRORS)[number])
        ? event.error
        : 'downloadFailed'
    return { kind: 'failed', error }
  }
  return { kind: 'invalid' }
}

export type NativeLocalizer = (
  root: string,
  relative: string,
  signal: AbortSignal,
  status: LocalizeStatusHandler
) => Promise<void>
export const nativeLocalize: NativeLocalizer = (root, relative, signal, status) =>
  new Promise((resolve, reject) => {
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, 'icloud-native/icloud-localize')
      : path.join(app.getAppPath(), 'resources/icloud-native/icloud-localize')
    const child = spawn(executable, ['download', root, relative], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal
    })
    let buffer = '',
      ready = false,
      failure = '',
      stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > 65536) {
        failure = 'downloadFailed'
        child.kill()
        return
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        try {
          const event = parseNativeLocalizeEvent(JSON.parse(line))
          if (event.kind === 'ready') ready = true
          else if (event.kind === 'status') status(event.state, event.percent)
          else if (event.kind === 'failed') failure = event.error
          else {
            failure = 'downloadFailed'
            child.kill()
          }
        } catch {
          failure = 'downloadFailed'
          child.kill()
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096)
    })
    child.on('error', (error) =>
      reject(
        new Error(
          signal.aborted
            ? 'cancelled'
            : (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'nativeUnavailable'
              : 'downloadFailed'
        )
      )
    )
    child.on('close', (code) => {
      void stderr
      if (signal.aborted) reject(new Error('cancelled'))
      else if (ready && code === 0) resolve()
      else reject(new Error(failure || 'downloadFailed'))
    })
  })

export async function localizeSong(options: {
  root: string
  relative: string
  residency: ResidencyReader
  native: NativeLocalizer
  signal: AbortSignal
  status: LocalizeStatusHandler
  timeoutMs?: number
}) {
  const { root, relative, residency, native, signal, status } = options
  if (signal.aborted) throw new Error('cancelled')
  if (!audioName(path.basename(relative))) throw new Error('invalid')
  let candidate: string
  try {
    candidate = await boundedPath(root, relative, residency)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !isLegacyPlaceholder(relative))
      throw error
    const logical = path.join(path.dirname(relative), path.basename(relative).slice(1, -7))
    candidate = await boundedPath(root, logical, residency)
    await requireLocal(candidate, residency)
    return logical
  }
  if (!(await fs.lstat(candidate)).isFile()) throw new Error('invalid')
  try {
    await requireLocal(candidate, residency)
    if (signal.aborted) throw new Error('cancelled')
    return relative
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'download') throw error
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 180000)
  status('waiting')
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error(timedOut ? 'timeout' : 'cancelled')),
        { once: true }
      )
    })
    if (signal.aborted) controller.abort()
    await Promise.race([native(root, relative, controller.signal, status), cancelled])
    if (signal.aborted) throw new Error('cancelled')
    const logical = isLegacyPlaceholder(relative)
      ? path.join(path.dirname(relative), path.basename(relative).slice(1, -7))
      : relative
    const file = await boundedPath(root, logical, residency)
    await requireLocal(file, residency)
    if (!(await fs.lstat(file)).isFile()) throw new Error('invalid')
    status('ready')
    return logical
  } catch (error) {
    if (timedOut) throw new Error('timeout', { cause: error })
    if (signal.aborted) throw new Error('cancelled', { cause: error })
    throw error
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
