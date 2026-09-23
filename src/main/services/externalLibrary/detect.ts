import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExternalLibrarySourceProbe } from '../../../shared/externalLibrary'

const execFileAsync = promisify(execFile)

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

const listWindowsDriveRoots = async () => {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object -ExpandProperty DeviceID'
    ])
    return String(stdout || '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => /^[A-Za-z]:$/.test(value))
      .map((value) => `${value}${path.sep}`)
  } catch {
    return []
  }
}

const findSeratoRoot = async () => {
  const driveRoots = await listWindowsDriveRoots()
  const candidates = uniquePaths([
    path.join(app.getPath('music'), '_Serato_'),
    path.join(app.getPath('home'), 'Music', '_Serato_'),
    path.join(app.getPath('home'), '_Serato_'),
    ...driveRoots.map((root) => path.join(root, '_Serato_'))
  ])
  for (const candidate of candidates) {
    const hasDatabase = await pathExists(path.join(candidate, 'database V2'))
    const hasSubcrates = await pathExists(path.join(candidate, 'Subcrates'))
    if (hasDatabase || hasSubcrates) return candidate
  }
  return ''
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

export const probeExternalLibraries = async (): Promise<ExternalLibrarySourceProbe[]> => {
  const seratoRoot = await findSeratoRoot()
  return [
    {
      kind: 'serato',
      available: Boolean(seratoRoot),
      sourceKey: seratoRoot ? `serato:${seratoRoot.toLocaleLowerCase()}` : 'serato',
      sourcePath: seratoRoot,
      displayName: 'Serato'
    }
  ]
}

export const __externalLibraryDetectTestUtils = {
  findSeratoRoot,
  findTraktorCollection
}
