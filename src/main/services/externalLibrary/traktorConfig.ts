import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 5_000

const windowsRegistryScript = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Get-ChildItem -LiteralPath 'HKCU:\Software\Native Instruments' |
  Where-Object { $_.PSChildName -match '^Traktor (?:Pro )?[234](?:\s|$)' } |
  ForEach-Object {
    $root = (Get-ItemProperty -LiteralPath $_.PSPath -Name RootDirectory).RootDirectory
    if ($root) { [pscustomobject]@{ key = $_.PSChildName; root = $root } }
  } | ConvertTo-Json -Compress
`

type ConfiguredRoot = { key: string; root: string }

export const parseWindowsTraktorRoots = (output: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, ''))
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .filter(
        (row): row is ConfiguredRoot =>
          !!row &&
          typeof row === 'object' &&
          'root' in row &&
          typeof row.root === 'string' &&
          row.root.trim().length > 0
      )
      .map((row) => row.root.trim())
  } catch {
    return []
  }
}

const readWindowsTraktorRoots = async (): Promise<string[]> => {
  try {
    const encoded = Buffer.from(windowsRegistryScript, 'utf16le').toString('base64')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true }
    )
    return parseWindowsTraktorRoots(stdout)
  } catch {
    return []
  }
}

const readMacTraktorRoots = async (): Promise<string[]> => {
  const preferenceDir = path.join(app.getPath('home'), 'Library', 'Preferences')
  const entries = await fs.readdir(preferenceDir).catch(() => [])
  const preferenceFiles = entries.filter((name) =>
    /^com\.native-instruments\.Traktor(?: Pro)?(?:\s.*)?\.plist$/i.test(name)
  )
  const roots = await Promise.all(
    preferenceFiles.map(async (name) => {
      try {
        const { stdout } = await execFileAsync(
          'plutil',
          ['-extract', 'RootDirectory', 'raw', '-o', '-', path.join(preferenceDir, name)],
          { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS }
        )
        return stdout.trim()
      } catch {
        return ''
      }
    })
  )
  return roots.filter(Boolean)
}

export const readTraktorConfiguredRoots = async (): Promise<string[]> => {
  if (process.platform === 'win32') return await readWindowsTraktorRoots()
  if (process.platform === 'darwin') return await readMacTraktorRoots()
  return []
}
