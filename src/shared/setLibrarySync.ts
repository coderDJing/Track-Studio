export const SET_SYNC_ROOT = '00000000-0000-4000-8000-000000000001'
export const SET_SYNC_VERSION = 1

export type SetSyncAsset = { sha256: string; size: number }
export type SetSyncNode = {
  id: string
  parentId: string
  name: string
  type: 'dir' | 'setList'
  order: number | null
}
export type SetSyncItem = {
  id: string
  playlistId: string
  order: number
  createdAtMs: number
  fileName: string
  audio: SetSyncAsset
  analysis: SetSyncAsset
  waveform: SetSyncAsset | null
}
export type SetSyncSnapshot = {
  protocolVersion: number
  revision: number
  nodes: SetSyncNode[]
  items: SetSyncItem[]
}
export type SetSyncResolution = 'local' | 'cloud'
export type SetSyncConflict = {
  id: string
  name: string
  field: string
  local: unknown
  cloud: unknown
}
export type SetSyncStatus = {
  running: boolean
  phase: 'idle' | 'scanning' | 'uploading' | 'downloading' | 'applying'
  done: number
  total: number
  result: 'idle' | 'success' | 'unchanged' | 'conflicts' | 'failed' | 'cancelled'
  error: string
  conflicts: SetSyncConflict[]
  lastSuccessAt: number
}

export const emptySetSnapshot = (): SetSyncSnapshot => ({
  protocolVersion: SET_SYNC_VERSION,
  revision: 0,
  nodes: [],
  items: []
})

export function stableSetJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSetJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSetJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const sameSetValue = (a: unknown, b: unknown): boolean =>
  stableSetJson(a) === stableSetJson(b)

/** Three-way field merge. A conflict leaves both machines untouched until explicitly resolved. */
export function mergeSetSnapshots(
  base: SetSyncSnapshot,
  local: SetSyncSnapshot,
  cloud: SetSyncSnapshot,
  resolution?: SetSyncResolution
): { snapshot: SetSyncSnapshot; conflicts: SetSyncConflict[] } {
  const conflicts: SetSyncConflict[] = []
  const mergeEntities = <T extends { id: string }>(before: T[], ours: T[], theirs: T[]): T[] => {
    const b = new Map(before.map((item) => [item.id, item]))
    const l = new Map(ours.map((item) => [item.id, item]))
    const r = new Map(theirs.map((item) => [item.id, item]))
    const merged: T[] = []
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
      const previous = b.get(id)
      const left = l.get(id)
      const right = r.get(id)
      const choose = (field: string, lv: unknown, rv: unknown): unknown => {
        const entity = left || right
        const name =
          entity && 'name' in entity
            ? String(entity.name)
            : entity && 'fileName' in entity
              ? String(entity.fileName)
              : id
        conflicts.push({
          id,
          name,
          field,
          local: lv ?? null,
          cloud: rv ?? null
        })
        return resolution === 'local' ? lv : rv
      }
      if (sameSetValue(left, right)) {
        if (left) merged.push(left)
      } else if (sameSetValue(previous, left)) {
        if (right) merged.push(right)
      } else if (sameSetValue(previous, right)) {
        if (left) merged.push(left)
      } else if (!left || !right || !previous) {
        const selected = choose('entity', left, right) as T | undefined
        if (selected) merged.push(selected)
      } else {
        const next = { ...right }
        for (const field of Object.keys(left) as (keyof T)[]) {
          if (field === 'id') continue
          next[field] =
            sameSetValue(left[field], right[field]) || sameSetValue(previous[field], right[field])
              ? left[field]
              : sameSetValue(previous[field], left[field])
                ? right[field]
                : (choose(String(field), left[field], right[field]) as T[keyof T])
        }
        merged.push(next)
      }
    }
    return merged.sort((a, b) => a.id.localeCompare(b.id))
  }
  const snapshot: SetSyncSnapshot = {
    protocolVersion: SET_SYNC_VERSION,
    revision: cloud.revision,
    nodes: mergeEntities(base.nodes, local.nodes, cloud.nodes),
    items: mergeEntities(base.items, local.items, cloud.items)
  }
  // A concurrent child addition keeps its deleted parent visible until the conflict is resolved.
  const sourceNodes = new Map([...base.nodes, ...local.nodes, ...cloud.nodes].map((n) => [n.id, n]))
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]))
  const removeSubtree = (id: string): void => {
    const removed = new Set([id])
    for (let changed = true; changed;) {
      changed = false
      for (const n of snapshot.nodes) {
        if (removed.has(n.parentId) && !removed.has(n.id)) {
          removed.add(n.id)
          changed = true
        }
      }
    }
    snapshot.nodes = snapshot.nodes.filter((n) => !removed.has(n.id))
    snapshot.items = snapshot.items.filter((i) => !removed.has(i.playlistId))
    for (const key of removed) nodes.delete(key)
  }
  const requireParent = (id: string, childId: string): void => {
    if (id === SET_SYNC_ROOT || nodes.has(id)) return
    const parent = sourceNodes.get(id)
    if (!parent) return
    conflicts.push({
      id,
      name: parent.name,
      field: 'children',
      local: local.nodes.find((n) => n.id === id) || null,
      cloud: cloud.nodes.find((n) => n.id === id) || null
    })
    const preferred = resolution === 'local' ? local.nodes : cloud.nodes
    if (resolution && !preferred.some((n) => n.id === id)) {
      removeSubtree(id)
      return
    }
    nodes.set(id, parent)
    snapshot.nodes.push(parent)
    requireParent(parent.parentId, id)
  }
  for (const n of [...snapshot.nodes]) requireParent(n.parentId, n.id)
  for (const i of [...snapshot.items]) requireParent(i.playlistId, i.id)
  // Two individually valid moves may together form a cycle (A into B, B into A).
  const cycleIds = new Set<string>()
  for (const node of snapshot.nodes) {
    const chain: string[] = []
    let id = node.id
    while (id !== SET_SYNC_ROOT && nodes.has(id)) {
      const index = chain.indexOf(id)
      if (index >= 0) {
        for (const key of chain.slice(index)) cycleIds.add(key)
        break
      }
      chain.push(id)
      id = nodes.get(id)!.parentId
    }
  }
  for (const id of cycleIds) {
    const n = nodes.get(id)!
    const l = local.nodes.find((v) => v.id === id)
    const r = cloud.nodes.find((v) => v.id === id)
    conflicts.push({
      id,
      name: n.name,
      field: 'parentId',
      local: l?.parentId || null,
      cloud: r?.parentId || null
    })
    const chosen = resolution === 'local' ? l : r
    if (chosen) {
      const next = { ...n, parentId: chosen.parentId }
      nodes.set(id, next)
      snapshot.nodes = snapshot.nodes.map((v) => (v.id === id ? next : v))
    }
  }
  // Independent new folders with the same display name are both preserved.
  const usedNames = new Set<string>()
  snapshot.nodes.sort((a, b) => a.id.localeCompare(b.id))
  snapshot.nodes = snapshot.nodes.map((n) => {
    let name = n.name
    let key = `${n.parentId}/${name.toLowerCase()}`
    if (usedNames.has(key)) {
      name = `${name.slice(0, 210)} (${n.id})`
      key = `${n.parentId}/${name.toLowerCase()}`
    }
    usedNames.add(key)
    return name === n.name ? n : { ...n, name }
  })
  return { snapshot, conflicts }
}
