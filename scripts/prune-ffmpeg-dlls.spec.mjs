/**
 * prune-ffmpeg-dlls.mjs 的自检。
 *
 * 用仓库内真实存在的 FFmpeg DLL 与真实原生模块搭夹具：
 *   1. 不加 --apply 时只报告、不动文件；
 *   2. 加 --apply 时只删闭包外的 DLL，闭包内一个都不能少；
 *   3. 闭包所需的 DLL 缺失时必须失败，而不是「少一个也照删」。
 *
 * 运行：node --test scripts/prune-ffmpeg-dlls.spec.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { readPeInfo } from './lib/pe-imports.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const scriptPath = path.join(repoRoot, 'scripts', 'prune-ffmpeg-dlls.mjs')
const nativeModule = path.join(repoRoot, 'node_modules/rust_package/index.win32-x64-msvc.node')
const sourceDllDir = path.join(repoRoot, 'vendor/ffmpeg/win32-x64/dll')

const FFMPEG_DLL_NAME =
  /^(av(codec|format|util|filter|device)|sw(resample|scale)|postproc)[-.].*\.dll$/i

// 版本号不写死：从原生模块的导入表里取，FFmpeg 主版本升级后样例依然对得上。
const requiredDlls = (() => {
  if (!existsSync(nativeModule)) return []
  const info = readPeInfo(nativeModule)
  if (!info.ok) return []
  return [...new Set(info.importedDlls.filter((name) => FFMPEG_DLL_NAME.test(name)))]
})()

// 冒充「没人引用、但也别被误删」的额外 DLL；名字取真实 FFmpeg 库名以便规则命中。
const EXTRA_DLLS = ['avfilter-12.dll', 'avdevice-63.dll', 'swscale-10.dll']

const fixturesAvailable =
  requiredDlls.length > 0 &&
  requiredDlls.every((name) => existsSync(path.join(sourceDllDir, name))) &&
  existsSync(scriptPath)

const skipWhenFixturesMissing = (t) => {
  if (fixturesAvailable) return false
  t.skip('缺少 Windows FFmpeg DLL 或原生模块样本，跳过')
  return true
}

const buildDllDir = async (root, options = {}) => {
  const dllDir = path.join(root, 'dll')
  await fs.mkdir(dllDir, { recursive: true })
  for (const name of requiredDlls) {
    if (options.omit === name) continue
    // 大小写不敏感：导入表里的名字与磁盘上的文件名在 Windows 上等价。
    const onDisk =
      (await fs.readdir(sourceDllDir)).find(
        (entry) => entry.toLowerCase() === name.toLowerCase()
      ) || name
    await fs.copyFile(path.join(sourceDllDir, onDisk), path.join(dllDir, onDisk))
  }
  for (const name of EXTRA_DLLS) {
    await fs.copyFile(path.join(sourceDllDir, requiredDlls[0]), path.join(dllDir, name))
  }
  return dllDir
}

const run = (dllDir, extraArgs = []) =>
  spawnSync(
    process.execPath,
    [scriptPath, '--dll-dir', dllDir, '--native-module', nativeModule, ...extraArgs],
    { encoding: 'utf8' }
  )

test('reports without deleting anything when --apply is absent', async (t) => {
  if (skipWhenFixturesMissing(t)) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-prune-dry-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dllDir = await buildDllDir(root)

  const result = run(dllDir)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /未加 --apply/)

  const remaining = await fs.readdir(dllDir)
  assert.deepEqual(
    remaining.sort(),
    [...requiredDlls, ...EXTRA_DLLS].sort(),
    '干跑不应删除任何文件'
  )
})

test('deletes only the DLLs outside the import closure', async (t) => {
  if (skipWhenFixturesMissing(t)) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-prune-apply-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dllDir = await buildDllDir(root)

  const result = run(dllDir, ['--apply'])
  assert.equal(result.status, 0, result.stderr)

  const remaining = (await fs.readdir(dllDir)).sort()
  assert.deepEqual(remaining, [...requiredDlls].sort(), '闭包内的 DLL 必须全部保留')
})

test('fails when a DLL required by the closure is missing', async (t) => {
  if (skipWhenFixturesMissing(t)) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-prune-missing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dllDir = await buildDllDir(root, { omit: requiredDlls[0] })

  const result = run(dllDir, ['--apply'])
  assert.equal(result.status, 2, `闭包缺 DLL 时应返回 2，实际 ${result.status}`)
  assert.match(
    result.stderr,
    new RegExp(requiredDlls[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  )

  const remaining = await fs.readdir(dllDir)
  assert.ok(remaining.length > 0, '闭包缺 DLL 时不应开始删除（必须整体失败）')
})
