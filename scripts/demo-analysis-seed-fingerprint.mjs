import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  computeDemoAnalysisSeedFingerprint,
  verifyDemoAnalysisSeed
} from './lib/demo-analysis-seed-fingerprint.mjs'

const appendGitHubOutput = (name, value) => {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim()
  if (!outputPath) return
  fs.appendFileSync(outputPath, `${name}=${value}\n`)
}

const verifyIndex = process.argv.indexOf('--verify')
if (verifyIndex >= 0) {
  const targetPath = process.argv[verifyIndex + 1]
  if (!targetPath) {
    console.error('[demo-seed] --verify 需要种子数据库路径')
    process.exit(1)
  }
  const result = verifyDemoAnalysisSeed(path.resolve(targetPath))
  if (!result.ok) {
    console.error(`[demo-seed] 种子校验失败：${result.reason}`)
    process.exit(1)
  }
  console.log('[demo-seed] 种子校验通过')
  process.exit(0)
}

try {
  const { fingerprint } = computeDemoAnalysisSeedFingerprint()
  appendGitHubOutput('fingerprint', fingerprint)
  console.log(`fingerprint=${fingerprint}`)
} catch (error) {
  console.error(
    `[demo-seed] 计算分析指纹失败：${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
}
