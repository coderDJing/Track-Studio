import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import {
  DEMO_SEED_ASSET_RELEASE_TAG,
  DEMO_SEED_FILE_NAME,
  DEMO_SEED_FINGERPRINT_FILE_NAME,
  computeDemoAnalysisSeedFingerprint,
  demoSeedAssetName,
  verifyDemoAnalysisSeed
} from './lib/demo-analysis-seed-fingerprint.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SEED_DIR = path.join(ROOT, 'resources', 'demoAnalysis')
const SEED_PATH = path.join(SEED_DIR, DEMO_SEED_FILE_NAME)
const FINGERPRINT_PATH = path.join(SEED_DIR, DEMO_SEED_FINGERPRINT_FILE_NAME)
const RELEASE_TITLE = 'Demo Analysis Seed Assets'
const RELEASE_NOTES =
  '随包示例曲分析种子（按算法版本指纹命名）。由 release.yml 自动发布，供后续发版复用，不属于应用版本资产。'

const repoArgs = () => {
  const repo = String(process.env.GITHUB_REPOSITORY || '').trim()
  return repo ? ['--repo', repo] : []
}

const runGh = (args) =>
  spawnSync('gh', [...args, ...repoArgs()], {
    encoding: 'utf8',
    windowsHide: true
  })

const setGitHubOutput = (name, value) => {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim()
  if (!outputPath) return
  fs.appendFileSync(outputPath, `${name}=${value}\n`)
}

const formatGhError = (result) => {
  const stderr = String(result.stderr || '').trim()
  const stdout = String(result.stdout || '').trim()
  return (stderr || stdout || `exit ${result.status ?? -1}`).slice(0, 600)
}

const readLocalFingerprint = () => {
  if (!fs.existsSync(FINGERPRINT_PATH)) return ''
  return String(fs.readFileSync(FINGERPRINT_PATH, 'utf8')).trim()
}

const restore = () => {
  const { fingerprint } = computeDemoAnalysisSeedFingerprint()
  if (readLocalFingerprint() === fingerprint) {
    const localVerify = verifyDemoAnalysisSeed(SEED_PATH)
    if (localVerify.ok) {
      console.log(`[demo-seed] 本地已有指纹 ${fingerprint} 的种子，跳过下载`)
      setGitHubOutput('restored', 'true')
      return
    }
  }

  const assetName = demoSeedAssetName(fingerprint)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-demo-seed-asset-'))
  try {
    const download = runGh([
      'release',
      'download',
      DEMO_SEED_ASSET_RELEASE_TAG,
      '--pattern',
      assetName,
      '--dir',
      tempDir,
      '--clobber'
    ])
    const downloadedPath = path.join(tempDir, assetName)
    if (download.status !== 0 || !fs.existsSync(downloadedPath)) {
      console.log(`[demo-seed] 未找到指纹 ${fingerprint} 的已发布种子，需要重新生成`)
      console.log(`[demo-seed] gh: ${formatGhError(download)}`)
      setGitHubOutput('restored', 'false')
      return
    }
    const verified = verifyDemoAnalysisSeed(downloadedPath)
    if (!verified.ok) {
      console.warn(`[demo-seed] 已发布种子校验失败（${verified.reason}），重新生成`)
      setGitHubOutput('restored', 'false')
      return
    }
    fs.mkdirSync(SEED_DIR, { recursive: true })
    fs.copyFileSync(downloadedPath, SEED_PATH)
    fs.writeFileSync(FINGERPRINT_PATH, `${fingerprint}\n`)
    console.log(`[demo-seed] 已复用已发布种子（指纹 ${fingerprint}）`)
    setGitHubOutput('restored', 'true')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

const publish = () => {
  const { fingerprint } = computeDemoAnalysisSeedFingerprint()
  const verified = verifyDemoAnalysisSeed(SEED_PATH)
  if (!verified.ok) {
    throw new Error(`本地种子不可发布：${verified.reason}`)
  }

  const assetName = demoSeedAssetName(fingerprint)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-demo-seed-upload-'))
  try {
    const assetPath = path.join(tempDir, assetName)
    fs.copyFileSync(SEED_PATH, assetPath)

    const view = runGh(['release', 'view', DEMO_SEED_ASSET_RELEASE_TAG])
    if (view.status !== 0) {
      const created = runGh([
        'release',
        'create',
        DEMO_SEED_ASSET_RELEASE_TAG,
        '--title',
        RELEASE_TITLE,
        '--notes',
        RELEASE_NOTES,
        '--latest=false'
      ])
      if (created.status !== 0) {
        throw new Error(`创建种子资产 Release 失败：${formatGhError(created)}`)
      }
    }

    const uploaded = runGh([
      'release',
      'upload',
      DEMO_SEED_ASSET_RELEASE_TAG,
      assetPath,
      '--clobber'
    ])
    if (uploaded.status !== 0) {
      throw new Error(`上传种子资产失败：${formatGhError(uploaded)}`)
    }
    console.log(`[demo-seed] 已发布种子资产 ${assetName}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

const command = process.argv[2]
try {
  if (command === 'restore') {
    restore()
  } else if (command === 'publish') {
    publish()
  } else {
    console.error('用法：node scripts/demo-analysis-seed-store.mjs <restore|publish>')
    process.exitCode = 1
  }
} catch (error) {
  console.error(`[demo-seed] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
