// 为官网首页双轨演示生成展示波形。
// 流程与应用分析链路一致：合成 PCM → Rust Mixxx 三频 → raw 波形 → unified display（含 rekordbox-like 配色），
// 把应用原生 UnifiedDisplay 波形和列表预览打包进 docs/public，页面端不需要任何音频。
//
// 用法：pnpm exec tsx scripts/build_docs_hero_waveforms.ts
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE } from '../src/shared/compactVisualWaveform'
import {
  UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE,
  buildUnifiedDisplayWaveformDetailFromMixxx,
  type UnifiedDisplayWaveformDetailData
} from '../src/shared/unifiedDisplayWaveform'
import {
  buildWaveformSurfaceCacheDataFromUnifiedDisplay,
  type WaveformListPreviewData
} from '../src/shared/waveformSurfaceCache'
import { computeRawWaveform } from '../src/main/workers/rawWaveformBuilder'
import type { MixxxWaveformData } from '../src/main/waveformCodec'
import {
  HERO_BEATS_PER_BAR,
  HERO_TRACKS,
  LIST_TRACKS,
  resolveHeroBeatSec,
  resolveHeroDurationSec,
  type HeroLayer,
  type HeroTrackSpec
} from '../docs/.vitepress/theme/app/demoTrackSpecs'

type RustBinding = {
  computeMixxxWaveformWithRate: (
    pcmData: Buffer,
    sampleRate: number,
    channels: number,
    targetRate: number
  ) => MixxxWaveformData
}

const SAMPLE_RATE = 44100
const UNIFIED_OUTPUT_DIR = path.resolve('docs/public/assets/unified-waveforms')

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const resolveLayersAtBar = (spec: HeroTrackSpec, bar: number) =>
  spec.sections.find((section) => bar >= section.startBar && bar < section.endBar)

// 一阶单极点滤波，足够把白噪声分成“嚓”和“沙”两种质感
const createOnePole = (cutoffHz: number) => {
  const alpha = Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE)
  let state = 0
  return (input: number) => {
    state = (1 - alpha) * input + alpha * state
    return state
  }
}

