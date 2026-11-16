import { reactive, ref } from 'vue'
import type { IDir, IMenu } from 'src/types/globals'
import libraryUtils from '@renderer/utils/libraryUtils'

export type LibraryTreeSortRule = 'manual' | 'nameAsc' | 'nameDesc' | 'countAsc' | 'countDesc'

const LIBRARY_TREE_SORT_RULES: LibraryTreeSortRule[] = [
  'manual',
  'nameAsc',
  'nameDesc',
  'countAsc',
  'countDesc'
]

const STORAGE_KEY = 'libraryTreeSortRules'
const COUNT_STORAGE_KEY = 'libraryTreeTrackCounts'
/** 曲目数缓存持久化上限，避免 localStorage 无限增长 */
const MAX_PERSISTED_COUNT_ENTRIES = 5000
/** 曲目数更新合并窗口：把同一批异步回包合成一次重排 */
const COUNT_FLUSH_DELAY_MS = 48
const COUNT_PERSIST_DELAY_MS = 1000

const isLibraryTreeSortRule = (value: unknown): value is LibraryTreeSortRule =>
  typeof value === 'string' && (LIBRARY_TREE_SORT_RULES as string[]).includes(value)

const loadRules = (): Record<string, LibraryTreeSortRule> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const result: Record<string, LibraryTreeSortRule> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isLibraryTreeSortRule(value)) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

const loadCounts = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(COUNT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const result: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        result[key] = Math.floor(value)
      }
    }
    return result
  } catch {
    return {}
  }
}

const rulesByLibrary = ref<Record<string, LibraryTreeSortRule>>(loadRules())
/** 排序规则变更版本，供显示层 computed 依赖 */
export const libraryTreeSortRuleVersion = ref(0)
/**
 * 曲目数缓存。上次会话的结果会持久化，保证按数量排序的库首帧即可给出正确顺序，
 * 避免"先按手动序渲染、再随异步回包逐个重排"的视觉抖动。
 */
export const libraryTreeTrackCountMap = reactive<Record<string, number>>(loadCounts())
/** 曲目数缓存变更版本，供显示层 computed 依赖 */
export const libraryTreeTrackCountVersion = ref(0)

const persistRules = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rulesByLibrary.value))
  } catch {
    // ignore quota / private mode failures
  }
}

let countFlushTimer: ReturnType<typeof setTimeout> | null = null
let countPersistTimer: ReturnType<typeof setTimeout> | null = null
let hasPendingCountVersionBump = false

const persistCounts = () => {
  try {
    const entries = Object.entries(libraryTreeTrackCountMap)
    const limited =
      entries.length > MAX_PERSISTED_COUNT_ENTRIES
        ? entries.slice(entries.length - MAX_PERSISTED_COUNT_ENTRIES)
        : entries
    localStorage.setItem(COUNT_STORAGE_KEY, JSON.stringify(Object.fromEntries(limited)))
  } catch {
    // ignore quota / private mode failures
  }
}

const scheduleCountPersist = () => {
  if (countPersistTimer) return
  countPersistTimer = setTimeout(() => {
    countPersistTimer = null
    persistCounts()
  }, COUNT_PERSIST_DELAY_MS)
}

/**
 * 曲目数是一条条异步回来的，逐条 bump 版本号会让列表连续重排多次。
 * 这里把同一窗口内的更新合并成一次重排。
 */
const scheduleCountVersionBump = () => {
  hasPendingCountVersionBump = true
  if (countFlushTimer) return
  countFlushTimer = setTimeout(() => {
    countFlushTimer = null
    if (!hasPendingCountVersionBump) return
    hasPendingCountVersionBump = false
    libraryTreeTrackCountVersion.value += 1
  }, COUNT_FLUSH_DELAY_MS)
}

/** 立即结算待合并的曲目数更新（预取整批结束时调用，让重排只发生一次） */
export const flushLibraryTreeTrackCountUpdates = () => {
  if (countFlushTimer) {
    clearTimeout(countFlushTimer)
    countFlushTimer = null
  }
  if (!hasPendingCountVersionBump) return
  hasPendingCountVersionBump = false
  libraryTreeTrackCountVersion.value += 1
}

