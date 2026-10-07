import { describe, expect, it } from 'vitest'
import { resolvePioneerDevicePath } from './devicePath'

describe('Pioneer device path resolution', () => {
  it.each(['win32', 'posix'] as const)(
    'resolves native and runtime paths with %s semantics',
    (style) => {
      const root = style === 'win32' ? 'E:\\' : '/Volumes/Fixture'
      const expected =
        style === 'win32'
          ? 'E:\\PIONEER\\USBANLZ\\1\\ANLZ0000.DAT'
          : '/Volumes/Fixture/PIONEER/USBANLZ/1/ANLZ0000.DAT'
      for (const source of [
        '/PIONEER/USBANLZ/1/ANLZ0000.DAT',
        '\\PIONEER\\USBANLZ\\1\\ANLZ0000.DAT',
        'PIONEER/USBANLZ/1/ANLZ0000.DAT',
        expected
      ])
        expect(resolvePioneerDevicePath(root, source, { pathStyle: style })).toBe(expected)
    }
  )

  it.each(['win32', 'posix'] as const)(
    'rejects traversal, drive and UNC escapes with %s semantics',
    (style) => {
      const root = style === 'win32' ? 'E:\\' : '/Volumes/Fixture'
      for (const source of [
        '/../outside/ANLZ0000.DAT',
        'PIONEER/../../outside/ANLZ0000.DAT',
        'F:\\PIONEER\\ANLZ0000.DAT',
        'F:ANLZ0000.DAT',
        '\\\\other-host\\share\\ANLZ0000.DAT'
      ])
        expect(() => resolvePioneerDevicePath(root, source, { pathStyle: style })).toThrow()
    }
  )

  it('accepts an existing runtime path inside a Windows UNC device root', () => {
    expect(
      resolvePioneerDevicePath('\\\\host\\usb', '\\\\host\\usb\\PIONEER\\ANLZ0000.DAT', {
        pathStyle: 'win32'
      })
    ).toBe('\\\\host\\usb\\PIONEER\\ANLZ0000.DAT')
  })

  it('retains the volume prefix for a Windows native path on the current host drive', () => {
    expect(resolvePioneerDevicePath('C:\\', '/PIONEER/ANLZ0000.DAT', { pathStyle: 'win32' })).toBe(
      'C:\\PIONEER\\ANLZ0000.DAT'
    )
  })
})
