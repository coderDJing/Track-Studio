import { describe, expect, it } from 'vitest'
import { KEY_FILTER_OPTIONS, normalizeCamelotKey, parseSelectedKeyFilter } from './keyDisplay'

describe('key selection filters', () => {
  it('offers the 24 distinct keys and matches classic, enharmonic and Camelot notation', () => {
    expect(new Set(KEY_FILTER_OPTIONS.map((option) => option.camelot)).size).toBe(24)
    expect(normalizeCamelotKey('C#m')).toBe('12A')
    expect(normalizeCamelotKey('D♭m')).toBe('12A')
    expect(normalizeCamelotKey('12a')).toBe('12A')
    expect(normalizeCamelotKey('C')).toBe('8B')
    expect(normalizeCamelotKey('Cm')).toBe('5A')
    expect(normalizeCamelotKey('unknown')).toBe('')
  })
  it('recognizes saved selections while preserving legacy text filters', () => {
    expect(parseSelectedKeyFilter('keys:12A,8B')).toEqual(['12A', '8B'])
    expect(parseSelectedKeyFilter('C')).toBeNull()
  })
})
