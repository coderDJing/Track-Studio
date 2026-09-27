import { describe, expect, it } from 'vitest'
import {
  isSearchFocusShortcut,
  pickSearchFocusInput,
  SEARCH_FOCUS_PRIORITY,
  selectSearchFocusCandidate,
  type SearchFocusShortcutEvent
} from './useSearchFocus'

const shortcut = (patch: Partial<SearchFocusShortcutEvent> = {}): SearchFocusShortcutEvent => ({
  key: 'f',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...patch
})

describe('isSearchFocusShortcut', () => {
  it('接受单独的 Ctrl+F 和 Cmd+F', () => {
    expect(isSearchFocusShortcut(shortcut())).toBe(true)
    expect(isSearchFocusShortcut(shortcut({ key: 'F' }))).toBe(true)
    expect(
      isSearchFocusShortcut(shortcut({ ctrlKey: false, metaKey: true, code: 'KeyF', key: 'ф' }))
    ).toBe(true)
  })

  it('不接受带 Shift、Alt，或两个修饰键一起按的组合', () => {
    expect(isSearchFocusShortcut(shortcut({ shiftKey: true }))).toBe(false)
    expect(isSearchFocusShortcut(shortcut({ altKey: true }))).toBe(false)
    expect(isSearchFocusShortcut(shortcut({ ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isSearchFocusShortcut(shortcut({ ctrlKey: false }))).toBe(false)
    expect(isSearchFocusShortcut(shortcut({ key: 'g' }))).toBe(false)
    expect(isSearchFocusShortcut(shortcut({ repeat: true }))).toBe(false)
    expect(isSearchFocusShortcut(shortcut({ isComposing: true }))).toBe(false)
  })
})

describe('pickSearchFocusInput', () => {
  const sidebar = { scope: 'windowGlobal', priority: 0, input: 'sidebar', visible: true }
  const dialog = { scope: 'windowGlobal', priority: 10, input: 'dialog', visible: true }

  it('当前层没有可见搜索框时不聚焦', () => {
    expect(pickSearchFocusInput([sidebar], 'dialog-scope')).toBeNull()
    expect(pickSearchFocusInput([{ ...sidebar, visible: false }], 'windowGlobal')).toBeNull()
  })

  it('同一层里优先聚焦更靠前的浮层搜索框', () => {
    expect(pickSearchFocusInput([sidebar, dialog], 'windowGlobal')).toBe('dialog')
  })

  it('对话框自己的 scope 不会落到后面的侧栏', () => {
    expect(
      pickSearchFocusInput(
        [sidebar, { scope: 'select-song-list', priority: 10, input: 'picker', visible: true }],
        'select-song-list'
      )
    ).toBe('picker')
  })

  it('可见对话框上的菜单 scope 不会聚焦后方搜索框', () => {
    const topDialog = { contains: () => true }
    expect(
      selectSearchFocusCandidate(
        [
          {
            scope: 'select-song-list',
            priority: SEARCH_FOCUS_PRIORITY.dialog,
            input: 'picker',
            visible: true
          },
          {
            scope: 'windowGlobal',
            priority: SEARCH_FOCUS_PRIORITY.dialog,
            input: 'external',
            visible: true
          }
        ],
        { currentScope: 'context-menu', topDialog }
      )
    ).toBeNull()
  })

  it('当前 scope 就是该对话框时聚焦其中的搜索框', () => {
    expect(
      selectSearchFocusCandidate(
        [
          {
            scope: 'windowGlobal',
            priority: SEARCH_FOCUS_PRIORITY.sidebar,
            input: 'sidebar',
            visible: true
          },
          {
            scope: 'select-song-list',
            priority: SEARCH_FOCUS_PRIORITY.dialog,
            input: 'picker',
            visible: true
          }
        ],
        {
          currentScope: 'select-song-list',
          topDialog: { contains: (input: string) => input === 'picker' }
        }
      )
    ).toBe('picker')
  })

  it('同优先级时后注册的搜索框优先', () => {
    expect(
      pickSearchFocusInput(
        [
          { scope: 'windowGlobal', priority: 10, input: 'first', visible: true },
          { scope: 'windowGlobal', priority: 10, input: 'second', visible: true }
        ],
        'windowGlobal'
      )
    ).toBe('second')
  })
})
