// Run: pnpm exec vitest run src/main/netease/importName.spec.ts
import { describe, expect, it } from 'vitest'
import { buildImportBaseName } from './importName'

describe('buildImportBaseName', () => {
  it('用「艺人 - 标题」拼出文件名', () => {
    expect(buildImportBaseName('Nancy Sinatra', 'Bang Bang', '1')).toBe('Nancy Sinatra - Bang Bang')
  })

  it('把 Windows 非法字符换成空格，并压掉连续空白', () => {
    expect(buildImportBaseName('A/B', 'C:D*E', '1')).toBe('A B - C D E')
  })

  it('去掉整段文件名结尾的点和空格，避免 Windows 吞掉后缀点后撞名', () => {
    // 清理发生在拼好的文件名上，中间段里的点会保留
    expect(buildImportBaseName('Artist', 'Title. ', '1')).toBe('Artist - Title')
    expect(buildImportBaseName('Artist.', 'Title. ', '1')).toBe('Artist. - Title')
  })

  it('标题或艺人为空时用剩下的那一段，两段都空则回退到 songId', () => {
    expect(buildImportBaseName('', 'Only Title', '9')).toBe('Only Title')
    expect(buildImportBaseName('Only Artist', '', '9')).toBe('Only Artist')
    expect(buildImportBaseName('   ', '', '42')).toBe('netease_42')
    expect(buildImportBaseName('...', '???', '42')).toBe('netease_42')
  })

  it('超长名字截到 96 个字符，截完后不会以点或空格结尾', () => {
    const title = `${'a'.repeat(90)}.`
    const base = buildImportBaseName('bb', title, '1')
    expect(base.length).toBeLessThanOrEqual(96)
    expect(base.endsWith('.')).toBe(false)
    expect(base.endsWith(' ')).toBe(false)
    expect(base.startsWith('bb - ')).toBe(true)
  })
})
