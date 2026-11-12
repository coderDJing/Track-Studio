import { probeDynamicGridAudioDuration } from '../../workers/dynamicBeatGridScanner'

/**
 * Dynamic 网格的可靠 audio 时长。
 *
 * `probeDurationSec` 只是 ffprobe 的候选值（容器时长可能包含非零 start_time），
 * 绝不能直接返回。必须交给 `probeDynamicGridAudioDuration` 做有界尾窗 EOF 验证；
 * 只有验证通过的 audio 时长才会返回。拿不到可信时长时返回 undefined，由 worker
 * 明确报 unsupported，禁止为了拿时长做全曲解码。
 */
export const resolveDynamicGridAudioDurationSec = async (params: {
  filePath: string
  probeDurationSec?: unknown
}): Promise<number | undefined> => {
  const candidate = Number(params.probeDurationSec)
  const candidateSec = Number.isFinite(candidate) && candidate > 0 ? candidate : undefined
  try {
    const durationSec = await probeDynamicGridAudioDuration(params.filePath, candidateSec)
    return Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined
  } catch {
    return undefined
  }
}
