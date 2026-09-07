import { CURATED_LIBRARY_SYNC_PROTOCOL_VERSION } from '../../shared/curatedLibrarySync'
import type {
  CuratedLibrarySyncCloudFile,
  CuratedLibrarySyncCloudNode,
  CuratedLibrarySyncSnapshot,
  CuratedLibrarySyncTombstone
} from '../../shared/curatedLibrarySync'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ROOT_PARENT_UUID = '00000000-0000-4000-8000-000000000000'
const SHA256 = /^[0-9a-f]{64}$/i
const isSafeName = (value: unknown): value is string => {
  const name = String(value || '').trim()
  if (!name || name === '.' || name === '..' || name.length > 255) return false
  if (/[\\/\u0000-\u001f<>:"|?*]/.test(name) || /[ .]$/.test(name)) return false
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)
}

const isOptionalPositiveInt = (value: unknown): boolean =>
  value == null || (Number.isSafeInteger(Number(value)) && Number(value) > 0)

const isCloudNode = (value: unknown): value is CuratedLibrarySyncCloudNode => {
  if (!isRecord(value)) return false
  return (
    UUID_V4.test(String(value.uuid || '')) &&
    String(value.uuid || '').toLowerCase() !== ROOT_PARENT_UUID &&
    UUID_V4.test(String(value.parentUuid || '')) &&
    isSafeName(value.name) &&
    (value.nodeType === 'dir' || value.nodeType === 'songList') &&
    (value.sortOrder == null || Number.isFinite(Number(value.sortOrder))) &&
    Number.isSafeInteger(Number(value.updatedAtMs)) &&
    Number(value.updatedAtMs) > 0 &&
    isOptionalPositiveInt(value.revision)
  )
}

const isCloudFile = (value: unknown): value is CuratedLibrarySyncCloudFile => {
  if (!isRecord(value)) return false
  return (
    UUID_V4.test(String(value.fileId || '')) &&
    UUID_V4.test(String(value.parentUuid || '')) &&
    isSafeName(value.fileName) &&
    SHA256.test(String(value.sha256 || '')) &&
    Number.isSafeInteger(Number(value.size)) &&
    Number(value.size) >= 0 &&
    isOptionalPositiveInt(value.trackNumber) &&
    isOptionalPositiveInt(value.addedAtMs) &&
    Number.isSafeInteger(Number(value.updatedAtMs)) &&
    Number(value.updatedAtMs) > 0 &&
    isOptionalPositiveInt(value.revision)
  )
}

const isTombstone = (value: unknown): value is CuratedLibrarySyncTombstone => {
  if (!isRecord(value)) return false
  return (
    (value.kind === 'file' || value.kind === 'node') &&
    UUID_V4.test(String(value.id || '')) &&
    !(value.kind === 'node' && String(value.id || '').toLowerCase() === ROOT_PARENT_UUID) &&
    Number.isSafeInteger(Number(value.revision)) &&
    Number(value.revision) > 0 &&
    Number.isSafeInteger(Number(value.deletedAtMs)) &&
    Number(value.deletedAtMs) > 0
  )
}

const hasDuplicate = (values: string[]): boolean => new Set(values).size !== values.length

const validateSnapshotEntities = (
  nodes: CuratedLibrarySyncCloudNode[],
  files: CuratedLibrarySyncCloudFile[],
  tombstones: CuratedLibrarySyncTombstone[],
  full: boolean
): boolean => {
  if (
    hasDuplicate(nodes.map((node) => node.uuid.toLowerCase())) ||
    hasDuplicate(files.map((file) => file.fileId.toLowerCase())) ||
    hasDuplicate(tombstones.map((item) => `${item.kind}:${item.id.toLowerCase()}`))
  ) {
    return false
  }
  const nodeIds = new Set(nodes.map((node) => node.uuid.toLowerCase()))
  const fileIds = new Set(files.map((file) => file.fileId.toLowerCase()))
  for (const tombstone of tombstones) {
    if (
      (tombstone.kind === 'node' && nodeIds.has(tombstone.id.toLowerCase())) ||
      (tombstone.kind === 'file' && fileIds.has(tombstone.id.toLowerCase()))
    ) {
      return false
    }
  }
  if (!full) return true
  const nodeById = new Map(nodes.map((node) => [node.uuid.toLowerCase(), node]))
  for (const node of nodes) {
    const seen = new Set<string>([node.uuid.toLowerCase()])
    let parent = node.parentUuid.toLowerCase()
    while (parent !== ROOT_PARENT_UUID && nodeById.has(parent)) {
      if (seen.has(parent)) return false
      seen.add(parent)
      parent = nodeById.get(parent)!.parentUuid.toLowerCase()
    }
  }
  const occupied = new Set<string>()
  for (const item of [...nodes, ...files]) {
    const parentUuid = item.parentUuid.toLowerCase()
    const name = 'name' in item ? item.name : item.fileName
    const key = `${parentUuid}\u0000${name.toLocaleLowerCase('en-US')}`
    if (occupied.has(key)) return false
    occupied.add(key)
  }
  return true
}

export const parseCuratedLibrarySnapshot = (raw: unknown): CuratedLibrarySyncSnapshot | null => {
  if (!isRecord(raw)) return null
  const protocolVersion = Number(raw.protocolVersion)
  const revision = Number(raw.revision)
  const full = raw.full !== false
  if (
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion !== CURATED_LIBRARY_SYNC_PROTOCOL_VERSION ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof raw.snapshotReady !== 'boolean' ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.files) ||
    !Array.isArray(raw.tombstones) ||
    !raw.nodes.every(isCloudNode) ||
    !raw.files.every(isCloudFile) ||
    !raw.tombstones.every(isTombstone) ||
    !validateSnapshotEntities(
      raw.nodes as CuratedLibrarySyncCloudNode[],
      raw.files as CuratedLibrarySyncCloudFile[],
      raw.tombstones as CuratedLibrarySyncTombstone[],
      full
    )
  ) {
    return null
  }
  return {
    protocolVersion,
    revision,
    snapshotReady: raw.snapshotReady,
    full,
    nodes: raw.nodes as CuratedLibrarySyncCloudNode[],
    files: raw.files as CuratedLibrarySyncCloudFile[],
    tombstones: raw.tombstones as CuratedLibrarySyncTombstone[]
  }
}

