import { createApp, h, ref, computed, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import 'overlayscrollbars/styles/overlayscrollbars.css'
import SongListRows from '../src/renderer/src/pages/modules/songsArea/SongListRows.vue'
import { useParentRafSampler } from '../src/renderer/src/pages/modules/songsArea/composables/useParentRafSampler'
import { useRuntimeStore } from '../src/renderer/src/stores/runtime'
import { buildSongsAreaDefaultColumns } from '../src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns'

const frame = async (ms = 35) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await nextTick()
}

let cellLayoutReads = 0
const readRect = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function () {
  if (this.matches('.cell-title, .cell-cover, .cell-waveform')) cellLayoutReads += 1
  return readRect.call(this)
}

createApp({
  setup() {
    const runtime = useRuntimeStore()
    runtime.setting.platform = 'win32'
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'desktop'
    const osRef = ref(null)
    const host = computed(() => osRef.value?.osInstance()?.elements().viewport)
    const { externalScrollTop, externalViewportHeight } = useParentRafSampler({
      songsAreaRef: osRef
    })
    const songs = ref(
      Array.from({ length: 6810 }, (_, i) => ({
        filePath: 'C:/Music/Track-' + i + '.mp3',
        fileName: 'Track-' + i + '.mp3',
        title: 'Track ' + i,
        artist: 'Artist',
        duration: '05:00',
        mixtapeItemId: 'rekordbox-collection:' + i,
        externalSourceKind: 'desktop',
        externalAnalyzePath: '/ANLZ/' + i + '/ANLZ0000.DAT',
        externalWaveformRootPath: 'D:/PIONEER/Master/share',
        hotCues: [],
        memoryCues: []
      }))
    )
    const columns = ref(buildSongsAreaDefaultColumns('default').filter((column) => column.show))
    const totalWidth = computed(() =>
      columns.value.reduce((width, column) => width + column.width, 0)
    )
    window.readScrollTop = () => host.value.scrollTop
    window.resetScrollTop = () => {
      host.value.scrollTop = 0
    }
    window.readListSnapshot = () => ({
      top: host.value.scrollTop,
      scrollHeight: host.value.scrollHeight,
      sampledTop: externalScrollTop.value,
      first: document.querySelector('.song-row-item')?.dataset.rowkey,
      coverCount: document.querySelectorAll('.cell-cover img').length,
      waveformCount: document.querySelectorAll('canvas').length
    })
    window.checkScroll = async () => {
      await frame(500)
      cellLayoutReads = 0
      for (const theme of ['theme-light', 'theme-dark']) {
        document.documentElement.className = theme
        host.value.scrollTop = 0
        await frame()
        for (let i = 0; i < 35; i++) {
          const requested = host.value.scrollTop + 60
          host.value.scrollTop = requested
          await frame()
          if (Math.abs(host.value.scrollTop - requested) > 1) {
            throw Error(theme + ': requested ' + requested + ', moved to ' + host.value.scrollTop)
          }
        }
        host.value.scrollTop = 120000
        await frame(500)
        if (Math.abs(host.value.scrollTop - 120000) > 1) throw Error(theme + ': jump moved')
        host.value.scrollTop -= 60
        await frame()
        if (Math.abs(host.value.scrollTop - 119940) > 1)
          throw Error(theme + ': reverse scroll moved')
      }
      if (cellLayoutReads !== 0) {
        throw Error('Ordinary scrolling caused ' + cellLayoutReads + ' cell layout reads')
      }
      return JSON.stringify(window.readListSnapshot())
    }
    window.checkColumnReorder = async () => {
      const original = columns.value
      const reordered = [...original]
      const titleIndex = reordered.findIndex((column) => column.key === 'title')
      const artistIndex = reordered.findIndex((column) => column.key === 'artist')
      ;[reordered[titleIndex], reordered[artistIndex]] = [
        reordered[artistIndex],
        reordered[titleIndex]
      ]
      columns.value = reordered
      await nextTick()
      await nextTick()
      const row = document.querySelector('.song-row-columns')
      const cells = Array.from(row.children)
      if (!cells.some((cell) => cell.getAnimations().length > 0))
        throw Error('Column move animation missing')
      await frame(250)
      if (
        cells.map((cell) => cell.dataset.columnKey).join('|') !==
        reordered.map((column) => column.key).join('|')
      ) {
        throw Error('Column order differs from the header order')
      }
      columns.value = original
      await frame(250)
      return 'Column reorder animation and column identities passed'
    }
    return () =>
      h(
        OverlayScrollbarsComponent,
        {
          ref: osRef,
          style: { height: '100%', width: '100%', position: 'relative' },
          options: {
            scrollbars: { autoHide: 'leave', autoHideDelay: 50, clickScroll: true },
            overflow: { x: 'scroll', y: 'scroll' }
          }
        },
        {
          default: () => [
            h(
              'div',
              {
                class: 'songListHeader',
                style: {
                  height: '30px',
                  position: 'sticky',
                  top: 0,
                  width: totalWidth.value + 'px'
                }
              },
              'Header'
            ),
            h(SongListRows, {
              songs: songs.value,
              visibleColumns: columns.value,
              selectedSongFilePaths: [],
              totalWidth: totalWidth.value,
              sourceLibraryName: 'PioneerDeviceLibrary',
              sourceSongListUUID: 'desktop:collection',
              scrollHostElement: host.value,
              externalScrollTop: externalScrollTop.value,
              externalViewportHeight: externalViewportHeight.value,
              externalWaveformRootPath: 'D:/PIONEER/Master/share',
              songListRootDir: 'library/PioneerDeviceLibrary',
              readOnly: true,
              allowWaveformPreviewWhenReadOnly: true,
              enableCoverThumbnails: true
            })
          ]
        }
      )
  }
})
  .use(createPinia())
  .mount('#app')
