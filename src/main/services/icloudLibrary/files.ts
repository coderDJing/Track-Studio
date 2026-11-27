import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import type { IcloudCopyItem, IcloudEntry, IcloudResidency } from '../../../shared/icloudLibrary'
import { SUPPORTED_AUDIO_FORMATS } from '../../../shared/audioFormats'

const execFileAsync = promisify(execFile)
export type ResidencyReader = (file: string) => Promise<IcloudResidency>
export const isInside = (root: string, file: string, allowRoot = true) => {
  const relative = path.relative(path.resolve(root), path.resolve(file))
  return (
    (!relative && allowRoot) ||
    (!!relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}
export const audioName = (name: string) => {
  const logical = name.startsWith('.') && name.endsWith('.icloud') ? name.slice(1, -7) : name
  return SUPPORTED_AUDIO_FORMATS.some(
    (ext) => `.${ext.replace(/^\./, '')}` === path.extname(logical).toLowerCase()
  )
}
export const isLegacyPlaceholder = (file: string) => {
  const name = path.basename(file)
  return name.startsWith('.') && name.endsWith('.icloud')
}
// stat inspects metadata only. Never open, hash, or probe audio during directory browsing.
export const readMacResidency: ResidencyReader = async (file) => {
  if (isLegacyPlaceholder(file)) return 'cloud'
  try {
    const { stdout } = await execFileAsync('/usr/bin/stat', ['-f', '%Sf', file], {
      timeout: 3000,
      maxBuffer: 4096
    })
    // Unknown flag output must fail closed rather than silently downloading a file.
    if (/dataless|offline/i.test(stdout)) return 'cloud'
    if (!stdout.trim() || /unknown|0x/i.test(stdout)) return 'unknown'
    return 'local'
  } catch {
    return 'unknown'
  }
}

// Reject symlinks at every component, not just the final filename. Check dataless
// intermediate directories BEFORE touching descendants (Apple TN3150).
export async function boundedPath(root: string, relative: string, residency?: ResidencyReader) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new Error('boundary')
  }
  const target = path.resolve(root, relative)
  if (!isInside(root, target)) throw new Error('boundary')
  const rootStat = await fs.lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('boundary')
  const canonicalRoot = await fs.realpath(root)
  // A configured root that was replaced with an ancestor symlink is not trusted.
  if (canonicalRoot !== path.resolve(root)) throw new Error('boundary')
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    if (residency && (await residency(current)) !== 'local') throw new Error('download')
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error('boundary')
  }
  if (!isInside(canonicalRoot, await fs.realpath(target))) throw new Error('boundary')
  return target
}
export async function requireLocal(file: string, residency: ResidencyReader) {
  if (isLegacyPlaceholder(file) || (await residency(file)) !== 'local') throw new Error('download')
}

export async function listDirectory(root: string, relative: string, residency: ResidencyReader) {
  const folder = await boundedPath(root, relative, residency)
  await requireLocal(folder, residency)
  const entries: IcloudEntry[] = []
  // Non-recursive by design: opening one folder must never materialize its subfolders.
  const dir = await fs.opendir(folder)
  try {
    for await (const entry of dir) {
      if (entry.isSymbolicLink()) continue
      if (!entry.isDirectory() && (!entry.isFile() || !audioName(entry.name))) continue
      if (entry.name.startsWith('.') && !entry.isDirectory() && !isLegacyPlaceholder(entry.name))
        continue
      entries.push({
        name: isLegacyPlaceholder(entry.name) ? entry.name.slice(1, -7) : entry.name,
        relativePath: path.relative(root, path.join(folder, entry.name)),
        directory: entry.isDirectory(),
        // Per-page residency queries happen below; no content reads.
        residency: isLegacyPlaceholder(entry.name) ? 'cloud' : 'unknown'
      })
      if (entries.length >= 20000) throw new Error('tooMany')
    }
  } finally {
    await dir.close().catch(() => {})
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  return entries
}

async function digest(file: string, residency: ResidencyReader, signal?: AbortSignal) {
  await requireLocal(file, residency)
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  const hash = createHash('sha256')
  try {
    if (!(await handle.stat()).isFile()) throw new Error('invalid')
    await pipeline(
      handle.createReadStream(),
      new Writable({
        write(chunk, _encoding, callback) {
          hash.update(chunk)
          callback()
        }
      }),
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000)
      }
    )
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => {})
  }
}

export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return 'unavailable'
  if (code === 'ENOSPC') return 'space'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'ABORT_ERR' || code === 'ETIMEDOUT') return 'timeout'
  const message = error instanceof Error ? error.message : ''
  return [
    'boundary',
    'download',
    'invalid',
    'busy',
    'tooMany',
    'unsupported',
    'destination',
    'unavailable',
    'cancelled',
    'timeout',
    'offline',
    'downloadFailed',
    'nativeUnavailable',
    'uploading',
    'notUploaded',
    'pinned',
    'playing',
    'notCloud'
  ].includes(message)
    ? message
    : 'failed'
}

