import { parseUsbAnlz } from './usbAnlzWrite'

const detailEntrySizes: Readonly<Record<string, number>> = { PWV3: 1, PWV5: 2, PWV7: 3 }

/** Native detail tags cover 150 half-frames per second; only their headers are read. */
export const readUsbAnlzDurationMs = (documents: readonly Buffer[]): number => {
  let frameCount: number | undefined
  for (const bytes of documents) {
    for (const section of parseUsbAnlz(bytes).sections) {
      const entrySize = detailEntrySizes[section.kind]
      if (entrySize === undefined) continue
      const tag = section.bytes
      if (
        tag.length < 24 ||
        tag.readUInt32BE(4) !== 24 ||
        tag.readUInt32BE(12) !== entrySize ||
        tag.readUInt32BE(20) >>> 16 !== 150
      )
        throw new Error('未知详细波形时长布局，已停止网格写入')
      const count = tag.readUInt32BE(16)
      if (!count || tag.length !== 24 + count * entrySize)
        throw new Error('详细波形长度无效，已停止网格写入')
      if (frameCount !== undefined && count !== frameCount)
        throw new Error('分析文件组的详细波形时长不一致，已停止网格写入')
      frameCount = count
    }
  }
  if (frameCount === undefined) throw new Error('缺少已验证的详细波形时长，已停止网格写入')
  const durationMs = (frameCount * 1000) / 150
  if (durationMs > 0xffffffff) throw new Error('分析文件时长超出网格范围')
  return durationMs
}
