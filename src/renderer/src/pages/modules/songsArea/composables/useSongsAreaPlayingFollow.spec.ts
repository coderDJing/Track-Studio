// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/useSongsAreaPlayingFollow.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, effectScope } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { useSongsAreaPlayingFollow } from './useSongsAreaPlayingFollow'

const scopes: ReturnType<typeof effectScope>[] = []
const song = (filePath: string, setItemId?: string, mixtapeItemId?: string) =>
  ({ filePath, setItemId, mixtapeItemId }) as ISongInfo
const setup = (
  songs: ISongInfo[],
  kind: 'normal' | 'set' | 'mixtape' = 'normal',
  pane: 'single' | 'left' | 'right' = 'single'
) => {
  const runtime = useRuntimeStore()
  runtime.setting.platform = 'win32'
  runtime.mainWindowBrowseMode = 'horizontal'
  const state = runtime.songsAreaPanels.panes[pane]
  state.songListUUID = 'visible-list'
  state.songInfoArr = songs
  const getRowKey = (item: ISongInfo) =>
    kind === 'set' && item.setItemId
      ? item.setItemId
      : kind === 'mixtape' && item.mixtapeItemId
        ? item.mixtapeItemId
        : item.filePath
  const scroll = vi.fn()
  const scope = effectScope()
  scopes.push(scope)
  const follow = scope.run(() =>
    useSongsAreaPlayingFollow({
      runtime,
      songsAreaState: state,
      viewState: computed(() => 'list'),
      getRowKey,
      scrollToIndex: scroll,
      scrollToIndexIfNeeded: vi.fn()
    })
  )!
  return { runtime, state, scroll, ...follow }
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()))

describe('playing rows across set and source playlists', () => {
  it('highlights the original row after loading a set entry with a different Windows path spelling', () => {
    const original = song('G:\\Music\\Track.mp3')
    const ctx = setup([original])
    ctx.runtime.horizontalBrowseDecks.topSong = song('g:/music/track.mp3', 'set-entry')
    ctx.runtime.horizontalBrowseDecks.topSongListUUID = 'set-list'
    expect(ctx.playingSongFilePathsForRows.value).toEqual([original.filePath])
  })

  it('highlights both loaded decks independently and removes the highlight when ejected', () => {
    const top = song('G:\\Music\\Top.mp3')
    const bottom = song('G:\\Music\\Bottom.mp3')
    const ctx = setup([top, bottom, song('G:\\Music\\Other.mp3')])
    ctx.runtime.horizontalBrowseDecks.topSong = song('g:/music/top.mp3', 'set-top')
    ctx.runtime.horizontalBrowseDecks.bottomSong = song('g:/music/bottom.mp3', 'set-bottom')
    expect(ctx.playingSongFilePathsForRows.value).toEqual([top.filePath, bottom.filePath])
    ctx.runtime.horizontalBrowseDecks.topSong = null
    expect(ctx.playingSongFilePathsForRows.value).toEqual([bottom.filePath])
  })

  it('only highlights the loaded set entry when the same file occurs more than once', () => {
    const first = song('G:\\Music\\Track.mp3', 'entry-one')
    const loaded = song('G:\\Music\\Track.mp3', 'entry-two')
    const ctx = setup([first, loaded], 'set')
    ctx.runtime.horizontalBrowseDecks.bottomSong = song('g:/music/track.mp3', 'entry-two')
    expect(ctx.playingSongFilePathsForRows.value).toEqual(['entry-two'])
    ctx.state.songInfoArr = [first]
    expect(ctx.playingSongFilePathsForRows.value).toEqual([])
  })

  it('keeps mixtape occurrences distinct as well', () => {
    const first = song('G:/Music/Track.mp3', undefined, 'mix-one')
    const loaded = song('G:/Music/Track.mp3', undefined, 'mix-two')
    const ctx = setup([first, loaded], 'mixtape')
    ctx.runtime.horizontalBrowseDecks.topSong = loaded
    expect(ctx.playingSongFilePathsForRows.value).toEqual(['mix-two'])
  })

  it('matches source playback to set rows by file when no set occurrence was loaded', () => {
    const ctx = setup([song('G:/Music/Track.mp3', 'set-entry')], 'set')
    ctx.runtime.horizontalBrowseDecks.topSong = song('g:\\music\\TRACK.mp3')
    expect(ctx.playingSongFilePathsForRows.value).toEqual(['set-entry'])
  })

  it('uses the same resolved row for the main player highlight and manual scroll', () => {
    const original = song('G:\\Music\\Track.mp3')
    const ctx = setup([song('G:/Music/Other.mp3'), original])
    ctx.runtime.mainWindowBrowseMode = 'browser'
    ctx.runtime.playingData.playingSong = song('g:/music/track.mp3', 'set-entry')
    ctx.runtime.playingData.playingSongListUUID = 'set-list'
    expect(ctx.playingSongFilePathForRows.value).toBe(original.filePath)
    expect(ctx.showScrollToPlaying.value).toBe(true)
    ctx.handleScrollToPlaying()
    expect(ctx.scroll).toHaveBeenCalledWith(1)
  })

  it('preserves case-sensitive matching on macOS and ignores other files', () => {
    const original = song('/Music/Track.mp3')
    const ctx = setup([original])
    ctx.runtime.setting.platform = 'darwin'
    ctx.runtime.horizontalBrowseDecks.topSong = song('/Music/track.mp3', 'set-entry')
    expect(ctx.playingSongFilePathsForRows.value).toEqual([])
    ctx.runtime.horizontalBrowseDecks.topSong = song(original.filePath, 'set-entry')
    expect(ctx.playingSongFilePathsForRows.value).toEqual([original.filePath])
  })
})

