import fs = require('fs-extra')
import path = require('path')
import type { BrowserWindow } from 'electron'
import store from './store'
import { log } from './log'
import { ensureEnglishCoreLibraries, getCoreFsDirName, getLibrary } from './utils'
import { syncLibraryTreeFromDisk } from './libraryTreeDb'
import { pruneOrphanedSongListCaches } from './services/cacheMaintenance'

let watcher: fs.FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null
let reconciling = false
let bulkOperationDepth = 0
let pendingBulkReconcileWindow: BrowserWindow | null = null
let mutationListener: (() => void) | null = null
let contentChangeListener: ((changedAbsPaths: string[]) => void) | null = null
let pendingContentPaths = new Set<string>()
let contentDebounceTimer: NodeJS.Timeout | null = null
let pendingCuratedContentChange = false
let watchWindow: BrowserWindow | null = null

const WATCH_DEBOUNCE_MS = 400
/** 单次 flush 最多带这么多路径：狂改几千个文件时没必要逐个上报，取样即可定位到歌单。 */
const MAX_PENDING_CONTENT_PATHS = 400

export function bindLibraryTreeMutationListener(listener: (() => void) | null): void {
  mutationListener = listener
}

/**
 * 目录内容变化监听（歌单视图快照用）。
 *
 * 与 mutationListener 的区别：那个只在"树结构变了"时响，而拖一首歌进歌单目录
 * 不改树结构，却让该歌单的视图快照过期。所以这里单独攒一份"改动过的绝对路径"，
 * 按同一个 400ms 抖动窗口 flush。
 *
 * 这里用注册钩子而不是直接 import 服务：mainWindow/index 会 import 本模块，
 * 而服务要 import mainWindow 推事件，直连就成环了。
 */
export function bindLibraryTreeContentChangeListener(
  listener: ((changedAbsPaths: string[]) => void) | null
): void {
  contentChangeListener = listener
}

const watchPathEquals = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right

const isCuratedLibraryWatchPath = (filename: string | Buffer | null | undefined): boolean => {
  const raw = String(filename || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!raw) return true
  const first = raw.split('/')[0] || ''
  const curatedName = getCoreFsDirName('CuratedLibrary')
  const recycleName = getCoreFsDirName('RecycleBin')
  if (watchPathEquals(first, curatedName) || watchPathEquals(first, '精选库')) return true
  // 删除曲目是搬进回收站；Windows 上 rename 常常只报 RecycleBin 路径
  if (watchPathEquals(first, recycleName) || watchPathEquals(first, '回收站')) return true
  return !raw.includes('/')
}

/**
 * True only while a real tree write is in flight (reconcile) or a bulk
 * maintenance section has paused scheduling. Pending debounce alone is not busy —
 * callers that need a quiet tree should discard the timer instead of blocking.
 */
export function isLibraryTreeWatcherBusy(): boolean {
  return reconciling || bulkOperationDepth > 0
}

function clearDebounceTimer() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

function clearContentDebounceTimer() {
  if (contentDebounceTimer) {
    clearTimeout(contentDebounceTimer)
    contentDebounceTimer = null
  }
}

function flushPendingContentPaths() {
  contentDebounceTimer = null
  if (pendingContentPaths.size === 0) return
  const paths = [...pendingContentPaths]
  pendingContentPaths = new Set<string>()
  if (!contentChangeListener) return
  try {
    contentChangeListener(paths)
  } catch (error) {
    log.error('[watcher] content change listener failed', error)
  }
}

/** 记下一个改动过的绝对路径，攒够抖动窗口再一次性交给监听者。 */
function queueContentChangePath(absPath: string) {
  if (!contentChangeListener || !absPath) return
  if (pendingContentPaths.size < MAX_PENDING_CONTENT_PATHS) {
    pendingContentPaths.add(absPath)
  }
  clearContentDebounceTimer()
  contentDebounceTimer = setTimeout(flushPendingContentPaths, WATCH_DEBOUNCE_MS)
}

/** Drop a scheduled reconcile that has not started yet (debounce window only). */
export function discardPendingLibraryTreeReconcile(): void {
  clearDebounceTimer()
}

