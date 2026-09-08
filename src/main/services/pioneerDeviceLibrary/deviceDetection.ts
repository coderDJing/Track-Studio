import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path = require('path')
import fs = require('fs-extra')
import iconv = require('iconv-lite')
import { log } from '../../log'
import type {
  PioneerDeviceLibraryProbe,
  PioneerDriveEjectFailureCode,
  PioneerDriveEjectResult,
  PioneerLibraryKind,
  PioneerRemovableDriveInfo
} from './types'
import { ensurePioneerUsbIdentity } from './usbIdentity'

const execFileAsync = promisify(execFile)

type BaseDriveRow = {
  id: string
  name: string
  path: string
  volumeName: string
  fileSystem: string
  size: number
  freeSpace: number
  driveType: number | null
  driveTypeLabel: string
  isUsb: boolean
  isRemovable: boolean
}

const WINDOWS_DRIVE_TYPE_LABELS: Record<number, string> = {
  0: 'unknown',
  1: 'no-root-dir',
  2: 'removable',
  3: 'fixed',
  4: 'network',
  5: 'cdrom',
  6: 'ramdisk'
}

const DRIVE_EJECT_WAIT_MS = 6000
const DRIVE_EJECT_POLL_MS = 400
const WINDOWS_SHELL_EJECT_WAIT_MS = 1600
const WINDOWS_DRIVE_LIST_TIMEOUT_MS = 10_000
const REMOVABLE_DRIVE_CACHE_TTL_MS = 5_000

let removableDriveCache: {
  value: PioneerRemovableDriveInfo[]
  expiresAt: number
} | null = null
let removableDriveInflight: Promise<PioneerRemovableDriveInfo[]> | null = null

function isChineseLocale(): boolean {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || ''
    return /^zh(-|$)/i.test(locale)
  } catch {
    return false
  }
}

const normalizeDriveRoot = (value: string) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (process.platform === 'win32') {
    const match = raw.match(/^[A-Za-z]:/)
    if (match) {
      const drive = match[0].toUpperCase()
      return `${drive}/`
    }
  }
  const resolved = path.resolve(raw)
  return resolved.replace(/\\/g, '/')
}

const toSafeInt = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.round(parsed)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const trimOutput = (value: unknown) => String(value || '').trim()

const decodeExecOutput = (value: unknown) => {
  if (Buffer.isBuffer(value)) {
    const decoded = iconv.decode(value, isChineseLocale() ? 'gbk' : 'utf8')
    return trimOutput(decoded)
  }
  return trimOutput(value)
}

const execFileBufferAsync = (
  file: string,
  args: string[],
  options: Record<string, unknown> = {}
): Promise<{ stdout: Buffer; stderr: Buffer }> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        ...options,
        encoding: 'buffer'
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '')
        const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '')
        if (error) {
          Object.assign(error, {
            stdout: stdoutBuffer,
            stderr: stderrBuffer
          })
          reject(error)
          return
        }
        resolve({
          stdout: stdoutBuffer,
          stderr: stderrBuffer
        })
      }
    )
  })

const extractExecErrorDetail = (error: unknown) => {
  const err = error as {
    stderr?: string | Buffer
    stdout?: string | Buffer
    message?: string
  }
  return (
    decodeExecOutput(err?.stderr) ||
    decodeExecOutput(err?.stdout) ||
    trimOutput(err?.message) ||
    'unknown error'
  )
}

const createDriveEjectFailure = (
  rootPath: string,
  code: PioneerDriveEjectFailureCode,
  detail = ''
): PioneerDriveEjectResult => ({
  success: false,
  path: normalizeDriveRoot(rootPath),
  code,
  detail: trimOutput(detail)
})

const createDriveEjectSuccess = (rootPath: string): PioneerDriveEjectResult => ({
  success: true,
  path: normalizeDriveRoot(rootPath)
})

