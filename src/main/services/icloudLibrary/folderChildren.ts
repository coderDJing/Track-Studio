import fs from 'node:fs/promises'
import path from 'node:path'
import { boundedPath, requireLocal, type ResidencyReader } from './files'
import type { IcloudEntry } from '../../../shared/icloudLibrary'

type Presence = boolean | 'unknown'
const signature = (info: Awaited<ReturnType<typeof fs.lstat>>) =>
  `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`

// One metadata-only lookahead, never recursion or audio reads. Incomplete/failed
// inspections stay unknown. A small signature-bound cache avoids rescanning huge
// unchanged directories; every reuse still checks residency and path boundaries.
export function createFolderChildInspector(
  options: {
    maxEntries?: number
    maxTotalEntries?: number
    maxFolders?: number
    maxMilliseconds?: number
  } = {}
) {
  const cache = new Map<string, { signature: string; result: Presence; expires: number }>()
  async function inspect(root: string, entries: IcloudEntry[], residency: ResidencyReader) {
    let next = 0,
      folders = 0,
      total = 0
    const deadline = Date.now() + (options.maxMilliseconds ?? 2500)
    const takeEntry = () => ++total <= (options.maxTotalEntries ?? 16384) && Date.now() <= deadline
    const probe = async (entry: IcloudEntry): Promise<Presence> => {
      try {
        const folder = await boundedPath(root, entry.relativePath, residency)
        await requireLocal(folder, residency)
        const before = await fs.lstat(folder)
        if (!before.isDirectory()) return 'unknown'
        const key = `${root}\0${entry.relativePath}`,
          stamp = signature(before)
        const previous = cache.get(key)
        if (previous?.signature === stamp && previous.expires > Date.now()) return previous.result
        let result: Presence = false,
          seen = 0
        const directory = await fs.opendir(folder)
        try {
          for await (const child of directory) {
            if (++seen > (options.maxEntries ?? 4096) || !takeEntry()) {
              result = 'unknown'
              break
            }
            if (child.isSymbolicLink() || !child.isDirectory()) continue
            const candidate = await boundedPath(
              root,
              path.join(entry.relativePath, child.name),
              residency
            )
            if ((await fs.lstat(candidate)).isDirectory()) {
              result = true
              break
            }
          }
        } finally {
          await directory.close().catch(() => {})
        }
        const after = await fs.lstat(folder)
        if (signature(after) !== stamp || after.isSymbolicLink()) return 'unknown'
        // Errors are not cached. Bounded scans and definitive results are cached
        // briefly, keyed to directory identity + modification/change timestamps.
        if (cache.size >= 512) cache.delete(cache.keys().next().value!)
        cache.set(key, { signature: stamp, result, expires: Date.now() + 5000 })
        return result
      } catch {
        return 'unknown'
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (next < entries.length) {
          const entry = entries[next++]
          entry.hasChildren = 'unknown'
          if (
            entry.residency !== 'local' ||
            ++folders > (options.maxFolders ?? 256) ||
            Date.now() > deadline
          )
            continue
          entry.hasChildren = await probe(entry)
        }
      })
    )
  }
  return { inspect, clear: () => cache.clear() }
}
