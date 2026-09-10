import { parentPort } from 'node:worker_threads'
import fs = require('fs-extra')

type CoverExtractionRequest = {
  filePath?: unknown
  allowBufferFallback?: unknown
}

type CoverExtractionTiming = {
  metadataImportMs: number
  parseFileMs: number
  fallbackStatMs: number
  fallbackReadMs: number
  fallbackParseMs: number
  copyMs: number
  totalMs: number
  sourceBytes: number
  usedBufferFallback: boolean
}

parentPort?.once('message', async (payload: CoverExtractionRequest) => {
  const startedAtMs = Date.now()
  const timing: CoverExtractionTiming = {
    metadataImportMs: 0,
    parseFileMs: 0,
    fallbackStatMs: 0,
    fallbackReadMs: 0,
    fallbackParseMs: 0,
    copyMs: 0,
    totalMs: 0,
    sourceBytes: 0,
    usedBufferFallback: false
  }
  try {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) throw new Error('invalid cover source path')
    let phaseStartedAtMs = Date.now()
    const metadataModule = await import('music-metadata')
    timing.metadataImportMs = Date.now() - phaseStartedAtMs
    phaseStartedAtMs = Date.now()
    const metadata = await metadataModule.parseFile(filePath)
    timing.parseFileMs = Date.now() - phaseStartedAtMs
    let cover = metadataModule.selectCover(metadata.common.picture)
    if (!cover && payload.allowBufferFallback === true) {
      timing.usedBufferFallback = true
      phaseStartedAtMs = Date.now()
      const stat = await fs.stat(filePath)
      timing.fallbackStatMs = Date.now() - phaseStartedAtMs
      phaseStartedAtMs = Date.now()
      const buffer = await fs.readFile(filePath)
      timing.fallbackReadMs = Date.now() - phaseStartedAtMs
      phaseStartedAtMs = Date.now()
      const parsed = await metadataModule.parseBuffer(buffer, { size: stat.size })
      timing.fallbackParseMs = Date.now() - phaseStartedAtMs
      cover = metadataModule.selectCover(parsed.common.picture)
    }
    if (!cover?.data) {
      timing.totalMs = Date.now() - startedAtMs
      parentPort?.postMessage({ result: null, timing })
      return
    }
    const source = cover.data
    timing.sourceBytes = source.byteLength
    phaseStartedAtMs = Date.now()
    const data = new Uint8Array(source.byteLength)
    data.set(source)
    timing.copyMs = Date.now() - phaseStartedAtMs
    timing.totalMs = Date.now() - startedAtMs
    parentPort?.postMessage(
      {
        result: {
          format: cover.format || 'image/jpeg',
          data
        },
        timing
      },
      [data.buffer]
    )
  } catch (error) {
    timing.totalMs = Date.now() - startedAtMs
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error || 'cover extraction failed'),
      timing
    })
  }
})
