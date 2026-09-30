// 首屏双轨演示用的两首示范曲目：ISongInfo 字段、网格、Cue 与段落结构都按应用真实数据格式填，
// 波形数据由 scripts/build_docs_hero_waveforms.ts 走应用分析链路生成（docs/public/assets/unified-waveforms）。
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'
import {
  createSongBeatGridMapV2FromFixedGrid,
  type SongBeatGridMapV2
} from '@shared/songBeatGridMapV2'
import {
  HERO_BEATS_PER_BAR,
  HERO_TRACKS,
  resolveHeroBarSec,
  resolveHeroDurationSec,
  type HeroTrackSpec
} from './demoTrackSpecs'

export const demoSongFilePath = (spec: HeroTrackSpec) => `demo://track-studio/${spec.id}.flac`

const formatDuration = (sec: number) => {
  const safe = Math.round(sec)
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

// 段落结构用应用的 legacy 结构格式（formatVersion 1），normalizeSongStructureAnalysis 能直接认
const buildSongStructure = (spec: HeroTrackSpec) => {
  const durationSec = resolveHeroDurationSec(spec)
  const merged: { kind: string; startBar: number; endBar: number }[] = []
  for (const section of spec.sections) {
    const last = merged[merged.length - 1]
    if (last && last.kind === section.kind && last.endBar === section.startBar) {
      last.endBar = section.endBar
    } else {
      merged.push({ kind: section.kind, startBar: section.startBar, endBar: section.endBar })
    }
  }
  return {
    formatVersion: 1,
    algorithmVersion: 1,
    source: 'algorithmic',
    durationSec,
    bpm: spec.bpm,
    firstBeatMs: 0,
    barBeatOffset: 0,
    phraseBars: 8,
    sections: merged.map((section, index) => ({
      startSec: resolveHeroBarSec(spec, section.startBar),
      endSec: resolveHeroBarSec(spec, section.endBar),
      startBar: section.startBar + 1,
      endBar: section.endBar + 1,
      phraseIndex: index,
      kind: section.kind,
      confidence: 0.72,
      energy: 0.6,
      low: 0.5,
      high: 0.5,
      novelty: 0.4
    }))
  }
}

const buildSong = (spec: HeroTrackSpec): ISongInfo => {
  const durationSec = resolveHeroDurationSec(spec)
  const hotCues: ISongHotCue[] = spec.hotCueBars.map((bar, slot) => ({
    slot,
    sec: resolveHeroBarSec(spec, bar)
  }))
  const memoryCues: ISongMemoryCue[] = spec.memoryCueBars.map((bar) => ({
    sec: resolveHeroBarSec(spec, bar)
  }))
  const beatGridMap: SongBeatGridMapV2 | null = createSongBeatGridMapV2FromFixedGrid({
    bpm: spec.bpm,
    firstBeatMs: 0,
    downbeatBeatOffset: 0,
    source: 'analysis'
  })
  const song: Partial<ISongInfo> & Record<string, unknown> = {
    filePath: demoSongFilePath(spec),
    fileName: `${spec.title}.flac`,
    fileFormat: 'FLAC',
    title: spec.title,
    artist: spec.artist,
    album: 'Track Studio Demo',
    duration: formatDuration(durationSec),
    bpm: spec.bpm,
    firstBeatMs: 0,
    barBeatOffset: 0,
    key: spec.keyText,
    energyScore: spec.energy,
    hotCues,
    memoryCues,
    beatGridMap: beatGridMap ?? undefined,
    songStructure: buildSongStructure(spec)
  }
  return song as ISongInfo
}

export const DEMO_TRACKS = HERO_TRACKS.map((spec) => ({
  spec,
  song: buildSong(spec),
  durationSec: resolveHeroDurationSec(spec),
  startSec: resolveHeroBarSec(spec, spec.startBar),
  beatSec: 60 / spec.bpm,
  barSec: (60 / spec.bpm) * HERO_BEATS_PER_BAR
}))

type UnifiedManifestEntry = {
  file: string
  version: number
  parameterVersion: number
  duration: number
  sampleRate: number
  detailRate: number
  overviewRate: number
  bodyRateDivisor: number
  fields: (keyof UnifiedDisplayWaveformDetailData)[]
  lengths: number[]
}

// 读回脚本原样打包的 unified display 数据
export const loadDemoUnifiedWaveforms = async (baseUrl: string) => {
  const res = await fetch(`${baseUrl}manifest.json`)
  if (!res.ok) throw new Error(`unified waveform manifest ${res.status}`)
  const manifest = (await res.json()) as Record<string, UnifiedManifestEntry>
  return Promise.all(
    DEMO_TRACKS.map(async (track) => {
      const entry = manifest[track.spec.id]
      if (!entry) throw new Error(`unified waveform ${track.spec.id} missing`)
      const binRes = await fetch(`${baseUrl}${entry.file}`)
      if (!binRes.ok) throw new Error(`unified waveform ${track.spec.id} ${binRes.status}`)
      const bytes = new Uint8Array(await binRes.arrayBuffer())
      const fields: Partial<Record<keyof UnifiedDisplayWaveformDetailData, Uint8Array>> = {}
      let offset = 0
      entry.fields.forEach((field, index) => {
        const length = entry.lengths[index] ?? 0
        fields[field] = bytes.slice(offset, offset + length)
        offset += length
      })
      const pick = (name: keyof UnifiedDisplayWaveformDetailData) => {
        const value = fields[name]
        if (!value) throw new Error(`unified waveform field ${String(name)} missing`)
        return value
      }
      const data: UnifiedDisplayWaveformDetailData = {
        version: entry.version,
        parameterVersion: entry.parameterVersion,
        duration: entry.duration,
        sampleRate: entry.sampleRate,
        detailRate: entry.detailRate,
        overviewRate: entry.overviewRate,
        bodyRateDivisor: entry.bodyRateDivisor,
        height: pick('height'),
        attack: pick('attack'),
        colorIndex: pick('colorIndex'),
        colorLow: pick('colorLow'),
        colorMid: pick('colorMid'),
        colorHigh: pick('colorHigh'),
        colorRed: pick('colorRed'),
        colorGreen: pick('colorGreen'),
        colorBlue: pick('colorBlue'),
        body: pick('body'),
        overviewHeight: pick('overviewHeight')
      }
      return { filePath: track.song.filePath, data }
    })
  )
}
