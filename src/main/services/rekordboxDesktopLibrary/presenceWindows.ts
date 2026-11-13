import path from 'node:path'
import { execFile } from 'node:child_process'

const POWERSHELL_TIMEOUT_MS = 4000
const POWERSHELL_MAX_BUFFER = 512 * 1024
const MAX_APP_PATH_ENTRIES = 20
const MAX_UNINSTALL_ENTRIES = 60

export type WindowsRegistryAppPathEntry = {
  path: string
}

export type WindowsRegistryUninstallEntry = {
  displayName: string
  installLocation: string
  displayIcon: string
}

export type WindowsRegistryEntries = {
  appPaths: WindowsRegistryAppPathEntry[]
  uninstall: WindowsRegistryUninstallEntry[]
}

const EMPTY_REGISTRY_ENTRIES: WindowsRegistryEntries = {
  appPaths: [],
  uninstall: []
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$appPathKeys = @(
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\rekordbox.exe',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\rekordbox.exe',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\rekordbox.exe'
)
$appPaths = @()
foreach ($key in $appPathKeys) {
  $keyItem = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
  if ($null -eq $keyItem) { continue }
  $value = [string]$keyItem.GetValue('')
  if ($value) { $appPaths += [pscustomobject]@{ path = $value } }
}
$uninstall = @()
$uninstallRoots = @(
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $uninstallRoots) {
  $children = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Select-Object -First 4096
  foreach ($child in $children) {
    $item = Get-ItemProperty -LiteralPath $child.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $item) { continue }
    $displayName = [string]$item.DisplayName
    $installLocation = [string]$item.InstallLocation
    $displayIcon = [string]$item.DisplayIcon
    if ($displayName -notmatch 'rekordbox' -and $installLocation -notmatch 'rekordbox' -and $displayIcon -notmatch 'rekordbox') {
      continue
    }
    $uninstall += [pscustomobject]@{
      displayName = $displayName
      installLocation = $installLocation
      displayIcon = $displayIcon
    }
    if ($uninstall.Count -ge ${MAX_UNINSTALL_ENTRIES}) { break }
  }
  if ($uninstall.Count -ge ${MAX_UNINSTALL_ENTRIES}) { break }
}
[pscustomobject]@{ appPaths = $appPaths; uninstall = $uninstall } | ConvertTo-Json -Depth 4 -Compress
`.trim()

const normalizeTrimmed = (value: unknown, limit = 4096): string =>
  String(value || '')
    .trim()
    .slice(0, limit)

export const parseWindowsRegistryOutput = (
  raw: string | null | undefined
): WindowsRegistryEntries | null => {
  const text = normalizeTrimmed(raw, POWERSHELL_MAX_BUFFER)
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const rawAppPaths = Array.isArray(record.appPaths)
    ? record.appPaths
    : record.appPaths && typeof record.appPaths === 'object'
      ? [record.appPaths]
      : []
  const rawUninstall = Array.isArray(record.uninstall)
    ? record.uninstall
    : record.uninstall && typeof record.uninstall === 'object'
      ? [record.uninstall]
      : []

  const appPaths: WindowsRegistryAppPathEntry[] = []
  for (const entry of rawAppPaths.slice(0, MAX_APP_PATH_ENTRIES)) {
    if (!entry || typeof entry !== 'object') continue
    const value = normalizeTrimmed((entry as Record<string, unknown>).path)
    if (value) appPaths.push({ path: value })
  }

  const uninstall: WindowsRegistryUninstallEntry[] = []
  for (const entry of rawUninstall.slice(0, MAX_UNINSTALL_ENTRIES)) {
    if (!entry || typeof entry !== 'object') continue
    const source = entry as Record<string, unknown>
    uninstall.push({
      displayName: normalizeTrimmed(source.displayName, 512),
      installLocation: normalizeTrimmed(source.installLocation),
      displayIcon: normalizeTrimmed(source.displayIcon)
    })
  }
  return { appPaths, uninstall }
}

const resolvePowerShellPath = (): string => {
  const systemRoot = String(
    process.env.SystemRoot || process.env.windir || process.env.WINDIR || ''
  ).trim()
  if (!systemRoot) return 'powershell.exe'
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const runPowerShell = async (script: string): Promise<string | null> =>
  await new Promise<string | null>((resolve) => {
    try {
      execFile(
        resolvePowerShellPath(),
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
        {
          windowsHide: true,
          timeout: POWERSHELL_TIMEOUT_MS,
          maxBuffer: POWERSHELL_MAX_BUFFER
        },
        (_error, stdout) => {
          const buffer = Buffer.isBuffer(stdout)
            ? stdout
            : Buffer.from(String(stdout || ''), 'utf8')
          const text = buffer
            .toString('utf8')
            .replace(/^\uFEFF/, '')
            .trim()
          resolve(text || null)
        }
      )
    } catch {
      resolve(null)
    }
  })

export const readWindowsRekordboxRegistry = async (): Promise<WindowsRegistryEntries> => {
  const output = await runPowerShell(POWERSHELL_SCRIPT)
  return parseWindowsRegistryOutput(output) ?? EMPTY_REGISTRY_ENTRIES
}
