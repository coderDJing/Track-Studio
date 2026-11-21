#!/usr/bin/env node
/**
 * 把 `vendor/ffmpeg/<platform>/dll` 裁剪成「原生模块真正用到的导入闭包」。
 *
 * 为什么需要：CI 的 Windows 步骤是从 BtbN 的 shared 构建里 `Get-ChildItem *.dll` 全量复制，
 * 于是 avfilter / avdevice / swscale 这些没人 dlopen、也没人写进导入表的库也会被打进安装包
 * （实测 36.4 + 4.7 + 2.4 = 43.5 MiB 未压缩）。它们既不会被加载，删掉也没有运行时风险，
 * 但**不能靠硬编码名单**——FFmpeg 升级后大版本号会变。
 *
 * 做法：从原生模块的导入表出发做 BFS 闭包，只保留沿着导入边真正可达的 DLL。
 * 判定依据是 PE 导入表（静态依赖），因此对「按名字动态 LoadLibrary」的情况不适用；
 * 本仓库没有这类调用（已 grep 确认）。
 *
 * 用法：
 *   node scripts/prune-ffmpeg-dlls.mjs --dll-dir vendor/ffmpeg/win32-x64/dll \
 *     --native-module rust_package/index.win32-x64-msvc.node            # 只报告
 *   ... --apply                                                          # 真正删除
 *
 * 退出码：0 = 无需裁剪或裁剪完成；1 = 用法/环境错误；2 = 闭包所需的 DLL 缺失。
 */

import fs from 'node:fs'
import path from 'node:path'

import { readPeInfo } from './lib/pe-imports.mjs'

const FFMPEG_DLL_NAME =
  /^(av(codec|format|util|filter|device)|sw(resample|scale)|postproc)[-.].*\.dll$/i

const argv = process.argv.slice(2)
const readFlag = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  if (index < 0) return fallback
  return String(argv[index + 1] || '').trim() || fallback
}

const dllDirArg = readFlag('--dll-dir', '')
const nativeModuleArg = readFlag('--native-module', '')
const apply = argv.includes('--apply')

if (!dllDirArg || !nativeModuleArg) {
  console.error(
    '[prune-ffmpeg] 需要 --dll-dir <目录> 与 --native-module <原生模块>（可选 --apply 执行删除）'
  )
  process.exit(1)
}

const dllDir = path.resolve(dllDirArg)
const nativeModule = path.resolve(nativeModuleArg)

if (!fs.existsSync(dllDir) || !fs.statSync(dllDir).isDirectory()) {
  console.error(`[prune-ffmpeg] DLL 目录不存在：${dllDir}`)
  process.exit(1)
}
if (!fs.existsSync(nativeModule)) {
  console.error(`[prune-ffmpeg] 原生模块不存在：${nativeModule}`)
  process.exit(1)
}

const MiB = (bytes) => Number((bytes / 1024 / 1024).toFixed(2))

// Windows 文件名大小写不敏感，导入表里的大小写不保证与磁盘一致，统一按小写建索引。
const available = new Map()
for (const entry of fs.readdirSync(dllDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) continue
  const absolute = path.join(dllDir, entry.name)
  available.set(entry.name.toLowerCase(), {
    name: entry.name,
    absolute,
    size: fs.statSync(absolute).size
  })
}

const nativeInfo = readPeInfo(nativeModule)
if (!nativeInfo.ok) {
  console.error(`[prune-ffmpeg] 原生模块不是可解析的 PE：${nativeInfo.reason}`)
  process.exit(1)
}

const closure = new Set()
const missing = new Set()
const pending = nativeInfo.importedDlls.filter((name) => FFMPEG_DLL_NAME.test(name))

while (pending.length > 0) {
  const name = pending.pop()
  const key = name.toLowerCase()
  if (closure.has(key)) continue
  const entry = available.get(key)
  if (!entry) {
    missing.add(name)
    continue
  }
  closure.add(key)
  const info = readPeInfo(entry.absolute)
  if (!info.ok) {
    console.error(`[prune-ffmpeg] ${entry.name} 不是可解析的 PE：${info.reason}`)
    process.exit(1)
  }
  for (const dependency of info.importedDlls) {
    if (!FFMPEG_DLL_NAME.test(dependency)) continue
    if (closure.has(dependency.toLowerCase())) continue
    pending.push(dependency)
  }
}

if (missing.size > 0) {
  console.error('[prune-ffmpeg] 闭包所需的 DLL 不在目录里（先补齐再裁剪）：')
  for (const name of [...missing].sort()) console.error(`  - ${name}`)
  process.exit(2)
}

if (closure.size === 0) {
  console.error(
    `[prune-ffmpeg] ${path.basename(nativeModule)} 没有静态导入任何 FFmpeg DLL，` +
      '无法据此推断闭包，拒绝裁剪'
  )
  process.exit(2)
}

const keep = [...closure].map((key) => available.get(key))
const removable = [...available.entries()]
  .filter(([key]) => !closure.has(key))
  .map(([, entry]) => entry)

console.log(`[prune-ffmpeg] 原生模块：${path.relative(process.cwd(), nativeModule)}`)
console.log(
  `[prune-ffmpeg] 闭包内（保留 ${keep.length} 个）：${keep.map((item) => item.name).join(', ')}`
)

if (removable.length === 0) {
  console.log('[prune-ffmpeg] 目录里没有多余 DLL，无需裁剪')
  process.exit(0)
}

const removableBytes = removable.reduce((sum, item) => sum + item.size, 0)
console.log(
  `[prune-ffmpeg] 可裁剪 ${removable.length} 个 / ${MiB(removableBytes)} MiB：` +
    removable.map((item) => `${item.name}(${MiB(item.size)} MiB)`).join(', ')
)

if (!apply) {
  console.log('[prune-ffmpeg] 未加 --apply，仅报告，未删除任何文件')
  process.exit(0)
}

for (const item of removable) {
  fs.rmSync(item.absolute)
  if (fs.existsSync(item.absolute)) {
    console.error(`[prune-ffmpeg] 删除失败：${item.name}`)
    process.exit(1)
  }
}
console.log(`[prune-ffmpeg] 已删除 ${removable.length} 个文件，释放 ${MiB(removableBytes)} MiB`)