const getWindowsDriveLetter = (rootPath: string) => {
  const normalized = normalizeDriveRoot(rootPath)
  const match = normalized.match(/^([A-Z]:)\//)
  return match?.[1] || ''
}

const quotePowerShellLiteral = (value: string) => String(value || '').replace(/'/g, "''")

const joinDriveEjectDetail = (...parts: Array<unknown>) =>
  Array.from(new Set(parts.map((part) => trimOutput(part)).filter((part) => part.length > 0))).join(
    ' | '
  )

type WindowsDeviceEjectAttempt = {
  level?: number
  cr?: number
  vetoType?: number
  vetoName?: string
}

type WindowsDeviceEjectScriptResult = {
  success?: boolean
  instanceId?: string
  attempts?: WindowsDeviceEjectAttempt[]
}

const parseJsonOutput = <T>(value: string): T | null => {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

const formatWindowsDeviceEjectAttempts = (attempts: WindowsDeviceEjectAttempt[] = []) =>
  attempts
    .map((attempt) => {
      const parts = [`level=${Number(attempt.level) || 0}`, `cr=${Number(attempt.cr) || 0}`]
      if (Number.isFinite(Number(attempt.vetoType)) && Number(attempt.vetoType) !== 0) {
        parts.push(`vetoType=${Number(attempt.vetoType)}`)
      }
      const vetoName = trimOutput(attempt.vetoName)
      if (vetoName) {
        parts.push(`veto=${vetoName}`)
      }
      return parts.join(', ')
    })
    .filter(Boolean)
    .join(' | ')

const EMPTY_PIONEER_PROBE: PioneerDeviceLibraryProbe = {
  hasPioneerFolder: false,
  hasRekordboxFolder: false,
  hasExportPdb: false,
  hasOneLibraryDb: false,
  hasUsbAnlzFolder: false,
  pioneerFolderPath: null,
  rekordboxFolderPath: null,
  exportPdbPath: null,
  oneLibraryDbPath: null,
  usbAnlzPath: null,
  libraryTypes: []
}

const collectPioneerLibraryTypes = (probe: {
  hasExportPdb?: boolean
  hasOneLibraryDb?: boolean
}): PioneerLibraryKind[] => {
  const result: PioneerLibraryKind[] = []
  if (probe?.hasExportPdb) {
    result.push('deviceLibrary')
  }
  if (probe?.hasOneLibraryDb) {
    result.push('oneLibrary')
  }
  return result
}

export const probePioneerDeviceLibraryRoot = async (
  rootPath: string
): Promise<PioneerDeviceLibraryProbe> => {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) {
    return { ...EMPTY_PIONEER_PROBE }
  }

  const pioneerFolderPath = path.join(normalizedRoot, 'PIONEER')
  const rekordboxFolderPath = path.join(pioneerFolderPath, 'rekordbox')
  const exportPdbPath = path.join(rekordboxFolderPath, 'export.pdb')
  const oneLibraryDbPath = path.join(rekordboxFolderPath, 'exportLibrary.db')
  const usbAnlzPath = path.join(pioneerFolderPath, 'USBANLZ')

  const [hasPioneerFolder, hasRekordboxFolder, hasExportPdb, hasOneLibraryDb, hasUsbAnlzFolder] =
    await Promise.all([
      fs.pathExists(pioneerFolderPath),
      fs.pathExists(rekordboxFolderPath),
      fs.pathExists(exportPdbPath),
      fs.pathExists(oneLibraryDbPath),
      fs.pathExists(usbAnlzPath)
    ])

  const libraryTypes = collectPioneerLibraryTypes({
    hasExportPdb,
    hasOneLibraryDb
  })
  return {
    hasPioneerFolder,
    hasRekordboxFolder,
    hasExportPdb,
    hasOneLibraryDb,
    hasUsbAnlzFolder,
    pioneerFolderPath: hasPioneerFolder ? pioneerFolderPath : null,
    rekordboxFolderPath: hasRekordboxFolder ? rekordboxFolderPath : null,
    exportPdbPath: hasExportPdb ? exportPdbPath : null,
    oneLibraryDbPath: hasOneLibraryDb ? oneLibraryDbPath : null,
    usbAnlzPath: hasUsbAnlzFolder ? usbAnlzPath : null,
    libraryTypes
  }
}

const normalizeJsonArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') return [value as T]
  return []
}

const convertPlistToJson = async <T>(input: string): Promise<T | null> => {
  return await new Promise((resolve, reject) => {
    const child = spawn('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `plutil exited with code ${code}`))
        return
      }
      try {
        resolve(JSON.parse(stdout || 'null') as T | null)
      } catch (error) {
        reject(error)
      }
    })

    child.stdin.write(input)
    child.stdin.end()
  })
}

