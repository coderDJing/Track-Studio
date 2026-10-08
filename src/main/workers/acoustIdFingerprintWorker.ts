import { parentPort } from 'node:worker_threads'
import type { FingerprintResult } from '../services/acoustIdFingerprintWorker'

type NativeFingerprintModule = {
  generateChromaprintFingerprint?: (filePath: string, maxLengthSeconds: number) => FingerprintResult
}

// 原生模块与 libavcodec 的加载、解码和指纹计算全部发生在 worker。
let nativeModule: NativeFingerprintModule | undefined
try {
  nativeModule = require('rust_package') as NativeFingerprintModule
} catch {
  nativeModule = undefined
}

parentPort?.on(
  'message',
  (request: { requestId: number; filePath: string; maxLengthSeconds: number }) => {
    try {
      const generate = nativeModule?.generateChromaprintFingerprint
      if (typeof generate !== 'function') throw new Error('ACOUSTID_CHROMAPRINT_UNAVAILABLE')
      const result = generate(request.filePath, request.maxLengthSeconds)
      parentPort?.postMessage({ requestId: request.requestId, result })
    } catch (error) {
      parentPort?.postMessage({
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
)
