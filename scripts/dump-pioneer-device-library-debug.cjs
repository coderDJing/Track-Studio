const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const rust = require('rust_package')

const rootDir = path.resolve(__dirname, '..')
const logPath = path.join(rootDir, 'log.txt')

const normalizeDriveRoot = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (process.platform === 'win32') {
    const match = raw.match(/^[A-Za-z]:/)
    if (match) return `${match[0].toUpperCase()}\\`
  }
  return path.resolve(raw)
}

async function listWindowsRemovableDrives() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
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
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 }
  )
  const rows = JSON.parse(String(stdout || '[]'))
  return Array.isArray(rows) ? rows : rows ? [rows] : []
}

async function listCandidateRoots() {
  if (process.platform === 'win32') {
    const rows = await listWindowsRemovableDrives()
    return rows
      .map((row) => ({
        id: String(row.deviceId || '')
          .trim()
          .toUpperCase(),
        name: String(row.volumeName || row.deviceId || '').trim(),
        path: normalizeDriveRoot(row.deviceId),
        fileSystem: String(row.fileSystem || '').trim(),
        isUsb: Boolean(row.isUsb)
      }))
      .filter((row) => row.id && row.path)
  }

  if (process.platform === 'darwin') {
    const volumesRoot = '/Volumes'
    const entries = await fs.readdir(volumesRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        id: entry.name,
        name: entry.name,
        path: path.join(volumesRoot, entry.name),
        fileSystem: '',
        isUsb: false
      }))
  }

  return []
}

async function buildProbe(rootPath) {
  const pioneerFolderPath = path.join(rootPath, 'PIONEER')
  const rekordboxFolderPath = path.join(pioneerFolderPath, 'rekordbox')
  const exportPdbPath = path.join(rekordboxFolderPath, 'export.pdb')
  const usbAnlzPath = path.join(pioneerFolderPath, 'USBANLZ')
  const [hasPioneerFolder, hasRekordboxFolder, hasExportPdb, hasUsbAnlzFolder] = await Promise.all([
    fs
      .access(pioneerFolderPath)
      .then(() => true)
      .catch(() => false),
    fs
      .access(rekordboxFolderPath)
      .then(() => true)
      .catch(() => false),
    fs
      .access(exportPdbPath)
      .then(() => true)
      .catch(() => false),
    fs
      .access(usbAnlzPath)
      .then(() => true)
      .catch(() => false)
  ])

  return {
    hasPioneerFolder,
    hasRekordboxFolder,
    hasExportPdb,
    hasUsbAnlzFolder,
    exportPdbPath: hasExportPdb ? exportPdbPath : null,
    usbAnlzPath: hasUsbAnlzFolder ? usbAnlzPath : null
  }
}

async function main() {
  const candidateRoots = await listCandidateRoots()
  const probes = []

  for (const drive of candidateRoots) {
    const probe = await buildProbe(drive.path)
    probes.push({
      ...drive,
      ...probe
    })
  }

  const pioneerDrives = probes.filter((item) => item.hasExportPdb && item.exportPdbPath)
  const currentSongsAreaColumns = [
    'index',
    'cover',
    'waveformPreview',
    'title',
    'artist',
    'duration',
    'bpm',
    'key',
    'album',
    'label',
    'genre',
    'fileFormat',
    'bitrate',
    'fileName',
    'container'
  ]

  const dumps = pioneerDrives.map((drive) => {
    const debugDump = rust.dumpPioneerExportDebug(drive.exportPdbPath, 120)
    const treeDump = rust.readPioneerPlaylistTree(drive.exportPdbPath)
    const treeNodes = Array.isArray(treeDump?.nodes) ? treeDump.nodes : []
    const firstPlaylist = treeNodes.find((node) => !node.isFolder)
    let playlistInspection = null

    if (firstPlaylist) {
      const playlistDump = rust.readPioneerPlaylistTracks(drive.exportPdbPath, firstPlaylist.id, 40)
      const tracks = Array.isArray(playlistDump?.tracks) ? playlistDump.tracks : []
      const pioneerReadableColumns = [
        'title',
        'artist',
        'album',
        'label',
        'genre',
        'duration',
        'bpm',
        'key',
        'bitrate',
        'fileName',
        'filePath',
        'sampleRate',
        'sampleDepth',
        'trackNumber',
        'discNumber',
        'year',
        'analyzePath',
        'comment',
        'dateAdded'
      ]
      const missingComparedToCurrent = currentSongsAreaColumns.filter(
        (key) =>
          ![
            'title',
            'artist',
            'duration',
            'bpm',
            'key',
            'album',
            'label',
            'genre',
            'bitrate',
            'fileName'
          ].includes(key)
      )
      const extraComparedToCurrent = pioneerReadableColumns.filter(
        (key) => !currentSongsAreaColumns.includes(key)
      )
      const entryIndices = tracks.map((track) => Number(track.entryIndex || 0))
      const isAscending = entryIndices.every(
        (value, index) => index === 0 || value >= entryIndices[index - 1]
      )

      playlistInspection = {
        playlistId: firstPlaylist.id,
        playlistName: playlistDump.playlistName,
        trackTotal: playlistDump.trackTotal,
        currentSongsAreaColumns,
        pioneerReadableColumns,
        missingComparedToCurrent,
        extraComparedToCurrent,
        orderCheck: {
          firstEntryIndices: entryIndices.slice(0, 20),
          isAscending
        },
        sampleTracks: tracks
      }
    }

    return {
      drive: {
        id: drive.id,
        name: drive.name,
        path: drive.path,
        fileSystem: drive.fileSystem,
        isUsb: drive.isUsb,
        hasUsbAnlzFolder: drive.hasUsbAnlzFolder
      },
      dump: debugDump,
      playlistInspection
    }
  })

  const payload = {
    generatedAt: new Date().toISOString(),
    candidateCount: candidateRoots.length,
    pioneerDriveCount: pioneerDrives.length,
    probes,
    dumps
  }

  await fs.writeFile(logPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`wrote pioneer debug dump to ${logPath}`)
}

main().catch(async (error) => {
  const payload = {
    generatedAt: new Date().toISOString(),
    error: error && error.stack ? error.stack : String(error)
  }
  await fs.writeFile(logPath, JSON.stringify(payload, null, 2), 'utf8')
  console.error(error)
  process.exitCode = 1
})
