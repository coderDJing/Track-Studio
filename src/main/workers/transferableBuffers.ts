const isTransferableArrayBuffer = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer

/**
 * 收集 worker 结果中的独占 ArrayBuffer，避免大型波形在回传主进程时被结构化克隆。
 * Buffer 可能来自 Node 共享内存池，不能安全转移，因此明确跳过。
 */
export const collectTransferableArrayBuffers = (value: unknown): ArrayBuffer[] => {
  const buffers = new Set<ArrayBuffer>()
  const blockedBuffers = new Set<ArrayBuffer>()
  const visited = new WeakSet<object>()

  const visit = (current: unknown): void => {
    if (isTransferableArrayBuffer(current)) {
      if (!blockedBuffers.has(current)) buffers.add(current)
      return
    }
    if (ArrayBuffer.isView(current)) {
      if (!isTransferableArrayBuffer(current.buffer)) return
      if (Buffer.isBuffer(current)) {
        blockedBuffers.add(current.buffer)
        buffers.delete(current.buffer)
      } else if (!blockedBuffers.has(current.buffer)) {
        buffers.add(current.buffer)
      }
      return
    }
    if (!current || typeof current !== 'object' || visited.has(current)) return
    visited.add(current)
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    for (const item of Object.values(current as Record<string, unknown>)) visit(item)
  }

  visit(value)
  return [...buffers]
}