/**
 * Wait until reconcile / bulk depth drain. Does not treat debounce as busy;
 * call discardPendingLibraryTreeReconcile first when preparing a mutation lock.
 */
export async function waitForLibraryTreeWatcherIdle(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (isLibraryTreeWatcherBusy()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

async function reconcileLibraryTree(window: BrowserWindow | null, fromBulk = false) {
  if (reconciling) return
  const rootDir = store.databaseDir
  if (!rootDir) return
  reconciling = true
  const curatedContentChanged = pendingCuratedContentChange
  pendingCuratedContentChange = false
  try {
    await ensureEnglishCoreLibraries(rootDir)
    const result = await syncLibraryTreeFromDisk(rootDir, {
      coreDirNames: {
        FilterLibrary: getCoreFsDirName('FilterLibrary'),
        CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
        SetLibrary: getCoreFsDirName('SetLibrary'),
        MixtapeLibrary: getCoreFsDirName('MixtapeLibrary'),
        RecordingLibrary: getCoreFsDirName('RecordingLibrary'),
        RecycleBin: getCoreFsDirName('RecycleBin')
      },
      audioExtensions: store.settingConfig?.audioExt
    })
    const treeChanged = result.added + result.removed + result.updated > 0
    if (treeChanged) {
      await pruneOrphanedSongListCaches(rootDir)
      const tree = await getLibrary({ skipSync: true })
      window?.webContents.send('library-tree-updated', tree)
    }
    if (!fromBulk && (treeChanged || curatedContentChanged)) {
      mutationListener?.()
    }
  } catch (error) {
    log.error('[watcher] library reconcile failed', error)
  } finally {
    reconciling = false
  }
}

function scheduleReconcile(window: BrowserWindow | null, fromBulk = false) {
  clearDebounceTimer()
  if (bulkOperationDepth > 0) {
    pendingBulkReconcileWindow = window
    return
  }
  debounceTimer = setTimeout(() => {
    void reconcileLibraryTree(window, fromBulk)
  }, WATCH_DEBOUNCE_MS)
}

export function beginLibraryTreeWatcherBulkOperation(): () => void {
  bulkOperationDepth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    bulkOperationDepth = Math.max(0, bulkOperationDepth - 1)
    if (bulkOperationDepth > 0 || !pendingBulkReconcileWindow) return
    const window = pendingBulkReconcileWindow
    pendingBulkReconcileWindow = null
    scheduleReconcile(window, true)
  }
}

/**
 * 精选库内容变了（含删除后文件落在回收站）。不是把回收站同步上云。
 * 必须立刻通知 mutationListener：delSongs 会包在 bulk 里，结束时 fromBulk
 * 对账不会触发同步，只靠 reconcile 会把这次删除吃掉。
 */
export function notifyLibraryFsChanged(absPath?: string): void {
  pendingCuratedContentChange = true
  mutationListener?.()
  if (absPath) queueContentChangePath(path.resolve(String(absPath)))
  scheduleReconcile(watchWindow)
}

export function startLibraryTreeWatcher(window: BrowserWindow | null): void {
  watchWindow = window
  if (watcher) return
  const rootDir = store.databaseDir
  if (!rootDir) return
  const libraryRoot = path.join(rootDir, 'library')
  if (!fs.pathExistsSync(libraryRoot)) return
  try {
    watcher = fs.watch(libraryRoot, { recursive: true }, (_event, filename) => {
      if (isCuratedLibraryWatchPath(filename)) pendingCuratedContentChange = true
      const relative = String(filename || '')
      if (relative) queueContentChangePath(path.join(libraryRoot, relative))
      scheduleReconcile(window)
    })
    watcher.on('error', (error) => {
      log.error('[watcher] library watcher error', error)
    })
  } catch (error) {
    log.error('[watcher] library watcher start failed', error)
  }
}

export function stopLibraryTreeWatcher(): void {
  clearDebounceTimer()
  clearContentDebounceTimer()
  pendingContentPaths = new Set<string>()
  pendingCuratedContentChange = false
  watchWindow = null
  if (!watcher) return
  try {
    watcher.close()
  } catch {}
  watcher = null
}
