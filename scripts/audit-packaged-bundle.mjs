#!/usr/bin/env node
/**
 * 打包产物审计：直接读 app.asar 头表与磁盘上的 resources / app.asar.unpacked，
 * 用「实际产物」而不是「构建配置」判断有没有把不该进包的东西打进去。
 *
 * 之所以要单独做这一步：electron-builder 的 files 规则是黑名单叠加，
 * 任何一次新增依赖、新增构建脚本、或者把一个目录从 git 里删掉却留在工作区，
 * 都可能让几百 MB 的重复目录、错误平台的二进制、源码和 .env 重新混进安装包，
 * 而安装包仍然能构建成功、也能启动，人工很难发现。
 *
 * 用法：
 *   node scripts/audit-packaged-bundle.mjs
 *   node scripts/audit-packaged-bundle.mjs --app-dir dist/win-unpacked --platform win32-x64
 *   node scripts/audit-packaged-bundle.mjs --json
 *
 * 退出码：0 = 全部通过；1 = 存在致命项；2 = 用法/环境错误。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import asar from '@electron/asar'

import { readMachOInfo } from './lib/macho-archs.mjs'
import { readPeInfo } from './lib/pe-imports.mjs'

const argv = process.argv.slice(2)
const readFlag = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  if (index < 0) return fallback
  return String(argv[index + 1] || '').trim() || fallback
}
const hasFlag = (flag) => argv.includes(flag)

const appDirArg = readFlag('--app-dir', 'dist/win-unpacked')
const platformArg = readFlag('--platform', '')
const jsonOutput = hasFlag('--json')
const outputFile = readFlag('--output', '')

const requestedDir = path.resolve(appDirArg)
if (!fs.existsSync(requestedDir)) {
  console.error(`[audit] 找不到打包目录：${requestedDir}`)
  process.exit(2)
}

/**
 * 定位 resources 目录，同时支持三种传参习惯：
 *   dist/win-unpacked            （Windows / Linux 解包目录）
 *   dist/mac-universal/Track Studio.app
 *   dist/mac-universal           （目录下只有一个 .app 时自动进去）
 */
const findResourcesDir = (rootDir) => {
  for (const candidate of [
    path.join(rootDir, 'Contents', 'Resources'),
    path.join(rootDir, 'resources')
  ]) {
    if (fs.existsSync(candidate)) return candidate
  }
  let children = []
  try {
    children = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return ''
  }
  const apps = children.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (apps.length !== 1) return ''
  const nested = path.join(rootDir, apps[0].name, 'Contents', 'Resources')
  return fs.existsSync(nested) ? nested : ''
}

const resourcesDir = findResourcesDir(requestedDir)
if (!resourcesDir) {
  console.error(`[audit] 在目标目录下找不到 resources/ 或 Contents/Resources：${requestedDir}`)
  process.exit(2)
}

const looksLikeMacBundle = /[\\/]Contents[\\/]Resources$/i.test(resourcesDir)
const platformKey =
  platformArg ||
  (looksLikeMacBundle
    ? 'darwin-universal'
    : process.platform === 'darwin'
      ? 'darwin-universal'
      : 'win32-x64')

// macOS 的 appDir 是 .app 包本身；Windows / Linux 是 resources 的父目录。
const appDir = looksLikeMacBundle
  ? path.resolve(resourcesDir, '..', '..')
  : path.dirname(resourcesDir)
const asarPath = path.join(resourcesDir, 'app.asar')
const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
if (!fs.existsSync(asarPath)) {
  console.error(`[audit] 找不到 app.asar：${asarPath}`)
  process.exit(2)
}

const MiB = (bytes) => Number((bytes / 1024 / 1024).toFixed(2))

const failures = []
const warnings = []
const notes = []

const fail = (rule, detail) => failures.push({ rule, detail })
const warn = (rule, detail) => warnings.push({ rule, detail })

// ---------------------------------------------------------------------------
// 1. 读取 app.asar 头表
// ---------------------------------------------------------------------------

const readArchiveEntries = (archivePath) => {
  const raw = asar.getRawHeader(archivePath)
  const tree = raw.header || raw
  const entries = []
  const walk = (node, prefix) => {
    if (!node?.files) return
    for (const [name, meta] of Object.entries(node.files)) {
      const logicalPath = prefix ? `${prefix}/${name}` : name
      if (meta.files) {
        walk(meta, logicalPath)
        continue
      }
      entries.push({
        path: logicalPath,
        // asar 头的 size 是该文件的实际字节数；unpacked 的文件内容在 asar 之外。
        size: Number(meta.size || 0),
        unpacked: Boolean(meta.unpacked) || Boolean(meta.link)
      })
    }
  }
  walk(tree, '')
  return entries
}

