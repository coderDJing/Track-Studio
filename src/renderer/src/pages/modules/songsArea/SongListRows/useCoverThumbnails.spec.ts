import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, shallowRef } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import { useCoverThumbnails } from './useCoverThumbnails'

const lifecycle = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  unmounted: [] as Array<() => void>
}))
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: (callback: () => void) => lifecycle.mounted.push(callback),
  onUnmounted: (callback: () => void) => lifecycle.unmounted.push(callback)
}))
vi.mock('./coverDisplayWorkerClient', () => ({
  createCoverDisplayWorkerClient: () => ({ dispose: vi.fn(), resize: vi.fn() })
}))

type CoverResponse = { dataUrl: string } | null
type CoverRequest = {
  channel: string
  filePath: string
  completed: boolean
  resolve: (response: CoverResponse) => void
}
const requests: CoverRequest[] = []
const pathFor = (index: number) => `C:\\music\\song-${index}.mp3`
const songFor = (index: number, extra: Partial<ISongInfo> = {}): ISongInfo => ({
  filePath: pathFor(index),
  fileName: `song-${index}.mp3`,
  fileFormat: 'mp3',
  cover: null,
  title: undefined,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  ...extra
})

beforeEach(() => {
  requests.length = 0
  lifecycle.mounted.length = 0
  lifecycle.unmounted.length = 0
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        send: vi.fn(),
        invoke: vi.fn((channel: string, filePath: string) => {
          return new Promise<CoverResponse>((resolve) => {
            const request: CoverRequest = {
              channel,
              filePath,
              completed: false,
              resolve: (response) => {
                request.completed = true
                resolve(response)
              }
            }
            requests.push(request)
          })
        })
      }
    }
  })
})
afterEach(() => {
  for (const callback of lifecycle.unmounted) callback()
  vi.unstubAllGlobals()
})

const mountCovers = (initialSongs: ISongInfo[], initialStart: number, count: number) => {
  const songs = shallowRef(initialSongs)
  const startIndex = ref(initialStart)
  const endIndex = computed(() => startIndex.value + count)
  const visibleSongsWithIndex = computed(() =>
    songs.value.slice(startIndex.value, endIndex.value).map((song, offset) => ({
      song,
      idx: startIndex.value + offset
    }))
  )
  const covers = useCoverThumbnails({
    songs,
    visibleSongsWithIndex,
    startIndex,
    endIndex,
    actualStartIndex: startIndex,
    actualEndIndex: endIndex,
    visibleCount: ref(count),
    sessionIdentity: ref('large-playlist'),
    platform: ref('win32')
  })
  for (const callback of lifecycle.mounted) callback()
  return { covers, songs, startIndex }
}

const flush = async () => {
  await nextTick()
  await nextTick()
}
const completeRequest = async (request: CoverRequest, suffix = 'cover') => {
  request.resolve({ dataUrl: `data:image/png;base64,${suffix}:${request.filePath}` })
  await flush()
}
const completeAll = async () => {
  for (const request of requests) {
    if (!request.completed) await completeRequest(request)
  }
}

