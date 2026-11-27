import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { audioName, boundedPath, isLegacyPlaceholder, type ResidencyReader } from './files'

export type EvictLocalResult = {
  relative: string
  status: 'evicted' | 'skipped' | 'failed'
  error?: string
}

const EVICT_ERRORS = new Set([
  'uploading',
  'notUploaded',
  'pinned',
  'playing',
  'notCloud',
  'failed',
  'boundary',
  'offline',
  'timeout',
  'nativeUnavailable',
  'invalid',
  'unavailable'
])

const nativeExecutable = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'icloud-native/icloud-localize')
    : path.join(app.getAppPath(), 'resources/icloud-native/icloud-localize')

const knownError = (value: string) => (EVICT_ERRORS.has(value) ? value : 'failed')

/** Ask the system to drop the local copy. The helper never unlinks. */
export function nativeEvict(root: string, relative: string): Promise<'evicted' | 'skipped'> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(nativeExecutable(), ['evict', root, relative], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(20000)
      })
    } catch (error) {
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'nativeUnavailable' : 'failed'
        )
      )
      return
    }
    let buffer = ''
    let outcome: 'evicted' | 'skipped' | '' = ''
    let failure = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > 65536) {
        failure = 'failed'
        child.kill()
        return
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { state?: unknown; error?: unknown }
          if (event.state === 'ready') outcome = 'evicted'
          else if (event.state === 'skipped') outcome = 'skipped'
          else if (event.state === 'failed')
            failure = knownError(typeof event.error === 'string' ? event.error : 'failed')
          else failure = 'failed'
        } catch {
          failure = 'failed'
        }
      }
    })
    child.once('error', (error) => {
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'nativeUnavailable' : 'timeout'
        )
      )
    })
    child.once('close', (code) => {
      if (failure) {
        reject(new Error(failure))
        return
      }
      if (code === 0 && outcome) {
        resolve(outcome)
        return
      }
      reject(new Error('failed'))
    })
  })
}

const placeholderFor = (file: string) =>
  path.join(path.dirname(file), `.${path.basename(file)}.icloud`)

/**
 * Remove local copies of the given songs only.
 * A still-local file after the system call is a failure. A missing file with no
 * cloud placeholder is also a failure: this path never deletes the item itself.
 */
export async function evictLocalCopies(options: {
  root: string
  relatives: string[]
  residency: ResidencyReader
  native: (root: string, relative: string) => Promise<'evicted' | 'skipped'>
  playing: (relative: string) => boolean
}): Promise<EvictLocalResult[]> {
  const results: EvictLocalResult[] = []
  for (const relative of options.relatives) {
    try {
      if (isLegacyPlaceholder(relative)) {
        results.push({ relative, status: 'skipped' })
        continue
      }
      const file = await boundedPath(options.root, relative, options.residency)
      if (!audioName(path.basename(file))) throw new Error('invalid')
      if (options.playing(relative)) throw new Error('playing')
      if ((await options.residency(file)) !== 'local') {
        results.push({ relative, status: 'skipped' })
        continue
      }
      const outcome = await options.native(options.root, relative)
      if (outcome === 'skipped') {
        results.push({ relative, status: 'skipped' })
        continue
      }
      const stat = await fs.lstat(file).catch(() => null)
      if (!stat) {
        const placeholder = await fs.lstat(placeholderFor(file)).catch(() => null)
        if (!placeholder) throw new Error('failed')
        results.push({ relative, status: 'evicted' })
        continue
      }
      if ((await options.residency(file)) === 'local') throw new Error('failed')
      results.push({ relative, status: 'evicted' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed'
      results.push({ relative, status: 'failed', error: knownError(message) })
    }
  }
  return results
}
