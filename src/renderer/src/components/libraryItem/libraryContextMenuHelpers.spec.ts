import { describe, expect, it } from 'vitest'
import {
  buildLibraryContextMenuArr,
  canRevealLibraryRootInExplorer
} from './libraryContextMenuHelpers'
import type { IDir } from 'src/types/globals'

const SHOW_IN_EXPLORER = 'tracks.showInFileExplorer'

const makeNode = (type: IDir['type'], dirName = 'someFolder'): IDir => ({
  uuid: 'node-uuid',
  type,
  dirName
})

const menuNames = (menuArr: ReturnType<typeof buildLibraryContextMenuArr>): string[] =>
  menuArr.flat().map((item) => item.menuName)

const buildMenu = (options: {
  dirData: IDir
  libraryAreaSelected: string
  libraryName: string
  creatingSongListUUID?: string
}) =>
  buildLibraryContextMenuArr({
    dirData: options.dirData,
    libraryAreaSelected: options.libraryAreaSelected,
    libraryName: options.libraryName,
    creatingSongListUUID: options.creatingSongListUUID || ''
  })

describe('buildLibraryContextMenuArr / 在文件资源浏览器中显示', () => {
  it.each(['FilterLibrary', 'CuratedLibrary', 'RecordingLibrary'])(
    '%s 的文件夹节点应提供「在文件资源浏览器中显示」',
    (libraryName) => {
      const names = menuNames(
        buildMenu({
          dirData: makeNode('dir'),
          libraryAreaSelected: libraryName,
          libraryName
        })
      )
      expect(names).toContain(SHOW_IN_EXPLORER)
    }
  )

  it.each(['FilterLibrary', 'CuratedLibrary', 'RecordingLibrary'])(
    '%s 的歌单节点应提供「在文件资源浏览器中显示」',
    (libraryName) => {
      const names = menuNames(
        buildMenu({
          dirData: makeNode('songList'),
          libraryAreaSelected: libraryName,
          libraryName
        })
      )
      expect(names).toContain(SHOW_IN_EXPLORER)
    }
  )

  it.each(['FilterLibrary', 'CuratedLibrary', 'RecordingLibrary'])(
    '%s 的库根节点应提供「在文件资源浏览器中显示」',
    (libraryName) => {
      const names = menuNames(
        buildMenu({
          dirData: makeNode('library', libraryName),
          libraryAreaSelected: libraryName,
          libraryName
        })
      )
      expect(names).toContain(SHOW_IN_EXPLORER)
    }
  )

  it('回收站节点应提供「在文件资源浏览器中显示」', () => {
    const names = menuNames(
      buildMenu({
        dirData: makeNode('songList', 'deletedPlaylist'),
        libraryAreaSelected: 'RecycleBin',
        libraryName: 'RecycleBin'
      })
    )
    expect(names).toContain(SHOW_IN_EXPLORER)
  })

  it('回收站菜单不应包含创建歌单等写入类操作', () => {
    const names = menuNames(
      buildMenu({
        dirData: makeNode('songList', 'deletedPlaylist'),
        libraryAreaSelected: 'RecycleBin',
        libraryName: 'RecycleBin'
      })
    )
    expect(names).not.toContain('library.createPlaylist')
    expect(names).toContain('recycleBin.permanentlyDelete')
  })
})

describe('canRevealLibraryRootInExplorer', () => {
  it.each(['FilterLibrary', 'CuratedLibrary', 'RecordingLibrary', 'RecycleBin'])(
    '%s 的库根目录可定位到资源管理器',
    (libraryAreaSelected) => {
      expect(canRevealLibraryRootInExplorer(libraryAreaSelected)).toBe(true)
    }
  )

  it.each(['MixtapeLibrary', 'SetLibrary', 'ExternalPlaylist', 'PioneerDeviceLibrary', ''])(
    '%s 不在可定位范围内',
    (libraryAreaSelected) => {
      expect(canRevealLibraryRootInExplorer(libraryAreaSelected)).toBe(false)
    }
  )
})
