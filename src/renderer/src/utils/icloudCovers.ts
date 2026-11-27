import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { shallowReactive } from 'vue'
import { createCoverDisplayWorkerClient } from '@renderer/pages/modules/songsArea/SongListRows/coverDisplayWorkerClient'
import type { ISongInfo } from 'src/types/globals'
import type { IcloudPicture } from '@shared/icloudLibrary'
export interface SongCoverProvider {
  getCoverUrl: (path: string) => string | null | undefined
  fetchCoverUrl: (path: string) => Promise<string | null>
  onImgError: (path: string) => void
  setVisibleSongs: (songs: ISongInfo[]) => void
}
export function createIcloudCovers(options: {
  resolve: (path: string) => { relative: string; token: string } | null
  read: (relative: string, token: string, id: string) => Promise<IcloudPicture | null>
  resize?: (bytes: Uint8Array, format: string) => Promise<{ data: Uint8Array; format: string }>
  cancel: (id: string) => void
}) {
  const urls = shallowReactive(new Map<string, string | null>())
  const hashes = new Map<string, string>()
  const revalidate = new Set<string>()
  let display: ReturnType<typeof createCoverDisplayWorkerClient> | undefined
  const resize =
    options.resize ||
    ((bytes: Uint8Array, format: string) => {
      display ??= createCoverDisplayWorkerClient()
      return display.resize(bytes, format, 256)
    })
  const queuedPromises = new Map<
    string,
    { promise: Promise<string | null>; resolve: (value: string | null) => void }
  >()
  const pending = new Map<string, { id: string; promise: Promise<string | null> }>()
  let visible: ISongInfo[] = [],
    queue: string[] = [],
    generation = 0,
    active = 0
  const getCoverUrl = (path: string) => urls.get(path)
  const onImgError = (path: string) => {
    const url = urls.get(path)
    if (url) URL.revokeObjectURL(url)
    urls.set(path, null)
  }
  function loadCover(path: string): Promise<string | null> {
    if (!visible.some((song) => sameRendererFilePath(song.filePath, path)))
      return Promise.resolve(null)
    if (urls.has(path) && !revalidate.delete(path)) return Promise.resolve(urls.get(path) || null)
    const old = pending.get(path)
    if (old) return old.promise
    const source = options.resolve(path)
    if (!source) return Promise.resolve(null)
    const id = crypto.randomUUID(),
      version = generation
    const promise = options
      .read(source.relative, source.token, id)
      .then(async (picture) => {
        if (
          pending.get(path)?.id !== id ||
          version !== generation ||
          !visible.some((song) => sameRendererFilePath(song.filePath, path)) ||
          options.resolve(path)?.token !== source.token
        )
          return null
        let url: string | null = null
        if (
          picture &&
          ['image/png', 'image/jpeg'].includes(picture.format) &&
          picture.data.length <= 1_400_000
        ) {
          const hash = picture.hash || picture.data
          if (hashes.get(path) === hash && urls.get(path)) return urls.get(path)!
          const bytes = Uint8Array.from(atob(picture.data), (c) => c.charCodeAt(0))
          const thumbnail = await resize(bytes, picture.format)
          if (
            version !== generation ||
            pending.get(path)?.id !== id ||
            options.resolve(path)?.token !== source.token ||
            !visible.some((song) => sameRendererFilePath(song.filePath, path))
          )
            return null
          url = URL.createObjectURL(
            new Blob([new Uint8Array(thumbnail.data)], { type: thumbnail.format })
          )
          hashes.set(path, hash)
        }
        if (urls.size >= 64) {
          const first = urls.keys().next().value!
          const old = urls.get(first)
          if (old) URL.revokeObjectURL(old)
          urls.delete(first)
          hashes.delete(first)
        }
        const previous = urls.get(path)
        if (previous) URL.revokeObjectURL(previous)
        urls.set(path, url)
        return url
      })
      .catch(() => {
        if (version === generation && pending.get(path)?.id === id) onImgError(path)
        return null
      })
      .finally(() => {
        if (pending.get(path)?.id === id) pending.delete(path)
      })
    pending.set(path, { id, promise })
    return promise
  }
  function pump() {
    while (active < 2 && queue.length) {
      const path = queue.shift()!
      active++
      const queued = queuedPromises.get(path)
      void loadCover(path)
        .then((value) => {
          queued?.resolve(value)
          if (queuedPromises.get(path) === queued) queuedPromises.delete(path)
        })
        .finally(() => {
          active--
          pump()
        })
    }
  }
  function setVisibleSongs(songs: ISongInfo[], force = false) {
    for (const [path, url] of urls)
      if (!options.resolve(path)) {
        if (url) URL.revokeObjectURL(url)
        urls.delete(path)
        hashes.delete(path)
      }
    if (force) for (const song of songs) revalidate.add(song.filePath)
    for (const [path, task] of queuedPromises)
      if (!songs.some((song) => sameRendererFilePath(song.filePath, path))) {
        task.resolve(null)
        queuedPromises.delete(path)
      }
    visible = songs
    for (const [path, task] of pending)
      if (!songs.some((song) => sameRendererFilePath(song.filePath, path))) {
        options.cancel(task.id)
        pending.delete(path)
      }
    queue = songs
      .map((song) => song.filePath)
      .filter((path) => options.resolve(path) && (force || !urls.has(path)) && !pending.has(path))
    pump()
  }
  function fetchCoverUrl(path: string): Promise<string | null> {
    if (urls.has(path)) return Promise.resolve(urls.get(path) || null)
    if (
      !pending.has(path) &&
      !queue.includes(path) &&
      visible.some((song) => sameRendererFilePath(song.filePath, path)) &&
      options.resolve(path)
    ) {
      queue.push(path)
      pump()
    }
    const active = pending.get(path)
    if (active) return active.promise
    if (!queue.includes(path)) return Promise.resolve(null)
    let queued = queuedPromises.get(path)
    if (!queued) {
      let resolve!: (value: string | null) => void
      const promise = new Promise<string | null>((done) => {
        resolve = done
      })
      queued = { promise, resolve }
      queuedPromises.set(path, queued)
    }
    return queued.promise
  }
  function clear() {
    generation++
    display?.dispose()
    display = undefined
    hashes.clear()
    revalidate.clear()
    queue = []
    for (const task of queuedPromises.values()) task.resolve(null)
    queuedPromises.clear()
    for (const task of pending.values()) options.cancel(task.id)
    pending.clear()
    for (const url of urls.values()) if (url) URL.revokeObjectURL(url)
    urls.clear()
  }
  return {
    getCoverUrl,
    fetchCoverUrl,
    onImgError,
    setVisibleSongs,
    clear,
    refreshVisible: (force = false) => setVisibleSongs(visible, force)
  }
}
