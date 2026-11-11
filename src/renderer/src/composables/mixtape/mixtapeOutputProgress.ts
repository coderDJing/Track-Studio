export type MixtapeOutputProgressState = {
  stageKey: string
  done: number
  total: number
  percent: number
}

export const resolveMixtapeOutputProgressState = (
  current: MixtapeOutputProgressState,
  payload: unknown
) => {
  const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const stageKeyRaw = typeof source.stageKey === 'string' ? source.stageKey.trim() : ''
  const stageKey = stageKeyRaw || current.stageKey

  const doneRaw = Number(source.done)
  const totalRaw = Number(source.total)
  const percentRaw = Number(source.percent)

  const done = Number.isFinite(doneRaw) ? Math.max(0, Math.round(doneRaw)) : current.done
  const total = Number.isFinite(totalRaw) ? Math.max(0, Math.round(totalRaw)) : current.total

  // 百分比只许向前：阶段切换时各段区间是重新分配的，偶尔会出现新值比旧值小一点点，
  // 直接回填会让进度条往回缩一下，比数字不准更难看。
  const forward = (percent: number) =>
    Math.max(current.percent, Math.max(0, Math.min(100, Math.round(percent))))

  if (Number.isFinite(percentRaw)) {
    return {
      stageKey,
      done,
      total,
      percent: forward(percentRaw)
    }
  }

  if (total > 0) {
    return {
      stageKey,
      done,
      total,
      percent: forward((done / Math.max(1, total)) * 100)
    }
  }

  return {
    stageKey,
    done,
    total,
    percent: current.percent
  }
}

export const buildRecFilename = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `rec-${date}-${time}`
}