export const getLibraryTreeSortRule = (libraryName: string): LibraryTreeSortRule => {
  const key = String(libraryName || '').trim()
  if (!key) return 'manual'
  return rulesByLibrary.value[key] || 'manual'
}

export const isLibraryTreeManualSort = (libraryName: string) =>
  getLibraryTreeSortRule(libraryName) === 'manual'

export const setLibraryTreeSortRule = (libraryName: string, rule: LibraryTreeSortRule) => {
  const key = String(libraryName || '').trim()
  if (!key || !isLibraryTreeSortRule(rule)) return
  if (rulesByLibrary.value[key] === rule) return
  rulesByLibrary.value = {
    ...rulesByLibrary.value,
    [key]: rule
  }
  libraryTreeSortRuleVersion.value += 1
  persistRules()
}

export const setLibraryTreeTrackCount = (uuid: string, count: number) => {
  const id = String(uuid || '').trim()
  if (!id) return
  const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  if (libraryTreeTrackCountMap[id] === next) return
  libraryTreeTrackCountMap[id] = next
  scheduleCountVersionBump()
  scheduleCountPersist()
}

/**
 * 清理已不存在节点的持久化曲目数，避免缓存无限增长。
 * 必须传入完整库树根节点：缓存是跨库共享的，按单个库剪枝会误删其他库的数据。
 */
export const pruneLibraryTreeTrackCounts = (fullLibraryTreeRoot?: IDir | null) => {
  if (!fullLibraryTreeRoot) return
  const alive = new Set(collectPlaylistNodes(fullLibraryTreeRoot).map((node) => node.uuid))
  if (!alive.size) return
  let removed = false
  for (const key of Object.keys(libraryTreeTrackCountMap)) {
    if (alive.has(key)) continue
    delete libraryTreeTrackCountMap[key]
    removed = true
  }
  if (removed) scheduleCountPersist()
}

const isPlaylistNode = (node?: IDir | null) =>
  node?.type === 'songList' || node?.type === 'mixtapeList' || node?.type === 'setList'

export const getLibraryTreeNodeTrackCount = (node?: IDir | null): number => {
  if (!node) return 0
  if (isPlaylistNode(node)) {
    // 虚拟节点（网易云歌单）自带数量，优先于缓存：缓存里可能是上一轮盘上扫描留下的 0
    if (typeof node.trackCount === 'number') return node.trackCount
    const cached = libraryTreeTrackCountMap[node.uuid]
    return typeof cached === 'number' ? cached : 0
  }
  if (node.type !== 'dir' || !node.children?.length) return 0
  let sum = 0
  for (const child of node.children) {
    sum += getLibraryTreeNodeTrackCount(child)
  }
  return sum
}

const compareName = (a: IDir, b: IDir, direction: 1 | -1) => {
  const left = String(a.dirName || '')
  const right = String(b.dirName || '')
  const byName = left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
  if (byName !== 0) return byName * direction
  return String(a.uuid).localeCompare(String(b.uuid)) * direction
}

const compareCount = (a: IDir, b: IDir, direction: 1 | -1) => {
  const left = getLibraryTreeNodeTrackCount(a)
  const right = getLibraryTreeNodeTrackCount(b)
  if (left !== right) return (left - right) * direction
  return compareName(a, b, 1)
}

export const sortLibraryTreeChildren = (
  children: IDir[] | undefined,
  rule: LibraryTreeSortRule
): IDir[] => {
  if (!children?.length) return []
  if (rule === 'manual') return children

  const pending = children.filter((item) => !String(item.dirName || '').trim())
  const named = children.filter((item) => String(item.dirName || '').trim())
  const sorted = [...named]

  if (rule === 'nameAsc') sorted.sort((a, b) => compareName(a, b, 1))
  else if (rule === 'nameDesc') sorted.sort((a, b) => compareName(a, b, -1))
  else if (rule === 'countAsc') sorted.sort((a, b) => compareCount(a, b, 1))
  else if (rule === 'countDesc') sorted.sort((a, b) => compareCount(a, b, -1))

  return pending.length ? [...pending, ...sorted] : sorted
}

