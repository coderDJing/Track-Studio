import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { usePioneerSongContextMenu } from './usePioneerSongContextMenu'
import type { ISongInfo } from '../../../../../types/globals'

const { menu, openEditor, resolveSelection } = vi.hoisted(() => ({
  menu: vi.fn(),
  openEditor: vi.fn(),
  resolveSelection: vi.fn()
}))
vi.mock('@renderer/components/rightClickMenu', () => ({ default: menu }))
vi.mock('@renderer/components/exportDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/utils/fingerprintActions', () => ({ analyzeFingerprintsForPaths: vi.fn() }))
vi.mock('@renderer/utils/rekordboxDesktopPlaylist', () => ({
  openRekordboxDesktopPlaylistForSelectedTracks: vi.fn()
}))
vi.mock('@renderer/utils/externalLibraryPlaylist', () => ({
  openExternalLibraryPlaylistForSelectedTracks: vi.fn()
}))
vi.mock('@renderer/utils/musicSearch', () => ({
  createMusicSearchMenuItems: () => [],
  resolveMusicSearchMenuAction: () => null,
  getMusicSearchOpenFailedMessageKey: vi.fn(),
  openMusicSearch: vi.fn()
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/utils/trackReanalysis', () => ({ promptAndStartTrackReanalysis: vi.fn() }))

const song = { filePath: 'D:\\Contents\\7.mp3', mixtapeItemId: 'usb:11:7' } as ISongInfo
const fixture = () => {
  const source = ref('usb::D::oneLibrary')
  const playlist = ref('usb:D:11')
  type Params = Parameters<typeof usePioneerSongContextMenu>[0]
  const actions = usePioneerSongContextMenu({
    runtime: {} as unknown as Params['runtime'],
    selectedRowKeys: ref([song.mixtapeItemId || '']),
    playlistMutationPending: ref(false),
    canRemoveTracksFromDesktopPlaylist: computed(() => false),
    canEditUsbPlaylist: computed(() => true),
    selectedSourceCacheKey: computed(() => source.value),
    currentPlaybackListKey: computed(() => playlist.value),
    removeUsbTracks: openEditor,
    deleteUsbTracks: openEditor,
    cancelPendingRepeatSingleClickDeselect: vi.fn(),
    resolveSelectedTracks: resolveSelection,
    resolveExistingOperationTracks: vi.fn(),
    showFileMissingHint: vi.fn(),
    openCopyTargetDialog: vi.fn(),
    removeTracksFromDesktopPlaylist: vi.fn()
  })
  return { source, playlist, ...actions }
}

beforeEach(() => {
  vi.resetAllMocks()
  resolveSelection.mockReturnValue([song])
})

describe('USB song context menu keeps its originating library and playlist', () => {
  it('deletes selected tracks using the existing delete menu', async () => {
    const state = fixture()
    menu.mockResolvedValue({ menuName: 'common.delete' })
    await state.handleSongContextMenu({} as MouseEvent, song)
    expect(openEditor).toHaveBeenCalledExactlyOnceWith([song])
  })

  it.each(['source', 'playlist'] as const)(
    'ignores a delayed menu result after switching %s',
    async (field) => {
      const state = fixture()
      menu.mockImplementation(async () => {
        state[field].value = field === 'source' ? 'usb::D::deviceLibrary' : 'usb:D:12'
        return { menuName: 'common.delete' }
      })
      await state.handleSongContextMenu({} as MouseEvent, song)
      expect(resolveSelection).not.toHaveBeenCalled()
      expect(openEditor).not.toHaveBeenCalled()
    }
  )
})
