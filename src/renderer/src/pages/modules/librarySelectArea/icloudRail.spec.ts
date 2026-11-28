import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { baseParse, NodeTypes, type RootNode, type ElementNode } from '@vue/compiler-dom'
import {
  icloudOpen,
  icloudDirectory,
  icloudDirectorySelected,
  icloudTransfer
} from '@renderer/utils/icloudLibrary'
import { leaveIcloudLibrary, selectIcloudSiblingLibrary } from './useIcloudLibraryRail'
import { isIcloudEntryVisible, type IcloudState } from '@shared/icloudLibrary'

function findElement(
  node: RootNode | ElementNode,
  predicate: (element: ElementNode) => boolean
): ElementNode | undefined {
  for (const child of node.children) {
    if (child.type !== NodeTypes.ELEMENT) continue
    if (predicate(child)) return child
    const found = findElement(child, predicate)
    if (found) return found
  }
}

function hasClass(node: ElementNode, name: string) {
  return node.props.some((prop) => {
    if (prop.type !== NodeTypes.ATTRIBUTE || prop.name !== 'class') return false
    return (prop.value?.content || '').split(/\s+/).includes(name)
  })
}

describe('iCloud rail placement and visibility preference', () => {
  it('is the first entry under the divider, outside the core libraries', async () => {
    const file = await fs.readFile(
      path.join(process.cwd(), 'src/renderer/src/pages/modules/librarySelectArea.vue'),
      'utf8'
    )
    const template = parse(file).descriptor.template!.content
    const ast = baseParse(template)
    const scroller = findElement(ast, (node) => node.tag === 'OverlayScrollbarsComponent')!
    const core = findElement(scroller, (node) => hasClass(node, 'librarySelectAreaCore'))!
    const dynamic = findElement(scroller, (node) => hasClass(node, 'librarySelectAreaDynamic'))!
    const scrollerElements = scroller.children.filter((node) => node.type === NodeTypes.ELEMENT)
    expect(scrollerElements.indexOf(core)).toBeGreaterThanOrEqual(0)
    expect(scrollerElements.indexOf(core)).toBeLessThan(scrollerElements.indexOf(dynamic))
    expect(hasClass(dynamic, 'librarySelectAreaDynamic--with-divider')).toBe(true)
    const firstDynamic = dynamic.children.find((node) => node.type === NodeTypes.ELEMENT)
    expect(firstDynamic?.type === NodeTypes.ELEMENT && firstDynamic.tag).toBe('IcloudLibraryEntry')
    expect(findElement(core, (node) => node.tag === 'IcloudLibraryEntry')).toBeUndefined()
  })
  it('honors persistent hiding and restoration without overriding capability or offline retention', () => {
    const state: IcloudState = {
      supported: true,
      visible: true,
      available: true,
      configured: false,
      folder: ''
    }
    expect(isIcloudEntryVisible(state)).toBe(true)
    expect(isIcloudEntryVisible(state, false)).toBe(false)
    expect(isIcloudEntryVisible(state, true)).toBe(true)
    expect(isIcloudEntryVisible({ ...state, available: false, configured: true }, true)).toBe(true)
    expect(isIcloudEntryVisible({ ...state, visible: false }, true)).toBe(false)
    expect(isIcloudEntryVisible(null, true)).toBe(false)
  })
})

describe('iCloud sibling navigation, not a dismissible panel', () => {
  it('returns to even the unchanged prior library without resetting song or Drive selections', () => {
    const runtime: Parameters<typeof selectIcloudSiblingLibrary>[0] & {
      songsArea: { songListUUID: string }
    } = {
      libraryAreaSelected: 'CuratedLibrary',
      songsArea: { songListUUID: 'kept-playlist' }
    }
    const original = runtime.songsArea
    icloudOpen.value = true
    icloudDirectory.value = 'Documents/Albums'
    icloudDirectorySelected.value = true
    icloudTransfer.busy = true
    selectIcloudSiblingLibrary(runtime, 'CuratedLibrary')
    expect(icloudOpen.value).toBe(false)
    expect(runtime.libraryAreaSelected).toBe('CuratedLibrary')
    expect(runtime.songsArea).toBe(original)
    expect(runtime.songsArea.songListUUID).toBe('kept-playlist')
    expect(icloudDirectory.value).toBe('Documents/Albums')
    expect(icloudDirectorySelected.value).toBe(true)
    expect(icloudTransfer.busy).toBe(true)
    icloudOpen.value = true
    selectIcloudSiblingLibrary(runtime, 'FilterLibrary')
    expect(runtime.libraryAreaSelected).toBe('FilterLibrary')
    expect(icloudOpen.value).toBe(false)
    icloudTransfer.busy = false
  })
  it('can leave for an already active DJ source without resetting its own state', () => {
    icloudOpen.value = true
    icloudDirectory.value = 'Keep'
    leaveIcloudLibrary()
    expect(icloudOpen.value).toBe(false)
    expect(icloudDirectory.value).toBe('Keep')
  })
  it('wires core, gated Netease and actual DJ activation rather than closing on incidental clicks', async () => {
    const file = await fs.readFile(
      path.join(process.cwd(), 'src/renderer/src/pages/modules/librarySelectArea.vue'),
      'utf8'
    )
    expect(file).toContain('selectIcloudSiblingLibrary(runtime, item.name)')
    expect(file).toContain("selectIcloudSiblingLibrary(runtime, 'NeteaseLibrary')")
    expect(file.match(/onLibraryActivated: leaveIcloudLibrary/g)).toHaveLength(2)
    const panel = await fs.readFile(
      path.join(process.cwd(), 'src/renderer/src/pages/modules/IcloudLibraryPanel.vue'),
      'utf8'
    )
    const ast = baseParse(parse(panel).descriptor.template!.content)
    expect(
      findElement(
        ast,
        (node) =>
          node.tag === 'button' &&
          node.children.some(
            (child) =>
              child.type === NodeTypes.INTERPOLATION &&
              child.content.type === NodeTypes.SIMPLE_EXPRESSION &&
              child.content.content.includes('common.close')
          )
      )
    ).toBeUndefined()
    expect(panel).toContain("t('icloud.cancel')")
  })
})
