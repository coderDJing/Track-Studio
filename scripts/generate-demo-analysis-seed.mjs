import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import electronPath from 'electron'
import {
  DEMO_SEED_FINGERPRINT_FILE_NAME,
  computeDemoAnalysisSeedFingerprint,
  verifyDemoAnalysisSeed
} from './lib/demo-analysis-seed-fingerprint.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const EXPORT_SCRIPT = path.join(ROOT, 'scripts', 'export-demo-analysis-seed.mjs')
const OUTPUT_PATH = path.join(ROOT, 'resources', 'demoAnalysis', 'demo-analysis-seed.sqlite')
const FINGERPRINT_PATH = path.join(
  ROOT,
  'resources',
  'demoAnalysis',
  DEMO_SEED_FINGERPRINT_FILE_NAME
)
const DATABASE_FILE_NAME = 'FRKB.database.sqlite'
const TIMEOUT_MS = 25 * 60 * 1000

// 打包前必须先在 out/ 产出可运行的 main 进程（npm run build）。
const mainEntry = path.join(ROOT, 'out', 'main', 'index.js')
if (!fs.existsSync(mainEntry)) {
  throw new Error(`缺少 ${mainEntry}，请先执行 npm run build`)
}

// 算法版本与示例音频都没变时直接复用现有种子，避免本地重复打包反复重跑分析。
const { fingerprint } = computeDemoAnalysisSeedFingerprint()
const existingFingerprint = fs.existsSync(FINGERPRINT_PATH)
  ? String(fs.readFileSync(FINGERPRINT_PATH, 'utf8')).trim()
  : ''
if (existingFingerprint === fingerprint) {
  const existingVerify = verifyDemoAnalysisSeed(OUTPUT_PATH)
  if (existingVerify.ok) {
    console.log(`[demo-seed] 分析指纹未变化（${fingerprint}），跳过重新生成`)
    process.exit(0)
  }
  console.warn(`[demo-seed] 指纹匹配但种子校验失败（${existingVerify.reason}），重新生成`)
}

const tempRoot = path.join(os.tmpdir(), `frkb-demo-analysis-seed-${Date.now()}`)
const libraryDir = path.join(tempRoot, 'library')
const userDataDir = path.join(tempRoot, 'userdata')
fs.mkdirSync(userDataDir, { recursive: true })

const env = {
  ...process.env,
  FRKB_DEMO_ANALYSIS_SEED_DIR: libraryDir,
  FRKB_DEV_USER_DATA_DIR: userDataDir,
  FRKB_DEV_SERVER_PORT: '',
  ELECTRON_RENDERER_URL: ''
}
delete env.FRKB_DEV_DATABASE_URL
delete env.FRKB_DEV_INSTANCE

const runElectron = () =>
  new Promise((resolve, reject) => {
    const child = spawn(electronPath, ['.'], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      windowsHide: true
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`示例曲分析超时（>${Math.round(TIMEOUT_MS / 60000)} 分钟）`))
    }, TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`示例曲分析进程退出码：${code}`))
      }
    })
  })

const main = async () => {
  console.log(`[demo-seed] 临时库：${libraryDir}`)
  await runElectron()

  const databasePath = path.join(libraryDir, DATABASE_FILE_NAME)
  if (!fs.existsSync(databasePath)) {
    throw new Error(`临时库没有生成数据库：${databasePath}`)
  }
  const exportResult = spawnSync(
    process.execPath,
    [EXPORT_SCRIPT, '--db', databasePath, '--out', OUTPUT_PATH],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (exportResult.status !== 0) {
    throw new Error(`导出示例分析缓存失败（退出码 ${exportResult.status}）`)
  }
  fs.writeFileSync(FINGERPRINT_PATH, `${fingerprint}\n`)
  fs.rmSync(tempRoot, { recursive: true, force: true })
  console.log('[demo-seed] 随包示例分析已更新')
}

try {
  await main()
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`)
  console.error(`[demo-seed] 临时库保留在：${tempRoot}`)
  process.exitCode = 1
}