const archiveEntries = readArchiveEntries(asarPath)
const packedEntries = archiveEntries.filter((entry) => !entry.unpacked)
const unpackedEntries = archiveEntries.filter((entry) => entry.unpacked)
const packedBytes = packedEntries.reduce((sum, entry) => sum + entry.size, 0)
const unpackedBytes = unpackedEntries.reduce((sum, entry) => sum + entry.size, 0)

// ---------------------------------------------------------------------------
// 2. 归档内容规则（平台相关）
// ---------------------------------------------------------------------------

const COMMON_FORBIDDEN = [
  {
    id: 'root-rust_package',
    re: /^rust_package\//,
    hint: '项目根 rust_package 整树被重复打进 asar（运行时只走 node_modules/rust_package）'
  },
  {
    id: 'rust_package-native-src',
    re: /^node_modules\/rust_package\/(native|src|__test__|npm|types|target)\//,
    hint: '原生模块的源码/头文件/构建目录不应进包'
  },
  {
    id: 'rust_package-build-files',
    re: /^node_modules\/rust_package\/(Cargo\.(toml|lock)|build\.rs|yarn\.lock|readme\.md|rustfmt\.toml|\.npmignore|\.gitignore|\.yarnrc\.yml|index\.d\.ts\.template)$/,
    hint: '原生模块的构建辅助文件不应进包'
  },
  {
    id: 'project-src',
    re: /^src\//,
    hint: 'TS/Vue 源码已被 electron-vite 打包，不应再进 asar'
  },
  {
    id: 'project-docs',
    re: /^(docs|readme|screenshot)\//,
    hint: '文档与截图不应进安装包'
  },
  {
    id: 'dev-scripts',
    re: /^scripts\//,
    hint: '开发脚本不进 asar；运行时用的是 extraResources 复制出的 demucs/bootstrap'
  },
  {
    id: 'out-research',
    re: /^out\/research\//,
    hint: 'out/research 是研究产物，不是运行时资源'
  },
  { id: 'corrupt-git-dir', re: /^\.git[^/]*\//, hint: '遗留的 .git 目录被当普通文件打进包' },
  {
    id: 'dev-tool-dirs',
    re: /^\.(playwright-mcp|github|husky|claude|cursor|vscode)\//,
    hint: '开发工具配置目录不应进包'
  },
  {
    id: 'env-or-secret',
    re: /^\.env(\.|$)|^\.npmrc$|^env\.example$/,
    hint: '环境变量/凭据文件进包会泄漏配置'
  },
  {
    id: 'lock-or-log',
    re: /^(package-lock\.json|pnpm-lock\.yaml|log\.txt|dev-run\.log|backlog\.md|AGENTS\.md|README\.md)$/,
    hint: '锁文件/日志/内部文档不应进包'
  },
  {
    id: 'dev-config',
    re: /^(electron\.vite\.config\.ts|tsconfig[^/]*\.json|vitest\.config\.[cm]?ts|eslint\.config\.cjs|lint-staged\.config\.mjs|\.editorconfig|\.prettierrc[^/]*|\.prettierignore)$/,
    hint: '构建/工具配置不应进包'
  },
  { id: 'sourcemap', re: /\.map$/, hint: 'source map 不应进安装包' }
]

const platformForbidden = {
  'win32-x64': [
    {
      id: 'foreign-dylib',
      re: /\.dylib$|\.so(\.\d+)*$/,
      hint: 'Windows 包里出现 macOS/Linux 动态库'
    },
    {
      id: 'onnx-darwin',
      re: /^node_modules\/onnxruntime-node\/bin\/napi-v3\/darwin\//,
      hint: 'Windows 包含入 darwin 版 onnxruntime'
    },
    {
      id: 'onnx-linux',
      re: /^node_modules\/onnxruntime-node\/bin\/napi-v3\/linux\//,
      hint: 'Windows 包含入 linux 版 onnxruntime'
    },
    {
      id: 'onnx-win-arm64',
      re: /^node_modules\/onnxruntime-node\/bin\/napi-v3\/win32\/arm64\//,
      hint: 'x64 包含入 arm64 版 onnxruntime'
    },
    {
      id: 'foreign-prebuild',
      re: /prebuilds\/(darwin-[^/]*|linux-[^/]*|linuxmusl-[^/]*|win32-arm64)\.node$/,
      hint: 'Windows x64 包含入其它平台的 SQLite 预编译绑定'
    }
  ],
  'darwin-universal': [
    { id: 'foreign-dll', re: /\.dll$/, hint: 'macOS 包里出现 Windows DLL' },
    { id: 'foreign-exe', re: /\.exe$/, hint: 'macOS 包里出现 Windows 可执行文件' },
    {
      id: 'onnx-linux',
      re: /^node_modules\/onnxruntime-node\/bin\/napi-v3\/linux\//,
      hint: 'macOS 包含入 linux 版 onnxruntime'
    },
    {
      id: 'onnx-win',
      re: /^node_modules\/onnxruntime-node\/bin\/napi-v3\/win32\//,
      hint: 'macOS 包含入 Windows 版 onnxruntime'
    },
    {
      id: 'foreign-prebuild',
      re: /prebuilds\/(win32-|linux-|linuxmusl-)[^/]*\.node$/,
      hint: 'macOS 包含入其它平台的 SQLite 预编译绑定'
    }
  ]
}

const rules = [...COMMON_FORBIDDEN, ...(platformForbidden[platformKey] || [])]
const ruleHits = new Map()
for (const entry of archiveEntries) {
  for (const rule of rules) {
    if (!rule.re.test(entry.path)) continue
    const bucket = ruleHits.get(rule.id) || { rule, items: [], bytes: 0 }
    bucket.items.push(entry.path)
    bucket.bytes += entry.size
    ruleHits.set(rule.id, bucket)
  }
}

const ruleReport = [...ruleHits.values()].map((bucket) => ({
  id: bucket.rule.id,
  hint: bucket.rule.hint,
  count: bucket.items.length,
  sizeMiB: MiB(bucket.bytes),
  samples: bucket.items.slice(0, 5)
}))

for (const bucket of ruleHits.values()) {
  fail(
    bucket.rule.id,
    `${bucket.rule.hint}（${bucket.items.length} 项，${MiB(bucket.bytes)} MiB，例如 ${bucket.items
      .slice(0, 3)
      .join(', ')}）`
  )
}

// ---------------------------------------------------------------------------
// 3. 必需资源（按平台）
// ---------------------------------------------------------------------------

const statEntry = (absolutePath) => {
  try {
    const stats = fs.statSync(absolutePath)
    return stats.isDirectory()
      ? { exists: true, directory: true, size: 0 }
      : { exists: true, directory: false, size: stats.size }
  } catch {
    return { exists: false, directory: false, size: 0 }
  }
}

const rel = (absolutePath) => path.relative(appDir, absolutePath).split(path.sep).join('/')
const requireFile = (absolutePath, label) => {
  const info = statEntry(absolutePath)
  if (!info.exists || info.directory || info.size === 0) {
    fail('missing-required-file', `${label || rel(absolutePath)} 缺失或为空：${rel(absolutePath)}`)
    return false
  }
  return true
}
const requireDir = (absolutePath, label) => {
  const info = statEntry(absolutePath)
  if (!info.exists || !info.directory) {
    fail('missing-required-dir', `${label || rel(absolutePath)} 缺失：${rel(absolutePath)}`)
    return false
  }
  return true
}

const listDir = (dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

const isFfmpegDllName = (name) =>
  /^(av(codec|format|util|filter|device)|sw(resample|scale)|postproc)[-.].*\.dll$/i.test(name)

const requiredChecks = []
const checkRequired = () => {
  // Electron 自带运行时：Windows 侧是根目录的 ffmpeg.dll，
  // macOS 侧在 Electron Framework 里，另有自己的校验分支。
  if (platformKey === 'win32-x64') {
    requireFile(path.join(appDir, 'ffmpeg.dll'), 'Electron 自带 ffmpeg.dll')
  }

  // 主进程入口
  const mainEntry = archiveEntries.find((entry) => entry.path === 'out/main/index.js')
  if (!mainEntry) fail('missing-main-entry', 'app.asar 内缺少 out/main/index.js')
  else requiredChecks.push({ path: 'out/main/index.js', sizeMiB: MiB(mainEntry.size) })
  if (!archiveEntries.some((entry) => entry.path === 'package.json')) {
    fail('missing-package-json', 'app.asar 内缺少 package.json')
  }

  if (platformKey === 'win32-x64') {
    const ffmpegDir = path.join(resourcesDir, 'ffmpeg', 'win32-x64')
    requireFile(path.join(ffmpegDir, 'ffmpeg.exe'), '静态 ffmpeg.exe')
    requireFile(path.join(ffmpegDir, 'ffprobe.exe'), '静态 ffprobe.exe')

    // 权威 DLL 目录：从原生模块自己的导入表反推所需 DLL，避免硬编码版本号。
    const dllDir = path.join(ffmpegDir, 'dll')
    const rustUnpacked = path.join(unpackedDir, 'node_modules', 'rust_package')
    const nativeNodes = listDir(rustUnpacked)
      .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
      .map((entry) => path.join(rustUnpacked, entry.name))
    if (nativeNodes.length === 0) {
      fail(
        'missing-rust-node',
        `app.asar.unpacked 内缺少 rust_package 原生模块：${rel(rustUnpacked)}`
      )
    }
    for (const nodePath of nativeNodes) {
      const info = readPeInfo(nodePath)
      if (!info.ok) {
        fail('unreadable-native-module', `${rel(nodePath)} 不是可解析的 PE：${info.reason}`)
        continue
      }
      if (info.architecture !== 'x64') {
        fail(
          'wrong-arch-native-module',
          `${rel(nodePath)} 架构为 ${info.architecture}，Windows x64 包要求 x64`
        )
      }
      const requiredDlls = info.importedDlls.filter(isFfmpegDllName)
      if (requiredDlls.length === 0) {
        notes.push(`${rel(nodePath)} 未静态导入 FFmpeg DLL（可能改为静态链接）`)
      }
      for (const dll of requiredDlls) {
        requireFile(path.join(dllDir, dll), `原生模块 ${path.basename(nodePath)} 依赖的 ${dll}`)
      }
      // 传递依赖：DLL 之间也可能互相导入（avformat→avcodec→swresample→avutil）。
      for (const dll of requiredDlls) {
        const dllPath = path.join(dllDir, dll)
        if (!fs.existsSync(dllPath)) continue
        const depInfo = readPeInfo(dllPath)
        if (!depInfo.ok) {
          fail('unreadable-ffmpeg-dll', `${rel(dllPath)} 不是可解析的 PE：${depInfo.reason}`)
          continue
        }
        if (depInfo.architecture !== 'x64') {
          fail('wrong-arch-ffmpeg-dll', `${rel(dllPath)} 架构为 ${depInfo.architecture}`)
        }
        for (const transitive of depInfo.importedDlls.filter(isFfmpegDllName)) {
          requireFile(path.join(dllDir, transitive), `${dll} 依赖的 ${transitive}`)
        }
      }
    }

    // SQLite 原生绑定（含 multiple-ciphers 与 serato-connect 内嵌副本）
    // better-sqlite3 v12 通过 lib/<platform>-<arch>.js 定位 prebuilds/<platform>-<arch>.node，
    // 旧版本则使用 build/Release/better_sqlite3.node。二者其一存在即可（旧产物实测为 prebuilds）。
    const existsInBundle = (relativePath) => {
      if (fs.existsSync(path.join(unpackedDir, relativePath))) return true
      return archiveEntries.some((entry) => entry.path === relativePath)
    }
    const sqliteBindingCandidates = (packagePath) =>
      platformKey === 'win32-x64'
        ? [
            `${packagePath}/prebuilds/win32-x64.node`,
            `${packagePath}/build/Release/better_sqlite3.node`
          ]
        : [
            `${packagePath}/prebuilds/darwin-x64.node`,
            `${packagePath}/prebuilds/darwin-arm64.node`,
            `${packagePath}/build/Release/better_sqlite3.node`
          ]
    for (const sqlitePackage of [
      'node_modules/better-sqlite3',
      'node_modules/better-sqlite3-multiple-ciphers',
      'node_modules/serato-connect/node_modules/better-sqlite3-multiple-ciphers'
    ]) {
      if (!existsInBundle(`${sqlitePackage}/package.json`)) continue
      const candidates = sqliteBindingCandidates(sqlitePackage)
      if (!candidates.some(existsInBundle)) {
        fail(
          'missing-sqlite-native',
          `SQLite 原生绑定缺失：${sqlitePackage}（期望 ${candidates.join(' 或 ')}）`
        )
      }
    }

    // ONNX Runtime（win32-x64）
    const onnxX64 = path.join(
      unpackedDir,
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v3',
      'win32',
      'x64'
    )
    requireFile(path.join(onnxX64, 'onnxruntime.dll'), 'ONNX Runtime 主库')
    requireFile(path.join(onnxX64, 'DirectML.dll'), 'ONNX Runtime DirectML')
    const onnxNode = listDir(onnxX64)
      .filter((entry) => entry.name.endsWith('.node'))
      .map((entry) => entry.name)
    if (onnxNode.length === 0) {
      fail('missing-onnx-binding', `onnxruntime-node 绑定缺失：${rel(onnxX64)}`)
    }

    // r3-stretch
    const r3Dir = path.join(resourcesDir, 'r3-stretch', 'win32-x64')
    requireDir(r3Dir, 'r3-stretch 运行时')
    const r3Dlls = listDir(r3Dir).filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dll')
    )
    if (r3Dlls.length === 0) fail('missing-r3-dll', `r3-stretch 目录内没有 DLL：${rel(r3Dir)}`)
    for (const entry of r3Dlls) {
      const info = readPeInfo(path.join(r3Dir, entry.name))
      if (!info.ok) fail('unreadable-r3-dll', `${entry.name} 不是可解析的 PE：${info.reason}`)
      else if (info.architecture !== 'x64') {
        fail('wrong-arch-r3-dll', `${entry.name} 架构为 ${info.architecture}`)
      }
    }
  }

  if (platformKey === 'darwin-universal') {
    requireDir(
      path.join(appDir, 'Contents', 'Frameworks', 'Electron Framework.framework'),
      'Electron Framework'
    )
    requireFile(path.join(resourcesDir, 'ffmpeg', 'darwin', 'ffmpeg'), 'macOS 通用 ffmpeg')
    requireFile(path.join(resourcesDir, 'ffmpeg', 'darwin', 'ffprobe'), 'macOS 通用 ffprobe')
    requireDir(path.join(resourcesDir, 'r3-stretch', 'darwin-universal'), 'r3-stretch 运行时')

    // rust_package 原生模块：必须是 Mach-O，universal 包要求两种架构都在。
    const rustUnpacked = path.join(unpackedDir, 'node_modules', 'rust_package')
    const nativeNodes = listDir(rustUnpacked)
      .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
      .map((entry) => path.join(rustUnpacked, entry.name))
    if (nativeNodes.length === 0) {
      fail(
        'missing-rust-node',
        `app.asar.unpacked 内缺少 rust_package 原生模块：${rel(rustUnpacked)}`
      )
    }
    const seenArchs = new Set()
    for (const nodePath of nativeNodes) {
      const info = readMachOInfo(nodePath)
      if (!info.ok) {
        fail('non-macho-native-module', `${rel(nodePath)} 不是 Mach-O：${info.reason}`)
        continue
      }
      for (const arch of info.archs) seenArchs.add(arch)
      notes.push(`${rel(nodePath)} 是 ${info.kind}，架构 ${info.archs.join('+')}`)
    }
    if (nativeNodes.length > 0) {
      for (const requiredArch of ['x86_64', 'arm64']) {
        if (seenArchs.has(requiredArch)) continue
        fail(
          'missing-mac-arch',
          `rust_package 原生模块缺少 ${requiredArch}（实际 ${[...seenArchs].join('+') || '无'}），` +
            'universal 包在对应架构的机器上会加载失败'
        )
      }
    }

    // ONNX Runtime：darwin 的 x64 / arm64 两份都要在
    const onnxDarwin = path.join(
      unpackedDir,
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v3',
      'darwin'
    )
    const onnxArchDirs = listDir(onnxDarwin)
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    if (onnxArchDirs.length === 0) {
      fail('missing-onnx-darwin', `onnxruntime-node 缺少 darwin 目录：${rel(onnxDarwin)}`)
    }
    for (const arch of ['x64', 'arm64']) {
      if (onnxArchDirs.includes(arch)) continue
      fail(
        'missing-onnx-darwin-arch',
        `onnxruntime-node 缺少 darwin/${arch}（实际 ${onnxArchDirs.join(',') || '无'}）`
      )
    }

    // SQLite 原生绑定（darwin 预编译，或旧布局的 build/Release）
    const existsInMacBundle = (relativePath) => {
      if (fs.existsSync(path.join(unpackedDir, relativePath))) return true
      return archiveEntries.some((entry) => entry.path === relativePath)
    }
    for (const sqlitePackage of [
      'node_modules/better-sqlite3',
      'node_modules/better-sqlite3-multiple-ciphers',
      'node_modules/serato-connect/node_modules/better-sqlite3-multiple-ciphers'
    ]) {
      if (!existsInMacBundle(`${sqlitePackage}/package.json`)) continue
      const candidates = [
        `${sqlitePackage}/prebuilds/darwin-x64.node`,
        `${sqlitePackage}/prebuilds/darwin-arm64.node`,
        `${sqlitePackage}/build/Release/better_sqlite3.node`
      ]
      if (candidates.some(existsInMacBundle)) continue
      fail(
        'missing-sqlite-native',
        `SQLite 原生绑定缺失：${sqlitePackage}（期望 ${candidates.join(' 或 ')}）`
      )
    }
  }

  // demucs bootstrap（全平台）
  const bootstrapDir = path.join(resourcesDir, 'demucs', 'bootstrap')
  requireDir(bootstrapDir, 'demucs bootstrap')
  const bootstrapFiles = new Set(
    listDir(bootstrapDir)
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  )
  for (const name of ['beat_this_bridge.py', 'bpm_fix.py']) {
    if (!bootstrapFiles.has(name)) {
      fail('missing-bootstrap-entry', `demucs bootstrap 缺少入口脚本 ${name}`)
    }
  }
  // bpm_fix / beat_this 会互相 import，缺一个就在运行时才炸。
  const pythonModules = [...bootstrapFiles]
    .filter((name) => name.endsWith('.py'))
    .map((name) => name.slice(0, -3))
  const missingModules = new Map()
  for (const fileName of [...bootstrapFiles].filter((name) => name.endsWith('.py'))) {
    const content = fs.readFileSync(path.join(bootstrapDir, fileName), 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/.exec(
        line
      )
      if (!match) continue
      const moduleName = (match[1] || match[2] || '').split('.')[0]
      if (!moduleName || moduleName === 'from') continue
      if (!pythonModules.includes(moduleName)) continue
      if (bootstrapFiles.has(`${moduleName}.py`)) continue
      const bucket = missingModules.get(moduleName) || new Set()
      bucket.add(fileName)
      missingModules.set(moduleName, bucket)
    }
  }
  for (const [moduleName, importers] of missingModules) {
    fail(
      'missing-bootstrap-module',
      `demucs bootstrap 内 ${[...importers].join(', ')} 引用了 ${moduleName}.py，但资源目录里没有`
    )
  }
  if (
    !fs.existsSync(
      path.join(bootstrapDir, 'models', 'rkb-official-downbeat-rotation-candidate-v1.json')
    )
  ) {
    warn(
      'missing-rkb-model',
      'demucs bootstrap 内缺少 models/rkb-official-downbeat-rotation-candidate-v1.json'
    )
  }

  // Rekordbox 桌面资料库（可选运行时资源，缺了功能会降级）
  if (!fs.existsSync(path.join(resourcesDir, 'rekordboxDesktopLibrary'))) {
    warn('missing-rekordbox-library', 'resources/rekordboxDesktopLibrary 缺失')
  }

  // 研究用大文件容易借 resources 混进来
  for (const entry of archiveEntries) {
    if (entry.size > 20 * 1024 * 1024 && !/^node_modules\//.test(entry.path)) {
      warn(
        'large-archive-entry',
        `${entry.path} 体积 ${MiB(entry.size)} MiB（非 node_modules 大文件，请确认运行时用途）`
      )
    }
  }
}
checkRequired()

// ---------------------------------------------------------------------------
// 3b. 磁盘上的二进制格式
//
// asar 规则只看归档条目，而 extraResources（ffmpeg / demucs / r3-stretch）
// 与 app.asar.unpacked 里的文件并不经过归档清单。
// 这里按文件头判断每个二进制的真实格式，避免「配置里排除了，实际还在」。
// ---------------------------------------------------------------------------

const BINARY_SUFFIX = /\.(dll|exe|node|dylib|so)$/i

const peekMagic = (filePath) => {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(4)
    return fs.readSync(fd, buffer, 0, 4, 0) === 4 ? buffer : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // 关闭失败不影响判定
      }
    }
  }
}