const runMacPlistCommand = async (command: string, args: string[]) => {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 8
  })
  return await convertPlistToJson(String(stdout || ''))
}

async function listWindowsRemovableDrives(): Promise<BaseDriveRow[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$usbLetters = New-Object 'System.Collections.Generic.HashSet[string]'",
    'Get-CimInstance Win32_DiskDrive | Where-Object {',
    "  $_.InterfaceType -eq 'USB' -or ($_.PNPDeviceID -like 'USBSTOR*')",
    '} | ForEach-Object {',
    '  $disk = $_',
    '  Get-CimAssociatedInstance -InputObject $disk -Association Win32_DiskDriveToDiskPartition -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $partition = $_',
    '    Get-CimAssociatedInstance -InputObject $partition -Association Win32_LogicalDiskToPartition -ErrorAction SilentlyContinue | ForEach-Object {',
    '      $id = [string]$_.DeviceID',
    '      if ($id) { [void]$usbLetters.Add($id.ToUpperInvariant()) }',
    '    }',
    '  }',
    '}',
    'if (Get-Command Get-Disk -ErrorAction SilentlyContinue) {',
    "  Get-Disk | Where-Object { $_.BusType -eq 'USB' } | ForEach-Object {",
    '    $diskNumber = $_.Number',
    '    Get-Partition -DiskNumber $diskNumber -ErrorAction SilentlyContinue | ForEach-Object {',
    '      if ($_.DriveLetter) {',
    "        [void]$usbLetters.Add((([string]$_.DriveLetter + ':').ToUpperInvariant()))",
    '      }',
    '    }',
    '  }',
    '}',
    '$rows = @()',
    'Get-CimInstance Win32_LogicalDisk | ForEach-Object {',
    '  $id = [string]$_.DeviceID',
    '  if (-not $id) { return }',
    '  $driveType = [int]$_.DriveType',
    '  $isUsb = $usbLetters.Contains($id.ToUpperInvariant())',
    '  $isRemovable = ($driveType -eq 2) -or $isUsb',
    '  if (-not $isRemovable) { return }',
    '  $rows += [PSCustomObject]@{',
    '    deviceId = $id',
    '    volumeName = [string]$_.VolumeName',
    '    driveType = $driveType',
    '    fileSystem = [string]$_.FileSystem',
    '    size = if ($_.Size) { [int64]$_.Size } else { 0 }',
    '    freeSpace = if ($_.FreeSpace) { [int64]$_.FreeSpace } else { 0 }',
    '    isUsb = $isUsb',
    '  }',
    '}',
    "if ($rows.Count -eq 0) { '[]' } else { $rows | ConvertTo-Json -Compress -Depth 4 }"
  ].join('\n')

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: WINDOWS_DRIVE_LIST_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 8
      }
    )
    const rows = normalizeJsonArray<Record<string, unknown>>(JSON.parse(String(stdout || '[]')))
    const normalizedRows: BaseDriveRow[] = []
    for (const row of rows) {
      const deviceId = String(row?.deviceId || '')
        .trim()
        .toUpperCase()
      const rootPath = normalizeDriveRoot(deviceId)
      if (!deviceId || !rootPath) continue
      const driveType = Number.isFinite(Number(row?.driveType)) ? Number(row.driveType) : null
      const volumeName = String(row?.volumeName || '').trim()
      normalizedRows.push({
        id: deviceId,
        name: volumeName || deviceId,
        path: rootPath,
        volumeName,
        fileSystem: String(row?.fileSystem || '').trim(),
        size: toSafeInt(row?.size),
        freeSpace: toSafeInt(row?.freeSpace),
        driveType,
        driveTypeLabel:
          driveType !== null ? WINDOWS_DRIVE_TYPE_LABELS[driveType] || 'unknown' : 'unknown',
        isUsb: Boolean(row?.isUsb),
        isRemovable: true
      })
    }
    return normalizedRows.sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
    )
  } catch (error) {
    log.error('[pioneer-device-library] windows removable drive detection failed', error)
    return []
  }
}

