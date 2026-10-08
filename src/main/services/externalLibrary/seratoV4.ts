import { app } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ExternalLibraryPlaylist,
  ExternalLibrarySnapshot,
  ExternalLibraryTrack
} from '../../../shared/externalLibrary'

type ConnectionRow = { location_id: number; database_uri: string }
type AssetRow = {
  id: number
  location_id: number
  portable_id: string
  file_name: string | null
  name: string
  artist: string
  album: string
  genre: string
  label: string
  comments: string
  key: string
  bpm: number | null
  length_sec: number | null
  length_ms: number | null
  file_bit_rate: number | null
  file_sample_rate: number | null
  format: string
  year: string
  time_added: number
  is_missing: number
}
type ContainerRow = {
  id: number
  parent_id: number | null
  name: string
  type: number
  list_order: number
}
type ContainerAssetRow = { container_id: number; asset_id: number }

export const getSeratoV4LibraryDir = () =>
  process.platform === 'darwin'
    ? path.join(app.getPath('home'), 'Library', 'Application Support', 'Serato', 'Library')
    : path.join(
        process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'),
        'Serato',
        'Library'
      )

export const isSeratoV4SourcePath = (sourcePath: string) =>
  path.basename(path.normalize(sourcePath)).toLowerCase() === 'library' &&
  ['serato', '_serato_'].includes(
    path.basename(path.dirname(path.normalize(sourcePath))).toLowerCase()
  )

export const isSeratoV4Library = async (sourcePath: string) => {
  if (!isSeratoV4SourcePath(sourcePath)) return false
  return Boolean(
    (await fs.stat(path.join(sourcePath, 'master.sqlite')).catch(() => null))?.isFile()
  )
}

const volumeRootFromUri = (uri: string, platform: string) => {
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  const normalized = pathModule.normalize(uri)
  const lower = normalized.replaceAll('\\', '/').toLowerCase()
  if (lower.endsWith('/_serato_/library/location.sqlite')) {
    return pathModule.dirname(pathModule.dirname(pathModule.dirname(normalized)))
  }
  if (lower.endsWith('/root.sqlite')) {
    return platform === 'win32' ? path.win32.parse(normalized).root : '/'
  }
  return ''
}

const makeFilePath = (root: string, portableId: string, platform: string) => {
  const relative = portableId.replace(/^[/\\]+/, '').replaceAll('\\', '/')
  return platform === 'win32'
    ? path.win32.normalize(path.win32.join(root, relative))
    : path.posix.normalize(path.posix.join(root, relative))
}

const mountedWindowsRoots = async () => {
  const roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
  const available = await Promise.all(
    roots.map(async (root) => Boolean((await fs.stat(root).catch(() => null))?.isDirectory()))
  )
  return roots.filter((_root, index) => available[index])
}

