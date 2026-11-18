import { createVNode, render } from 'vue'
import ImportTracksDialogBase from './ImportTracksDialogBase.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export type NeteaseCopyToLibraryDialogResult = {
  songListUuid: string
  songListPath: string
  isPushSongFingerprintLibrary: boolean
  deduplicateMode: 'library' | 'none'
  removeFromPlaylist: boolean
}

/**
 * 从网易云歌单（或「查看已下载」）复制到筛选库 / 精选库的前置选项。
 * 样式跟导入新曲目同一套：先选目标歌单，再决定要不要入指纹库、比对去重、
 * 以及复制后是否从当前网易云歌单移除。没有「仅对本次导入去重」——
 * 网易云曲目本身不会在同一批里重复。
 */
export default (options: {
  libraryName: 'FilterLibrary' | 'CuratedLibrary'
  canRemoveFromPlaylist: boolean
}): Promise<NeteaseCopyToLibraryDialogResult | null> =>
  new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const finish = (value: NeteaseCopyToLibraryDialogResult | null) => {
      render(null, div)
      div.remove()
      resolve(value)
    }
    const vnode = createVNode(ImportTracksDialogBase, {
      mode: 'neteaseCopy',
      libraryName: options.libraryName,
      canRemoveFromPlaylist: options.canRemoveFromPlaylist,
      actionMode: 'copy',
      confirmCallback: (payload: NeteaseCopyToLibraryDialogResult) => finish(payload),
      cancelCallback: () => finish(null)
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
