import { createHash } from 'node:crypto'
import type { IcloudPicture } from '../../../shared/icloudLibrary'
// Bound encoded and decoded size before anything reaches an image decoder.
export function embeddedPicture(format: string, bytes: Uint8Array): IcloudPicture | undefined {
  const b = Buffer.from(bytes)
  if (!b.length || b.length > 1024 * 1024) return
  let width = 0,
    height = 0
  if (
    format === 'image/png' &&
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    width = b.readUInt32BE(16)
    height = b.readUInt32BE(20)
  } else if ((format === 'image/jpeg' || format === 'image/jpg') && b[0] === 255 && b[1] === 216) {
    format = 'image/jpeg'
    for (let offset = 2; offset + 4 <= b.length;) {
      if (b[offset++] !== 255) return
      while (b[offset] === 255) offset++
      const marker = b[offset++]
      if (marker === 217 || marker === 218) break
      if (offset + 2 > b.length) return
      const length = b.readUInt16BE(offset)
      if (length < 2 || offset + length > b.length) return
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 7
      ) {
        height = b.readUInt16BE(offset + 3)
        width = b.readUInt16BE(offset + 5)
        break
      }
      offset += length
    }
  } else return
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) return
  return {
    format: format as IcloudPicture['format'],
    data: b.toString('base64'),
    hash: createHash('sha256').update(b).digest('hex')
  }
}
