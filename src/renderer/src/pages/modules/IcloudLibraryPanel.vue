<script setup lang="ts">
import {
  cloudPlaybackStates,
  cancelCloudPlayback,
  playCloudDirectory,
  prepareCloudPlayback,
  icloudDeckForBrowseMode,
  buildIcloudDeckLoad,
  setIcloudDeckLocalizedHandler
} from '@renderer/utils/icloudPlayback'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline'
import {
  icloudDownloadStatusLabel,
  mergeIcloudDownloadProgress
} from '@renderer/utils/icloudDownloadStatus'
import { filterSongColumns } from '@renderer/utils/songListColumnFilters'
import {
  resolveMusicSearchMenuAction,
  openMusicSearch,
  getMusicSearchOpenFailedMessageKey
} from '@renderer/utils/musicSearch'
import { cancelIcloudLocalAction } from '@renderer/utils/icloudPrepareLocal'
import {
  createIcloudSongMenuArr,
  handleIcloudSongMenuChoice
} from '@renderer/utils/icloudSongContextMenu'
import { saveIcloudView, readIcloudView } from '@renderer/utils/icloudViewState'
import { planSongListMerge } from '@shared/playlistViewMerge'
import { createSongListItemComparator } from '@shared/songListItemCompare'
import { activeCloudListContext } from '@renderer/utils/activeSongListContext'
import {
  computed,
  shallowRef,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  useTemplateRef,
  watch,
  watchEffect
} from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { t } from '@renderer/utils/translate'
import {
  icloudInvoke,
  cancelIcloudTransfer,
  icloudOpen,
  icloudDirectory,
  icloudSongDragging,
  icloudState,
  icloudTransfer,
  refreshIcloudState,
  copyIcloudSongs
} from '@renderer/utils/icloudLibrary'
import { dropLocalSongsOnIcloud } from '@renderer/utils/icloudDrag'
import { ICLOUD_DRAG_MIME } from '@shared/icloudLibrary'
import type { IcloudEntry, IcloudListing, IcloudDownloadProgress } from '@shared/icloudLibrary'
import type { ISongInfo } from 'src/types/globals'
import SongListSettingsToggle from './songsArea/SongListSettingsToggle.vue'
import SongListPaneChrome from './songsArea/SongListPaneChrome.vue'
import SongListViewport from './songsArea/SongListViewport.vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useParentRafSampler } from './songsArea/composables/useParentRafSampler'
import SongListState from './songsArea/SongListState.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { createIcloudCovers } from '@renderer/utils/icloudCovers'
import {
  readIcloudSongListWaveform,
  registerIcloudWaveformPreviewLoader
} from '@renderer/utils/icloudWaveformPreview'
import { notifyWaveformUpdated } from './songsArea/SongListRows/waveformPreviewIpcSubscriptions'
import { filterSongsByPlaylistSearch } from '@renderer/utils/playlistSongSearch'
import { icloudListPresentation } from '@renderer/utils/icloudListPresentation'
import type { IcloudPicture } from '@shared/icloudLibrary'
import SongListRows from './songsArea/SongListRows.vue'
import SongListHeader from './songsArea/SongListHeader.vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import selectSongListDialog from '@renderer/components/selectSongListDialog'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import ascendingOrder from '@renderer/assets/ascending-order.svg?asset'
import descendingOrder from '@renderer/assets/descending-order.svg?asset'
import emitter from '@renderer/utils/mitt'
import ColumnHeaderContextMenu from './songsArea/ColumnHeaderContextMenu.vue'
import { useIcloudColumns, sortIcloudSongs } from '@renderer/utils/icloudColumns'
import { createIcloudMetadataLoader } from '@renderer/utils/icloudMetadata'
import {
  bindIcloudAnalysisRows,
  mergeIcloudAnalysis,
  icloudLocalPathForRelative,
  rememberIcloudAnalysisPath,
  publishIcloudBoundAnalysis,
  subscribeIcloudAnalysisLive,
  type IcloudAnalysisRow
} from '@renderer/utils/icloudAnalysisRows'
import type { IcloudMetadataItem, IcloudSongMetadata } from '@shared/icloudLibrary'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
const runtime = useRuntimeStore()
const entries = ref<IcloudEntry[]>([])
const total = ref(0),
  query = ref(''),
  loading = ref(true),
  error = ref(''),
  rootToken = ref(''),
  hasLoaded = ref(false)
const selected = ref<string[]>([]),
  scrollHost = ref<HTMLElement>(),
  cancelAnchor = ref<HTMLElement>()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })
