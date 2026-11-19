// Run: pnpm exec vitest run src/renderer/src/utils/neteasePlaylistContext.spec.ts
import { describe, expect, it } from 'vitest'
import type { IDir } from '../../../types/globals'
import {
  canDeleteNeteasePlaylist,
  canRemoveTracksFromNeteasePlaylist,
  findNeteasePlaylistContext,
  getNeteasePlaylistDeletionAction
} from './neteasePlaylistContext'

const tree = (): IDir =>
  ({
    uuid: 'root',
    type: 'dir',
    dirName: 'root',
    order: 0,
    children: [
      {
        uuid: 'lib',
        type: 'library',
        dirName: 'NeteaseLibrary',
        order: 0,
        children: [
          {
            uuid: 'netease:pl:1',
            type: 'songList',
            dirName: '我喜欢的音乐',
            order: 0,
            trackCount: 10
          },
          {
            uuid: 'netease:group:created',
            type: 'dir',
            dirName: '创建的歌单',
            order: 1,
            children: [
              {
                uuid: 'netease:pl:100',
                type: 'songList',
                dirName: '夜场备播',
                order: 0,
                trackCount: 4
              }
            ]
          },
          {
            uuid: 'netease:group:subscribed',
            type: 'dir',
            dirName: '收藏的歌单',
            order: 2,
            children: [
              {
                uuid: 'netease:pl:200',
                type: 'songList',
                dirName: '别人的歌单',
                order: 0,
                trackCount: 8
              }
            ]
          },
          {
            uuid: 'netease:group:album',
            type: 'dir',
            dirName: '收藏的专辑',
            order: 3,
            children: [
              {
                uuid: 'netease:pl:300',
                type: 'songList',
                dirName: '一张专辑',
                order: 0,
                trackCount: 12
              }
            ]
          }
        ]
      }
    ]
  }) as IDir

describe('findNeteasePlaylistContext', () => {
  it('把库根下的歌单识别为我喜欢的音乐', () => {
    expect(findNeteasePlaylistContext(tree(), 'netease:pl:1')).toEqual({
      playlistId: '1',
      kind: 'liked',
      title: '我喜欢的音乐'
    })
    expect(canRemoveTracksFromNeteasePlaylist(tree(), 'netease:pl:1')).toBe(true)
    expect(canDeleteNeteasePlaylist(tree(), 'netease:pl:1')).toBe(false)
    expect(getNeteasePlaylistDeletionAction(tree(), 'netease:pl:1')).toBeNull()
  })

  it('只允许自建歌单和我喜欢的音乐移出曲目', () => {
    const root = tree()
    expect(findNeteasePlaylistContext(root, 'netease:pl:100')).toEqual({
      playlistId: '100',
      kind: 'created',
      title: '夜场备播'
    })
    expect(canRemoveTracksFromNeteasePlaylist(root, 'netease:pl:100')).toBe(true)
    expect(canRemoveTracksFromNeteasePlaylist(root, 'netease:pl:200')).toBe(false)
    expect(canRemoveTracksFromNeteasePlaylist(root, 'netease:pl:300')).toBe(false)
    expect(canRemoveTracksFromNeteasePlaylist(root, '__netease_downloaded__')).toBe(false)
    expect(canRemoveTracksFromNeteasePlaylist(root, 'netease:pl:999')).toBe(false)
  })

  it('自建歌单可删除，收藏歌单和专辑是取消收藏', () => {
    const root = tree()
    expect(canDeleteNeteasePlaylist(root, 'netease:pl:100')).toBe(true)
    expect(getNeteasePlaylistDeletionAction(root, 'netease:pl:100')).toBe('delete')
    expect(canDeleteNeteasePlaylist(root, 'netease:pl:200')).toBe(true)
    expect(getNeteasePlaylistDeletionAction(root, 'netease:pl:200')).toBe('unsubscribe')
    expect(canDeleteNeteasePlaylist(root, 'netease:pl:300')).toBe(true)
    expect(getNeteasePlaylistDeletionAction(root, 'netease:pl:300')).toBe('unsubscribe')
    expect(canDeleteNeteasePlaylist(root, '__netease_downloaded__')).toBe(false)
    expect(canDeleteNeteasePlaylist(root, 'netease:pl:999')).toBe(false)
  })
})
