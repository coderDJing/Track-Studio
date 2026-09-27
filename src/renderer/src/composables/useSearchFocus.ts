import { onUnmounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'

/** 侧栏搜索和浮层搜索叠在一起时，浮层优先。 */
export const SEARCH_FOCUS_PRIORITY = {
  sidebar: 0,
  dialog: 10
} as const

export type SearchFocusShortcutEvent = {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing?: boolean
}

export type SearchFocusCandidate<T> = {
  scope: string
  priority: number
  input: T | null
  visible: boolean
}

type SearchFocusTarget = {
  getInput: () => HTMLInputElement | null | undefined
  /** 该搜索框所属的 hotkeys scope。只有它处于当前层时才响应 Ctrl/Cmd+F。 */
  scope: string | (() => string)
  priority: number
}

const WINDOW_GLOBAL_SCOPE = 'windowGlobal'

export const SEARCH_FOCUS_WINDOW_SCOPE = WINDOW_GLOBAL_SCOPE

const targets: SearchFocusTarget[] = []
let shortcutInstalled = false

export function isSearchFocusShortcut(event: SearchFocusShortcutEvent) {
  if (event.repeat || event.isComposing) return false
  if (event.altKey || event.shiftKey) return false
  // 只认单独的 Ctrl 或 Cmd，避免 Ctrl+Cmd+F 这类组合被吃掉。
  if (event.ctrlKey === event.metaKey) return false
  return event.key.toLowerCase() === 'f' || event.code === 'KeyF'
}

export function pickSearchFocusInput<T>(
  candidates: SearchFocusCandidate<T>[],
  currentScope: string
): T | null {
  let bestPriority = Number.NEGATIVE_INFINITY
  let bestIndex = -1
  let bestInput: T | null = null
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (candidate.scope !== currentScope || !candidate.visible || candidate.input == null) continue
    if (
      candidate.priority > bestPriority ||
      (candidate.priority === bestPriority && index > bestIndex)
    ) {
      bestPriority = candidate.priority
      bestIndex = index
      bestInput = candidate.input
    }
  }
  return bestInput
}

export function selectSearchFocusCandidate<T>(
  candidates: SearchFocusCandidate<T>[],
  options: {
    currentScope: string
    topDialog: { contains: (input: T) => boolean } | null
  }
): T | null {
  const { currentScope, topDialog } = options
  // 右键菜单等临时层不是对话框，但会盖住后方搜索框；scope 不一致时直接忽略。
  if (!topDialog && currentScope !== WINDOW_GLOBAL_SCOPE) return null
  const eligible: SearchFocusCandidate<T>[] = []
  for (const candidate of candidates) {
    if (candidate.scope !== currentScope || !candidate.visible || candidate.input == null) continue
    if (topDialog) {
      if (!topDialog.contains(candidate.input)) continue
    } else if (candidate.priority !== SEARCH_FOCUS_PRIORITY.sidebar) {
      continue
    }
    eligible.push(candidate)
  }
  return pickSearchFocusInput(eligible, currentScope)
}

function resolveSearchFocusScope(scope: string | (() => string)) {
  return typeof scope === 'function' ? scope() : scope
}

export function isSearchInputVisible(input: HTMLInputElement | null | undefined) {
  if (!input || input.disabled || !input.isConnected) return false
  const rect = input.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

export function focusSearchInput(input: HTMLInputElement | null | undefined) {
  if (!isSearchInputVisible(input) || !input) return
  input.focus()
  input.select()
}

function currentHotkeyScope() {
  const heap = useRuntimeStore().hotkeysScopesHeap
  return heap[heap.length - 1] || WINDOW_GLOBAL_SCOPE
}

function topmostVisibleDialog() {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('.dialog.dialog-visible'))
  const visible = dialogs.filter((dialog) => {
    const rect = dialog.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  visible.sort((a, b) => {
    const aZ = Number.parseInt(getComputedStyle(a).zIndex, 10)
    const bZ = Number.parseInt(getComputedStyle(b).zIndex, 10)
    const zDelta = (Number.isFinite(aZ) ? aZ : 0) - (Number.isFinite(bZ) ? bZ : 0)
    if (zDelta !== 0) return zDelta
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
  return visible[visible.length - 1] ?? null
}

function pickFrontmostSearchInput() {
  const dialog = topmostVisibleDialog()
  const candidates: SearchFocusCandidate<HTMLInputElement>[] = []
  for (const target of targets) {
    const input = target.getInput() ?? null
    if (!isSearchInputVisible(input) || !input) continue
    candidates.push({
      scope: resolveSearchFocusScope(target.scope),
      priority: target.priority,
      input,
      visible: true
    })
  }
  return selectSearchFocusCandidate(candidates, {
    currentScope: currentHotkeyScope(),
    topDialog: dialog ? { contains: (input: HTMLInputElement) => dialog.contains(input) } : null
  })
}

function isForeignEditable(target: EventTarget | null, input: HTMLInputElement) {
  const element = target as HTMLElement | null
  if (!element || element === input) return false
  const tagName = element.tagName
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  return element.isContentEditable
}

function handleSearchFocusKeydown(event: KeyboardEvent) {
  if (!isSearchFocusShortcut(event)) return
  const input = pickFrontmostSearchInput()
  if (!input || isForeignEditable(event.target, input)) return
  event.preventDefault()
  event.stopPropagation()
  focusSearchInput(input)
}

export function installSearchFocusShortcut() {
  if (shortcutInstalled) return
  shortcutInstalled = true
  window.addEventListener('keydown', handleSearchFocusKeydown, true)
}

export function uninstallSearchFocusShortcut() {
  if (!shortcutInstalled) return
  shortcutInstalled = false
  window.removeEventListener('keydown', handleSearchFocusKeydown, true)
}

export function useSearchFocusTarget(target: SearchFocusTarget) {
  targets.push(target)
  onUnmounted(() => {
    const index = targets.indexOf(target)
    if (index >= 0) targets.splice(index, 1)
  })
}
