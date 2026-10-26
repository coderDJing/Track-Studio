import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckInteractionTrace = {
  filePath: string
  startedAt: number
}

type DeckActionKey = 'play-toggle' | 'cue-preview' | 'cue-stop' | 'seek'

type DeckActionTrace = {
  filePath: string
  startedAt: number
}

const deckInteractionTraceMap = new Map<HorizontalBrowseDeckKey, DeckInteractionTrace>()
const deckActionTraceMap = new Map<string, DeckActionTrace>()

export const beginHorizontalBrowseDeckInteraction = (
  deck: HorizontalBrowseDeckKey,
  filePath: string
) => {
  deckInteractionTraceMap.set(deck, {
    filePath: String(filePath || '').trim(),
    startedAt: performance.now()
  })
}

export const resolveHorizontalBrowseInteractionElapsedMs = (
  deck: HorizontalBrowseDeckKey,
  filePath: string
) => {
  const current = deckInteractionTraceMap.get(deck)
  const normalizedPath = String(filePath || '').trim()
  if (!current || !normalizedPath || !sameRendererFilePath(current.filePath, normalizedPath))
    return undefined
  return Number((performance.now() - current.startedAt).toFixed(1))
}

const resolveDeckActionTraceKey = (deck: HorizontalBrowseDeckKey, action: DeckActionKey) =>
  `${deck}:${action}`

export const beginHorizontalBrowseDeckAction = (
  deck: HorizontalBrowseDeckKey,
  action: DeckActionKey,
  filePath: string
) => {
  deckActionTraceMap.set(resolveDeckActionTraceKey(deck, action), {
    filePath: String(filePath || '').trim(),
    startedAt: performance.now()
  })
}

export const resolveHorizontalBrowseDeckActionElapsedMs = (
  deck: HorizontalBrowseDeckKey,
  action: DeckActionKey,
  filePath: string
) => {
  const current = deckActionTraceMap.get(resolveDeckActionTraceKey(deck, action))
  const normalizedPath = String(filePath || '').trim()
  if (!current || !normalizedPath || !sameRendererFilePath(current.filePath, normalizedPath))
    return undefined
  return Number((performance.now() - current.startedAt).toFixed(1))
}
