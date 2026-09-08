import { parentPort } from 'node:worker_threads'
import fs = require('fs-extra')

type CoverExtractionRequest = {
  filePath?: unknown
  allowBufferFallback?: unknown
}

parentPort?.once('message', async (payload: CoverExtractionRequest) => {
  try {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) throw new Error('invalid cover source path')
    const metadataModule = await import('music-metadata')
    const metadata = await metadataModule.parseFile(filePath)
    let cover = metadataModule.selectCover(metadata.common.picture)
    if (!cover && payload.allowBufferFallback === true) {
      const stat = await fs.stat(filePath)
      const buffer = await fs.readFile(filePath)
      const parsed = await metadataModule.parseBuffer(buffer, { size: stat.size })
      cover = metadataModule.selectCover(parsed.common.picture)
    }
    if (!cover?.data) {
      parentPort?.postMessage({ result: null })
      return
    }
    const source = cover.data
    const data = new Uint8Array(source.byteLength)
    data.set(source)
    parentPort?.postMessage(
      {
        result: {
          format: cover.format || 'image/jpeg',
          data
        }
      },
      [data.buffer]
    )
  } catch (error) {
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error || 'cover extraction failed')
    })
  }
})
