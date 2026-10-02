import { computed, ref, type Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import {
  hasRequiredSongEnergyAnalysis,
  hasRequiredSongStructureAnalysis,
  hasUsableKeyAnalysis,
  hasUsableSongBeatGridAnalysis
} from '@shared/songAnalysisCompleteness'

type AnalysisStage =
  | 'job-received'
  | 'decode-start'
  | 'decode-done'
  | 'analyze-start'
  | 'analyze-done'
  | 'waveform-start'
  | 'waveform-done'
  | 'job-done'
  | 'job-error'

type StageUpdatePayload = {
  filePath: string
  stage: AnalysisStage
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  needsStructure?: boolean
}

// 每个阶段的基础权重
const PHASE_WEIGHTS = {
  decode: 20,
  analyze: 40,
  waveform: 40
}

const normalizePath = (value: string) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const computePercent = (
  stage: AnalysisStage,
  needsKey?: boolean,
  needsBpm?: boolean,
  needsWaveform?: boolean,
  needsStructure?: boolean
): number => {
  const needsAnalysis = needsKey === true || needsBpm === true
  const needsWave = needsWaveform === true || needsStructure === true

  // 计算需要的阶段权重总和
  let totalWeight = PHASE_WEIGHTS.decode // 解码总是需要的
  if (needsAnalysis) totalWeight += PHASE_WEIGHTS.analyze
  if (needsWave) totalWeight += PHASE_WEIGHTS.waveform
  if (totalWeight <= 0) return 0

  // 计算当前阶段完成后的累计百分比
  const decodeWeight = PHASE_WEIGHTS.decode / totalWeight
  const analyzeWeight = needsAnalysis ? PHASE_WEIGHTS.analyze / totalWeight : 0
  const waveformWeight = needsWave ? PHASE_WEIGHTS.waveform / totalWeight : 0

  switch (stage) {
    case 'job-received':
      return 0
    case 'decode-start':
      // 动画目标：解码阶段结束时的百分比
      return Math.round(decodeWeight * 100)
    case 'decode-done':
      return Math.round(decodeWeight * 100)
    case 'analyze-start':
      // 动画目标：分析阶段结束时的百分比
      return Math.round((decodeWeight + analyzeWeight) * 100)
    case 'analyze-done':
      return Math.round((decodeWeight + analyzeWeight) * 100)
    case 'waveform-start':
      // 动画目标：波形阶段结束时的百分比
      return Math.round((decodeWeight + analyzeWeight + waveformWeight) * 100)
    case 'waveform-done':
      return Math.round((decodeWeight + analyzeWeight + waveformWeight) * 100)
    case 'job-done':
      return 100
    case 'job-error':
      return 0
    default:
      return 0
  }
}

const isDisplayableProgressEntry = (
  entry?: {
    stage: AnalysisStage
    displayPercent: number
  } | null
): entry is {
  stage: AnalysisStage
  displayPercent: number
} => Boolean(entry && entry.stage !== 'job-received' && entry.displayPercent > 0)

// 阶段内平滑过渡：估算每个阶段的持续时间（ms）
const PHASE_DURATION_MS = {
  decode: 3000,
  analyze: 8000,
  waveform: 6000
}

const STAGE_TO_PHASE: Record<string, keyof typeof PHASE_DURATION_MS | null> = {
  'job-received': null,
  'decode-start': 'decode',
  'decode-done': null,
  'analyze-start': 'analyze',
  'analyze-done': null,
  'waveform-start': 'waveform',
  'waveform-done': null,
  'job-done': null,
  'job-error': null
}

// 模块级响应式状态，所有组件共享
// percent 是目标值，displayPercent 是带动画的显示值
const progressMap = ref(
  new Map<
    string,
    {
      stage: AnalysisStage
      percent: number
      displayPercent: number
      needsKey?: boolean
      needsBpm?: boolean
      needsWaveform?: boolean
      needsStructure?: boolean
    }
  >()
)
const progressVersion = ref(0)

// 每首歌的平滑动画 timer
const animTimers = new Map<string, ReturnType<typeof setInterval>>()

const stopAnimTimer = (filePath: string) => {
  const timer = animTimers.get(filePath)
  if (timer) {
    clearInterval(timer)
    animTimers.delete(filePath)
  }
}

const startAnimTimer = (
  filePath: string,
  entry: { displayPercent: number; percent: number },
  phaseDurationMs: number
) => {
  stopAnimTimer(filePath)
  if (entry.displayPercent >= entry.percent) return

  // 每 200ms 更新一次，每次增加一小步
  const intervalMs = 200
  const totalSteps = Math.ceil(phaseDurationMs / intervalMs)
  const remaining = entry.percent - entry.displayPercent
  const step = remaining / totalSteps

  const timer = setInterval(() => {
    entry.displayPercent = Math.min(entry.percent, entry.displayPercent + step)
    touchProgress()
    if (entry.displayPercent >= entry.percent) {
      stopAnimTimer(filePath)
    }
  }, intervalMs)
  animTimers.set(filePath, timer)
}

const touchProgress = () => {
  progressVersion.value += 1
}

const updateProgress = (payload: StageUpdatePayload) => {
  const filePath = normalizePath(payload.filePath)
  if (!filePath) return

  // 终态：从 map 中移除
  if (payload.stage === 'job-done' || payload.stage === 'job-error') {
    stopAnimTimer(filePath)
    progressMap.value.delete(filePath)
    touchProgress()
    return
  }

  const percent = computePercent(
    payload.stage,
    payload.needsKey,
    payload.needsBpm,
    payload.needsWaveform,
    payload.needsStructure
  )
  const phase = STAGE_TO_PHASE[payload.stage]

  const existing = progressMap.value.get(filePath)
  // 阶段开始事件：从当前显示值开始，向目标值平滑过渡
  if (phase && payload.stage.endsWith('-start')) {
    const startPercent = existing?.displayPercent ?? percent
    const entry = {
      stage: payload.stage,
      percent,
      displayPercent: startPercent,
      needsKey: payload.needsKey,
      needsBpm: payload.needsBpm,
      needsWaveform: payload.needsWaveform,
      needsStructure: payload.needsStructure
    }
    progressMap.value.set(filePath, entry)
    startAnimTimer(filePath, entry, PHASE_DURATION_MS[phase])
  } else {
    // 阶段完成事件：跳到目标值，停止动画
    stopAnimTimer(filePath)
    const entry = {
      stage: payload.stage,
      percent,
      displayPercent: percent,
      needsKey: payload.needsKey,
      needsBpm: payload.needsBpm,
      needsWaveform: payload.needsWaveform,
      needsStructure: payload.needsStructure
    }
    progressMap.value.set(filePath, entry)
  }
  touchProgress()
}

// 模块加载时自动绑定 IPC listener，生命周期跟随 renderer 进程
const bindIpcListener = () => {
  if (typeof window === 'undefined' || !window.electron?.ipcRenderer) return
  window.electron.ipcRenderer.on(
    'key-analysis:stage-update',
    (_event: unknown, payload: StageUpdatePayload) => {
      updateProgress(payload)
    }
  )
}
bindIpcListener()

export const hasCompleteKeyAnalysis = (song: ISongInfo | undefined): boolean => {
  if (!song) return false
  return (
    hasRequiredSongEnergyAnalysis(song) &&
    hasUsableKeyAnalysis(song) &&
    hasUsableSongBeatGridAnalysis(song)
  )
}

export const hasDisplayableAnalysisProgressForSongs = (songs: ISongInfo[]): boolean => {
  progressVersion.value
  for (const song of songs) {
    const normalized = normalizePath(song?.filePath || '')
    if (!normalized) continue
    if (isDisplayableProgressEntry(progressMap.value.get(normalized))) return true
  }
  return false
}

export function useKeyAnalysisProgress(params: {
  visibleSongsWithIndex: Ref<Array<{ song: ISongInfo; idx: number }>>
  isAnalysisCompleteOverride?: (filePath: string) => boolean
  requiresRuntimeAnalysis?: Ref<boolean>
}) {
  const { visibleSongsWithIndex, isAnalysisCompleteOverride } = params

  const hasRequiredAnalysis = (song: ISongInfo | undefined) => {
    if (!song) return false
    if (!hasCompleteKeyAnalysis(song)) return false
    if (params.requiresRuntimeAnalysis?.value === true) {
      return hasRequiredSongStructureAnalysis(song)
    }
    return true
  }

  const getAnalysisProgress = (filePath: string): number | null => {
    // 触发响应式依赖
    progressVersion.value
    const normalized = normalizePath(filePath)
    const entry = progressMap.value.get(normalized)
    if (isDisplayableProgressEntry(entry)) return Math.round(entry.displayPercent)
    return null
  }

  const isSongNeedsAnalysis = (filePath: string): boolean => {
    const normalized = normalizePath(filePath)
    const entry = progressMap.value.get(normalized)
    // 有真实进度就说明正在分析，不再算"待分析"
    if (isDisplayableProgressEntry(entry)) return false
    // 检查可见歌曲列表中是否有这首歌且需要分析
    for (const item of visibleSongsWithIndex.value || []) {
      const songPath = normalizePath(item?.song?.filePath || '')
      if (songPath === normalized) {
        return !hasRequiredAnalysis(item.song) && !isAnalysisCompleteOverride?.(filePath)
      }
    }
    return false
  }

  const hasAnyAnalysisProgress = computed(() => {
    // 触发响应式依赖
    progressVersion.value
    for (const entry of progressMap.value.values()) {
      if (isDisplayableProgressEntry(entry)) return true
    }
    return false
  })

  return {
    getAnalysisProgress,
    isSongNeedsAnalysis,
    hasAnyAnalysisProgress
  }
}
