import { open } from 'node:fs/promises'
import { CURATED_LIBRARY_SYNC_BLOB_CHUNK_SIZE } from '../../shared/curatedLibrarySync'
import { beginBlobUpload, CuratedBlobOffsetMismatchError, uploadBlobChunk } from './apiClient'

const CHUNK_RETRIES = 3

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isAbortError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const name = String((error as { name?: unknown }).name || '')
  return name === 'AbortError'
}

export const uploadBlobWithResume = async (params: {
  sha256: string
  filePath: string
  size: number
  signal?: AbortSignal
  onSuspendWait?: () => Promise<void>
  throwIfCancelled?: () => void
}): Promise<void> => {
  const begin = await beginBlobUpload({
    sha256: params.sha256,
    size: params.size,
    signal: params.signal
  })
  if (!begin.needed) return
  const chunkSize = Math.min(
    CURATED_LIBRARY_SYNC_BLOB_CHUNK_SIZE,
    Math.max(1, begin.chunkSize || CURATED_LIBRARY_SYNC_BLOB_CHUNK_SIZE)
  )
  let offset = Math.max(0, begin.uploadedBytes)
  const handle = await open(params.filePath, 'r')
  try {
    while (offset < params.size) {
      params.throwIfCancelled?.()
      await params.onSuspendWait?.()
      const length = Math.min(chunkSize, params.size - offset)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead !== length) {
        throw new Error('CURATED_SYNC_BLOB_READ_SHORT')
      }
      let attempt = 0
      while (true) {
        try {
          const result = await uploadBlobChunk({
            sha256: params.sha256,
            size: params.size,
            offset,
            chunk: buffer,
            signal: params.signal
          })
          offset = result.uploadedBytes
          if (result.ready || offset >= params.size) return
          break
        } catch (error) {
          if (error instanceof CuratedBlobOffsetMismatchError) {
            offset = error.uploadedBytes
            break
          }
          if (isAbortError(error)) {
            params.throwIfCancelled?.()
            throw error
          }
          attempt += 1
          if (attempt >= CHUNK_RETRIES) throw error
          await delay(1000 * attempt)
        }
      }
    }
  } finally {
    await handle.close()
  }
}
