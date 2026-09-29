import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileScript, compileTemplate, parse, registerTS } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const componentPath = fileURLToPath(
  new URL('./HorizontalBrowseRawWaveformDetail.vue', import.meta.url)
)
const templatePath = fileURLToPath(
  new URL('./HorizontalBrowseRawWaveformDetail.template.html', import.meta.url)
)

describe('双轨大波形外置模板', () => {
  it('ref 回调使用脚本绑定，不把 DOM 构造函数当作组件变量读取', () => {
    registerTS(() => ts)
    const { descriptor } = parse(readFileSync(componentPath, 'utf8'), {
      filename: componentPath
    })
    const script = compileScript(descriptor, {
      id: 'horizontal-browse-detail-test',
      fs: {
        fileExists: existsSync,
        readFile: (path) => readFileSync(path, 'utf8'),
        realpath: realpathSync
      }
    })
    const template = compileTemplate({
      source: readFileSync(templatePath, 'utf8'),
      filename: templatePath,
      id: 'horizontal-browse-detail-test',
      compilerOptions: { bindingMetadata: script.bindings }
    })

    expect(template.errors).toEqual([])
    expect(template.code).toContain('setWaveformTileContainer')
    expect(template.code).toContain('setWaveformTileCanvas')
    expect(template.code).not.toMatch(/_ctx\.HTML(?:Div|Canvas)Element/)
  })
})