const classifyBinary = (buffer) => {
  if (!buffer) return 'unknown'
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'pe'
  const bigEndianMagic = buffer.readUInt32BE(0)
  if (bigEndianMagic === 0x7f454c46) return 'elf'
  if (bigEndianMagic === 0xcafebabe || bigEndianMagic === 0xcafebabf) return 'macho'
  const littleEndianMagic = buffer.readUInt32LE(0)
  if (littleEndianMagic === 0xfeedfacf || littleEndianMagic === 0xfeedface) return 'macho'
  return 'unknown'
}

const scanDiskBinaries = () => {
  const expectedKind = platformKey === 'darwin-universal' ? 'macho' : 'pe'
  const foreign = []
  const unreadable = []
  let scanned = 0
  const pending = [resourcesDir]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      if (!entry.isFile() || !BINARY_SUFFIX.test(entry.name)) continue
      scanned += 1
      const kind = classifyBinary(peekMagic(absolute))
      if (kind === expectedKind) continue
      if (kind === 'unknown') unreadable.push(rel(absolute))
      else foreign.push(`${kind.toUpperCase()} ${rel(absolute)}`)
    }
  }
  if (foreign.length > 0) {
    fail(
      'foreign-binary-on-disk',
      `resources 下有 ${foreign.length} 个二进制格式与 ${platformKey} 不符（示例 ${foreign
        .slice(0, 5)
        .join(', ')}）`
    )
  }
  if (unreadable.length > 0) {
    warn(
      'unclassified-binary',
      `${unreadable.length} 个二进制文件头无法识别（示例 ${unreadable.slice(0, 5).join(', ')}）`
    )
  }
  return { scanned, foreign: foreign.length, unreadable: unreadable.length, expectedKind }
}

