import { createVNode, render } from 'vue'
import ImportTracksDialogBase from './ImportTracksDialogBase.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export type NeteaseImportDialogResult = {
  songListUuid: string
  songListPath: string
  isPushSongFingerprintLibrary: boolean
  deduplicateMode: 'library' | 'batch' | 'none'
  neteasePlaylistId: string
}

/**
 * 网易云导入的选项对话框。
 *
 * 复用普通导入那一套（歌单选择、去重模式、加入指纹库），只把"选文件"那一步去掉——
 * 源是网易云歌单，没有可选的路径。`deleteAfterImport` 也不显示：
 * 网易云导入只复制，源文件（`.store` 缓存）必须留着。
 */
export default (options: {
  libraryName: 'FilterLibrary' | 'CuratedLibrary' | 'SetLibrary' | 'MixtapeLibrary'
  neteasePlaylistId: string
}): Promise<NeteaseImportDialogResult | null> =>
  new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const finish = (value: NeteaseImportDialogResult | null) => {
      render(null, div)
      div.remove()
      resolve(value)
    }
    const vnode = createVNode(ImportTracksDialogBase, {
      mode: 'netease',
      libraryName: options.libraryName,
      neteasePlaylistId: options.neteasePlaylistId,
      actionMode: 'copy',
      confirmCallback: (payload: NeteaseImportDialogResult) => finish(payload),
      cancelCallback: () => finish(null)
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
