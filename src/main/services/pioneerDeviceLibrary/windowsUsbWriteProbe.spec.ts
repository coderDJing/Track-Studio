import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32')(
  'validates native drive roots and exact process snapshots',
  () => {
    const result = spawnSync(
      process.execPath,
      ['--require', 'tsx/cjs', path.join(import.meta.dirname, 'windowsUsbWriteProbe.fixture.ts')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('Windows USB probe native checks passed')
  }
)
