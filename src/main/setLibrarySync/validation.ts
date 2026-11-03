import { SET_SYNC_ROOT, SET_SYNC_VERSION, type SetSyncSnapshot } from '../../shared/setLibrarySync'

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v)
export const safeSetName = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 255 &&
  v !== '.' &&
  v !== '..' &&
  !/[<>:"/\\|?*\x00-\x1f]/.test(v) &&
  !/[. ]$/.test(v) &&
  !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(v)
const asset = (v: unknown): boolean =>
  record(v) &&
  typeof v.sha256 === 'string' &&
  /^[a-f0-9]{64}$/.test(v.sha256) &&
  Number.isSafeInteger(v.size) &&
  Number(v.size) > 0

export function parseSetSnapshot(raw: unknown): SetSyncSnapshot {
  const fail = (): never => {
    throw new Error('SET_SYNC_INVALID_SNAPSHOT')
  }
  if (
    !record(raw) ||
    raw.protocolVersion !== SET_SYNC_VERSION ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 0 ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.items) ||
    raw.nodes.length > 20000 ||
    raw.items.length > 100000
  )
    return fail()
  const nodes = new Map<string, Record<string, unknown>>()
  const siblingNames = new Set<string>()
  for (const n of raw.nodes) {
    if (
      !record(n) ||
      !uuid(n.id) ||
      n.id === SET_SYNC_ROOT ||
      !uuid(n.parentId) ||
      !safeSetName(n.name) ||
      (n.type !== 'dir' && n.type !== 'setList') ||
      (n.order !== null && (typeof n.order !== 'number' || !Number.isFinite(n.order))) ||
      nodes.has(n.id)
    )
      return fail()
    const key = `${n.parentId}/${n.name.toLowerCase()}`
    if (siblingNames.has(key)) return fail()
    siblingNames.add(key)
    nodes.set(n.id, n)
  }
  for (const n of nodes.values()) {
    let parent = String(n.parentId)
    const seen = new Set([n.id])
    while (parent !== SET_SYNC_ROOT) {
      if (seen.has(parent)) return fail()
      const p = nodes.get(parent)
      if (!p || p.type !== 'dir') return fail()
      seen.add(parent)
      parent = String(p.parentId)
    }
  }
  const ids = new Set<string>()
  for (const i of raw.items) {
    if (
      !record(i) ||
      !uuid(i.id) ||
      nodes.has(i.id) ||
      ids.has(i.id) ||
      nodes.get(String(i.playlistId))?.type !== 'setList' ||
      typeof i.order !== 'number' ||
      !Number.isFinite(i.order) ||
      !Number.isSafeInteger(i.createdAtMs) ||
      Number(i.createdAtMs) < 0 ||
      !safeSetName(i.fileName) ||
      !asset(i.audio) ||
      !asset(i.analysis) ||
      Number((i.analysis as Record<string, unknown>).size) > 8 * 1024 * 1024 ||
      (i.waveform !== null &&
        (!asset(i.waveform) ||
          Number((i.waveform as Record<string, unknown>).size) > 256 * 1024 * 1024))
    )
      return fail()
    ids.add(i.id)
  }
  // All nested values needed for filesystem/DB writes have been checked above.
  return raw as SetSyncSnapshot
}