const diskBinaries = scanDiskBinaries()

// ---------------------------------------------------------------------------
// 4. 重复二进制检测（按内容哈希）
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set(['.dll', '.node', '.exe', '.so', '.dylib'])
const walk = (rootDir, onFile) => {
  const pending = [rootDir]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      onFile(absolute, entry.name)
    }
  }
}

const binaryCandidates = []
const collectBinary = (absolute, name) => {
  const ext = path.extname(name).toLowerCase()
  if (!BINARY_EXTENSIONS.has(ext)) return
  let stats
  try {
    stats = fs.statSync(absolute)
  } catch {
    return
  }
  if (stats.size < 1024 * 1024) return
  binaryCandidates.push({ path: rel(absolute), size: stats.size, absolute })
}

// electron 本体（顶层 dll / exe）+ resources + app.asar.unpacked
for (const entry of listDir(appDir)) {
  const absolute = path.join(appDir, entry.name)
  if (entry.isFile()) collectBinary(absolute, entry.name)
}
if (fs.existsSync(unpackedDir)) walk(unpackedDir, collectBinary)
for (const entry of listDir(resourcesDir)) {
  const absolute = path.join(resourcesDir, entry.name)
  if (!entry.isDirectory()) {
    if (entry.name !== 'app.asar') collectBinary(absolute, entry.name)
    continue
  }
  if (entry.name === 'app.asar.unpacked') continue
  walk(absolute, collectBinary)
}

