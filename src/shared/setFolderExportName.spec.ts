import { describe, expect, it } from 'vitest'
import {
  allocateUniqueFileName,
  buildSetFolderExportFileName,
  padSetExportIndex,
  sanitizeSetExportNamePart
} from './setFolderExportName'

describe('set folder export names', () => {
  it('builds 01 Title - Artist with the original extension', () => {
    expect(
      buildSetFolderExportFileName({
        index: 1,
        total: 10,
        title: 'Midnight City',
        artist: 'M83',
        originalFileName: 'raw.mp3'
      })
    ).toBe('01 Midnight City - M83.mp3')
    expect(
      buildSetFolderExportFileName({
        index: 2,
        total: 10,
        title: '夜曲',
        artist: '某艺人',
        originalFileName: 'clip.wav'
      })
    ).toBe('02 夜曲 - 某艺人.wav')
  })

  it('omits the trailing artist separator when artist is missing', () => {
    expect(
      buildSetFolderExportFileName({
        index: 1,
        total: 3,
        title: 'Midnight City',
        artist: '  ',
        originalFileName: 'raw.mp3'
      })
    ).toBe('01 Midnight City.mp3')
  })

  it('falls back from title to the original file stem, then Track', () => {
    expect(
      buildSetFolderExportFileName({
        index: 3,
        total: 3,
        artist: 'M83',
        originalFileName: 'backup take.flac'
      })
    ).toBe('03 backup take - M83.flac')
    expect(
      buildSetFolderExportFileName({
        index: 1,
        total: 1
      })
    ).toBe('01 Track')
  })

  it('pads to two digits, then wider when the set has 100 or more tracks', () => {
    expect(padSetExportIndex(9, 99)).toBe('09')
    expect(padSetExportIndex(10, 99)).toBe('10')
    expect(padSetExportIndex(7, 100)).toBe('007')
    expect(padSetExportIndex(100, 100)).toBe('100')
  })

  it('strips Windows-illegal characters and trailing dots or spaces', () => {
    expect(sanitizeSetExportNamePart('A<B>:C/D|E?. ')).toBe('A B C D E')
    expect(
      buildSetFolderExportFileName({
        index: 1,
        total: 1,
        title: 'Hello/World?',
        artist: 'AC/DC',
        originalFileName: 'x.mp3'
      })
    ).toBe('01 Hello World - AC DC.mp3')
  })

  it('allocates a numeric suffix when the name is already used', () => {
    const used = new Set<string>()
    expect(allocateUniqueFileName('01 Night - A.mp3', used)).toBe('01 Night - A.mp3')
    expect(allocateUniqueFileName('01 Night - A.mp3', used)).toBe('01 Night - A (2).mp3')
    expect(allocateUniqueFileName('01 NIGHT - A.mp3', used)).toBe('01 NIGHT - A (3).mp3')
  })
})