const resolveAssetPaths = async (
  assets: Array<Pick<AssetRow, 'id' | 'location_id' | 'portable_id'>>,
  connections: ConnectionRow[],
  platform = process.platform
) => {
  const baseByLocation = new Map(
    connections.map((item) => [item.location_id, volumeRootFromUri(item.database_uri, platform)])
  )
  const windowsRoots = platform === 'win32' ? await mountedWindowsRoots() : []
  const driveByPrefix = new Map<string, string>()
  const filePaths = new Map<number, string>()
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  for (const asset of assets) {
    const portableId = String(asset.portable_id || '').trim()
    if (!portableId || /^\w+:\/\//.test(portableId)) continue
    if (pathModule.isAbsolute(portableId) || /^[A-Za-z]:[\\/]/.test(portableId)) {
      filePaths.set(asset.id, pathModule.normalize(portableId))
      continue
    }
    const base = baseByLocation.get(asset.location_id) || ''
    if (!base) continue
    if (platform !== 'win32' || !base.endsWith('\\')) {
      filePaths.set(asset.id, makeFilePath(base, portableId, platform))
      continue
    }

    const prefix = portableId.split(/[/\\]/)[0].toLowerCase()
    let drive = driveByPrefix.get(prefix)
    if (!drive) {
      const candidates = [
        base,
        ...windowsRoots.filter((root) => root.toLowerCase() !== base.toLowerCase())
      ]
      drive = base
      for (const candidate of candidates) {
        if (
          await fs
            .access(makeFilePath(candidate, portableId, platform))
            .then(() => true)
            .catch(() => false)
        ) {
          drive = candidate
          break
        }
      }
      driveByPrefix.set(prefix, drive)
    }
    filePaths.set(asset.id, makeFilePath(drive, portableId, platform))
  }
  return filePaths
}

export const __seratoV4TestUtils = { resolveAssetPaths }

export const readSeratoV4Library = async (libraryDir: string): Promise<ExternalLibrarySnapshot> => {
  const database = new Database(path.join(libraryDir, 'master.sqlite'), {
    readonly: true,
    fileMustExist: true
  })
  let connections: ConnectionRow[]
  let assets: AssetRow[]
  let containers: ContainerRow[]
  let containerAssets: ContainerAssetRow[]
  let smartContainerIds: number[]
  try {
    connections = database
      .prepare('SELECT location_id, database_uri FROM connection')
      .all() as ConnectionRow[]
    assets = database.prepare('SELECT * FROM asset').all() as AssetRow[]
    const librarySpace = database
      .prepare("SELECT id FROM space WHERE name = 'Serato Library' LIMIT 1")
      .get() as { id: number } | undefined
    containers = librarySpace
      ? (database
          .prepare('SELECT id, parent_id, name, type, list_order FROM container WHERE space_id = ?')
          .all(librarySpace.id) as ContainerRow[])
      : []
    containerAssets = database
      .prepare(
        'SELECT lc.container_id, ca.asset_id FROM container_asset ca JOIN location_container lc ON lc.id = ca.location_container_id ORDER BY ca.list_order'
      )
      .all() as ContainerAssetRow[]
    try {
      smartContainerIds = (
        database.prepare('SELECT container_id FROM smart_crate_rules').all() as Array<{
          container_id: number
        }>
      ).map((row) => row.container_id)
    } catch {
      smartContainerIds = []
    }
  } finally {
    database.close()
  }

  const filePaths = await resolveAssetPaths(assets, connections)
  const tracks: ExternalLibraryTrack[] = assets.flatMap((asset) => {
    const filePath = filePaths.get(asset.id)
    if (!filePath) return []
    const bpm = Number(asset.bpm)
    const date = Number(asset.time_added)
    return [
      {
        id: `serato-v4-track:${asset.id}`,
        filePath,
        title: asset.name || asset.file_name || undefined,
        artist: asset.artist || undefined,
        album: asset.album || undefined,
        genre: asset.genre || undefined,
        label: asset.label || undefined,
        comment: asset.comments || undefined,
        key: asset.key || undefined,
        bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : undefined,
        durationSec: Number(asset.length_sec) || Number(asset.length_ms) / 1000 || undefined,
        bitrate: Number(asset.file_bit_rate) || undefined,
        sampleRate: Number(asset.file_sample_rate) || undefined,
        fileFormat: asset.format || undefined,
        year: Number(asset.year) || undefined,
        dateAdded:
          Number.isFinite(date) && date > 0 && date < 8_640_000_000_000
            ? new Date(date * 1000).toISOString()
            : undefined,
        missing: Boolean(asset.is_missing),
        cues: []
      }
    ]
  })
  const trackIds = new Set(tracks.map((track) => track.id))
  const childCounts = new Map<number, number>()
  for (const container of containers) {
    if (container.parent_id !== null)
      childCounts.set(container.parent_id, (childCounts.get(container.parent_id) || 0) + 1)
  }
  const tracksByContainer = new Map<number, string[]>()
  for (const membership of containerAssets) {
    const trackId = `serato-v4-track:${membership.asset_id}`
    if (!trackIds.has(trackId)) continue
    const list = tracksByContainer.get(membership.container_id) || []
    list.push(trackId)
    tracksByContainer.set(membership.container_id, list)
  }
  const crateIds = new Set(containers.filter((item) => item.type !== 0).map((item) => item.id))
  const smartIds = new Set(smartContainerIds)
  const playlists: ExternalLibraryPlaylist[] = containers
    .filter((item) => crateIds.has(item.id))
    .map((item) => {
      const entries = tracksByContainer.get(item.id) || []
      return {
        id: `serato-v4:${item.id}`,
        name: item.name,
        parentId:
          item.parent_id !== null && crateIds.has(item.parent_id)
            ? `serato-v4:${item.parent_id}`
            : null,
        isFolder: Boolean(childCounts.get(item.id)) && entries.length === 0,
        isSmartPlaylist: smartIds.has(item.id),
        trackIds: entries,
        order: item.list_order
      }
    })

  return {
    kind: 'serato',
    rootPath: path.dirname(libraryDir),
    libraryPath: libraryDir,
    tracks,
    playlists,
    warnings: []
  }
}