const {
  columns,
  independentSettings,
  rowsVisibleColumns,
  handleColumnDragPreview,
  updateColumns,
  sortColumn,
  toggleColumn,
  resetColumns,
  contextMenu,
  menuOpen,
  menuEvent
} = useIcloudColumns(runtime)
const metadataByPath = ref<Record<string, IcloudSongMetadata>>({})
const analysisByRelative = ref<Record<string, IcloudAnalysisRow>>({})
const analysisPathToRelative = new Map<string, string>()
const metadataOptions = {
  read: (paths: string[], token: string, requestId: string) =>
    icloudInvoke<IcloudMetadataItem[]>('icloud:metadata', paths, token, requestId),
  cancel: (requestId: string) => {
    void icloudInvoke('icloud:cancel', requestId).catch(() => {})
  },
  apply: (relative: string, metadata: IcloudSongMetadata | undefined) => {
    const entry = entries.value.find(
      (value) =>
        value.relativePath === relative ||
        value.relativePath.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2') === relative
    )
    if (!entry) return
    if (metadata) {
      metadataByPath.value[entry.relativePath] = metadata
      const playing = runtime.playingData.playingSong
      const url = states.value[keyFor(entry)]?.url
      if (playing && url && sameRendererFilePath(playing.filePath, url))
        Object.assign(playing, metadata)
    } else delete metadataByPath.value[entry.relativePath]
  }
}
const metadataLoader = createIcloudMetadataLoader(metadataOptions)
let visibleMetadataSongs: ISongInfo[] = [],
  visibleMetadataKey = ''
function loadVisibleMetadata(rows: ISongInfo[], force = false) {
  visibleMetadataSongs = rows
  const keys = new Set(rows.map((song) => song.filePath)),
    local = entries.value.filter((entry) => entry.residency === 'local' && keys.has(keyFor(entry)))
  const key = `${rootToken.value}|${local.map((entry) => entry.relativePath).join('\n')}`
  if (!force && key === visibleMetadataKey) return
  visibleMetadataKey = key
  void metadataLoader.load(local, rootToken.value)
}
const playMetadataLoader = createIcloudMetadataLoader(metadataOptions)
const keyFor = (entry: IcloudEntry) =>
  `icloud-song:${entry.relativePath.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2')}`

const logicalRelative = (relative: string) => relative.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2')
const resolveLocalSource = (key: string) => {
  const playing = runtime.playingData.playingSong
  const entry =
    entries.value.find((value) => keyFor(value) === key) ||
    entries.value.find(
      (value) =>
        sameRendererFilePath(playing?.filePath, key) &&
        playing?.icloudOrigin?.key === keyFor(value) &&
        playing?.icloudOrigin?.rootToken === rootToken.value
    )
  if (!entry || !rootToken.value) return null
  const relative = logicalRelative(entry.relativePath)
  if (entry.residency !== 'local' && !icloudLocalPathForRelative(analysisPathToRelative, relative))
    return null
  return { relative, token: rootToken.value }
}
registerIcloudWaveformPreviewLoader({
  resolve: resolveLocalSource,
  read: (relative, token, id) =>
    readIcloudSongListWaveform(analysisPathToRelative, relative, token, id),
  cancel: metadataOptions.cancel
})
const covers = createIcloudCovers({
  resolve: resolveLocalSource,
  read: (relative, token, id) =>
    icloudInvoke<IcloudPicture | null>('icloud:cover', [relative], token, id),
  cancel: metadataOptions.cancel
})
const width = computed(() =>
  columns.value.filter((column) => column.show).reduce((sum, column) => sum + column.width, 0)
)
const states = cloudPlaybackStates
const transferIssues = computed(() =>
  icloudTransfer.results.filter((item) => item.status === 'failed' || item.warning)
)
const transferSummary = computed(() =>
  (['copied', 'skipped', 'failed'] as const)
    .map((status) => ({
      status,
      count: icloudTransfer.results.filter((item) => item.status === status).length
    }))
    .filter(({ count }) => count > 0)
    .map(({ status, count }) => t(`icloud.${status}Count`, { count }))
    .join(' · ')
)
let alive = true,
  generation = 0,
  playbackEpoch = 0,
  anchorIndex = -1,
  cursorIndex = -1,
  anchorKey = '',
  cursorKey = ''
