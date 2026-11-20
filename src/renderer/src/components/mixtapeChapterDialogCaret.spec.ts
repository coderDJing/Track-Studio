import { describe, expect, it } from 'vitest'
import {
  resolveScrollTopToShowRange,
  resolveTextareaCaretMarkerText
} from './mixtapeChapterDialogCaret'

describe('resolveTextareaCaretMarkerText', () => {
  it('uses a single character at the caret instead of the remaining text', () => {
    const value = ['0:00 One - A', '0:46 Two - B', '3:20 Third - C'].join('\n')
    expect(resolveTextareaCaretMarkerText(value, 0)).toBe('0')
    expect(resolveTextareaCaretMarkerText(value, value.indexOf('Two'))).toBe('T')
    expect(resolveTextareaCaretMarkerText(value, value.length)).toBe('.')
    expect(resolveTextareaCaretMarkerText(value, 0)).not.toBe(value)
  })
})

describe('resolveScrollTopToShowRange', () => {
  const viewHeight = 278

  it('keeps the current scroll when a one-line caret is already visible', () => {
    expect(resolveScrollTopToShowRange(0, viewHeight, 10, 31)).toBe(0)
    expect(resolveScrollTopToShowRange(120, viewHeight, 150, 171)).toBe(120)
  })

  it('does not jump to the end when the caret is near the top of a long document', () => {
    const remainingTextBottom = 1860
    const buggyScrollTop = resolveScrollTopToShowRange(0, viewHeight, 10, remainingTextBottom)
    const fixedScrollTop = resolveScrollTopToShowRange(0, viewHeight, 10, 31)
    expect(buggyScrollTop).toBe(remainingTextBottom - viewHeight)
    expect(fixedScrollTop).toBe(0)
  })

  it('scrolls the smallest distance needed to reveal a caret outside the viewport', () => {
    expect(resolveScrollTopToShowRange(0, viewHeight, 500, 521)).toBe(521 - viewHeight)
    expect(resolveScrollTopToShowRange(400, viewHeight, 10, 31)).toBe(10)
  })
})
