import { watch as watchDirectory, type FSWatcher } from 'node:fs'
import { createIcloudMetadataCache, nativeCoverReader } from '../services/icloudLibrary/metadata'
import { createIcloudWaveformPreviewCache } from '../services/icloudLibrary/waveformPreview'
import { createFolderChildInspector } from '../services/icloudLibrary/folderChildren'
import {
  defaultIcloudConfig,
  migrateIcloudConfig,
  resolveIcloudDriveRoot,
  type IcloudConfig
} from '../services/icloudLibrary/config'
import { localizeSong, nativeLocalize } from '../services/icloudLibrary/localization'
import { evictLocalCopies, nativeEvict } from '../services/icloudLibrary/evictLocal'
import {
  loadExternalAnalysisCacheEntry,
  registerExternalAnalysisContext,
  touchExternalAnalysisDevice
} from '../libraryCacheDb/externalAnalysisCache'
import { randomUUID } from 'node:crypto'
import { icloudPlayback } from '../services/icloudLibrary/playback'
import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  icloudVisibility,
  toIcloudDownloadProgressEvent,
  type IcloudCopyRequest,
  type IcloudCopyItem,
  type IcloudResult,
  type IcloudState
} from '../../shared/icloudLibrary'
import {
  boundedPath,
  copySong,
  errorCode,
  isInside,
  browseIcloudDirectory,
  readMacResidency,
  requireLocal
} from '../services/icloudLibrary/files'
import { localPlaylistRelativePath } from '../services/icloudLibrary/playlist'
import { loadLibraryNodes } from '../libraryTreeDb'
import { getCoreFsDirName } from '../coreLibraries'
import store from '../store'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'
import { beginImportSongsActivity } from '../services/libraryMerge/operationActivity'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { appendSongListTrackNumbers } from '../services/playlistTrackNumbers'
import { stampPlaylistSongsAddedAt } from '../services/playlistAddedAt'