// Only the requested songs are read. Same-name equal bytes are skipped; different
// bytes receive a new filename, never an overwrite. No source deletion anywhere.
export async function copySong(options: {
  sourceRoot: string
  sourceRelative: string
  targetRoot: string
  targetRelative: string
  residency: ResidencyReader
  signal?: AbortSignal
}): Promise<IcloudCopyItem> {
  const { sourceRoot, sourceRelative, targetRoot, targetRelative, residency } = options
  let owned: { file: string; ino: number; dev: number } | undefined
  try {
    options.signal?.throwIfAborted()
    const source = await boundedPath(sourceRoot, sourceRelative, residency)
    if (!audioName(path.basename(source))) throw new Error('invalid')
    await requireLocal(source, residency)
    if (!(await fs.lstat(source)).isFile()) throw new Error('invalid')
    const targetDir = await boundedPath(targetRoot, targetRelative, residency)
    await requireLocal(targetDir, residency)
    if (!(await fs.lstat(targetDir)).isDirectory()) throw new Error('invalid')
    const parsed = path.parse(source)
    let sourceDigest: string | undefined
    // Deduplicate differently named, already-local audio only. Never materialize unrelated cloud songs.
    const sourceSize = (await fs.lstat(source)).size
    for (const entry of await fs.readdir(targetDir, { withFileTypes: true })) {
      options.signal?.throwIfAborted()
      if (!entry.isFile() || !audioName(entry.name) || isLegacyPlaceholder(entry.name)) continue
      const candidate = path.join(targetDir, entry.name)
      if (
        (await fs.lstat(candidate)).size !== sourceSize ||
        (await residency(candidate)) !== 'local'
      )
        continue
      try {
        await boundedPath(targetRoot, path.relative(targetRoot, candidate), residency)
        sourceDigest ??= await digest(source, residency, options.signal)
        if ((await digest(candidate, residency, options.signal)) === sourceDigest)
          return { source: sourceRelative, status: 'skipped', destination: candidate }
      } catch {
        options.signal?.throwIfAborted()
        // Cannot prove equality: never overwrite or claim a duplicate.
      }
    }
    for (let suffix = 0; suffix < 1000; suffix++) {
      options.signal?.throwIfAborted()
      // Case-insensitive collisions on macOS are also caught by exclusive open.
      const name = suffix ? `${parsed.name} (${suffix + 1})${parsed.ext}` : parsed.base
      const target = path.join(targetDir, name)
      // Legacy placeholders reserve their logical filename even when that path
      // is absent. Creating it could otherwise replace a remote-only song.
      const legacyTarget = path.join(targetDir, `.${name}.icloud`)
      try {
        await fs.lstat(legacyTarget)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try {
        const existing = await fs.lstat(target)
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('boundary')
        if ((await residency(target)) !== 'local') continue
        sourceDigest ??= await digest(source, residency, options.signal)
        if (
          existing.size === (await fs.lstat(source)).size &&
          (await digest(target, residency, options.signal)) === sourceDigest
        ) {
          return { source: sourceRelative, status: 'skipped', destination: target }
        }
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // Repeat boundary checks immediately before opening. O_NOFOLLOW + wx prevent
      // final-component symlink attacks and replacement of existing songs.
      await boundedPath(targetRoot, targetRelative, residency)
      await boundedPath(sourceRoot, sourceRelative, residency)
      await requireLocal(source, residency)
      const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const output = await fs.open(target, 'wx', 0o600)
        const info = await output.stat()
        owned = { file: target, ino: info.ino, dev: info.dev }
        try {
          await pipeline(input.createReadStream(), output.createWriteStream(), {
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
              : AbortSignal.timeout(120000)
          })
        } finally {
          await output.close().catch(() => {})
        }
      } finally {
        await input.close().catch(() => {})
      }
      owned = undefined
      return { source: sourceRelative, status: 'copied', destination: target }
    }
    throw new Error('tooMany')
  } catch (error) {
    if (owned) {
      const current = await fs.lstat(owned.file).catch(() => null)
      if (current?.ino === owned.ino && current.dev === owned.dev)
        await fs.unlink(owned.file).catch(() => {})
    }
    return {
      source: sourceRelative,
      status: 'failed',
      error: options.signal?.aborted ? 'cancelled' : errorCode(error)
    }
  }
}

// One explicit level only. An unmaterialized directory is an actionable error, never an empty folder.
export async function browseIcloudDirectory(
  root: string,
  relative: string,
  residency: ResidencyReader
) {
  if (
    path.isAbsolute(relative) ||
    relative.includes('\0') ||
    relative.split(/[\\/]/).includes('..') ||
    !isInside(root, path.resolve(root, relative))
  )
    throw new Error('boundary')
  try {
    await fs.lstat(root)
  } catch (error) {
    if (relative === '' && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return { entries: [], missingRoot: true }
    throw error
  }
  return { entries: await listDirectory(root, relative, residency), missingRoot: false }
}
