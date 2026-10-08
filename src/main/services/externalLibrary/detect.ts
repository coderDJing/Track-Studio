import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExternalLibrarySourceProbe } from '../../../shared/externalLibrary'
import { readTraktorConfiguredRoots } from './traktorConfig'
import { getSeratoV4LibraryDir, isSeratoV4Library } from './seratoV4'

const pathExists = async (targetPath: string) => {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

const uniquePaths = (values: string[]) => {
  const seen = new Set<string>()
  return values
    .map((value) => path.normalize(value.trim()))
    .filter((value) => {
      if (!value || value === '.') return false
      const key = process.platform === 'win32' ? value.toLocaleLowerCase() : value
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
const sourcePathKey = (value: string) =>
  process.platform === 'win32' ? value.toLocaleLowerCase() : value

const listMountedVolumeRoots = async (): Promise<string[]> => {
  if (process.platform === 'win32') {
    // Probe only the known Serato directory at each drive root; do not traverse drives.
    return Array.from(
      { length: 26 },
      (_, index) => `${String.fromCharCode(65 + index)}:${path.sep}`
    )
  }
  if (process.platform !== 'darwin') return []
  try {
    const entries = await fs.readdir('/Volumes', { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join('/Volumes', entry.name))
  } catch {
    return []
  }
}

const findSeratoRoots = async (): Promise<string[]> => {
  const currentLibrary = getSeratoV4LibraryDir()
  const localCandidates = [
    path.join(app.getPath('music'), '_Serato_'),
    path.join(app.getPath('home'), 'Music', '_Serato_'),
    path.join(app.getPath('home'), '_Serato_')
  ]
  const volumeRoots = await listMountedVolumeRoots()
  const candidates = uniquePaths([
    ...localCandidates,
    ...volumeRoots.map((root) => path.join(root, '_Serato_'))
  ])
  const available = await Promise.all(
    candidates.map(
      async (candidate) =>
        (await pathExists(path.join(candidate, 'database V2'))) ||
        (await pathExists(path.join(candidate, 'Subcrates')))
    )
  )
  const crateRoots = candidates.filter((_candidate, index) => available[index])
  if (crateRoots.length) return crateRoots
  return (await isSeratoV4Library(currentLibrary)) ? [currentLibrary] : []
}

const findTraktorCollections = async (): Promise<string[]> => {
  const configuredRoots = await readTraktorConfiguredRoots()
  const configuredCollections = uniquePaths(
    configuredRoots.map((root) => path.join(root, 'collection.nml'))
  )
  const availableConfigured = await Promise.all(
    configuredCollections.map(async (filePath) => await pathExists(filePath))
  )
  const activeCollections = configuredCollections.filter(
    (_filePath, index) => availableConfigured[index]
  )
  if (activeCollections.length) return activeCollections

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
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  return uniquePaths(candidates.map((candidate) => candidate.filePath))
}

const probeSources = async (): Promise<ExternalLibrarySourceProbe[]> => {
  const [seratoRoots, traktorCollections] = await Promise.all([
    findSeratoRoots(),
    findTraktorCollections()
  ])
  return [
    ...(seratoRoots.length ? seratoRoots : ['']).map((sourcePath) => ({
      kind: 'serato' as const,
      available: Boolean(sourcePath),
      sourceKey: sourcePath ? `serato:${sourcePathKey(sourcePath)}` : 'serato',
      sourcePath,
      displayName: 'Serato'
    })),
    ...(traktorCollections.length ? traktorCollections : ['']).map((sourcePath) => ({
      kind: 'traktor' as const,
      available: Boolean(sourcePath),
      sourceKey: sourcePath ? `traktor:${sourcePathKey(sourcePath)}` : 'traktor',
      sourcePath,
      displayName: 'Traktor'
    }))
  ]
}

let probeInflight: Promise<ExternalLibrarySourceProbe[]> | null = null
export const probeExternalLibraries = (): Promise<ExternalLibrarySourceProbe[]> => {
  if (probeInflight) return probeInflight
  const request = probeSources().finally(() => {
    if (probeInflight === request) probeInflight = null
  })
  probeInflight = request
  return request
}

export const __externalLibraryDetectTestUtils = {
  findSeratoRoots,
  findTraktorCollections
}