describe('song cover work follows the current viewport', () => {
  it('reads only the viewport and prefetch rows in a 50,000-song playlist', async () => {
    const reads: number[] = []
    const songs = Array.from({ length: 50_000 }, (_, index) => {
      const song = songFor(index)
      Object.defineProperty(song, 'filePath', {
        get: () => {
          reads.push(index)
          return pathFor(index)
        }
      })
      return song
    })
    mountCovers(songs, 45_000, 20)
    await completeAll()

    expect(requests).toHaveLength(60)
    expect(reads.length).toBeLessThan(2_000)
    expect(reads.every((index) => index >= 44_980 && index < 45_040)).toBe(true)
    expect(requests.slice(0, 20).map((request) => request.filePath)).toEqual(
      Array.from({ length: 20 }, (_, offset) => pathFor(45_000 + offset))
    )
  })

  it('drops obsolete queued work after fast jumps and lets the newest viewport run next', async () => {
    const { covers, startIndex } = mountCovers(
      Array.from({ length: 1_000 }, (_, index) => songFor(index)),
      0,
      20
    )
    expect(requests.map((request) => request.filePath)).toEqual(
      Array.from({ length: 6 }, (_, index) => pathFor(index))
    )
    startIndex.value = 400
    await flush()
    startIndex.value = 800
    await flush()
    await completeAll()

    expect(requests[6].filePath).toBe(pathFor(800))
    expect(requests.slice(6).map((request) => request.filePath)).toEqual([
      ...Array.from({ length: 20 }, (_, offset) => pathFor(800 + offset)),
      ...Array.from({ length: 20 }, (_, offset) => pathFor(780 + offset)),
      ...Array.from({ length: 20 }, (_, offset) => pathFor(820 + offset))
    ])
    expect(covers.getCoverUrl(pathFor(400))).toBeUndefined()
    startIndex.value = 400
    await flush()
    await completeAll()
    expect(covers.getCoverUrl(pathFor(400))).toContain(pathFor(400))
  })

  it('demotes the old visible queue behind rows that are now visible', async () => {
    const { startIndex } = mountCovers(
      Array.from({ length: 200 }, (_, index) => songFor(index)),
      20,
      20
    )
    startIndex.value = 40
    await flush()
    await completeAll()

    expect(requests.slice(6, 26).map((request) => request.filePath)).toEqual(
      Array.from({ length: 20 }, (_, offset) => pathFor(40 + offset))
    )
  })

  it('retains desktop and USB cover sources for queued and explicit preview requests', async () => {
    const songs = Array.from({ length: 100 }, (_, index) => songFor(index))
    songs[8] = songFor(8, {
      externalSourceKind: 'desktop',
      pioneerCoverPath: 'C:\\rekordbox\\desktop-cover.jpg'
    })
    songs[80] = songFor(80, {
      externalSourceKind: 'usb',
      pioneerCoverPath: 'G:\\PIONEER\\usb-cover.jpg'
    })
    const { covers } = mountCovers(songs, 0, 10)
    const preview = covers.fetchCoverUrl('c:/MUSIC/SONG-80.mp3')
    await completeAll()
    await preview

    expect(
      requests.find((request) => request.filePath === songs[8].pioneerCoverPath)?.channel
    ).toBe('rekordbox-desktop-library:get-cover-thumb')
    expect(
      requests.find((request) => request.filePath === songs[80].pioneerCoverPath)?.channel
    ).toBe('pioneer-device-library:get-cover-thumb')
    expect(covers.getCoverUrl(pathFor(80))).toContain('usb-cover.jpg')
  })

  it('uses the latest metadata row and ignores an invalidated response for the same path', async () => {
    const { covers, songs } = mountCovers([songFor(0)], 0, 1)
    const obsolete = requests[0]
    songs.value = [
      songFor(0, {
        externalSourceKind: 'desktop',
        pioneerCoverPath: 'C:\\rekordbox\\updated-cover.jpg'
      })
    ]
    emitter.emit('songMetadataUpdated', { filePath: pathFor(0) })
    expect(requests[1].channel).toBe('rekordbox-desktop-library:get-cover-thumb')
    expect(requests[1].filePath).toBe('C:\\rekordbox\\updated-cover.jpg')
    await completeRequest(obsolete, 'obsolete')
    expect(covers.getCoverUrl(pathFor(0))).toBeUndefined()
    await completeRequest(requests[1], 'current')
    expect(covers.getCoverUrl(pathFor(0))).toContain('current:')
  })

  it('clears the old identity on rename without caching a late response under it', async () => {
    const { covers, songs } = mountCovers([songFor(0)], 0, 1)
    const obsolete = requests[0]
    songs.value = [songFor(1)]
    emitter.emit('songMetadataUpdated', { oldFilePath: pathFor(0), filePath: pathFor(1) })
    await completeRequest(obsolete, 'obsolete')
    await completeAll()

    expect(covers.getCoverUrl(pathFor(0))).toBeUndefined()
    expect(covers.getCoverUrl(pathFor(1))).toContain(pathFor(1))
    expect(requests.filter((request) => request.filePath === pathFor(1))).toHaveLength(1)
  })
})