const sourceSongs = shallowRef<ISongInfo[]>([])
const comparator = createSongListItemComparator({
  caseInsensitiveFileName: false,
  caseInsensitiveFilePath: false
})
let songMergeEpoch = 0
watch(
  [entries, metadataByPath, rootToken, analysisByRelative],
  async () => {
    const version = ++songMergeEpoch,
      token = rootToken.value
    const next = entries.value.map((entry) => {
      const metadata = metadataByPath.value[entry.relativePath],
        key = keyFor(entry),
        analysis = analysisByRelative.value[logicalRelative(entry.relativePath)]
      return {
        filePath: key,
        fileName: entry.name,
        title: metadata?.title || entry.name.replace(/\.[^.]+$/, ''),
        fileFormat: entry.name.split('.').pop() || '',
        cover: null,
        artist: metadata?.artist,
        album: metadata?.album,
        duration: metadata?.duration || '',
        bpm: analysis?.bpm ?? metadata?.bpm,
        key: analysis?.key || metadata?.key,
        ...(analysis?.beatGridMap ? { beatGridMap: analysis.beatGridMap } : {}),
        genre: metadata?.genre,
        label: metadata?.label,
        bitrate: metadata?.bitrate,
        container: metadata?.container,
        icloudOrigin: {
          relativePath: entry.relativePath.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2'),
          rootToken: token,
          key
        }
      } as ISongInfo
    })
    const merge = await planSongListMerge({
      current: sourceSongs.value,
      next,
      comparator: {
        ...comparator,
        isEquivalentSongInfo: (a, b) =>
          a.icloudOrigin?.rootToken === b.icloudOrigin?.rootToken &&
          comparator.isEquivalentSongInfo(a, b)
      }
    })
    if (!alive || version !== songMergeEpoch || token !== rootToken.value || !merge.changed) return
    const existing = new Map(sourceSongs.value.map((song) => [song.filePath, song]))
    const rows = merge.items.map((incoming) => {
      const prior = existing.get(incoming.filePath)
      if (!prior) return reactive(incoming)
      if (prior !== incoming) Object.assign(prior, incoming)
      return prior
    })
    if (
      rows.length !== sourceSongs.value.length ||
      rows.some((song, index) => song !== sourceSongs.value[index])
    )
      sourceSongs.value = rows
  },
  { deep: true }
)
const songs = computed(() =>
  sortIcloudSongs(
    filterSongsByPlaylistSearch(
      filterSongColumns(sourceSongs.value, columns.value, {
        keyStyle: runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic',
        curatedArtists: runtime.curatedArtistFavorites
      }),
      query.value,
      columns.value.map((col) => col.key),
      {
        keyDisplayStyle: runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic',
        isDesktopRekordboxSong: false
      }
    ),
    columns.value,
    runtime.setting.keyDisplayStyle,
    (song) => label(song)
  )
)
watchEffect(() => {
  icloudListPresentation.value = {
    songs: songs.value,
    selected: selected.value,
    total: total.value,
    page: false
  }
})
const findEntry = (song: ISongInfo) =>
  entries.value.find((entry) => sameRendererFilePath(keyFor(entry), song.filePath))
const rowStatus = (song: ISongInfo) => states.value[song.filePath]
const waiting = (song: ISongInfo) =>
  ['waiting', 'downloading'].includes(rowStatus(song)?.state || '')
const label = (song: ISongInfo) =>
  icloudDownloadStatusLabel(t, rowStatus(song), findEntry(song)?.residency)
const playingKey = computed(() =>
  runtime.playingData.playingSong?.icloudOrigin?.rootToken === rootToken.value
    ? runtime.playingData.playingSong?.icloudOrigin?.key
    : undefined
)
let pendingRestoreScroll: number | undefined
watch(
  scrollHost,
  (host) => {
    if (host && pendingRestoreScroll !== undefined) {
      host.scrollTop = pendingRestoreScroll
      pendingRestoreScroll = undefined
    }
  },
  { flush: 'post' }
)
let viewIdentity = '',
  loadFlight: { key: string; promise: Promise<void>; again: boolean } | null = null
