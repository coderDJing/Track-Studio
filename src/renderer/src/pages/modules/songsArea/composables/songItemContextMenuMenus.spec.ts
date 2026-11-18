// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/songItemContextMenuMenus.spec.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/utils/libraryTransfer', () => ({
  resolveLibraryTransferActionModeForSongList: () => 'copy'
}))

import {
  createNeteaseDownloadedMenuArr,
  createNeteaseSetStreamMenuArr,
  createNeteaseStreamMenuArr
} from './songItemContextMenuMenus'

const menuNames = (groups: Array<Array<{ menuName: string }>>): string[] =>
  groups.flat().map((item) => item.menuName)

describe('NetEase song context menus: re-analyze availability', () => {
  it('hides re-analyze for NetEase playlist rows that are not downloaded', () => {
    const names = menuNames(createNeteaseStreamMenuArr(false))
    expect(names).not.toContain('tracks.clearTrackCache')
    expect(names).toContain('netease.downloadToLocal')
  })

  it('shows re-analyze for already-downloaded NetEase playlist rows', () => {
    const names = menuNames(createNeteaseStreamMenuArr(true))
    expect(names).toContain('tracks.clearTrackCache')
    expect(names).toContain('netease.removeLocalFile')
    expect(names).not.toContain('netease.downloadToLocal')
  })

  it('shows re-analyze in the downloaded-files view', () => {
    const names = menuNames(createNeteaseDownloadedMenuArr('netease-downloaded'))
    expect(names).toContain('tracks.clearTrackCache')
  })

  it('does not show re-analyze for pending or preview rows inside a SET', () => {
    const names = menuNames(createNeteaseSetStreamMenuArr())
    expect(names).not.toContain('tracks.clearTrackCache')
  })
})