const hashCache = new Map()
const hashFile = (filePath) => {
  if (hashCache.has(filePath)) return hashCache.get(filePath)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  hashCache.set(filePath, hash)
  return hash
}

const byHash = new Map()
for (const candidate of binaryCandidates) {
  let hash
  try {
    hash = hashFile(candidate.absolute)
  } catch {
    continue
  }
  const bucket = byHash.get(hash) || { size: candidate.size, paths: [] }
  bucket.paths.push(candidate.path)
  byHash.set(hash, bucket)
}

const duplicateGroups = [...byHash.values()]
  .filter((bucket) => bucket.paths.length > 1)
  .map((bucket) => ({
    sizeMiB: MiB(bucket.size),
    wastedMiB: MiB(bucket.size * (bucket.paths.length - 1)),
    paths: bucket.paths.sort()
  }))
  .sort((a, b) => b.wastedMiB - a.wastedMiB)

for (const group of duplicateGroups) {
  const ffmpegCopies = group.paths.filter((entry) => isFfmpegDllName(path.basename(entry)))
  if (
    ffmpegCopies.length > 1 &&
    ffmpegCopies.some((entry) => !entry.startsWith('resources/ffmpeg/'))
  ) {
    fail(
      'duplicate-ffmpeg-dll',
      `FFmpeg DLL 出现多份副本：${ffmpegCopies.join(' | ')}（权威目录应只有 resources/ffmpeg/win32-x64/dll）`
    )
  } else if (group.wastedMiB >= 5) {
    warn('duplicate-binary', `重复二进制 ${group.paths.join(' | ')}，冗余 ${group.wastedMiB} MiB`)
  }
}

