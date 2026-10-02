import { describe, expect, it, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'

const { runtime } = vi.hoisted(() => ({
  runtime: {
    pioneerDeviceLibrary: {
      selectedSourceKey: 'source',
      selectedSourceRootPath: 'C:/DJ',
      selectedPlaylistId: 1
    },
    dragSourceSongListUUID: '',
    draggingSongFilePaths: ['C:/Music/A.mp3', 'C:/Music/B.mp3'],
    dragSourceMixtapeItemIds: ['11', '12']
  }
}))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => runtime }))
vi.mock('@renderer/utils/rekordboxDesktopWriteAvailability', () => ({
  ensureRekordboxDesktopWriteAvailable: vi.fn(async () => true)
}))
vi.mock('@renderer/utils/mitt', () => ({ default: { emit: vi.fn() } }))
import { resolveDjLibrarySongDrop } from './useDjLibrarySongDrop'
import { usePioneerDeviceTreeDrag } from './usePioneerDeviceTreeDrag'

const node: IPioneerPlaylistTreeNode = {
  id: 2,
  name: 'Target',
  isFolder: false,
  externalId: 'crate:Target',
  parentId: 0,
  order: 1,
  sortOrder: 1,
  children: []
}
const event = () =>
  ({ dataTransfer: { types: ['application/x-song-drag'], dropEffect: '' } }) as unknown as DragEvent

describe('DJ library songs dropped onto playlist tree', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('rejects another source, folders, smart/all tracks, and the original playlist', () => {
    const source = { kind: 'desktop' as const, sourceKey: 'source', sourcePath: 'C:/DJ' }
    const state = { sourceListKey: 'desktop:source:1', filePaths: ['A'], rowKeys: ['11'] }
    expect(resolveDjLibrarySongDrop(source, state, node)?.sourcePlaylistId).toBe(1)
    for (const target of [
      { ...node, isFolder: true },
      { ...node, isSmartPlaylist: true },
      { ...node, isAllTracks: true },
      { ...node, id: 1 }
    ]) {
      expect(resolveDjLibrarySongDrop(source, state, target)).toBeNull()
    }
    expect(
      resolveDjLibrarySongDrop(source, { ...state, sourceListKey: 'desktop:other:1' }, node)
    ).toBeNull()
    expect(
      resolveDjLibrarySongDrop(source, { ...state, sourceListKey: 'traktor:source:1' }, node)
    ).toBeNull()
  })

  it.each(['desktop', 'serato', 'traktor'] as const)(
    'connects a multi-song %s drop to its native writer and preserves selection',
    async (kind) => {
      runtime.dragSourceSongListUUID = `${kind}:source:1`
      const invoke = vi.fn(async () => ({ ok: true, summary: { addedCount: 2 } }))
      vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
      const refresh = vi.fn(async () => {})
      const failure = vi.fn(async () => {})
      const writing = ref(false)
      const controller = usePioneerDeviceTreeDrag(
        ref([node]),
        ref(kind === 'desktop'),
        writing,
        ref(''),
        vi.fn(),
        refresh,
        failure,
        async (task) => {
          writing.value = true
          try {
            return await task()
          } finally {
            writing.value = false
          }
        },
        () => 1,
        {
          enabled: ref(kind !== 'desktop'),
          kind: ref(kind === 'desktop' ? null : kind),
          sourcePath: ref('C:/DJ/collection.nml')
        }
      )
      const drag = event()
      controller.handleDragOverNode(drag, node)
      expect(drag.dataTransfer!.dropEffect).toBe('copy')
      expect(controller.dragTarget.value?.approach).toBe('center')
      await controller.handleDropNode(drag, node)
      expect(invoke).toHaveBeenCalledOnce()
      if (kind === 'desktop') {
        expect(invoke.mock.calls[0]).toEqual([
          'rekordbox-desktop-library:append-existing-playlist-tracks',
          { playlistId: 2, sourcePlaylistId: 1, rowKeys: ['11', '12'] }
        ])
      } else {
        expect(invoke.mock.calls[0]).toEqual([
          'external-library:mutate',
          {
            kind,
            path: 'C:/DJ/collection.nml',
            operation: 'append-existing-tracks',
            externalId: 'crate:Target',
            sourcePlaylistId: 1,
            trackPaths: runtime.draggingSongFilePaths
          }
        ])
      }
      expect(refresh).toHaveBeenCalledWith(1)
      expect(runtime.pioneerDeviceLibrary.selectedPlaylistId).toBe(1)
      expect(controller.dragTarget.value).toBeNull()
      expect(failure).not.toHaveBeenCalled()
      expect(writing.value).toBe(false)
    }
  )
})