async function listLinuxRemovableDrives(): Promise<BaseDriveRow[]> {
  try {
    const { stdout } = await execFileAsync(
      'lsblk',
      ['-J', '-b', '-o', 'NAME,RM,HOTPLUG,TRAN,MOUNTPOINT,LABEL,FSTYPE,SIZE'],
      {
        maxBuffer: 1024 * 1024 * 8
      }
    )
    const parsed = JSON.parse(String(stdout || '{}')) as {
      blockdevices?: Array<Record<string, unknown>>
    }

    const rows: BaseDriveRow[] = []
    const walk = (item: Record<string, unknown>) => {
      const mountpoint = typeof item?.mountpoint === 'string' ? item.mountpoint.trim() : ''
      const rm = Number(item?.rm) === 1
      const hotplug = Number(item?.hotplug) === 1
      const transport = String(item?.tran || '')
        .trim()
        .toLowerCase()
      const isUsb = transport === 'usb'
      if (mountpoint && (rm || hotplug || isUsb)) {
        const rootPath = normalizeDriveRoot(mountpoint)
        rows.push({
          id: String(item?.name || rootPath),
          name: String(item?.label || item?.name || rootPath).trim(),
          path: rootPath,
          volumeName: String(item?.label || '').trim(),
          fileSystem: String(item?.fstype || '').trim(),
          size: toSafeInt(item?.size),
          freeSpace: 0,
          driveType: null,
          driveTypeLabel: isUsb ? 'usb' : rm ? 'removable' : 'hotplug',
          isUsb,
          isRemovable: true
        })
      }
      const children = Array.isArray(item?.children) ? item.children : []
      for (const child of children) walk(child)
    }

    const devices = Array.isArray(parsed?.blockdevices) ? parsed.blockdevices : []
    for (const device of devices) walk(device)
    return rows
  } catch (error) {
    log.error('[pioneer-device-library] linux removable drive detection failed', error)
    return []
  }
}

async function listMacRemovableDrives(): Promise<BaseDriveRow[]> {
  try {
    const volumesRoot = '/Volumes'
    const exists = await fs.pathExists(volumesRoot)
    if (!exists) return []
    const entries = await fs.readdir(volumesRoot, { withFileTypes: true })
    const rows: BaseDriveRow[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const rootPath = normalizeDriveRoot(path.join(volumesRoot, entry.name))
      if (!rootPath) continue

      try {
        const info = (await runMacPlistCommand('diskutil', ['info', '-plist', rootPath])) as Record<
          string,
          unknown
        > | null
        const mountPoint = typeof info?.MountPoint === 'string' ? info.MountPoint.trim() : ''
        if (!mountPoint) continue

        const normalizedMountPoint = normalizeDriveRoot(mountPoint)
        if (!normalizedMountPoint) continue

        const protocol = String(info?.BusProtocol || info?.Protocol || '').trim()
        const protocolLower = protocol.toLowerCase()
        const internal = Boolean(info?.Internal)
        const ejectable = Boolean(info?.Ejectable)
        const isUsb = protocolLower.includes('usb')
        const isRemovable =
          !internal &&
          (ejectable ||
            isUsb ||
            protocolLower.includes('firewire') ||
            protocolLower.includes('thunderbolt') ||
            protocolLower.includes('sd'))
        if (!isRemovable) continue

        const volumeName = String(
          info?.VolumeName || info?.MediaName || entry.name || normalizedMountPoint
        ).trim()
        const fileSystem = String(
          info?.FilesystemName || info?.FileSystemName || info?.FilesystemType || ''
        ).trim()
        rows.push({
          id: String(info?.DeviceIdentifier || normalizedMountPoint).trim() || normalizedMountPoint,
          name: volumeName || normalizedMountPoint,
          path: normalizedMountPoint,
          volumeName,
          fileSystem,
          size: toSafeInt(info?.TotalSize),
          freeSpace: toSafeInt(info?.FreeSpace),
          driveType: null,
          driveTypeLabel: protocol || (ejectable ? 'ejectable' : 'external'),
          isUsb,
          isRemovable: true
        })
      } catch (error) {
        log.error('[pioneer-device-library] mac diskutil probe failed', {
          path: rootPath,
          error
        })
      }
    }
    return rows.sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
    )
  } catch (error) {
    log.error('[pioneer-device-library] mac removable drive detection failed', error)
    return []
  }
}