export function registerIcloudLibraryHandlers() {
  const watched = new Map<
    number,
    { key: string; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> }
  >()
  const observed = new Set<number>()
  const stopWatch = (owner: number) => {
    const active = watched.get(owner)
    active?.watcher.close()
    if (active?.timer) clearTimeout(active.timer)
    watched.delete(owner)
  }
  const stopWatches = () => {
    for (const owner of watched.keys()) stopWatch(owner)
  }
  let copying = false
  let destination: {
    token: string
    root: string
    directory: string
    expires: number
    owner: number
  } | null = null
  const cloudRoot = () =>
    path.join(app.getPath('home'), 'Library/Mobile Documents/com~apple~CloudDocs')
  const configPath = () => path.join(app.getPath('userData'), 'icloud-library.json')
  const metadata = createIcloudMetadataCache(readMacResidency)
  const covers = createIcloudMetadataCache(readMacResidency, nativeCoverReader, 32)
  const waveforms = createIcloudWaveformPreviewCache(
    readMacResidency,
    path.join(app.getPath('userData'), 'icloud-waveform-preview')
  )
  const folderChildren = createFolderChildInspector()
  let rootToken = randomUUID()
  const jobs = new Map<string, AbortController>()
  const config = async (): Promise<IcloudConfig | null> => {
    try {
      return migrateIcloudConfig(JSON.parse(await fs.readFile(configPath(), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  let configWrite = Promise.resolve()
  const persistConfig = (saved: IcloudConfig, onlyIfMissing = false) => {
    const operation = configWrite.then(async () => {
      if (onlyIfMissing) {
        const existing = await config()
        if (existing) {
          const raw = JSON.parse(await fs.readFile(configPath(), 'utf8')) as { version?: unknown }
          if (raw.version === 3) return
          saved = existing
        }
      }
      await fs.mkdir(path.dirname(configPath()), { recursive: true })
      const temp = `${configPath()}.tmp`
      await fs.writeFile(temp, JSON.stringify(saved), { mode: 0o600 })
      await fs.rename(temp, configPath())
    })
    configWrite = operation.catch(() => {})
    return operation
  }
  const saveFolder = async (relativeFolder: string) => {
    await persistConfig(
      relativeFolder
        ? { ...defaultIcloudConfig(), legacyFolder: relativeFolder }
        : defaultIcloudConfig()
    )
    for (const controller of jobs.values()) controller.abort()
    jobs.clear()
    stopWatches()
    rootToken = randomUUID()
    icloudPlayback.clear()
    destination = null
    folderChildren.clear()
    metadata.clear()
    covers.clear()
  }
  let rootIdentity = ''
  const selectedRoot = async () => {
    if (process.platform !== 'darwin') throw new Error('unsupported')
    const root = await resolveIcloudDriveRoot(cloudRoot(), readMacResidency)
    const info = await fs.lstat(root)
    const identity = `${root}:${info.dev}:${info.ino}`
    if (rootIdentity && identity !== rootIdentity) {
      for (const controller of jobs.values()) controller.abort()
      jobs.clear()
      stopWatches()
      rootToken = randomUUID()
      icloudPlayback.clear()
      destination = null
      folderChildren.clear()
      metadata.clear()
      covers.clear()
    }
    rootIdentity = identity
    return root
  }
  const state = async (): Promise<IcloudState> => {
    const supported = process.platform === 'darwin'
    if (!supported)
      return { supported, visible: false, available: false, configured: false, folder: '' }
    const saved = await config()
    let detected = false,
      available = false
    try {
      const root = await selectedRoot()
      detected = true
      await requireLocal(root, readMacResidency)
      await fs.access(root, fs.constants.R_OK)
      available = true
    } catch {
      /* Keep previously configured iCloud visible while offline. */
    }
    return {
      supported,
      visible: icloudVisibility(supported, detected, !!saved),
      available,
      configured: !!saved,
      folder: '',
      preferredDirectory: saved?.legacyFolder,
      rootToken
    }
  }
  const beginJob = (event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('invalid')
    const key = `${event.sender.id}:${id}`
    if (jobs.has(key) || jobs.size > 16) throw new Error('busy')
    const controller = new AbortController()
    jobs.set(key, controller)
    const destroyed = () => controller.abort()
    event.sender.once?.('destroyed', destroyed)
    return {
      signal: controller.signal,
      finish: () => {
        jobs.delete(key)
        event.sender.removeListener?.('destroyed', destroyed)
      }
    }
  }
  const localize = (
    event: IpcMainInvokeEvent,
    root: string,
    relative: string,
    requestId: string,
    signal: AbortSignal
  ) =>
    localizeSong({
      root,
      relative,
      residency: readMacResidency,
      native: nativeLocalize,
      signal,
      status: (status, percent) => {
        if (!event.sender.isDestroyed())
          event.sender.send(
            'icloud:download-progress',
            toIcloudDownloadProgressEvent(requestId, relative, status, percent)
          )
      }
    })
  const handle = <T>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T>
  ) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IcloudResult<T>> => {
      try {
        return { ok: true, value: await fn(event, ...args) }
      } catch (error) {
        return { ok: false, error: errorCode(error) }
      }
    })
  }
  const text = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('invalid')
    return value
  }
  handle('icloud:state', async () => state())
  handle('icloud:choose-folder', async () => {
    if (process.platform !== 'darwin') throw new Error('unsupported')
    if (copying) throw new Error('busy')
    const root = await boundedPath(cloudRoot(), '', readMacResidency)
    await requireLocal(root, readMacResidency)
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: root })
    if (result.canceled || !result.filePaths[0]) return null
    if (copying) throw new Error('busy')
    const chosen = result.filePaths[0]
    if (!isInside(root, chosen)) throw new Error('boundary')
    const relativeFolder = path.relative(root, chosen)
    const selected = await boundedPath(root, relativeFolder, readMacResidency)
    await requireLocal(selected, readMacResidency)
    if (!(await fs.lstat(selected)).isDirectory()) throw new Error('invalid')
    await saveFolder(relativeFolder)
    return state()
  })
  handle('icloud:use-default-folder', async () => {
    if (process.platform !== 'darwin') throw new Error('unsupported')
    if (copying) throw new Error('busy')
    await saveFolder('')
    return state()
  })
  handle('icloud:choose-destination', async (event, directoryInput) => {
    if (copying) throw new Error('busy')
    const root = await selectedRoot()
    const selectionToken = rootToken
    const current = await boundedPath(root, text(directoryInput), readMacResidency)
    await requireLocal(current, readMacResidency)
    const choice = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: current
    })
    if (choice.canceled || !choice.filePaths[0]) return null
    if (copying) throw new Error('busy')
    const activeRoot = await selectedRoot()
    if (root !== activeRoot || selectionToken !== rootToken) throw new Error('boundary')
    if (!isInside(root, choice.filePaths[0])) throw new Error('boundary')
    const directory = path.relative(root, choice.filePaths[0])
    const chosen = await boundedPath(root, directory, readMacResidency)
    await requireLocal(chosen, readMacResidency)
    if (!(await fs.lstat(chosen)).isDirectory()) throw new Error('invalid')
    const token = randomUUID()
    destination = {
      token,
      root,
      directory,
      expires: Date.now() + 10 * 60 * 1000,
      owner: event.sender.id
    }
    return { directory, token, rootToken }
  })
  handle('icloud:authorize-destination', async (event, directoryInput, tokenInput) => {
    if (copying) throw new Error('busy')
    if (tokenInput !== rootToken) throw new Error('boundary')
    const directory = text(directoryInput),
      root = await selectedRoot()
    const chosen = await boundedPath(root, directory, readMacResidency)
    await requireLocal(chosen, readMacResidency)
    if (!(await fs.lstat(chosen)).isDirectory()) throw new Error('invalid')
    const activeRoot = await selectedRoot()
    if (tokenInput !== rootToken || root !== activeRoot) throw new Error('boundary')
    const token = randomUUID()
    destination = {
      token,
      root,
      directory,
      expires: Date.now() + 10 * 60 * 1000,
      owner: event.sender.id
    }
    return { token, directory, rootToken }
  })
  handle(
    'icloud:list',
    async (_event, relativeInput, offsetInput, queryInput = '', tokenInput?) => {
      if (tokenInput !== undefined && tokenInput !== rootToken) throw new Error('boundary')
      const relative = text(relativeInput)
      const offset =
        typeof offsetInput === 'number' && Number.isInteger(offsetInput) && offsetInput >= 0
          ? offsetInput
          : 0
      const token = rootToken
      const root = await selectedRoot()
      const query = text(queryInput).toLocaleLowerCase()
      const data = await browseIcloudDirectory(root, relative, readMacResidency)
      const all = data.entries.filter(
        (entry) => !entry.directory && entry.name.toLocaleLowerCase().includes(query)
      )
      if (token !== rootToken) throw new Error('boundary')
      await persistConfig(defaultIcloudConfig(), true)
      const entries = offsetInput === null ? all : all.slice(offset, offset + 200)
      for (let index = 0; index < entries.length; index += 8)
        await Promise.all(
          entries.slice(index, index + 8).map(async (entry) => {
            entry.residency = await readMacResidency(path.join(root, entry.relativePath))
          })
        )
      if (token !== rootToken) throw new Error('boundary')
      return { entries, total: all.length, rootToken, directory: relative }
    }
  )
  handle('icloud:unwatch-directory', async (event) => {
    stopWatch(event.sender.id)
    return true
  })
  handle('icloud:watch-directory', async (event, relativeInput, tokenInput) => {
    const relative = text(relativeInput),
      token = rootToken,
      root = await selectedRoot()
    if (tokenInput !== rootToken || token !== rootToken) throw new Error('boundary')
    const folder = await boundedPath(root, relative, readMacResidency)
    await requireLocal(folder, readMacResidency)
    if (!(await fs.stat(folder)).isDirectory() || token !== rootToken) throw new Error('boundary')
    const owner = event.sender.id,
      key = `${token}|${relative}`
    if (watched.get(owner)?.key === key) return true
    stopWatch(owner)
    const watcher = watchDirectory(folder, { persistent: false }, () => {
      const active = watched.get(owner)
      if (!active || active.key !== key || active.timer) return
      active.timer = setTimeout(() => {
        active.timer = undefined
        if (token === rootToken && !event.sender.isDestroyed())
          event.sender.send('icloud:directory-changed', { rootToken: token, directory: relative })
      }, 250)
    })
    watched.set(owner, { key, watcher })
    // Notifications carry no filesystem names; every consumer refresh revalidates root/path.
    watcher.on('error', () => {
      if (watched.get(owner)?.watcher === watcher) stopWatch(owner)
    })
    if (!observed.has(owner)) {
      observed.add(owner)
      event.sender.once('destroyed', () => {
        stopWatch(owner)
        observed.delete(owner)
      })
    }
    return true
  })
  handle('icloud:folders', async (_event, relativeInput, tokenInput) => {
    if (tokenInput !== rootToken) throw new Error('boundary')
    const token = rootToken,
      directory = text(relativeInput),
      root = await selectedRoot()
    const data = await browseIcloudDirectory(root, directory, readMacResidency)
    const entries = data.entries.filter((entry) => entry.directory)
    for (let index = 0; index < entries.length; index += 8)
      await Promise.all(
        entries.slice(index, index + 8).map(async (entry) => {
          entry.residency = await readMacResidency(path.join(root, entry.relativePath))
        })
      )
    await folderChildren.inspect(root, entries, readMacResidency)
    const activeRoot = await selectedRoot()
    if (token !== rootToken || root !== activeRoot) throw new Error('boundary')
    await persistConfig(defaultIcloudConfig(), true)
    return { entries, directory, rootToken, missingRoot: data.missingRoot }
  })
  for (const channel of ['icloud:metadata', 'icloud:cover'])
    handle(channel, async (event, pathsInput, tokenInput, requestInput) => {
      if (tokenInput !== rootToken) throw new Error('boundary')
      if (
        !Array.isArray(pathsInput) ||
        !pathsInput.length ||
        pathsInput.length > (channel === 'icloud:cover' ? 1 : 16)
      )
        throw new Error('invalid')
      const paths = [...new Set(pathsInput.map(text))]
      if (
        paths.some(
          (value) =>
            path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')
        )
      )
        throw new Error('boundary')
      const job = beginJob(event, requestInput)
      try {
        const root = await selectedRoot()
        if (tokenInput !== rootToken) throw new Error('boundary')
        const result = await (channel === 'icloud:cover' ? covers : metadata).read(
          root,
          paths,
          rootToken,
          job.signal,
          rootIdentity
        )
        const current = await selectedRoot()
        if (job.signal.aborted || tokenInput !== rootToken || current !== root)
          throw new Error('boundary')
        return channel === 'icloud:cover' ? result[0]?.metadata?.picture || null : result
      } finally {
        job.finish()
      }
    })
  handle('icloud:waveform-preview', async (event, pathsInput, tokenInput, requestInput) => {
    if (tokenInput !== rootToken) throw new Error('boundary')
    if (!Array.isArray(pathsInput) || pathsInput.length !== 1) throw new Error('invalid')
    const paths = [...new Set(pathsInput.map(text))]
    if (
      paths.length !== 1 ||
      paths.some(
        (value) =>
          path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')
      )
    )
      throw new Error('boundary')
    const job = beginJob(event, requestInput)
    try {
      const root = await selectedRoot()
      if (tokenInput !== rootToken) throw new Error('boundary')
      const result = await waveforms.read(root, paths, rootToken, job.signal, rootIdentity)
      const current = await selectedRoot()
      if (job.signal.aborted || tokenInput !== rootToken || current !== root)
        throw new Error('boundary')
      return result[0]?.data || null
    } finally {
      job.finish()
    }
  })
  handle('icloud:cancel', async (event, idInput) => {
    const id = text(idInput)
    jobs.get(`${event.sender.id}:${id}`)?.abort()
  })
  handle('icloud:prepare-play', async (event, relativeInput, requestInput) => {
    const input = requestInput as { requestId?: unknown; rootToken?: unknown } | null
    if (!input || input.rootToken !== rootToken) throw new Error('boundary')
    const job = beginJob(event, input.requestId)
    const token = rootToken
    try {
      const root = await selectedRoot()
      const relative = await localize(
        event,
        root,
        text(relativeInput),
        text(input.requestId),
        job.signal
      )
      if (job.signal.aborted) throw new Error('cancelled')
      const activeRoot = await selectedRoot()
      if (token !== rootToken || root !== activeRoot) throw new Error('boundary')
      try {
        const file = await boundedPath(root, relative, readMacResidency)
        registerExternalAnalysisContext({
          sourceKind: 'icloud',
          sourceId: 'icloud',
          rootPath: root,
          relativePath: relative,
          filePath: file
        })
      } catch {
        // 分析登记失败不挡住这一次播放。
      }
      return await icloudPlayback.issue(root, relative)
    } finally {
      job.finish()
    }
  })
  handle('icloud:prepare-local', async (event, relativeInput, requestInput) => {
    const input = requestInput as { requestId?: unknown; rootToken?: unknown } | null
    if (!input || input.rootToken !== rootToken) throw new Error('boundary')
    const job = beginJob(event, input.requestId)
    const token = rootToken
    try {
      const root = await selectedRoot()
      const relative = await localize(
        event,
        root,
        text(relativeInput),
        text(input.requestId),
        job.signal
      )
      if (job.signal.aborted) throw new Error('cancelled')
      const file = await boundedPath(root, relative, readMacResidency)
      await requireLocal(file, readMacResidency)
      const activeRoot = await selectedRoot()
      if (token !== rootToken || root !== activeRoot) throw new Error('boundary')
      if (!(await fs.lstat(file)).isFile()) throw new Error('invalid')
      return { relative, filePath: file }
    } finally {
      job.finish()
    }
  })
  handle('icloud:evict-local', async (_event, pathsInput, tokenInput) => {
    if (tokenInput !== rootToken) throw new Error('boundary')
    if (!Array.isArray(pathsInput) || pathsInput.length === 0 || pathsInput.length > 500)
      throw new Error('invalid')
    const relatives = [
      ...new Set(
        pathsInput.map((value) => {
          const relative = text(value)
          if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
            throw new Error('boundary')
          return relative
        })
      )
    ]
    const root = await selectedRoot()
    const token = rootToken
    const results = await evictLocalCopies({
      root,
      relatives,
      residency: readMacResidency,
      native: nativeEvict,
      // 播放票会留十几个小时，只表示准备过播放。文件仍被打开时，系统用 EBUSY 回报 playing。
      playing: () => false
    })
    const activeRoot = await selectedRoot()
    if (token !== rootToken || root !== activeRoot) throw new Error('boundary')
    for (const item of results) {
      if (item.status === 'evicted') icloudPlayback.revoke(root, item.relative)
    }
    return results
  })
  handle('icloud:bind-analysis', async (_event, pathsInput, tokenInput) => {
    if (tokenInput !== rootToken) throw new Error('boundary')
    if (!Array.isArray(pathsInput) || pathsInput.length === 0 || pathsInput.length > 500)
      throw new Error('invalid')
    const relatives = [
      ...new Set(
        pathsInput.map((value) => {
          const relative = text(value)
          if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
            throw new Error('boundary')
          return relative
        })
      )
    ]
    const root = await selectedRoot()
    const token = rootToken
    await touchExternalAnalysisDevice('icloud', 'icloud', root)
    const items: Array<{
      relative: string
      filePath: string
      key?: string
      beatGridMap?: unknown
    }> = []
    for (const relative of relatives) {
      try {
        const file = await boundedPath(root, relative, readMacResidency)
        if ((await readMacResidency(file)) !== 'local') continue
        const context = registerExternalAnalysisContext({
          sourceKind: 'icloud',
          sourceId: 'icloud',
          rootPath: root,
          relativePath: relative,
          filePath: file
        })
        if (!context) continue
        const stat = await fs.stat(file)
        const cached = await loadExternalAnalysisCacheEntry(context, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        const info = cached?.info
        items.push({
          relative,
          filePath: file,
          ...(typeof info?.key === 'string' && info.key ? { key: info.key } : {}),
          ...(info?.beatGridMap ? { beatGridMap: info.beatGridMap } : {})
        })
      } catch {
        continue
      }
    }
    if (token !== rootToken || (await selectedRoot()) !== root) throw new Error('boundary')
    return items
  })
  handle('icloud:reveal', async (_event, relativeInput, tokenInput) => {
    if (tokenInput !== rootToken) throw new Error('boundary')
    const root = await selectedRoot()
    const file = await boundedPath(root, text(relativeInput), readMacResidency)
    const activeRoot = await selectedRoot()
    if (tokenInput !== rootToken || root !== activeRoot) throw new Error('boundary')
    shell.showItemInFolder(file)
  })
  handle('icloud:copy', async (event, requestInput) => {
    if (copying) throw new Error('busy')
    if (!requestInput || typeof requestInput !== 'object') throw new Error('invalid')
    const input = requestInput as Partial<IcloudCopyRequest>
    if (
      (input.direction !== 'to-cloud' && input.direction !== 'to-local') ||
      !Array.isArray(input.paths) ||
      !input.paths.length ||
      input.paths.length > 500
    )
      throw new Error('invalid')
    const paths = [...new Set(input.paths.map(text))]
    const uuid = text(input.localPlaylistUuid)
    const directory = text(input.cloudDirectory)
    if (input.direction === 'to-local' && input.rootToken !== rootToken) throw new Error('boundary')
    if (
      input.direction === 'to-cloud' &&
      input.rootToken !== undefined &&
      input.rootToken !== rootToken
    )
      throw new Error('boundary')
    if (
      input.direction === 'to-cloud' &&
      directory !== '' &&
      input.rootToken !== rootToken &&
      input.destinationToken === undefined
    )
      throw new Error('boundary')
    assertLibraryMergeMutationAllowed()
    const scopeToken = rootToken
    const job = beginJob(event, input.requestId || randomUUID())
    copying = true
    const finish = beginImportSongsActivity()
    try {
      if (!store.databaseDir) throw new Error('unavailable')
      const databaseRoot = await fs.realpath(store.databaseDir)
      const relativePlaylist = localPlaylistRelativePath(loadLibraryNodes() || [], uuid, [
        getCoreFsDirName('FilterLibrary'),
        getCoreFsDirName('CuratedLibrary')
      ])
      const local = await boundedPath(databaseRoot, relativePlaylist)
      const cloud = await selectedRoot()
      const requireCurrentRoot = async () => {
        const current = await selectedRoot()
        if (scopeToken !== rootToken || cloud !== current) throw new Error('boundary')
        if (job.signal.aborted) throw new Error('cancelled')
      }
      await requireCurrentRoot()
      if (input.direction === 'to-cloud') {
        if (
          !destination ||
          destination.token !== input.destinationToken ||
          destination.root !== cloud ||
          destination.directory !== directory ||
          destination.owner !== event.sender.id ||
          destination.expires < Date.now()
        )
          throw new Error('destination')
        destination = null
        const target = await boundedPath(cloud, directory, readMacResidency)
        await requireLocal(target, readMacResidency)
        if (!(await fs.lstat(target)).isDirectory()) throw new Error('invalid')
        await requireCurrentRoot()
        await persistConfig(defaultIcloudConfig(), true)
      }
      const targetCloud = await boundedPath(cloud, directory, readMacResidency)
      await requireLocal(targetCloud, readMacResidency)
      if (isInside(cloud, local) || isInside(local, cloud)) throw new Error('boundary')
      const results: IcloudCopyItem[] = []
      for (const file of paths) {
        let item: IcloudCopyItem
        if (
          input.direction === 'to-cloud' &&
          (!path.isAbsolute(file) || !isInside(local, file, false))
        ) {
          item = { source: file, status: 'failed', error: 'boundary' }
        } else {
          try {
            await requireCurrentRoot()
            const relative =
              input.direction === 'to-local'
                ? await localize(event, cloud, file, input.requestId || '', job.signal)
                : file
            await requireCurrentRoot()
            item = await copySong({
              sourceRoot: input.direction === 'to-cloud' ? local : cloud,
              sourceRelative:
                input.direction === 'to-cloud' ? path.relative(local, file) : relative,
              targetRoot: input.direction === 'to-cloud' ? cloud : local,
              targetRelative: input.direction === 'to-cloud' ? directory : '',
              residency: readMacResidency,
              signal: job.signal
            })
            if (item.status === 'failed' && job.signal.aborted) item.error = 'cancelled'
          } catch (error) {
            item = { source: file, status: 'failed', error: errorCode(error) }
          }
        }
        results.push(item)
        if (!event.sender.isDestroyed())
          event.sender.send('icloud:copy-progress', {
            done: results.length,
            total: paths.length,
            current: path.basename(file)
          })
      }
      if (input.direction === 'to-local') {
        const added = results
          .filter((item) => item.status === 'copied')
          .map((item) => item.destination!)
        if (added.length) {
          // Preserve the normal FRKB playlist ordering / added-at bookkeeping.
          try {
            await appendSongListTrackNumbers({ listRoot: local, appendedFilePaths: added })
            await stampPlaylistSongsAddedAt({ listRoot: local, filePaths: added })
          } catch {
            for (const item of results) if (item.status === 'copied') item.warning = 'metadata'
          }
          markGlobalSongSearchDirty('icloud-import', { songListUUID: uuid })
          if (!event.sender.isDestroyed()) event.sender.send('importFinished', uuid)
        }
      }
      return results
    } finally {
      finish()
      job.finish()
      copying = false
    }
  })
}
