import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExternalLibrarySourceProbe } from '../../../shared/externalLibrary'

const pathExists = async (targetPath: string) => {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

const uniquePaths = (values: string[]) =>
  Array.from(new Set(values.map((value) => path.normalize(value)).filter(Boolean)))

const listWindowsDriveRoots = () => {
  if (process.platform !== 'win32') return []
  // 只探测明确的 Serato 文件路径，不为定时图标刷新启动 PowerShell/CIM 进程。
  return Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:${path.sep}`)
}

const findSeratoRoot = async () => {
  const localCandidates = uniquePaths([
    path.join(app.getPath('music'), '_Serato_'),
    path.join(app.getPath('home'), 'Music', '_Serato_'),
    path.join(app.getPath('home'), '_Serato_')
  ])
  const findAvailable = async (candidates: string[]) => {
    const available = await Promise.all(
      candidates.map(async (candidate) => {
        const [hasDatabase, hasSubcrates] = await Promise.all([
          pathExists(path.join(candidate, 'database V2')),
          pathExists(path.join(candidate, 'Subcrates'))
        ])
        return hasDatabase || hasSubcrates
      })
    )
    return candidates.find((_candidate, index) => available[index]) || ''
  }
  const localRoot = await findAvailable(localCandidates)
  if (localRoot) return localRoot
  return findAvailable(listWindowsDriveRoots().map((root) => path.join(root, '_Serato_')))
}

const findTraktorCollection = async () => {
  const nativeInstrumentsRoots = uniquePaths([
    path.join(app.getPath('documents'), 'Native Instruments'),
    path.join(app.getPath('home'), 'Documents', 'Native Instruments')
  ])
  const candidates: Array<{ filePath: string; modifiedAt: number }> = []
  for (const root of nativeInstrumentsRoots) {
    let entries
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Traktor(?:\s|$)/i.test(entry.name)) continue
      const filePath = path.join(root, entry.name, 'collection.nml')
      try {
        const stat = await fs.stat(filePath)
        candidates.push({ filePath, modifiedAt: stat.mtimeMs })
      } catch {}
    }
  }
  return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.filePath || ''
}

const probeSources = async (): Promise<ExternalLibrarySourceProbe[]> => {
  const [seratoRoot, traktorCollection] = await Promise.all([
    findSeratoRoot(),
    findTraktorCollection()
  ])
  return [
    {
      kind: 'serato',
      available: Boolean(seratoRoot),
      sourceKey: seratoRoot ? `serato:${seratoRoot.toLocaleLowerCase()}` : 'serato',
      sourcePath: seratoRoot,
      displayName: 'Serato'
    },
    {
      kind: 'traktor',
      available: Boolean(traktorCollection),
      sourceKey: traktorCollection ? `traktor:${traktorCollection.toLocaleLowerCase()}` : 'traktor',
      sourcePath: traktorCollection,
      displayName: 'Traktor'
    }
  ]
}

let probeInflight: Promise<ExternalLibrarySourceProbe[]> | null = null
export const probeExternalLibraries = (): Promise<ExternalLibrarySourceProbe[]> => {
  if (probeInflight) return probeInflight
  probeInflight = probeSources().finally(() => {
    probeInflight = null
  })
  return probeInflight
}

export const __externalLibraryDetectTestUtils = {
  findSeratoRoot,
  findTraktorCollection
}
