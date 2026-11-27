import { reactive } from 'vue'
import type { IcloudEntry, IcloudFolderListing } from '@shared/icloudLibrary'
export interface IcloudFolderNode {
  name: string
  relativePath: string
  residency: IcloudEntry['residency']
  hasChildren: boolean | 'unknown'
  expanded: boolean
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  error: string
  missingRoot: boolean
  children: IcloudFolderNode[]
}
const nodeFor = (
  entry: Pick<IcloudEntry, 'name' | 'relativePath' | 'residency' | 'hasChildren'>
): IcloudFolderNode =>
  reactive({
    ...entry,
    hasChildren: entry.hasChildren ?? 'unknown',
    expanded: false,
    status: entry.hasChildren === false ? 'ready' : 'idle',
    error: '',
    missingRoot: false,
    children: []
  })
export function createIcloudFolderTree(options: {
  token: () => string
  fetch: (relative: string, token: string) => Promise<IcloudFolderListing>
  listed?: (node: IcloudFolderNode) => void
}) {
  const root = nodeFor({ name: 'iCloud Drive', relativePath: '', residency: 'unknown' })
  root.expanded = true
  let generation = 0,
    sequence = 0,
    revealSequence = 0
  const latest = new WeakMap<IcloudFolderNode, number>()
  const pending = new Map<IcloudFolderNode, Promise<void>>()
  function load(node: IcloudFolderNode, force = false): Promise<void> {
    if (!force && node.status === 'ready') return Promise.resolve()
    if (!force && pending.has(node)) return pending.get(node)!
    const id = ++sequence,
      epoch = generation,
      token = options.token()
    latest.set(node, id)
    node.status = 'loading'
    node.error = ''
    const current = () =>
      epoch === generation && token === options.token() && latest.get(node) === id
    const operation = (async () => {
      try {
        const data = await options.fetch(node.relativePath, token)
        if (!current()) return
        if (data.rootToken !== token || data.directory !== node.relativePath)
          throw new Error('boundary')
        const old = new Map(node.children.map((entry) => [entry.relativePath, entry]))
        const children = data.entries
          .filter((entry) => entry.directory)
          .map((entry) => {
            const prior = old.get(entry.relativePath)
            if (!prior) return nodeFor(entry)
            if (prior.name !== entry.name) prior.name = entry.name
            if (prior.residency !== entry.residency) prior.residency = entry.residency
            const presence = entry.hasChildren ?? 'unknown'
            if (prior.hasChildren !== presence) {
              prior.hasChildren = presence
              latest.set(prior, ++sequence)
              pending.delete(prior)
              prior.status = presence === false ? 'ready' : 'idle'
              prior.error = ''
              if (presence === false) {
                prior.expanded = false
                if (prior.children.length) prior.children = []
                options.listed?.(prior)
              }
            }
            return prior
          })
        if (
          children.length !== node.children.length ||
          children.some((entry, index) => entry !== node.children[index])
        )
          node.children = children
        node.missingRoot = data.missingRoot
        node.hasChildren = data.missingRoot ? 'unknown' : children.length > 0
        if (node.hasChildren === false) node.expanded = false
        node.status = 'ready'
        options.listed?.(node)
      } catch (reason) {
        if (!current()) return
        node.hasChildren = 'unknown'
        node.expanded = true
        node.error = reason instanceof Error ? reason.message : 'failed'
        node.status = ['download', 'unavailable', 'offline'].includes(node.error)
          ? 'unavailable'
          : 'error'
      } finally {
        if (latest.get(node) === id) pending.delete(node)
      }
    })()
    pending.set(node, operation)
    return operation
  }
  async function toggle(node: IcloudFolderNode) {
    if (node.hasChildren === false) return
    node.expanded = !node.expanded
    if (node.expanded && node.status !== 'ready') await load(node)
  }
  async function refresh(node = root) {
    const epoch = generation
    await load(node, true)
    if (generation !== epoch || node.status !== 'ready') return
    for (const child of node.children) if (child.expanded) await refresh(child)
  }
  async function reveal(relative: string) {
    const epoch = generation,
      revealId = ++revealSequence
    root.expanded = true
    await load(root)
    let node = root
    const parts = relative.split('/').filter(Boolean)
    for (let index = 0; index < parts.length; index++) {
      if (epoch !== generation || revealId !== revealSequence || node.status !== 'ready') return
      const path = parts.slice(0, index + 1).join('/')
      const child = node.children.find((item) => item.relativePath === path)
      if (!child) return
      node = child
      if (index < parts.length - 1) {
        node.expanded = true
        await load(node)
      }
    }
  }
  function reset() {
    generation++
    pending.clear()
    root.children = []
    root.hasChildren = 'unknown'
    root.status = 'idle'
    root.error = ''
    root.missingRoot = false
    root.expanded = true
  }
  function dispose() {
    generation++
    pending.clear()
  }
  return { root, load, toggle, refresh, reveal, reset, dispose }
}
