import assert from 'node:assert/strict'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

// 使用真实构建产物，在无 Electron API 的线程里验证初始化及连续请求。
// 开发环境装有 electron npm 包，主动禁止加载它以复现安装版 worker 的模块边界。
const worker = new Worker(
  `
    const Module = require('node:module')
    const { workerData } = require('node:worker_threads')
    const originalLoad = Module._load
    Module._load = function (request, ...args) {
      if (request === 'electron') {
        const error = new Error("Cannot find module 'electron'")
        error.code = 'MODULE_NOT_FOUND'
        throw error
      }
      return originalLoad.call(this, request, ...args)
    }
    require(workerData)
  `,
  {
    eval: true,
    workerData: path.resolve('out/main/workers/keyAnalysisWorker.js'),
    env: { ...process.env, FRKB_APP_PACKAGED: '1' }
  }
)

let timeout
try {
  await new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Analysis worker startup timed out')), 10_000)
    let completed = 0
    worker.on('error', reject)
    worker.on('exit', (code) => reject(new Error(`Analysis worker exited early: ${code}`)))
    worker.on('message', (payload) => {
      if (payload.progress || payload.diagnostic) return
      try {
        assert.equal(payload.jobId, completed + 1)
        assert.equal(payload.error, 'Missing file path')
        completed += 1
        if (completed === 2) {
          resolve()
        } else {
          worker.postMessage({ jobId: completed + 1, filePath: '' })
        }
      } catch (error) {
        reject(error)
      }
    })
    worker.postMessage({ jobId: 1, filePath: '' })
  })
  console.log('keyAnalysisWorker startup check passed (Electron unavailable, two requests handled)')
} finally {
  clearTimeout(timeout)
  await worker.terminate()
}
