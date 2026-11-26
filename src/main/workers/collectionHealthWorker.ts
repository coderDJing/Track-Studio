import { parentPort } from 'node:worker_threads'

type NativeFingerprintModule = {
  generateChromaprintFingerprint?: (
    filePath: string,
    maxLengthSeconds?: number | null
  ) => { fingerprint: string; duration: number; error?: string }
}

let nativeModule: NativeFingerprintModule | undefined
try {
  nativeModule = require('rust_package') as NativeFingerprintModule
} catch {
  nativeModule = undefined
}

const FINGERPRINT_MAX_SECONDS = 120

const probe = async (filePath: string) => {
  const metadataModule = await import('music-metadata')
  const metadata = await metadataModule.parseFile(filePath, { duration: false })
  const hasCover = Boolean(metadataModule.selectCover(metadata.common.picture))
  let fingerprint: string | null = null
  try {
    const generate = nativeModule?.generateChromaprintFingerprint
    if (typeof generate === 'function') {
      const result = generate(filePath, FINGERPRINT_MAX_SECONDS)
      if (!result.error && result.fingerprint) fingerprint = result.fingerprint
    }
  } catch {
    fingerprint = null
  }
  return { hasCover, fingerprint }
}

parentPort?.on('message', async (request: { requestId: number; filePath: string }) => {
  try {
    const result = await probe(request.filePath)
    parentPort?.postMessage({ requestId: request.requestId, ...result })
  } catch (error) {
    parentPort?.postMessage({
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
