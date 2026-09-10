const isTransferableArrayBuffer = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer

/**
 * Buffer backing stores may come from Node's shared pool and therefore cannot safely enter a
 * transfer list. Copy them once inside the worker into dedicated Uint8Arrays. Plain payload
 * objects are cloned so callers do not have to mutate their typed result before posting it.
 */
export const copyBuffersToTransferableViews = <T>(value: T): T => {
  const visited = new WeakMap<object, unknown>()

  const copy = (current: unknown): unknown => {
    if (Buffer.isBuffer(current)) return Uint8Array.from(current)
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) return current
    if (!current || typeof current !== 'object') return current

    const existing = visited.get(current)
    if (existing) return existing
    if (Array.isArray(current)) {
      const result: unknown[] = []
      visited.set(current, result)
      for (const item of current) result.push(copy(item))
      return result
    }

    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) return current
    const result: Record<string, unknown> = {}
    visited.set(current, result)
    for (const [key, item] of Object.entries(current)) result[key] = copy(item)
    return result
  }

  return copy(value) as T
}

/**
 * 收集 worker 结果中的独占 ArrayBuffer，避免大型波形在回传主进程时被结构化克隆。
 * Buffer 可能来自 Node 共享内存池，不能安全转移，因此明确跳过；需要跨线程发送的
 * Buffer 应先转换为拥有独立 ArrayBuffer 的 Uint8Array。
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
