/**
 * audit-packaged-bundle.mjs 的 mac 分支自检。
 *
 * 本地是 Windows，跑不了 `electron-builder --mac`，所以这里用
 * **仓库内真实存在的 Mach-O 样本**（darwin 预编译绑定）拼出一个
 * 最小 `.app/Contents/Resources` 目录，再用真实入口跑审计：
 *
 *   1. 全是 Mach-O 时应当通过（正控制）；
 *   2. 混入一个 Windows DLL 时必须失败（负控制，验证磁盘格式扫描真的会触发）；
 *   3. rust_package 只剩单架构时必须失败（验证 universal 架构判定）。
 *
 * 运行：node --test scripts/audit-packaged-bundle.spec.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..')
const builderRequire = createRequire(require.resolve('electron-builder'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = appBuilderRequire('@electron/asar')

const auditScript = path.join(repoRoot, 'scripts', 'audit-packaged-bundle.mjs')

const SAMPLES = {
  universalNode: 'node_modules/@electron-internal/extract-zip/index.darwin-universal.node',
  darwinX64Node: 'node_modules/onnxruntime-node/bin/napi-v3/darwin/x64/onnxruntime_binding.node',
  darwinArm64Node:
    'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
  sqliteX64: 'node_modules/better-sqlite3/prebuilds/darwin-x64.node',
  sqliteArm64: 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
  windowsDll: 'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll'
}

const missingSamples = Object.entries(SAMPLES)
  .filter(([, relativePath]) => !existsSync(path.join(repoRoot, relativePath)))
  .map(([key]) => key)

const skipWhenSamplesMissing = (t) => {
  if (missingSamples.length === 0) return false
  t.skip(`缺少真实样本（${missingSamples.join(', ')}），无法构造夹具`)
  return true
}

const writeFile = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

const copySample = async (relativePath, destination) => {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(path.join(repoRoot, relativePath), destination)
}

const SQLITE_PACKAGES = [
  'node_modules/better-sqlite3',
  'node_modules/better-sqlite3-multiple-ciphers',
  'node_modules/serato-connect/node_modules/better-sqlite3-multiple-ciphers'
]

const buildMacBundle = async (root, options = {}) => {
  const appDir = path.join(root, 'Track Studio.app')
  const contents = path.join(appDir, 'Contents')
  const resources = path.join(contents, 'Resources')
  const unpacked = path.join(resources, 'app.asar.unpacked')

  await writeFile(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'stub'), 'stub')

  const staging = path.join(root, 'staging')
  const archiveFiles = {
    'package.json': '{"name":"fixture","version":"0.0.0"}',
    'out/main/index.js': '// fixture main entry',
    'node_modules/onnxruntime-node/package.json': '{"name":"onnxruntime-node"}',
    'node_modules/rust_package/package.json': '{"name":"rust_package"}'
  }
  for (const packagePath of SQLITE_PACKAGES) {
    archiveFiles[`${packagePath}/package.json`] = '{"name":"better-sqlite3"}'
  }
  for (const [relativePath, content] of Object.entries(archiveFiles)) {
    await writeFile(path.join(staging, relativePath), content)
  }
  await fs.mkdir(resources, { recursive: true })
  await asar.createPackage(staging, path.join(resources, 'app.asar'))

  // rust_package 原生模块：默认用真实的 fat（x86_64+arm64）样本
  const rustNodeSample = options.thinRustNode ? SAMPLES.darwinX64Node : SAMPLES.universalNode
  await copySample(
    rustNodeSample,
    path.join(unpacked, 'node_modules/rust_package', 'rust_package.darwin-universal.node')
  )

  // ONNX Runtime darwin 两架构
  await copySample(
    SAMPLES.darwinX64Node,
    path.join(unpacked, 'node_modules/onnxruntime-node/bin/napi-v3/darwin/x64/binding.node')
  )
  await copySample(
    SAMPLES.darwinArm64Node,
    path.join(unpacked, 'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/binding.node')
  )

  // SQLite darwin 预编译绑定
  for (const packagePath of SQLITE_PACKAGES) {
    await copySample(
      SAMPLES.sqliteX64,
      path.join(unpacked, packagePath, 'prebuilds', 'darwin-x64.node')
    )
    await copySample(
      SAMPLES.sqliteArm64,
      path.join(unpacked, packagePath, 'prebuilds', 'darwin-arm64.node')
    )
  }

  // extraResources：ffmpeg / r3-stretch / demucs / rekordbox
  await writeFile(path.join(resources, 'ffmpeg', 'darwin', 'ffmpeg'), 'stub')
  await writeFile(path.join(resources, 'ffmpeg', 'darwin', 'ffprobe'), 'stub')
  await fs.mkdir(path.join(resources, 'r3-stretch', 'darwin-universal'), { recursive: true })
  await writeFile(path.join(resources, 'demucs', 'bootstrap', 'beat_this_bridge.py'), '# stub')
  await writeFile(path.join(resources, 'demucs', 'bootstrap', 'bpm_fix.py'), '# stub')
  await fs.mkdir(path.join(resources, 'rekordboxDesktopLibrary'), { recursive: true })

  if (options.windowsDll) {
    await copySample(
      SAMPLES.windowsDll,
      path.join(unpacked, 'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll')
    )
  }

  return appDir
}

const runAudit = (appDir, options = {}) => {
  const args = [auditScript, '--app-dir', appDir, '--json']
  if (options.platform !== null) args.push('--platform', options.platform || 'darwin-universal')
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    report = null
  }
  return {
    status: result.status,
    report,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  }
}

const failureRules = (report) => (report?.failures || []).map((item) => item.rule)

test('accepts a macOS bundle whose binaries are all Mach-O', async (t) => {
  if (skipWhenSamplesMissing(t)) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-audit-mac-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDir = await buildMacBundle(root)

  const { status, report, stdout, stderr } = runAudit(appDir)
  assert.ok(report, `审计没有输出 JSON：${stderr || stdout.slice(0, 500)}`)
  assert.deepEqual(failureRules(report), [], '真实 Mach-O 夹具不应触发任何致命项')
  assert.equal(status, 0)
  assert.equal(report.passed, true)
  assert.equal(report.diskBinaries.expectedKind, 'macho')
  assert.ok(report.diskBinaries.scanned >= 8, `扫描到的二进制过少：${report.diskBinaries.scanned}`)
  assert.equal(report.diskBinaries.foreign, 0)
})

test('rejects a Windows DLL smuggled into a macOS bundle', async (t) => {
  if (skipWhenSamplesMissing(t)) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-audit-mac-dll-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDir = await buildMacBundle(root, { windowsDll: true })

  const { status, report } = runAudit(appDir)
  assert.ok(report, '审计没有输出 JSON')
  assert.equal(status, 1, '混入 Windows DLL 时必须返回非零退出码')
  assert.ok(
    failureRules(report).includes('foreign-binary-on-disk'),
    `期望 foreign-binary-on-disk，实际 ${failureRules(report).join(', ')}`
  )
  assert.equal(report.diskBinaries.foreign, 1)
})

test('rejects a single-architecture native module in a universal bundle', async (t) => {
  if (skipWhenSamplesMissing(t)) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-audit-mac-thin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDir = await buildMacBundle(root, { thinRustNode: true })

  const { status, report } = runAudit(appDir)
  assert.ok(report, '审计没有输出 JSON')
  assert.equal(status, 1, '单架构 rust_package 在 universal 包里必须失败')
  assert.ok(
    failureRules(report).includes('missing-mac-arch'),
    `期望 missing-mac-arch，实际 ${failureRules(report).join(', ')}`
  )
})

test('infers the macOS layout without an explicit --platform flag', async (t) => {
  if (skipWhenSamplesMissing(t)) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-audit-mac-infer-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await buildMacBundle(root)

  // 传 .app 的父目录，且不给 --platform：应自动找到 .app 并判定为 darwin-universal
  const { status, report, stderr } = runAudit(root, { platform: null })
  assert.ok(report, `审计没有输出 JSON：${stderr}`)
  assert.equal(status, 0)
  assert.equal(report.platformKey, 'darwin-universal')
  assert.equal(path.basename(report.appDir), 'Track Studio.app')
})
