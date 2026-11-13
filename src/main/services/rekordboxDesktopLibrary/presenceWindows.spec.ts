import { describe, expect, it } from 'vitest'
import { parseWindowsRegistryOutput } from './presenceWindows'

describe('windows registry JSON parsing', () => {
  it('keeps Chinese paths and quoted DisplayIcon values with spaces and commas', () => {
    const parsed = parseWindowsRegistryOutput(
      JSON.stringify({
        appPaths: [{ path: 'C:\\程序 文件\\Pioneer\\rekordbox.exe' }],
        uninstall: [
          {
            displayName: 'rekordbox 7',
            installLocation: 'D:\\软件 安装,目录',
            displayIcon: '"D:\\软件 安装,目录\\rekordbox.exe",0'
          }
        ]
      })
    )

    expect(parsed).toEqual({
      appPaths: [{ path: 'C:\\程序 文件\\Pioneer\\rekordbox.exe' }],
      uninstall: [
        {
          displayName: 'rekordbox 7',
          installLocation: 'D:\\软件 安装,目录',
          displayIcon: '"D:\\软件 安装,目录\\rekordbox.exe",0'
        }
      ]
    })
  })

  it('normalizes a single object into arrays', () => {
    const parsed = parseWindowsRegistryOutput(
      JSON.stringify({
        appPaths: { path: 'C:\\rekordbox.exe' },
        uninstall: { displayName: 'rekordbox', installLocation: 'C:\\', displayIcon: '' }
      })
    )

    expect(parsed?.appPaths).toEqual([{ path: 'C:\\rekordbox.exe' }])
    expect(parsed?.uninstall).toHaveLength(1)
  })

  it('rejects invalid JSON or non-object output', () => {
    expect(parseWindowsRegistryOutput('{not-json')).toBeNull()
    expect(parseWindowsRegistryOutput('null')).toBeNull()
    expect(parseWindowsRegistryOutput('')).toBeNull()
  })
})