async function listPlatformRemovableDrives(): Promise<BaseDriveRow[]> {
  if (process.platform === 'win32') {
    return await listWindowsRemovableDrives()
  }
  if (process.platform === 'linux') {
    return await listLinuxRemovableDrives()
  }
  if (process.platform === 'darwin') {
    return await listMacRemovableDrives()
  }
  return []
}

const isDriveDetached = async (rootPath: string) => {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) return false

  try {
    const exists = await fs.pathExists(normalizedRoot)
    if (!exists) return true
  } catch {}

  const rows = await listPlatformRemovableDrives()
  return !rows.some((row) => normalizeDriveRoot(row.path) === normalizedRoot)
}

const waitForDriveDetach = async (rootPath: string, timeoutMs = DRIVE_EJECT_WAIT_MS) => {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) return false

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDriveDetached(normalizedRoot)) return true
    await sleep(DRIVE_EJECT_POLL_MS)
  }

  return await isDriveDetached(normalizedRoot)
}

async function ejectWindowsRemovableDrive(rootPath: string): Promise<PioneerDriveEjectResult> {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  const driveLetter = getWindowsDriveLetter(normalizedRoot)
  if (!driveLetter) {
    return createDriveEjectFailure(rootPath, 'INVALID_PATH')
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$driveLetter = '${quotePowerShellLiteral(driveLetter)}'`,
    '$logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID = \'" + $driveLetter + "\'")',
    'if (-not $logicalDisk) { throw "WINDOWS_DRIVE_NOT_FOUND:$driveLetter" }',
    '$disk = Get-CimAssociatedInstance -InputObject $logicalDisk -Association Win32_LogicalDiskToPartition -ErrorAction Stop |',
    '  ForEach-Object {',
    '    Get-CimAssociatedInstance -InputObject $_ -Association Win32_DiskDriveToDiskPartition -ErrorAction Stop',
    '  } | Select-Object -First 1',
    'if (-not $disk) { throw "WINDOWS_DISK_ASSOCIATION_NOT_FOUND:$driveLetter" }',
    '$instanceId = [string]$disk.PNPDeviceID',
    'if (-not $instanceId) { throw "WINDOWS_PNP_DEVICE_ID_NOT_FOUND:$driveLetter" }',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class FrkbDeviceEjectNative {',
    '  [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]',
    '  public static extern uint CM_Locate_DevNodeW(out uint pdnDevInst, string pDeviceID, uint ulFlags);',
    '  [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]',
    '  public static extern uint CM_Get_Parent(out uint pdnDevInst, uint dnDevInst, uint ulFlags);',
    '  [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]',
    '  public static extern uint CM_Request_Device_EjectW(uint dnDevInst, out uint pVetoType, StringBuilder pszVetoName, int ulNameLength, uint ulFlags);',
    '}',
    '"@',
    '$devInst = 0',
    '$locateCr = [FrkbDeviceEjectNative]::CM_Locate_DevNodeW([ref]$devInst, $instanceId, 0)',
    'if ($locateCr -ne 0) { throw "WINDOWS_CM_LOCATE_FAILED:${locateCr}:${instanceId}" }',
    '$attempts = @()',
    'for ($level = 0; $level -lt 6 -and $devInst -ne 0; $level++) {',
    '  $vetoType = 0',
    '  $vetoName = New-Object System.Text.StringBuilder 512',
    '  $requestCr = [FrkbDeviceEjectNative]::CM_Request_Device_EjectW($devInst, [ref]$vetoType, $vetoName, $vetoName.Capacity, 0)',
    '  $attempts += [PSCustomObject]@{',
    '    level = $level',
    '    cr = $requestCr',
    '    vetoType = $vetoType',
    '    vetoName = $vetoName.ToString()',
    '  }',
    '  if ($requestCr -eq 0) {',
    '    [PSCustomObject]@{ success = $true; instanceId = $instanceId; attempts = $attempts } | ConvertTo-Json -Compress -Depth 6',
    '    exit',
    '  }',
    '  $parentDevInst = 0',
    '  $parentCr = [FrkbDeviceEjectNative]::CM_Get_Parent([ref]$parentDevInst, $devInst, 0)',
    '  if ($parentCr -ne 0 -or $parentDevInst -eq 0 -or $parentDevInst -eq $devInst) { break }',
    '  $devInst = $parentDevInst',
    '}',
    '[PSCustomObject]@{ success = $false; instanceId = $instanceId; attempts = $attempts } | ConvertTo-Json -Compress -Depth 6'
  ].join('\n')

  let scriptResult: WindowsDeviceEjectScriptResult | null = null
  let commandDetail = ''
  try {
    const { stdout } = await execFileBufferAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 8
      }
    )
    scriptResult = parseJsonOutput<WindowsDeviceEjectScriptResult>(decodeExecOutput(stdout))
    if (!scriptResult) {
      commandDetail = 'WINDOWS_EJECT_RESULT_PARSE_FAILED'
    }
  } catch (error) {
    commandDetail = extractExecErrorDetail(error)
  }

  if (!commandDetail && scriptResult?.success) {
    const detached = await waitForDriveDetach(normalizedRoot, WINDOWS_SHELL_EJECT_WAIT_MS)
    if (detached) {
      return createDriveEjectSuccess(normalizedRoot)
    }
    return createDriveEjectFailure(
      rootPath,
      'EJECT_TIMEOUT',
      joinDriveEjectDetail(
        formatWindowsDeviceEjectAttempts(scriptResult.attempts),
        'CM_Request_Device_EjectW returned success but the drive is still mounted.'
      )
    )
  }

  const attemptDetail = formatWindowsDeviceEjectAttempts(scriptResult?.attempts || [])
  const detail = joinDriveEjectDetail(commandDetail, attemptDetail)
  if (detail) {
    return createDriveEjectFailure(rootPath, 'EJECT_COMMAND_FAILED', detail)
  }

  const detachedWithoutDetail = await waitForDriveDetach(
    normalizedRoot,
    WINDOWS_SHELL_EJECT_WAIT_MS
  )
  if (detachedWithoutDetail) {
    return createDriveEjectSuccess(normalizedRoot)
  }

  return createDriveEjectFailure(rootPath, 'EJECT_TIMEOUT', 'Device eject request timed out.')
}

async function ejectMacRemovableDrive(rootPath: string): Promise<PioneerDriveEjectResult> {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) {
    return createDriveEjectFailure(rootPath, 'INVALID_PATH')
  }

  try {
    await execFileAsync('diskutil', ['eject', normalizedRoot], {
      maxBuffer: 1024 * 1024 * 8
    })
  } catch (error) {
    return createDriveEjectFailure(rootPath, 'EJECT_COMMAND_FAILED', extractExecErrorDetail(error))
  }

  const detached = await waitForDriveDetach(normalizedRoot)
  if (!detached) {
    return createDriveEjectFailure(rootPath, 'EJECT_TIMEOUT')
  }

  return createDriveEjectSuccess(normalizedRoot)
}

const resolveLinuxBlockDeviceByMountPoint = async (rootPath: string) => {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) return ''
  const { stdout } = await execFileAsync('findmnt', ['-no', 'SOURCE', '--target', normalizedRoot], {
    maxBuffer: 1024 * 1024 * 2
  })
  return trimOutput(stdout)
}

const resolveLinuxBaseBlockDevice = async (devicePath: string) => {
  const normalizedDevicePath = trimOutput(devicePath)
  if (!normalizedDevicePath) return ''
  const { stdout } = await execFileAsync('lsblk', ['-no', 'PKNAME', normalizedDevicePath], {
    maxBuffer: 1024 * 1024 * 2
  })
  const parentName = trimOutput(stdout)
  if (!parentName) return normalizedDevicePath
  return parentName.startsWith('/dev/') ? parentName : `/dev/${parentName}`
}

async function ejectLinuxRemovableDrive(rootPath: string): Promise<PioneerDriveEjectResult> {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) {
    return createDriveEjectFailure(rootPath, 'INVALID_PATH')
  }

  let devicePath = ''
  try {
    devicePath = await resolveLinuxBlockDeviceByMountPoint(normalizedRoot)
    if (!devicePath) {
      return createDriveEjectFailure(
        rootPath,
        'EJECT_COMMAND_FAILED',
        `No block device found for mount point: ${normalizedRoot}`
      )
    }

    await execFileAsync('udisksctl', ['unmount', '-b', devicePath], {
      maxBuffer: 1024 * 1024 * 8
    })

    const baseDevicePath = await resolveLinuxBaseBlockDevice(devicePath)
    await execFileAsync('udisksctl', ['power-off', '-b', baseDevicePath || devicePath], {
      maxBuffer: 1024 * 1024 * 8
    })
  } catch (error) {
    return createDriveEjectFailure(rootPath, 'EJECT_COMMAND_FAILED', extractExecErrorDetail(error))
  }

  const detached = await waitForDriveDetach(normalizedRoot)
  if (!detached) {
    return createDriveEjectFailure(rootPath, 'EJECT_TIMEOUT')
  }

  return createDriveEjectSuccess(normalizedRoot)
}

export async function listPioneerRemovableDrives(): Promise<PioneerRemovableDriveInfo[]> {
  if (removableDriveCache && removableDriveCache.expiresAt > Date.now()) {
    return removableDriveCache.value
  }
  if (removableDriveInflight) return await removableDriveInflight

  const request = (async () => {
    const baseRows = await listPlatformRemovableDrives()

    const results: PioneerRemovableDriveInfo[] = []
    for (const baseRow of baseRows) {
      try {
        const pioneer = await probePioneerDeviceLibraryRoot(baseRow.path)
        const identity =
          pioneer.libraryTypes.length > 0 ? await ensurePioneerUsbIdentity(baseRow.path) : null
        results.push({
          ...baseRow,
          frkbUsbUuid: identity?.uuid || undefined,
          frkbUsbIdFilePath: identity?.filePath || undefined,
          frkbUsbIdPersisted: identity?.persisted,
          isPioneerDeviceLibrary: pioneer.libraryTypes.length > 0,
          supportedLibraryTypes: pioneer.libraryTypes,
          pioneer
        })
      } catch (error) {
        log.error('[pioneer-device-library] pioneer probe failed', {
          path: baseRow.path,
          error
        })
        results.push({
          ...baseRow,
          isPioneerDeviceLibrary: false,
          supportedLibraryTypes: [],
          pioneer: { ...EMPTY_PIONEER_PROBE }
        })
      }
    }

    const sorted = results.sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
    )
    removableDriveCache = {
      value: sorted,
      expiresAt: Date.now() + REMOVABLE_DRIVE_CACHE_TTL_MS
    }
    return sorted
  })()
  removableDriveInflight = request
  try {
    return await request
  } finally {
    if (removableDriveInflight === request) removableDriveInflight = null
  }
}

export async function ejectPioneerRemovableDrive(
  rootPath: string
): Promise<PioneerDriveEjectResult> {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) {
    return createDriveEjectFailure(rootPath, 'INVALID_PATH')
  }

  let result: PioneerDriveEjectResult
  if (process.platform === 'win32') {
    result = await ejectWindowsRemovableDrive(normalizedRoot)
  } else if (process.platform === 'darwin') {
    result = await ejectMacRemovableDrive(normalizedRoot)
  } else if (process.platform === 'linux') {
    result = await ejectLinuxRemovableDrive(normalizedRoot)
  } else {
    result = createDriveEjectFailure(normalizedRoot, 'UNSUPPORTED_PLATFORM', process.platform)
  }

  if (!result.success) {
    log.error('[pioneer-device-library] eject removable drive failed', {
      rootPath: normalizedRoot,
      code: result.code,
      detail: result.detail
    })
  }

  removableDriveCache = null

  return result
}
