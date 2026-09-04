import fs from 'fs-extra'
import path from 'node:path'
import store from '../store'
import { log } from '../log'
import { loadLibraryNodes, removeLibraryNode } from '../libraryTreeDb'
import {
  readCuratedLibrarySyncPendingDeletedNodeIds,
  writeCuratedLibrarySyncPendingDeletedNodeIds
} from '../librarySettingsDb'
import { getCuratedLibraryAbsRoot, getNodeAbsPath, isPathInside } from './paths'

const collectDescendantUuids = (rootUuid: string): string[] => {
  if (!rootUuid) return []
  const nodes = loadLibraryNodes() || []
  const childrenByParent = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.parentUuid) continue
    const list = childrenByParent.get(node.parentUuid) || []
    list.push(node.uuid)
    childrenByParent.set(node.parentUuid, list)
  }
  const result: string[] = []
  const queue = [...(childrenByParent.get(rootUuid) || [])]
  for (let i = 0; i < queue.length; i += 1) {
    const uuid = queue[i]
    if (!uuid) continue
    result.push(uuid)
    queue.push(...(childrenByParent.get(uuid) || []))
  }
  return result
}

/** 空歌单删除竞态排查：只在待删/跳过/建回相关时落盘，方便对照 Dev A / Dev E。 */
export const logCuratedDeleteTrace = (event: string, detail: Record<string, unknown>): void => {
  log.info(`[curated-sync-delete] ${event}`, detail)
}

export const listPendingDeletedCuratedNodeIds = (): Set<string> =>
  new Set(readCuratedLibrarySyncPendingDeletedNodeIds())

/** 用户在精选库删了歌单/文件夹：记下 UUID，避免对账或落地又把空壳建回来。 */
export const rememberCuratedLibraryNodeDeletion = (uuid: string, absPath: string): void => {
  const root = getCuratedLibraryAbsRoot()
  const id = String(uuid || '').trim()
  const abs = String(absPath || '').trim()
  if (!root || !id || !abs) {
    logCuratedDeleteTrace('remember-skip', {
      uuid: id,
      abs,
      hasRoot: Boolean(root),
      reason: 'missing-args'
    })
    return
  }
  if (!isPathInside(abs, root)) {
    logCuratedDeleteTrace('remember-skip', { uuid: id, abs, root, reason: 'outside-curated' })
    return
  }
  const next = listPendingDeletedCuratedNodeIds()
  next.add(id)
  for (const child of collectDescendantUuids(id)) next.add(child)
  writeCuratedLibrarySyncPendingDeletedNodeIds([...next])
  logCuratedDeleteTrace('remember', { uuid: id, abs, pending: [...next] })
}

/**
 * 云上或本机还留着这个 UUID 时都要继续记着：
 * 云上还有 → 继续推墓碑；本机还在 → 禁止当成新建 upsert 回去。
 * 只有两边都没了才忘掉。
 */
export const prunePendingDeletedCuratedNodes = (
  cloudNodeIds: Set<string>,
  localNodeIds?: Set<string> | null
): void => {
  const pending = readCuratedLibrarySyncPendingDeletedNodeIds()
  const next = pending.filter((id) => cloudNodeIds.has(id) || Boolean(localNodeIds?.has(id)))
  if (pending.length > 0) {
    logCuratedDeleteTrace('prune-pending', {
      before: pending,
      after: next,
      keptBecauseCloud: next.filter((id) => cloudNodeIds.has(id)),
      keptBecauseLocal: next.filter((id) => Boolean(localNodeIds?.has(id)) && !cloudNodeIds.has(id))
    })
  }
  writeCuratedLibrarySyncPendingDeletedNodeIds(next)
}

const audioExtSet = (): Set<string> => {
  const list = store.settingConfig?.audioExt
  const result = new Set<string>()
  if (!Array.isArray(list)) return result
  for (const raw of list) {
    const ext = String(raw || '')
      .trim()
      .toLowerCase()
    if (!ext) continue
    result.add(ext.startsWith('.') ? ext : `.${ext}`)
  }
  return result
}

const dirHasAudioFiles = async (dirPath: string, audioExts: Set<string>): Promise<boolean> => {
  const items = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [])
  for (const item of items) {
    const full = path.join(dirPath, item.name)
    if (item.isFile()) {
      if (audioExts.has(path.extname(item.name).toLowerCase())) return true
    } else if (item.isDirectory() && (await dirHasAudioFiles(full, audioExts))) {
      return true
    }
  }
  return false
}

export const removeLocalPendingCuratedNodeShell = async (
  uuid: string,
  curatedRoot: string
): Promise<void> => {
  const abs = getNodeAbsPath(uuid)
  if (abs && isPathInside(abs, curatedRoot) && (await fs.pathExists(abs))) {
    const leftover = await fs.readdir(abs).catch(() => [])
    const meaningful = leftover.filter((name) => name !== '.frkb.uuid')
    // 没有音频就整目录删（封面不能挡住待删空壳，否则 watcher 会按磁盘把歌单建回）。
    if (meaningful.length === 0 || !(await dirHasAudioFiles(abs, audioExtSet()))) {
      await fs.remove(abs)
    }
  }
  removeLibraryNode(uuid)
}

export const purgePendingDeletedCuratedNodeShells = async (): Promise<void> => {
  const root = getCuratedLibraryAbsRoot()
  if (!root) return
  const pending = [...listPendingDeletedCuratedNodeIds()]
  if (pending.length === 0) return
  logCuratedDeleteTrace('purge-shells', { pending })
  for (const uuid of pending) {
    await removeLocalPendingCuratedNodeShell(uuid, root)
  }
}
