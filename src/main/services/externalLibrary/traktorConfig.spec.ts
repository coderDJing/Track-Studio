import { describe, expect, it } from 'vitest'
import { parseWindowsTraktorRoots } from './traktorConfig'

describe('Traktor configured RootDirectory', () => {
  it('accepts one or several registry records with Unicode paths', () => {
    expect(
      parseWindowsTraktorRoots(
        JSON.stringify({ key: 'Traktor Pro 4 4.5.1', root: 'D:\\音乐库\\Traktor 4.5.1' })
      )
    ).toEqual(['D:\\音乐库\\Traktor 4.5.1'])
    expect(
      parseWindowsTraktorRoots(
        JSON.stringify([
          { key: 'Traktor Pro 3 3.11', root: 'D:\\Traktor 3' },
          { key: 'Traktor Pro 4 4.5.1', root: 'E:\\Traktor 4' }
        ])
      )
    ).toEqual(['D:\\Traktor 3', 'E:\\Traktor 4'])
  })
})