export const mergeCuratedLibrarySnapshot = (
  cached: CuratedLibrarySyncSnapshot | null,
  pulled: CuratedLibrarySyncSnapshot
): CuratedLibrarySyncSnapshot => {
  if (pulled.full !== false || !cached) {
    return {
      protocolVersion: pulled.protocolVersion,
      revision: pulled.revision,
      snapshotReady: pulled.snapshotReady,
      full: true,
      nodes: pulled.nodes,
      files: pulled.files,
      tombstones: pulled.tombstones
    }
  }
  const nodes = new Map(cached.nodes.map((node) => [node.uuid, node]))
  const files = new Map(cached.files.map((file) => [file.fileId, file]))
  let tombstones = [...cached.tombstones]
  for (const node of pulled.nodes) {
    nodes.set(node.uuid, node)
    tombstones = tombstones.filter((item) => !(item.kind === 'node' && item.id === node.uuid))
  }
  for (const file of pulled.files) {
    files.set(file.fileId, file)
    tombstones = tombstones.filter((item) => !(item.kind === 'file' && item.id === file.fileId))
  }
  for (const tombstone of pulled.tombstones) {
    if (tombstone.kind === 'file') files.delete(tombstone.id)
    else nodes.delete(tombstone.id)
    const index = tombstones.findIndex(
      (item) => item.kind === tombstone.kind && item.id === tombstone.id
    )
    if (index >= 0) tombstones[index] = tombstone
    else tombstones.push(tombstone)
  }
  return {
    protocolVersion: pulled.protocolVersion,
    revision: pulled.revision,
    snapshotReady: pulled.snapshotReady,
    full: true,
    nodes: [...nodes.values()],
    files: [...files.values()],
    tombstones
  }
}
