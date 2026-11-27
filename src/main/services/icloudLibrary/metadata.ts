import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  audioName,
  boundedPath,
  isLegacyPlaceholder,
  requireLocal,
  type ResidencyReader
} from './files'
import type { IcloudMetadataItem, IcloudSongMetadata } from '../../../shared/icloudLibrary'
const run = promisify(execFile)
export type IcloudMetadataReader = (
  root: string,
  paths: string[],
  signal: AbortSignal,
  rootIdentity: string
) => Promise<IcloudMetadataItem[]>
const runNativeMetadata = async (
  root: string,
  paths: string[],
  signal: AbortSignal,
  rootIdentity: string,
  cover = false
) => {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'icloud-native/icloud-localize')
    : path.join(app.getAppPath(), 'resources/icloud-native/icloud-localize')
  const worker = path.join(app.getAppPath(), 'out/main/workers/icloudMetadataWorker.js')
  const { stdout } = await run(
    executable,
    [
      'metadata',
      process.execPath,
      worker,
      root,
      JSON.stringify(cover ? { paths, cover: true } : paths),
      rootIdentity
    ],
    { signal, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
  )
  const result: unknown = JSON.parse(stdout)
  if (!Array.isArray(result) || result.length > 16) throw new Error('invalid')
  return result as IcloudMetadataItem[]
}
export const nativeMetadataReader: IcloudMetadataReader = (root, paths, signal, identity) =>
  runNativeMetadata(root, paths, signal, identity)
export const nativeCoverReader: IcloudMetadataReader = (root, paths, signal, identity) =>
  runNativeMetadata(root, paths, signal, identity, true)
export function createIcloudMetadataCache(
  residency: ResidencyReader,
  reader: IcloudMetadataReader = nativeMetadataReader,
  maxEntries = 1024
) {
  const cache = new Map<string, { signature: string; metadata: IcloudSongMetadata }>()
  let active = 0
  const signature = (info: Awaited<ReturnType<typeof fs.lstat>>) =>
    `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const stamp = async (root: string, relative: string) => {
    if (!audioName(relative) || isLegacyPlaceholder(relative)) throw new Error('invalid')
    const file = await boundedPath(root, relative, residency)
    await requireLocal(file, residency)
    const info = await fs.lstat(file)
    if (!info.isFile()) throw new Error('invalid')
    return signature(info)
  }
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
      const results = new Map<string, IcloudMetadataItem>(),
        pending: string[] = [],
        stamps = new Map<string, string>()
      for (const relative of paths) {
        if (signal.aborted) throw new Error('cancelled')
        try {
          const value = await stamp(root, relative),
            cached = cache.get(`${scope}:${relative}`)
          stamps.set(relative, value)
          if (cached?.signature === value)
            results.set(relative, { relativePath: relative, metadata: cached.metadata })
          else pending.push(relative)
        } catch {
          results.set(relative, { relativePath: relative })
        }
      }
      if (pending.length) {
        const data = await reader(root, pending, signal, rootIdentity)
        for (const item of data) {
          if (!pending.includes(item.relativePath) || !item.metadata || signal.aborted) continue
          try {
            if ((await stamp(root, item.relativePath)) !== stamps.get(item.relativePath)) continue
            if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!)
            cache.set(`${scope}:${item.relativePath}`, {
              signature: stamps.get(item.relativePath)!,
              metadata: item.metadata
            })
            results.set(item.relativePath, item)
          } catch {
            /* File evicted or changed while reading: discard, never download. */
          }
        }
      }
      return paths.map((relativePath) => results.get(relativePath) || { relativePath })
    } finally {
      active--
    }
  }
  return { read, clear: () => cache.clear() }
}
