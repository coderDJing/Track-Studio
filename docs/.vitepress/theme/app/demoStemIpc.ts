// Stem 工作台演示用的 IPC 数据：让应用原版 libraryStemSeparationDialog 自己走一遍
// “等待 → 正在分离 → 渲染 → 就绪”的状态流。状态推送与主进程推送的格式一致（library-stem-status-updated）。
import { emitDemoIpcEvent, registerDemoIpcHandler } from './demoIpc'

export const DEMO_STEM_FILE_PATH = 'demo://track-studio/deck-a.flac'
const MODEL = 'htdemucs@quality'
const DEVICE = 'DirectML (NVIDIA GeForce RTX 4070)'

type StemStatus = 'idle' | 'pending' | 'running' | 'ready' | 'failed'

const baseSnapshot = (status: StemStatus, percent: number | null, stage: string | null) => ({
  filePath: DEMO_STEM_FILE_PATH,
  model: MODEL,
  status,
  errorMessage: null,
  vocalPath: status === 'ready' ? 'demo://stems/vocal.wav' : null,
  instPath: status === 'ready' ? 'demo://stems/inst.wav' : null,
  bassPath: status === 'ready' ? 'demo://stems/bass.wav' : null,
  drumsPath: status === 'ready' ? 'demo://stems/drums.wav' : null,
  percent,
  activityConfirmedAt: null,
  device: status === 'running' || status === 'ready' ? DEVICE : null,
  stage,
  stageCompleted: stage === 'rendering' ? 2 : null,
  stageTotal: stage === 'rendering' ? 4 : null
})

// 每条 Stem 的预览峰值：固定种子生成，形状对应各自听感（人声有句读、鼓组是密集脉冲）
const buildPeaks = (stem: 'vocal' | 'inst' | 'bass' | 'drums') => {
  let seed = { vocal: 11, inst: 23, bass: 37, drums: 53 }[stem]
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  return Array.from({ length: 240 }, (_, index) => {
    const beat = index % 8
    if (stem === 'drums') return beat === 0 ? 0.95 : beat === 4 ? 0.72 : 0.16 + rand() * 0.2
    if (stem === 'bass') return 0.42 + 0.34 * Math.abs(Math.sin(index / 3)) + rand() * 0.1
    if (stem === 'vocal') {
      return Math.floor(index / 24) % 2 === 0 ? 0.3 + rand() * 0.6 : 0.04 + rand() * 0.08
    }
    return 0.28 + 0.24 * Math.sin(index / 9) + rand() * 0.22
  })
}

let current = baseSnapshot('idle', null, null)

registerDemoIpcHandler('library-stem:get-status', () => current)
registerDemoIpcHandler('demucs-model:get-ultra-status', () => null)
registerDemoIpcHandler('library-stem:preview-waveforms', () => ({
  stems: {
    vocal: { peaks: buildPeaks('vocal') },
    inst: { peaks: buildPeaks('inst') },
    bass: { peaks: buildPeaks('bass') },
    drums: { peaks: buildPeaks('drums') }
  }
}))

const push = (snapshot: ReturnType<typeof baseSnapshot>) => {
  current = snapshot
  emitDemoIpcEvent('library-stem-status-updated', snapshot)
}

// 一次完整的分离过程：约 9 秒跑完，停在就绪 4 秒后重来
const TIMELINE: { at: number; snapshot: () => ReturnType<typeof baseSnapshot> }[] = [
  { at: 0, snapshot: () => baseSnapshot('idle', null, null) },
  { at: 1400, snapshot: () => baseSnapshot('pending', null, null) },
  ...Array.from({ length: 16 }, (_, index) => ({
    at: 2200 + index * 380,
    snapshot: () => baseSnapshot('running', Math.round(((index + 1) / 16) * 92), 'separating')
  })),
  { at: 8400, snapshot: () => baseSnapshot('running', 96, 'rendering') },
  { at: 9000, snapshot: () => baseSnapshot('running', 99, 'validating') },
  { at: 9600, snapshot: () => baseSnapshot('ready', 100, null) }
]
const CYCLE_MS = 13600

let timers: ReturnType<typeof setTimeout>[] = []
export const startDemoStemCycle = () => {
  stopDemoStemCycle()
  const run = () => {
    TIMELINE.forEach((step) => timers.push(setTimeout(() => push(step.snapshot()), step.at)))
    timers.push(setTimeout(run, CYCLE_MS))
  }
  run()
}
export const stopDemoStemCycle = () => {
  timers.forEach(clearTimeout)
  timers = []
}
export const showDemoStemReady = () => push(baseSnapshot('ready', 100, null))
