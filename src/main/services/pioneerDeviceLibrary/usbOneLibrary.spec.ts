import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect, it } from 'vitest'

// 两种 cipher profile 的完整用例会反复执行原生密钥派生，留出运行时预算。
const fixtureTimeoutMs = 180_000

it(
  '保留 SQLCipher 加密及原生 seek 字段，完整处理歌单与引用，并在未验证 Cue 位置时回滚',
  () => {
    const executable = require('electron') as string
    const fixture = path.join(import.meta.dirname, 'usbOneLibrary.fixture.ts')
    // SQLite 原生依赖为 Electron ABI 编译；不能在普通 Node Vitest 进程中加载。
    const result = spawnSync(executable, ['--require', 'tsx/cjs', fixture], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: fixtureTimeoutMs
    })
    expect(result.error, result.error?.message).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('OneLibrary encrypted fixture checks passed')
  },
  fixtureTimeoutMs + 5000
)