const synthesizeTrack = (spec: HeroTrackSpec) => {
  const durationSec = resolveHeroDurationSec(spec)
  const frames = Math.ceil(durationSec * SAMPLE_RATE)
  const pcm = new Float32Array(frames * 2)
  const rand = mulberry32(spec.seed)
  const beatSec = resolveHeroBeatSec(spec)
  const hatLowpass = createOnePole(9000)
  const hatHighpassBase = createOnePole(5200)
  const clapBody = createOnePole(2400)
  const riserLow = createOnePole(1800)
  const padPhases = spec.chordHz.map(() => 0)
  const arrangementRand = mulberry32(spec.seed ^ 0x9e3779b9)
  const bassColor = 0.7 + arrangementRand() * 0.35
  const hatColor = 0.7 + arrangementRand() * 0.4
  const stabColor = 0.65 + arrangementRand() * 0.45
  const phraseDrive = Array.from(
    { length: Math.ceil(spec.bars / 8) },
    () => 0.72 + arrangementRand() * 0.42
  )
  const barDrive = Array.from({ length: spec.bars }, (_, bar) => {
    const phraseSwell = (bar % 8) / 7
    return (
      (phraseDrive[Math.floor(bar / 8)] ?? 1) * (0.75 + phraseSwell * 0.2 + arrangementRand() * 0.2)
    )
  })
  const beatDrive = Array.from(
    { length: spec.bars * HERO_BEATS_PER_BAR },
    (_, beat) => (beat % HERO_BEATS_PER_BAR === 0 ? 1.08 : 0.82) + arrangementRand() * 0.23
  )
  let bassPhase = 0
  let stabPhase = 0
  let activeBar = -1
  let section: ReturnType<typeof resolveLayersAtBar>
  let layers = new Set<HeroLayer>()

  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / SAMPLE_RATE
    const beatPos = t / beatSec
    const beat = Math.floor(beatPos)
    const beatPhaseSec = (beatPos - beat) * beatSec
    const bar = Math.floor(beat / HERO_BEATS_PER_BAR)
    const beatInBar = beat % HERO_BEATS_PER_BAR
    if (bar !== activeBar) {
      activeBar = bar
      section = resolveLayersAtBar(spec, bar)
      layers = new Set<HeroLayer>(section?.layers ?? [])
    }
    const sectionProgress = section
      ? (beatPos / HERO_BEATS_PER_BAR - section.startBar) / (section.endBar - section.startBar)
      : 0
    const drive = barDrive[bar] ?? 0.8
    const beatAccent = beatDrive[beat] ?? 0.9
    const noise = rand() * 2 - 1
    let sample = 0

    const phraseTurnaround = bar % 8 === 7 && beatInBar === 3
    if (layers.has('kick') && !phraseTurnaround) {
      // 指数下滑的正弦底鼓：150Hz → 48Hz
      // 相位是瞬时频率 48 + 102·e^(-38t) 的积分
      const env = Math.exp(-beatPhaseSec * 18)
      const kickPhase =
        2 * Math.PI * (48 * beatPhaseSec + (102 / 38) * (1 - Math.exp(-beatPhaseSec * 38)))
      sample += Math.sin(kickPhase) * env * 0.94 * beatAccent
      sample += noise * Math.exp(-beatPhaseSec * 100) * 0.09 * beatAccent
    }

    const hatHigh = noise - hatHighpassBase(noise)
    if (layers.has('hat8') || layers.has('hat16')) {
      const sixteenth = beatSec / 4
      const stepIndex = Math.floor(beatPhaseSec / sixteenth)
      const stepPos = beatPhaseSec - stepIndex * sixteenth
      const openHat = stepIndex === 2
      const ghostHat =
        layers.has('hat16') && (stepIndex === 1 || (stepIndex === 3 && bar % 4 !== 3))
      const closedHat = stepIndex === 0 && beatInBar % 2 === 0
      if (openHat || ghostHat || closedHat) {
        const env = Math.exp(-stepPos * (openHat ? 78 : 135))
        const strength = openHat ? 0.28 : ghostHat ? 0.11 : 0.08
        sample += hatLowpass(hatHigh) * env * strength * hatColor * beatAccent
      }
    }

    if (layers.has('clap') && (beatInBar === 1 || beatInBar === 3)) {
      const env = Math.exp(-beatPhaseSec * 22)
      sample += (clapBody(noise) * 1.4 + noise * 0.18) * env * 0.45 * beatAccent
    }

    if (layers.has('bassRoll') || layers.has('bassOffbeat')) {
      const sixteenth = beatSec / 4
      const stepIndex = Math.floor(beatPhaseSec / sixteenth)
      const stepPos = beatPhaseSec - stepIndex * sixteenth
      const gate =
        !phraseTurnaround &&
        (layers.has('bassOffbeat') ? stepIndex === 2 : stepIndex === 1 || stepIndex === 3)
      const env = gate ? Math.exp(-stepPos * (bar % 4 === 3 ? 12 : 18)) : 0
      const noteRatio = bar % 8 === 6 ? 1.335 : bar % 4 === 3 ? 1.189 : 1
      bassPhase += (2 * Math.PI * spec.bassHz * noteRatio) / SAMPLE_RATE
      const saw = ((bassPhase / (2 * Math.PI)) % 1) * 2 - 1
      sample += (Math.sin(bassPhase) * 0.78 + saw * 0.18) * env * 0.7 * bassColor
    }

    if (layers.has('pad')) {
      let pad = 0
      for (let index = 0; index < spec.chordHz.length; index += 1) {
        padPhases[index] += (2 * Math.PI * spec.chordHz[index]) / SAMPLE_RATE
        pad += Math.sin(padPhases[index]) + Math.sin(padPhases[index] * 2.003) * 0.3
      }
      const swell = 0.4 + 0.48 * (0.5 + 0.5 * Math.sin((beatPos / 8) * Math.PI))
      sample += (pad / spec.chordHz.length) * 0.31 * swell
    }

    if (layers.has('stabs')) {
      const eighth = beatSec / 2
      const stepIndex = Math.floor(beatPhaseSec / eighth)
      const stepPos = beatPhaseSec - stepIndex * eighth
      const stabBeat = beatInBar === 0 || beatInBar === 2 || (bar % 4 === 3 && beatInBar === 3)
      const env = stepIndex === 1 && stabBeat ? Math.exp(-stepPos * 15) : 0
      stabPhase += (2 * Math.PI * spec.chordHz[1] * 2) / SAMPLE_RATE
      const square = Math.sign(Math.sin(stabPhase)) * 0.6 + Math.sin(stabPhase * 1.5) * 0.4
      sample += square * env * 0.26 * stabColor
    }

    if (layers.has('riser')) {
      const amount = Math.max(0, Math.min(1, sectionProgress))
      const filtered = riserLow(noise) * (1 - amount) + noise * amount
      sample += filtered * (0.05 + amount * amount * 0.32)
    }

    if (layers.has('roll')) {
      // 军鼓越滚越密：4 分 → 8 分 → 16 分
      const amount = Math.max(0, Math.min(1, sectionProgress))
      const division = amount < 0.5 ? 1 : amount < 0.8 ? 2 : 4
      const stepSec = beatSec / division
      const stepPos = beatPhaseSec % stepSec
      const env = Math.exp(-stepPos * 30)
      sample += (clapBody(noise) + noise * 0.3) * env * (0.14 + amount * 0.36)
    }

    if (section?.startBar === bar && beatInBar === 0 && section.kind === 'drop') {
      sample += hatHigh * Math.exp(-beatPhaseSec * 7) * 0.24
    }

    const value = Math.tanh(sample * drive * 0.98) * 0.94
    pcm[frame * 2] = value
    pcm[frame * 2 + 1] = value
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

// 原样打包 unified display 的全部字段（不降采样），官网直接交给应用自己的波形加载与渲染链路
const UNIFIED_FIELDS = [
  'height',
  'attack',
  'colorIndex',
  'colorLow',
  'colorMid',
  'colorHigh',
  'colorRed',
  'colorGreen',
  'colorBlue',
  'body',
  'overviewHeight'
] as const

const packUnifiedDisplayRaw = (data: UnifiedDisplayWaveformDetailData) => {
  const lengths = UNIFIED_FIELDS.map((field) => data[field].length)
  const packed = new Uint8Array(lengths.reduce((sum, length) => sum + length, 0))
  let offset = 0
  UNIFIED_FIELDS.forEach((field) => {
    packed.set(data[field], offset)
    offset += data[field].length
  })
  return { packed, lengths }
}

// listPreview 里的 Uint8Array 转成数组存 JSON；页面端用 normalizeWaveformSurfaceData 读回
const serializeSurface = (surface: WaveformListPreviewData) =>
  Object.fromEntries(
    Object.entries(surface).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? Array.from(value) : value
    ])
  )