const collectPlaylistNodes = (root?: IDir | null): IDir[] => {
  const result: IDir[] = []
  const walk = (node?: IDir | null) => {
    if (!node) return
    if (isPlaylistNode(node)) result.push(node)
    if (node.children?.length) {
      for (const child of node.children) walk(child)
    }
  }
  walk(root)
  return result
}

/** 是否所有歌单节点都已有曲目数（含上次会话持久化的缓存），用于判断按数量排序能否直接出正确首帧 */
export const hasCompleteLibraryTreeTrackCounts = (root?: IDir | null): boolean => {
  const nodes = collectPlaylistNodes(root)
  if (!nodes.length) return true
  return nodes.every(
    (node) =>
      !String(node.dirName || '').trim() ||
      typeof node.trackCount === 'number' ||
      typeof libraryTreeTrackCountMap[node.uuid] === 'number'
  )
}

const isCountRecord = (value: unknown): value is Record<string, number> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readCountFromRecord = (record: Record<string, number>, uuid: string) => {
  const value = record[uuid]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// token 按库隔离：多个库的 libraryArea 同时挂载，共用一个 token 会互相取消写入
const prefetchTokenByRoot = new Map<string, number>()
const inFlightPrefetchByRoot = new Map<string, Promise<void>>()
const rerunRequestedByRoot = new Set<string>()

/**
 * 一次性取回整棵库树的曲目数：songList 与 setList 各走一个批量 IPC，
 * 结果整批落地后只触发一次重排，避免逐歌单回包造成的连续抖动。
 *
 * 同一个库正在预取时不并发发起第二轮，而是记下"结束后再跑一次"，
 * 保证树在预取途中变化也能拿到最新结果，同时不重复压满统计 worker。
 */
export const prefetchLibraryTreeTrackCounts = (root?: IDir | null): Promise<void> => {
  const rootKey = String(root?.uuid || '')
  if (!rootKey) return Promise.resolve()
  const existing = inFlightPrefetchByRoot.get(rootKey)
  if (existing) {
    rerunRequestedByRoot.add(rootKey)
    return existing
  }
  const task = (async () => {
    await runPrefetchLibraryTreeTrackCounts(rootKey, root)
    while (rerunRequestedByRoot.has(rootKey)) {
      rerunRequestedByRoot.delete(rootKey)
      await runPrefetchLibraryTreeTrackCounts(rootKey, root)
    }
  })()
  inFlightPrefetchByRoot.set(rootKey, task)
  void task.finally(() => {
    if (inFlightPrefetchByRoot.get(rootKey) === task) inFlightPrefetchByRoot.delete(rootKey)
    rerunRequestedByRoot.delete(rootKey)
  })
  return task
}

const runPrefetchLibraryTreeTrackCounts = async (rootKey: string, root?: IDir | null) => {
  const nodes = collectPlaylistNodes(root)
  if (!nodes.length) return
  const token = (prefetchTokenByRoot.get(rootKey) || 0) + 1
  prefetchTokenByRoot.set(rootKey, token)
  const isStale = () => prefetchTokenByRoot.get(rootKey) !== token

  const songListNodes: Array<{ uuid: string; songListPath: string }> = []
  const setListUuids: string[] = []
  for (const node of nodes) {
    if (node.type === 'mixtapeList') {
      setLibraryTreeTrackCount(node.uuid, libraryTreeTrackCountMap[node.uuid] ?? 0)
      continue
    }
    if (node.type === 'setList') {
      setListUuids.push(node.uuid)
      continue
    }
    // 虚拟节点自带数量（网易云歌单），直接落地；
    // 它的 dirName 不是磁盘目录名，送进统计只会去扫一个不存在的路径。
    if (typeof node.trackCount === 'number') {
      setLibraryTreeTrackCount(node.uuid, node.trackCount)
      continue
    }
    // 新建歌单尚未命名时，路径解析会指向父目录；绝不能把它送进递归统计。
    if (!String(node.dirName || '').trim()) continue
    const songListPath = libraryUtils.findDirPathByUuid(node.uuid)
    if (!songListPath) {
      setLibraryTreeTrackCount(node.uuid, 0)
      continue
    }
    songListNodes.push({ uuid: node.uuid, songListPath })
  }

  try {
    await Promise.all([
      (async () => {
        if (!songListNodes.length) return
        try {
          const counts = await window.electron.ipcRenderer.invoke('playlist:batchTrackCount', {
            songLists: songListNodes
          })
          if (isStale()) return
          if (!isCountRecord(counts)) {
            for (const node of songListNodes) setLibraryTreeTrackCount(node.uuid, 0)
            return
          }
          for (const node of songListNodes) {
            setLibraryTreeTrackCount(node.uuid, readCountFromRecord(counts, node.uuid))
          }
        } catch {
          if (isStale()) return
          for (const node of songListNodes) setLibraryTreeTrackCount(node.uuid, 0)
        }
      })(),
      (async () => {
        if (!setListUuids.length) return
        try {
          const counts = await window.electron.ipcRenderer.invoke(
            'setList:batchCount',
            setListUuids
          )
          if (isStale()) return
          if (!isCountRecord(counts)) {
            for (const uuid of setListUuids) setLibraryTreeTrackCount(uuid, 0)
            return
          }
          for (const uuid of setListUuids) {
            setLibraryTreeTrackCount(uuid, readCountFromRecord(counts, uuid))
          }
        } catch {
          if (isStale()) return
          for (const uuid of setListUuids) setLibraryTreeTrackCount(uuid, 0)
        }
      })()
    ])
  } finally {
    if (!isStale()) flushLibraryTreeTrackCountUpdates()
  }
}

export const libraryTreeSortRuleLabelKey = (rule: LibraryTreeSortRule) => {
  switch (rule) {
    case 'manual':
      return 'playlist.sortRuleManual'
    case 'nameAsc':
      return 'playlist.sortRuleNameAsc'
    case 'nameDesc':
      return 'playlist.sortRuleNameDesc'
    case 'countAsc':
      return 'playlist.sortRuleCountAsc'
    case 'countDesc':
      return 'playlist.sortRuleCountDesc'
    default:
      return 'playlist.sortRuleManual'
  }
}

export const libraryTreeSortRuleMenuKey = (rule: LibraryTreeSortRule) => {
  switch (rule) {
    case 'manual':
      return 'playlist.sortMenuManual'
    case 'nameAsc':
      return 'playlist.sortMenuNameAsc'
    case 'nameDesc':
      return 'playlist.sortMenuNameDesc'
    case 'countAsc':
      return 'playlist.sortMenuCountAsc'
    case 'countDesc':
      return 'playlist.sortMenuCountDesc'
    default:
      return 'playlist.sortMenuManual'
  }
}

/** 歌单区 / 选择歌单 dialog 共用的排序菜单分组 */
export const buildLibraryTreeSortMenuArr = (currentRule: LibraryTreeSortRule): IMenu[][] => {
  const check = (value: LibraryTreeSortRule): string | undefined =>
    currentRule === value ? '✓' : undefined
  return [
    [{ menuName: libraryTreeSortRuleMenuKey('manual'), shortcutKey: check('manual') }],
    [
      { menuName: libraryTreeSortRuleMenuKey('nameAsc'), shortcutKey: check('nameAsc') },
      { menuName: libraryTreeSortRuleMenuKey('nameDesc'), shortcutKey: check('nameDesc') }
    ],
    [
      { menuName: libraryTreeSortRuleMenuKey('countAsc'), shortcutKey: check('countAsc') },
      { menuName: libraryTreeSortRuleMenuKey('countDesc'), shortcutKey: check('countDesc') }
    ]
  ]
}

export const resolveLibraryTreeSortRuleFromMenuName = (
  menuName: string
): LibraryTreeSortRule | null => {
  for (const rule of LIBRARY_TREE_SORT_RULES) {
    if (menuName === libraryTreeSortRuleMenuKey(rule)) return rule
  }
  return null
}