const platforms = [
  {
    platform: 'win32',
    originalPath: 'G:\\音乐 Library\\Artist - Track.mp3',
    loadedPath: 'g:/音乐 library/artist - track.mp3'
  },
  {
    platform: 'darwin',
    originalPath: '/Volumes/Music/音乐 Library/Artist - Track.mp3',
    loadedPath: '/Volumes/Music/音乐 Library/Artist - Track.mp3'
  }
] as const

describe.each(platforms)(
  '$platform split-pane playing row compatibility',
  ({ platform, originalPath, loadedPath }) => {
    it.each(['top', 'bottom'] as const)(
      'highlights both the loaded set entry and its original row for the %s deck',
      (deck) => {
        const original = song(originalPath)
        const loaded = song(loadedPath, 'loaded-entry')
        const source = setup([original], 'normal', 'right')
        const set = setup([song(originalPath, 'other-entry'), loaded], 'set', 'left')
        source.runtime.setting.platform = platform
        source.runtime.songsAreaPanels.splitEnabled = true
        source.runtime.horizontalBrowseDecks[deck === 'top' ? 'topSong' : 'bottomSong'] = loaded
        source.runtime.horizontalBrowseDecks[
          deck === 'top' ? 'topSongListUUID' : 'bottomSongListUUID'
        ] = 'set-playlist'
        source.state.selectedSongFilePath = ['selected-original']
        source.state.scrollTop = 300
        set.state.selectedSongFilePath = ['other-entry']
        set.state.scrollTop = 120

        expect(source.playingSongFilePathsForRows.value).toEqual([originalPath])
        expect(set.playingSongFilePathsForRows.value).toEqual(['loaded-entry'])
        expect(source.state.selectedSongFilePath).toEqual(['selected-original'])
        expect(set.state.selectedSongFilePath).toEqual(['other-entry'])
        expect(source.state.scrollTop).toBe(300)
        expect(set.state.scrollTop).toBe(120)
      }
    )

    it('matches original-library loading back to set entries without relying on source UUID', () => {
      const source = setup([song(originalPath)], 'normal', 'right')
      const set = setup([song(originalPath, 'set-entry')], 'set', 'left')
      source.runtime.setting.platform = platform
      source.runtime.horizontalBrowseDecks.topSong = song(loadedPath)
      source.runtime.horizontalBrowseDecks.topSongListUUID = 'original-playlist'
      expect(source.playingSongFilePathsForRows.value).toEqual([originalPath])
      expect(set.playingSongFilePathsForRows.value).toEqual(['set-entry'])
    })

    it('highlights two separately loaded occurrences of one file without duplicating the source row', () => {
      const source = setup([song(originalPath)], 'normal', 'right')
      const set = setup(
        [
          song(originalPath, 'entry-one'),
          song(originalPath, 'entry-two'),
          song(originalPath, 'not-loaded')
        ],
        'set',
        'left'
      )
      source.runtime.setting.platform = platform
      source.runtime.horizontalBrowseDecks.topSong = song(loadedPath, 'entry-one')
      source.runtime.horizontalBrowseDecks.bottomSong = song(loadedPath, 'entry-two')
      expect(source.playingSongFilePathsForRows.value).toEqual([originalPath])
      expect(set.playingSongFilePathsForRows.value).toEqual(['entry-one', 'entry-two'])
      source.runtime.horizontalBrowseDecks.topSong = null
      expect(source.playingSongFilePathsForRows.value).toEqual([originalPath])
      expect(set.playingSongFilePathsForRows.value).toEqual(['entry-two'])
      source.runtime.horizontalBrowseDecks.bottomSong = null
      expect(source.playingSongFilePathsForRows.value).toEqual([])
      expect(set.playingSongFilePathsForRows.value).toEqual([])
    })

    it('recalculates the actual row key when filtering hides and restores the original song', () => {
      const ctx = setup([song(originalPath)])
      ctx.runtime.setting.platform = platform
      ctx.runtime.horizontalBrowseDecks.topSong = song(loadedPath, 'set-entry')
      expect(ctx.playingSongFilePathsForRows.value).toEqual([originalPath])
      ctx.state.songInfoArr = [song(`${originalPath}.different.mp3`)]
      expect(ctx.playingSongFilePathsForRows.value).toEqual([])
      ctx.state.songInfoArr = [song(originalPath)]
      expect(ctx.playingSongFilePathsForRows.value).toEqual([originalPath])
    })
  }
)