const main = async () => {
  const require = createRequire(import.meta.url)
  const rust = require('rust_package') as RustBinding
  await mkdir(UNIFIED_OUTPUT_DIR, { recursive: true })
  const unifiedManifest: Record<string, unknown> = {}
  const listPreviews: Record<string, unknown> = {}

  for (const spec of [...HERO_TRACKS, ...LIST_TRACKS]) {
    const pcm = synthesizeTrack(spec)
    const mixxx = rust.computeMixxxWaveformWithRate(
      pcm,
      SAMPLE_RATE,
      2,
      UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE
    )
    const raw = computeRawWaveform(pcm, SAMPLE_RATE, 2, COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE)
    const unified = buildUnifiedDisplayWaveformDetailFromMixxx(mixxx, raw)
    if (!unified) throw new Error(`${spec.id}: unified display 构建失败`)
    // 双轨详情 / 概览要完整 unified display 数据；列表预览只要 listPreview 表面数据（1–2KB）
    if (!HERO_TRACKS.includes(spec)) {
      const surface = buildWaveformSurfaceCacheDataFromUnifiedDisplay(unified)
      if (!surface) throw new Error(`${spec.id}: listPreview 构建失败`)
      listPreviews[spec.id] = serializeSurface(surface.listPreview)
    } else {
      const raw = packUnifiedDisplayRaw(unified)
      await writeFile(path.join(UNIFIED_OUTPUT_DIR, `${spec.id}.bin`), raw.packed)
      unifiedManifest[spec.id] = {
        file: `${spec.id}.bin`,
        version: unified.version,
        parameterVersion: unified.parameterVersion,
        duration: unified.duration,
        sampleRate: unified.sampleRate,
        detailRate: unified.detailRate,
        overviewRate: unified.overviewRate,
        bodyRateDivisor: unified.bodyRateDivisor,
        fields: UNIFIED_FIELDS,
        lengths: raw.lengths
      }
      const rawGzipKb = (gzipSync(raw.packed).byteLength / 1024).toFixed(1)
      console.log(
        `  unified ${spec.id}: ${(raw.packed.byteLength / 1024).toFixed(1)} KB (gzip ${rawGzipKb} KB)`
      )
    }
  }

  await writeFile(
    path.join(UNIFIED_OUTPUT_DIR, 'manifest.json'),
    `${JSON.stringify(unifiedManifest, null, 2)}\n`
  )
  const listPreviewJson = JSON.stringify(listPreviews)
  await writeFile(path.join(UNIFIED_OUTPUT_DIR, 'list-previews.json'), `${listPreviewJson}\n`)
  console.log(
    `list-previews.json: ${(listPreviewJson.length / 1024).toFixed(1)} KB (gzip ${(gzipSync(listPreviewJson).byteLength / 1024).toFixed(1)} KB)`
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
