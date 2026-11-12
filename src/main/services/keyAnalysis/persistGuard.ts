export type AudioIdentity = {
  size: number
  mtimeMs: number
}

const IDENTITY_MTIME_TOLERANCE_MS = 1

export const normalizeAudioIdentity = (
  value: { size?: unknown; mtimeMs?: unknown } | null | undefined
): AudioIdentity | null => {
  const size = Number(value?.size)
  const mtimeMs = Number(value?.mtimeMs)
  if (!Number.isFinite(size) || size < 0) return null
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return null
  return { size, mtimeMs }
}

export const isSameAudioIdentity = (
  left: AudioIdentity | null | undefined,
  right: AudioIdentity | null | undefined
) => {
  if (!left || !right) return false
  return (
    left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) < IDENTITY_MTIME_TOLERANCE_MS
  )
}

/**
 * 任务所有权（是否仍是当前请求代次）之外，再叠加音频身份保护：
 * 分析期间文件被替换时，旧计算结果没有提交资格。
 */
export const createWorkerPersistGuard = async (params: {
  isCurrentJob: () => boolean
  expectedAudioIdentity?: AudioIdentity | null
  readCurrentAudioIdentity: () => Promise<AudioIdentity | null>
}): Promise<() => boolean> => {
  const expected = normalizeAudioIdentity(params.expectedAudioIdentity)
  let audioIdentityCurrent = true
  if (expected) {
    const current = normalizeAudioIdentity(await params.readCurrentAudioIdentity())
    audioIdentityCurrent = isSameAudioIdentity(expected, current)
  }
  return () => audioIdentityCurrent && params.isCurrentJob()
}