// ---------------------------------------------------------------------------
// 5. 体积汇总
// ---------------------------------------------------------------------------

const directorySize = (dirPath) => {
  let total = 0
  const pending = [dirPath]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      try {
        total += fs.statSync(absolute).size
      } catch {
        // 忽略无法读取的文件
      }
    }
  }
  return total
}

const sizes = {
  appAsarMiB: MiB(fs.statSync(asarPath).size),
  appAsarPackedMiB: MiB(packedBytes),
  appAsarUnpackedLogicalMiB: MiB(unpackedBytes),
  appAsarUnpackedDirMiB: fs.existsSync(unpackedDir) ? MiB(directorySize(unpackedDir)) : 0,
  resourcesMiB: MiB(directorySize(resourcesDir)),
  appDirTotalMiB: MiB(directorySize(appDir))
}

// ---------------------------------------------------------------------------
// 6. 输出
// ---------------------------------------------------------------------------

const result = {
  appDir,
  platformKey,
  archiveFileCount: archiveEntries.length,
  ruleReport,
  requiredChecks,
  duplicateGroups,
  diskBinaries,
  sizes,
  failures,
  warnings,
  notes,
  passed: failures.length === 0
}

if (jsonOutput) {
  const serialized = JSON.stringify(result, null, 2)
  if (outputFile) fs.writeFileSync(path.resolve(outputFile), serialized, 'utf8')
  console.log(serialized)
} else {
  console.log(`[audit] 目标目录：${appDir}`)
  console.log(`[audit] 平台标识：${platformKey}`)
  console.log(
    `[audit] asar 条目：${archiveEntries.length}（packed ${packedEntries.length} / unpacked ${unpackedEntries.length}）`
  )
  console.log(
    `[audit] 体积：app.asar ${sizes.appAsarMiB} MiB（其中未压缩内容 ${sizes.appAsarPackedMiB} MiB）` +
      `，app.asar.unpacked ${sizes.appAsarUnpackedDirMiB} MiB，resources 合计 ${sizes.resourcesMiB} MiB，整包 ${sizes.appDirTotalMiB} MiB`
  )

  console.log(
    `[audit] 磁盘二进制：扫描 ${diskBinaries.scanned} 个，期望格式 ${
      diskBinaries.expectedKind === 'macho' ? 'Mach-O' : 'PE'
    }，不符 ${diskBinaries.foreign} 个，无法识别 ${diskBinaries.unreadable} 个`
  )

  if (ruleReport.length > 0) {
    console.log('\n[audit] 归档内违规项：')
    for (const item of ruleReport) {
      console.log(`  ✗ ${item.id}：${item.count} 项 / ${item.sizeMiB} MiB — ${item.hint}`)
      for (const sample of item.samples) console.log(`      · ${sample}`)
    }
  } else {
    console.log('\n[audit] 归档内违规项：无')
  }

  if (duplicateGroups.length > 0) {
    console.log('\n[audit] 重复二进制：')
    for (const group of duplicateGroups) {
      console.log(`  · ${group.sizeMiB} MiB × ${group.paths.length}（冗余 ${group.wastedMiB} MiB）`)
      for (const member of group.paths) console.log(`      - ${member}`)
    }
  } else {
    console.log('\n[audit] 重复二进制：无')
  }

  if (warnings.length > 0) {
    console.log('\n[audit] 警告：')
    for (const item of warnings) console.log(`  ! ${item.rule}：${item.detail}`)
  }
  if (notes.length > 0) {
    console.log('\n[audit] 备注：')
    for (const item of notes) console.log(`  - ${item}`)
  }

  if (failures.length > 0) {
    console.log('\n[audit] 致命项：')
    for (const item of failures) console.log(`  ✗ ${item.rule}：${item.detail}`)
    console.log(`\n[audit] 结论：FAIL（${failures.length} 项致命）`)
  } else {
    console.log('\n[audit] 结论：PASS')
  }
}

process.exit(failures.length > 0 ? 1 : 0)
