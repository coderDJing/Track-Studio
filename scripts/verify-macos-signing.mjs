#!/usr/bin/env node
// 校验打包出来的 macOS 应用是否具备可分发的签名与公证状态。
//
// 用法：
//   node scripts/verify-macos-signing.mjs
//   node scripts/verify-macos-signing.mjs --app "dist/mac-universal/Track Studio.app"
//   node scripts/verify-macos-signing.mjs --allow-unsigned
//
// 退出码：0 表示通过，1 表示校验失败。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_APP_PATH = path.join('dist', 'mac-universal', 'Track Studio.app')
const DEVELOPER_ID_AUTHORITY = 'Authority=Developer ID Application'

const parseArgs = (argv) => {
  const options = { appPath: DEFAULT_APP_PATH, allowUnsigned: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--app') {
      options.appPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--allow-unsigned') {
      options.allowUnsigned = true
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  if (!options.appPath) throw new Error('--app 需要一个路径参数')
  return options
}

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    code: result.status ?? 1,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim()
  }
}

const failures = []

const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return true
  }
  console.log(`  ✗ ${label}`)
  if (detail) console.log(`      ${detail}`)
  failures.push(label)
  return false
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const appPath = path.resolve(options.appPath)

  console.log(`检查应用包：${appPath}`)

  if (!fs.existsSync(appPath)) {
    console.error(`应用包不存在：${appPath}`)
    console.error('请先执行 pnpm run build:mac，或用 --app 指定路径。')
    process.exit(1)
  }

  const mainBinary = path.join(appPath, 'Contents', 'MacOS', 'FRKB')
  const signatureInfo = run('codesign', ['-dvvv', mainBinary])
  const signedWithDeveloperId = signatureInfo.output.includes(DEVELOPER_ID_AUTHORITY)
  const hasHardenedRuntime = /flags=.*runtime/.test(signatureInfo.output)

  console.log('\n[1] 代码签名身份')
  if (!signedWithDeveloperId) {
    if (!options.allowUnsigned) {
      console.log('  ✗ 主程序不是用 Developer ID Application 证书签名的')
      console.log('      未签名的产物无法通过 Gatekeeper，也不能对外分发。')
      console.log('      如果这是本地自测产物，可以加 --allow-unsigned 跳过分发检查。')
      failures.push('Developer ID 签名')
    } else {
      console.log('  · 未使用 Developer ID 签名（已按 --allow-unsigned 放行）')
    }
  } else {
    check('主程序由 Developer ID Application 签', true)
    check('开启了 Hardened Runtime', hasHardenedRuntime)
  }

  console.log('\n[2] 签名完整性')
  if (!signedWithDeveloperId) {
    console.log('  · 应用未签名，跳过签名完整性检查')
  } else {
    const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    check('codesign --verify --deep --strict 通过', verify.code === 0, verify.output)
  }

  console.log('\n[3] 公证票据')
  if (!signedWithDeveloperId) {
    console.log('  · 应用未签名，跳过公证票据检查')
  } else {
    const staple = run('xcrun', ['stapler', 'validate', appPath])
    check('公证票据已 stapling 到应用包', staple.code === 0, staple.output)
  }

  console.log('\n[4] Gatekeeper')
  if (!signedWithDeveloperId) {
    console.log('  · 应用未签名，跳过 Gatekeeper 评估')
  } else {
    const assess = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
    check('Gatekeeper 接受该应用', assess.code === 0, assess.output)
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`校验未通过，共 ${failures.length} 项失败：`)
    for (const item of failures) console.error(`  - ${item}`)
    process.exit(1)
  }
  console.log('全部校验通过。')
}

try {
  main()
} catch (error) {
  console.error(String(error?.message || error))
  process.exit(1)
}