function rememberView() {
  if (!viewIdentity || !hasLoaded.value) return
  saveIcloudView(viewIdentity, {
    songs: sourceSongs.value,
    entries: entries.value,
    metadata: { ...metadataByPath.value },
    selected: [...selected.value],
    query: query.value,
    scrollTop: scrollHost.value?.scrollTop || 0,
    cursorKey,
    anchorKey,
    cursor: cursorIndex,
    anchor: anchorIndex
  })
}
function restoreView(token: string) {
  const key = `${token}|${icloudDirectory.value}`,
    saved = readIcloudView(key)
  viewIdentity = key
  if (!saved) return
  rootToken.value = token
  sourceSongs.value = saved.songs
  entries.value = saved.entries
  metadataByPath.value = { ...saved.metadata }
  query.value = saved.query
  selected.value = [...saved.selected]
  cursorIndex = saved.cursor
  anchorIndex = saved.anchor
  cursorKey = saved.cursorKey || saved.songs[cursorIndex]?.filePath || ''
  anchorKey = saved.anchorKey || saved.songs[anchorIndex]?.filePath || ''
  hasLoaded.value = true
  loading.value = false
  total.value = entries.value.length
  if (scrollHost.value) scrollHost.value.scrollTop = saved.scrollTop
  else pendingRestoreScroll = saved.scrollTop
}
function load(): Promise<void> {
  const key = `${icloudState.value?.rootToken}|${icloudDirectory.value}`
  if (loadFlight?.key === key) {
    loadFlight.again = true
    return loadFlight.promise
  }
  const flight = { key, promise: Promise.resolve(), again: false }
  loadFlight = flight
  flight.promise = performLoad().finally(() => {
    if (loadFlight === flight) {
      loadFlight = null
      if (flight.again && alive) void load()
    }
  })
  return flight.promise
}
async function performLoad() {
  const id = ++generation
  metadataLoader.cancel()
  playMetadataLoader.cancel()
  const directory = icloudDirectory.value
  loading.value = !hasLoaded.value
  error.value = ''
  try {
    const state = await refreshIcloudState()
    if (!alive || id !== generation || directory !== icloudDirectory.value) return
    if (!hasLoaded.value && state.rootToken) {
      restoreView(state.rootToken)
      loading.value = !hasLoaded.value
    }
    if (!state.available) {
      if (id === generation) entries.value = []
      return
    }
    const data = await icloudInvoke<IcloudListing>(
      'icloud:list',
      directory,
      null,
      '',
      state.rootToken
    )
    if (data.directory !== undefined && data.directory !== directory) throw new Error('boundary')
    if (!alive || id !== generation || directory !== icloudDirectory.value) return
    rootToken.value = data.rootToken || state.rootToken || ''
    viewIdentity = `${rootToken.value}|${directory}`
    hasLoaded.value = true
    void icloudInvoke('icloud:watch-directory', directory, rootToken.value).catch(() => {})
    // Reuse unchanged entry objects on refresh; do not reset selection or scroll.
    const previousResidency = new Map(
      entries.value.map((entry) => [keyFor(entry), entry.residency])
    )
    const old = new Map(entries.value.map((entry) => [keyFor(entry), entry]))
    const next = data.entries
      .filter((entry) => !entry.directory)
      .map((entry) => {
        const prior = old.get(keyFor(entry))
        return prior &&
          prior.relativePath === entry.relativePath &&
          prior.residency === entry.residency &&
          prior.name === entry.name
          ? prior
          : entry
      })
    if (
      next.length !== entries.value.length ||
      next.some((entry, index) => entry !== entries.value[index])
    )
      entries.value = next
    const present = new Set(next.map(keyFor))
    const retainedSelection = selected.value.filter((key) => present.has(key))
    if (retainedSelection.length !== selected.value.length) selected.value = retainedSelection
    const presentPaths = new Set(
      next.filter((entry) => entry.residency === 'local').map((entry) => entry.relativePath)
    )
    for (const path of Object.keys(metadataByPath.value))
      if (!presentPaths.has(path)) delete metadataByPath.value[path]
    total.value = data.total
    covers.refreshVisible(true)
    for (const entry of next.filter((item) => item.residency === 'local')) {
      const key = keyFor(entry)
      if (previousResidency.get(key) && previousResidency.get(key) !== 'local')
        notifyWaveformUpdated(key)
    }
    loadVisibleMetadata(visibleMetadataSongs, true)
    void bindVisibleAnalysis(next.filter((entry) => entry.residency === 'local'))
  } catch (reason) {
    if (alive && id === generation)
      error.value = reason instanceof Error ? reason.message : 'failed'
  } finally {
    if (id === generation) loading.value = false
  }
}
function select(event: MouseEvent, song: ISongInfo) {
  const index = songs.value.findIndex((item) => sameRendererFilePath(item.filePath, song.filePath))
  anchorIndex = songs.value.findIndex((item) => sameRendererFilePath(item.filePath, anchorKey))
  if (event.shiftKey && anchorIndex >= 0)
    selected.value = songs.value
      .slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1)
      .map((item) => item.filePath)
  else if (event.metaKey || event.ctrlKey)
    selected.value = selected.value.includes(song.filePath)
      ? selected.value.filter((key) => !sameRendererFilePath(key, song.filePath))
      : [...selected.value, song.filePath]
  else selected.value = [song.filePath]
  if (!event.shiftKey || anchorIndex < 0) {
    anchorIndex = index
    anchorKey = song.filePath
  }
  cursorIndex = index
  cursorKey = song.filePath
}
function cancel(song: ISongInfo) {
  if (cancelIcloudLocalAction(song.filePath)) return
  playbackEpoch++
  cancelCloudPlayback(song.filePath)
}
function markEvicted(relative: string) {
  const entry = entries.value.find(
    (row) =>
      row.relativePath === relative ||
      row.relativePath.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2') === relative
  )
  if (!entry) return
  entry.residency = 'cloud'
}
function rememberDeckAnalysis(relative: string, filePath = '') {
  rememberIcloudAnalysisPath(analysisPathToRelative, filePath, relative)
  const token = rootToken.value
  markLocalized(relative)
  void bindIcloudAnalysisRows([relative], token, (paths, active) =>
    icloudInvoke('icloud:bind-analysis', paths, active)
  ).then((bound) => {
    if (alive && token === rootToken.value) rememberAnalysis(bound)
  })
}
function markLocalized(relative: string) {
  const entry = entries.value.find(
    (row) =>
      row.relativePath === relative ||
      row.relativePath.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2') === relative
  )
  if (!entry) return
  entry.residency = 'local'
  covers.refreshVisible()
  notifyWaveformUpdated(keyFor(entry))
  void playMetadataLoader.load([{ ...entry, relativePath: relative }], rootToken.value)
}
async function loadOnDeck(song: ISongInfo, deck: 'top' | 'bottom') {
  for (const pending of songs.value) if (waiting(pending)) cancel(pending)
  const epoch = ++playbackEpoch,
    entry = findEntry(song),
    token = rootToken.value
  if (!entry) return
  const ready = await prepareCloudPlayback(song, runtime.mainWindowBrowseMode)
  if (!ready || !alive || epoch !== playbackEpoch || token !== rootToken.value) return
  const loaded = buildIcloudDeckLoad(ready, songs.value, song.filePath)
  if (!loaded) {
    states.value[song.filePath] = { state: 'failed', requestId: '', error: 'failed' }
    return
  }
  rememberDeckAnalysis(logicalRelative(entry.relativePath), loaded.filePath)
  beginHorizontalBrowseDeckInteraction(deck, loaded.filePath)
  emitter.emit('horizontalBrowse/load-song', {
    deck,
    song: loaded.song,
    sourceSongListUUID: 'icloud-music',
    sourceSongListData: loaded.queue
  })
}
async function play(song: ISongInfo, event?: MouseEvent) {
  const deck = icloudDeckForBrowseMode(runtime.mainWindowBrowseMode, Boolean(event?.shiftKey))
  if (deck) {
    await loadOnDeck(song, deck)
    return
  }
  for (const pending of songs.value) if (waiting(pending)) cancel(pending)
  const epoch = ++playbackEpoch,
    entry = findEntry(song),
    token = rootToken.value
  if (!entry) return
  try {
    const readySong = await playCloudDirectory(runtime, song, songs.value)
    if (!readySong || !alive || epoch !== playbackEpoch || token !== rootToken.value) return
    entry.residency = 'local'
    covers.refreshVisible()
    notifyWaveformUpdated(keyFor(entry))
    const logical = entry.relativePath.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2')
    void playMetadataLoader.load([{ ...entry, relativePath: logical }], token)
  } catch (reason) {
    if (alive && epoch === playbackEpoch)
      states.value[song.filePath] = {
        state: 'failed',
        requestId: '',
        error: reason instanceof Error ? reason.message : 'failed'
      }
  }
}
async function addToPlaylist(libraryName: 'FilterLibrary' | 'CuratedLibrary') {
  const paths = entries.value
    .filter((entry) => selected.value.includes(keyFor(entry)))
    .map((entry) => entry.relativePath)
  if (!paths.length) return
  const choice = await selectSongListDialog({ libraryName, actionMode: 'copy' })
  if (choice === 'cancel') return
  const result = await copyIcloudSongs('to-local', choice.uuid, paths, rootToken.value)
  for (const item of result) {
    const entry = entries.value.find((row) => row.relativePath === item.source)
    if (entry && item.status === 'failed')
      states.value[keyFor(entry)] = { state: 'failed', requestId: '', error: item.error }
  }
}
async function context(event: MouseEvent, song: ISongInfo) {
  if (!selected.value.includes(song.filePath))
    select({ shiftKey: false, metaKey: false, ctrlKey: false } as MouseEvent, song)
  const choice = await rightClickMenu({
    clickEvent: event,
    menuArr: createIcloudSongMenuArr({
      canRemoveDownload: entries.value.some(
        (entry) => selected.value.includes(keyFor(entry)) && entry.residency === 'local'
      )
    })
  })
  if (choice === 'cancel') return
  const search = resolveMusicSearchMenuAction(choice.menuName, song)
  if (search) {
    if (!search.query) error.value = search.emptyMessageKey
    else if (!(await openMusicSearch(search.provider, search.query)))
      error.value = getMusicSearchOpenFailedMessageKey(search.provider)
    return
  }
  if (choice.menuName === 'icloud.play') await play(song)
  else if (choice.menuName === 'library.copyToFilter') await addToPlaylist('FilterLibrary')
  else if (choice.menuName === 'library.copyToCurated') await addToPlaylist('CuratedLibrary')
  else if (choice.menuName === 'icloud.reveal' || choice.menuName === 'tracks.showInFileExplorer') {
    const entry = findEntry(song)
    if (entry)
      await icloudInvoke('icloud:reveal', entry.relativePath, rootToken.value).catch((reason) => {
        error.value = reason.message
      })
  } else {
    const selectedSongs = songs.value.filter((item) => selected.value.includes(item.filePath))
    await handleIcloudSongMenuChoice({
      menuName: choice.menuName,
      songs: selectedSongs.length ? selectedSongs : [song],
      anchor: song,
      visibleSongs: songs.value,
      onLocalized: markLocalized,
      onChanged: afterCloudWrite,
      localRelativePaths: entries.value
        .filter((entry) => selected.value.includes(keyFor(entry)) && entry.residency === 'local')
        .map((entry) => entry.relativePath.replace(/(^|\/)\.([^/]+)\.icloud$/, '$1$2')),
      rootToken: rootToken.value,
      onEvicted: markEvicted,
      onAnalysisBound: rememberAnalysis
    })
  }
}
function afterCloudWrite(change?: { stopRelativePaths?: string[] }) {
  const playing = runtime.playingData.playingSong
  const origin = playing?.icloudOrigin?.relativePath
  const stopped = change?.stopRelativePaths || []
  if (
    origin &&
    stopped.includes(origin) &&
    runtime.playingData.playingSongListUUID === 'icloud-music'
  ) {
    runtime.playingData.playingSong = null
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
  }
  void load()
}
function drag(event: DragEvent, song: ISongInfo) {
  if (!selected.value.includes(song.filePath)) selected.value = [song.filePath]
  if (!event.dataTransfer) return
  icloudSongDragging.value = true
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(
    ICLOUD_DRAG_MIME,
    JSON.stringify({
      version: 1,
      rootToken: rootToken.value,
      paths: entries.value
        .filter((entry) => selected.value.includes(keyFor(entry)))
        .map((entry) => entry.relativePath)
    })
  )
}
function clearBlank(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (
    target === event.currentTarget ||
    target === scrollHost.value ||
    (target?.closest?.('.song-rows-root') && !target.closest('.song-row-item'))
  ) {
    selected.value = []
    anchorIndex = -1
    cursorIndex = -1
    cursorKey = ''
    anchorKey = ''
  }
}
function cloudDragover(event: DragEvent) {
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-song-drag')
      ? 'copy'
      : 'none'
}
function cloudDrop(event: DragEvent) {
  dropLocalSongsOnIcloud(
    event,
    runtime.draggingSongFilePaths,
    icloudDirectory.value,
    rootToken.value
  )
}
function changeDirectory() {
  rememberView()
  viewIdentity = ''
  hasLoaded.value = false
  playbackEpoch++
  covers.clear()
  metadataLoader.cancel()
  playMetadataLoader.cancel()
  metadataByPath.value = {}
  visibleMetadataKey = ''
  visibleMetadataSongs = []
  entries.value = []
  sourceSongs.value = []
  selected.value = []
  total.value = 0
  query.value = ''
  anchorIndex = -1
  cursorIndex = -1
  cursorKey = ''
  anchorKey = ''
  if (scrollHost.value) scrollHost.value.scrollTop = 0
  void load()
}
watch(icloudDirectory, changeDirectory)
watch(
  query,
  () => {
    anchorIndex = -1
    cursorIndex = -1
    cursorKey = ''
    anchorKey = ''
  },
  { flush: 'sync' }
)
watch(songs, (value) => {
  const visible = new Set(value.map((song) => song.filePath))
  if (selected.value.some((key) => !visible.has(key)))
    selected.value = selected.value.filter((key) => visible.has(key))
  if (!visible.has(cursorKey)) cursorKey = selected.value[0] || ''
  if (!visible.has(anchorKey)) anchorKey = cursorKey
  cursorIndex = value.findIndex((song) => sameRendererFilePath(song.filePath, cursorKey))
  anchorIndex = value.findIndex((song) => sameRendererFilePath(song.filePath, anchorKey))
  const playing = runtime.playingData.playingSong,
    origin = playing?.icloudOrigin
  if (
    playing &&
    origin?.rootToken === rootToken.value &&
    origin.relativePath.split('/').slice(0, -1).join('/') === icloudDirectory.value &&
    runtime.playingData.playingSongListUUID === 'icloud-music'
  ) {
    const queue = value.map((song) =>
        sameRendererFilePath(song.filePath, origin.key) ? playing : song
      ),
      previous = runtime.playingData.playingSongListData
    if (queue.length !== previous.length || queue.some((song, index) => song !== previous[index]))
      runtime.playingData.playingSongListData = queue
  }
})
function keydown(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    event.stopPropagation()
    selected.value = songs.value.map((song) => song.filePath)
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    const selectedSongs = songs.value.filter((item) => selected.value.includes(item.filePath))
    if (!selectedSongs.length) return
    void handleIcloudSongMenuChoice({
      menuName: 'tracks.deleteTracks',
      songs: selectedSongs,
      anchor: selectedSongs[0],
      visibleSongs: songs.value,
      onLocalized: markLocalized,
      onChanged: afterCloudWrite
    })
  } else if (event.key === 'Enter') {
    event.stopPropagation()
    const song = songs.value.find((row) => selected.value.includes(row.filePath))
    if (song) void play(song)
  } else if (event.key === 'Escape') {
    event.stopPropagation()
    for (const song of songs.value) if (waiting(song)) cancel(song)
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
    const step = event.key.startsWith('Page')
      ? Math.max(1, Math.floor((scrollHost.value?.clientHeight || 300) / 30) - 1)
      : 1
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? songs.value.length - 1
          : Math.max(
              0,
              Math.min(
                songs.value.length - 1,
                cursorIndex + (event.key === 'ArrowDown' || event.key === 'PageDown' ? step : -step)
              )
            )
    const song = songs.value[next]
    if (song) {
      select({ shiftKey: event.shiftKey, ctrlKey: false, metaKey: false } as MouseEvent, song)
      if (scrollHost.value) {
        const top = next * 30,
          bottom = top + 60
        if (top < scrollHost.value.scrollTop) scrollHost.value.scrollTop = top
        else if (bottom > scrollHost.value.scrollTop + scrollHost.value.clientHeight)
          scrollHost.value.scrollTop = bottom - scrollHost.value.clientHeight
      }
    }
  }
}
const downloaded = (_event: unknown, data: IcloudDownloadProgress) => {
  const entry = entries.value.find((row) => row.relativePath === data.relative)
  if (!entry) return
  const key = keyFor(entry),
    state = states.value[key]
  const next = mergeIcloudDownloadProgress(state, data, icloudTransfer.requestId)
  if (next) states.value[key] = next
}
watch(
  () => icloudState.value?.rootToken,
  (next, previous) => {
    if (!alive || !previous || !next || previous === next) return
    rootToken.value = next
    if (icloudDirectory.value !== '') icloudDirectory.value = ''
    else changeDirectory()
  }
)
watch(
  () => [runtime.libraryAreaSelected, runtime.songsArea.songListUUID],
  () => {
    icloudOpen.value = false
  }
)
watch(
  () => icloudTransfer.busy,
  (busy, previous) => {
    if (previous && !busy && !icloudTransfer.error) void load()
  }
)
const refreshDirectory = (relative: unknown) => {
  if (relative === icloudDirectory.value) void load()
}
const directoryChanged = (_event: unknown, data: { rootToken: string; directory: string }) => {
  if (data.rootToken === rootToken.value && data.directory === icloudDirectory.value) void load()
}
function rememberAnalysis(
  items: Array<{ relative?: string; filePath?: string; key?: string; beatGridMap?: unknown }>
) {
  const next = mergeIcloudAnalysis(analysisByRelative.value, analysisPathToRelative, items)
  if (next !== analysisByRelative.value) analysisByRelative.value = next
}
async function bindVisibleAnalysis(localEntries: IcloudEntry[]) {
  const token = rootToken.value
  const items = await bindIcloudAnalysisRows(
    localEntries.map((entry) => logicalRelative(entry.relativePath)),
    token,
    (relatives, activeToken) => icloudInvoke('icloud:bind-analysis', relatives, activeToken)
  )
  if (token === rootToken.value)
    publishIcloudBoundAnalysis(items, rememberAnalysis, notifyWaveformUpdated)
}
let stopAnalysisLive = () => {}
if (icloudState.value?.rootToken) restoreView(icloudState.value.rootToken)
const listContext = { copy: addToPlaylist }
activeCloudListContext.value = listContext
onMounted(() => {
  window.electron.ipcRenderer.on('icloud:directory-changed', directoryChanged)
  window.electron.ipcRenderer.on('icloud:download-progress', downloaded)
  stopAnalysisLive = subscribeIcloudAnalysisLive({
    paths: analysisPathToRelative,
    remember: rememberAnalysis,
    onWaveformKey: notifyWaveformUpdated
  })
  emitter.on('icloud/refresh-directory', refreshDirectory)
  setIcloudDeckLocalizedHandler(rememberDeckAnalysis)
  void load()
})
onUnmounted(() => {
  setIcloudDeckLocalizedHandler(null)
  stopAnalysisLive()
  rememberView()
  void icloudInvoke('icloud:unwatch-directory').catch(() => {})
  if (activeCloudListContext.value === listContext) activeCloudListContext.value = null
  icloudListPresentation.value = null
  alive = false
  songMergeEpoch++
  covers.clear()
  registerIcloudWaveformPreviewLoader(null)
  metadataLoader.cancel()
  playMetadataLoader.cancel()
  icloudSongDragging.value = false
  generation++
  playbackEpoch++
  window.electron.ipcRenderer.removeListener('icloud:directory-changed', directoryChanged)
  window.electron.ipcRenderer.removeListener('icloud:download-progress', downloaded)
  emitter.off('icloud/refresh-directory', refreshDirectory)
})
</script>
<template>
  <section
    class="icloud-songs"
    tabindex="0"
    :aria-label="t('icloud.title')"
    @keydown="keydown"
    @dragover.stop.prevent="cloudDragover"
    @drop.stop.prevent="cloudDrop"
  >
    <SongListPaneChrome
      v-model:query="query"
      :title="icloudDirectory || 'iCloud Drive'"
      :closable="false"
    >
      <SongListSettingsToggle
        v-model="independentSettings"
        :hint="
          t(
            independentSettings
              ? 'tracks.independentListSettingsOnHint'
              : 'tracks.independentListSettingsOffHint'
          )
        "
      />
      <bubbleBoxTrigger
        tag="button"
        type="button"
        class="songs-pane-header__button"
        :title="t('icloud.refresh')"
        :aria-label="t('icloud.refresh')"
        :disabled="loading"
        @click="load()"
        >↻</bubbleBoxTrigger
      >
    </SongListPaneChrome>
    <div class="song-scroll" @click="clearBlank">
      <SongListViewport
        ref="songsAreaRef"
        @viewport="scrollHost = $event"
        @click.self="selected = []"
      >
        <SongListHeader
          :columns="columns"
          :t="t"
          :ascending-order="ascendingOrder"
          :descending-order="descendingOrder"
          :total-width="width"
          @update:columns="updateColumns"
          @column-click="sortColumn"
          @header-contextmenu="contextMenu"
          @columns-preview="handleColumnDragPreview"
        />
        <SongListRows
          :songs="songs"
          :search-query="query"
          :visible-columns="rowsVisibleColumns"
          :selected-song-file-paths="selected"
          :playing-song-file-path="playingKey"
          :total-width="width"
          source-library-name="IcloudLibrary"
          source-song-list-u-u-i-d="icloud-music"
          :scroll-host-element="scrollHost"
          :external-scroll-top="externalScrollTop"
          :external-viewport-height="externalViewportHeight"
          :read-only="true"
          :enable-cover-thumbnails="false"
          :cover-provider="covers"
          :allow-context-menu-when-read-only="true"
          :allow-dblclick-when-read-only="true"
          :allow-song-drag-when-read-only="true"
          :allow-waveform-preview-when-read-only="true"
          @visible-songs="loadVisibleMetadata"
          @song-click="select"
          @song-dblclick="play"
          @song-contextmenu="context"
          @song-dragstart="drag"
          @song-dragend="icloudSongDragging = false"
        >
          <template #cell-icloudStatus="{ song }">
            <span role="status">{{ label(song) }}</span>
            <button
              v-if="waiting(song)"
              ref="cancelAnchor"
              class="row-action"
              @click.stop="cancel(song)"
              @dblclick.stop
            >
              {{ t('icloud.cancel') }}
            </button>
            <button
              v-else-if="rowStatus(song)?.state === 'failed'"
              class="row-action"
              @click.stop="play(song)"
              @dblclick.stop
            >
              {{ t('icloud.retry') }}
            </button>
          </template>
        </SongListRows>
      </SongListViewport>
      <SongListState v-if="loading" loading overlay />
      <SongListState
        v-else-if="error"
        alert
        :title="
          t(
            error.startsWith('tracks.')
              ? error
              : error === 'download'
                ? 'icloud.folderNotLocal'
                : `icloud.errors.${error}`
          )
        "
      />
      <SongListState
        v-else-if="icloudState && !icloudState.available"
        :title="t('icloud.unavailable')"
      />
      <SongListState
        v-else-if="!songs.length"
        :title="
          t(
            query.trim() || columns.some((col) => col.filterActive)
              ? 'filters.noResults'
              : 'icloud.emptyMusic'
          )
        "
      />
    </div>
    <bubbleBox :dom="cancelAnchor" :title="t('icloud.cancelHint')" />
    <footer v-if="icloudTransfer.busy || icloudTransfer.error || transferSummary">
      <span v-if="icloudTransfer.busy && icloudTransfer.progress" role="status"
        >{{ icloudTransfer.progress.done }} / {{ icloudTransfer.progress.total }} ·
        {{ icloudTransfer.progress.current }}</span
      >
      <button v-if="icloudTransfer.busy" @click="cancelIcloudTransfer">
        {{ t('icloud.cancel') }}
      </button>
      <span v-if="icloudTransfer.error" role="alert">{{
        t(`icloud.errors.${icloudTransfer.error}`)
      }}</span>
      <span v-if="!icloudTransfer.busy && transferSummary" role="status">{{
        transferSummary
      }}</span>
    </footer>
    <ColumnHeaderContextMenu
      v-model="menuOpen"
      :target-event="menuEvent"
      :columns="columns"
      :independent-settings="independentSettings"
      @reset-to-shared-settings="resetColumns"
      @toggle-column-visibility="toggleColumn"
    />
    <details v-if="!icloudTransfer.busy && transferIssues.length" class="transfer-details">
      <summary>{{ t('icloud.failures') }}</summary>
      <p v-for="item of transferIssues" :key="item.source">
        {{ item.source }} ·
        {{ t(item.warning ? 'icloud.metadataWarning' : `icloud.errors.${item.error || 'failed'}`) }}
      </p>
    </details>
  </section>
</template>
<style scoped>
.icloud-songs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--text);
  background: var(--bg);
}
.song-scroll {
  flex: 1;
  min-height: 0;
  position: relative;
}
footer,
.transfer-details {
  font-size: 12px;
  color: var(--text-weak);
  padding: 4px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border);
}
.transfer-details {
  display: block;
  max-height: 160px;
  overflow: auto;
  overflow-wrap: anywhere;
}
.row-action,
footer button {
  font: inherit;
  color: var(--text);
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 1px 4px;
}
.row-action {
  margin-left: 8px;
  font-size: 12px;
}
button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
</style>
