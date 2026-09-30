// 首页双轨演示用的两首合成示范曲目。
// 同一份定义既给 scripts/build_docs_hero_waveforms.ts 合成音频，也给页面画结构条和 Cue，
// 保证波形里的段落、Hot Cue 与信息卡完全对得上。

export type HeroStructureKind = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown' | 'outro'

export type HeroLayer =
  | 'kick'
  | 'hat8'
  | 'hat16'
  | 'clap'
  | 'bassRoll'
  | 'bassOffbeat'
  | 'pad'
  | 'stabs'
  | 'riser'
  | 'roll'

export type HeroSectionSpec = {
  kind: HeroStructureKind
  startBar: number
  endBar: number
  layers: HeroLayer[]
}

export type HeroTrackSpec = {
  id: string
  title: string
  artist: string
  bpm: number
  bars: number
  keyText: string
  energy: number
  seed: number
  bassHz: number
  chordHz: number[]
  sections: HeroSectionSpec[]
  hotCueBars: number[]
  memoryCueBars: number[]
  startBar: number
}

export const HERO_BEATS_PER_BAR = 4

export const HERO_TRACKS: HeroTrackSpec[] = [
  {
    id: 'deck-a',
    title: 'Night Shift',
    artist: 'Track Studio Demo',
    bpm: 128,
    bars: 64,
    keyText: 'Am',
    energy: 84,
    seed: 20260930,
    bassHz: 55,
    chordHz: [220, 261.63, 329.63],
    sections: [
      { kind: 'intro', startBar: 0, endBar: 8, layers: ['kick', 'hat8'] },
      { kind: 'groove', startBar: 8, endBar: 16, layers: ['kick', 'hat16', 'bassRoll', 'clap'] },
      {
        kind: 'build',
        startBar: 16,
        endBar: 22,
        layers: ['kick', 'hat16', 'clap', 'riser', 'roll']
      },
      { kind: 'build', startBar: 22, endBar: 24, layers: ['hat16', 'riser', 'roll'] },
      {
        kind: 'drop',
        startBar: 24,
        endBar: 32,
        layers: ['kick', 'hat16', 'bassRoll', 'clap', 'stabs', 'pad']
      },
      {
        kind: 'drop',
        startBar: 32,
        endBar: 40,
        layers: ['kick', 'hat16', 'bassRoll', 'clap', 'stabs']
      },
      { kind: 'breakdown', startBar: 40, endBar: 48, layers: ['pad', 'riser'] },
      {
        kind: 'drop',
        startBar: 48,
        endBar: 60,
        layers: ['kick', 'hat16', 'bassRoll', 'clap', 'stabs', 'pad']
      },
      { kind: 'outro', startBar: 60, endBar: 64, layers: ['kick', 'hat8'] }
    ],
    hotCueBars: [0, 8, 24, 40, 48],
    memoryCueBars: [16, 60],
    startBar: 21
  },
  {
    id: 'deck-b',
    title: 'Lowlight',
    artist: 'Track Studio Demo',
    bpm: 128,
    bars: 64,
    keyText: 'Em',
    energy: 78,
    seed: 20261001,
    bassHz: 41.2,
    chordHz: [164.81, 196, 246.94],
    sections: [
      { kind: 'intro', startBar: 0, endBar: 8, layers: ['kick', 'hat8'] },
      { kind: 'intro', startBar: 8, endBar: 16, layers: ['kick', 'hat16'] },
      {
        kind: 'groove',
        startBar: 16,
        endBar: 32,
        layers: ['kick', 'hat16', 'bassOffbeat', 'clap', 'pad']
      },
      { kind: 'breakdown', startBar: 32, endBar: 40, layers: ['pad', 'stabs'] },
      { kind: 'build', startBar: 40, endBar: 44, layers: ['pad', 'riser', 'roll'] },
      {
        kind: 'drop',
        startBar: 44,
        endBar: 52,
        layers: ['kick', 'hat16', 'bassOffbeat', 'clap', 'stabs']
      },
      {
        kind: 'drop',
        startBar: 52,
        endBar: 60,
        layers: ['kick', 'hat16', 'bassOffbeat', 'clap', 'stabs', 'pad']
      },
      { kind: 'outro', startBar: 60, endBar: 64, layers: ['kick', 'hat8'] }
    ],
    hotCueBars: [0, 16, 44],
    memoryCueBars: [32, 40, 60],
    startBar: 13
  }
]

// 歌曲列表、播放器等小尺寸界面用的示范曲目：只生成整曲预览波形，不需要 Cue
export type ListTrackSpec = HeroTrackSpec & {
  album: string
  durationText: string
  format: string
}

const listTrack = (
  id: string,
  title: string,
  artist: string,
  album: string,
  bpm: number,
  keyText: string,
  energy: number,
  seed: number,
  bassHz: number,
  sections: HeroSectionSpec[],
  format = 'FLAC'
): ListTrackSpec => {
  const bars = sections[sections.length - 1].endBar
  const seconds = Math.round(bars * HERO_BEATS_PER_BAR * (60 / bpm))
  return {
    id,
    title,
    artist,
    album,
    bpm,
    bars,
    keyText,
    energy,
    seed,
    bassHz,
    chordHz: [bassHz * 4, bassHz * 4 * 1.189, bassHz * 4 * 1.498],
    sections,
    hotCueBars: [],
    memoryCueBars: [],
    startBar: 0,
    durationText: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    format
  }
}

const S = (
  kind: HeroStructureKind,
  startBar: number,
  endBar: number,
  layers: HeroLayer[]
): HeroSectionSpec => ({ kind, startBar, endBar, layers })

const FULL: HeroLayer[] = ['kick', 'hat16', 'bassRoll', 'clap', 'stabs']
const ROLL: HeroLayer[] = ['kick', 'hat16', 'bassOffbeat', 'clap', 'pad']

export const LIST_TRACKS: ListTrackSpec[] = [
  listTrack('list-01', 'Afterglow', 'Mira Vale', 'Night Transit', 124, 'Fm', 71, 101, 43.65, [
    S('intro', 0, 16, ['kick', 'hat8']),
    S('groove', 16, 48, ROLL),
    S('breakdown', 48, 64, ['pad']),
    S('drop', 64, 96, FULL),
    S('outro', 96, 112, ['kick', 'hat8'])
  ]),
  listTrack(
    'list-02',
    'Concrete Bloom',
    'Hollow Signal',
    'Concrete Bloom EP',
    126,
    'Gm',
    82,
    102,
    49,
    [
      S('intro', 0, 8, ['kick', 'hat16']),
      S('build', 8, 16, ['hat16', 'riser', 'roll']),
      S('drop', 16, 48, FULL),
      S('breakdown', 48, 56, ['pad', 'riser']),
      S('drop', 56, 88, FULL),
      S('outro', 88, 96, ['kick'])
    ]
  ),
  listTrack('list-03', 'Parallel Lines', 'Kaito Ren', 'Parallel', 128, 'Am', 88, 103, 55, [
    S('intro', 0, 16, ['kick', 'hat16', 'clap']),
    S('drop', 16, 56, FULL),
    S('breakdown', 56, 64, ['stabs']),
    S('drop', 64, 104, FULL),
    S('outro', 104, 112, ['kick', 'hat8'])
  ]),
  listTrack(
    'list-04',
    'Slow Orbit',
    'Nadia Frost',
    'Weightless',
    122,
    'Dm',
    58,
    104,
    36.71,
    [
      S('intro', 0, 16, ['pad']),
      S('groove', 16, 64, ['kick', 'hat8', 'bassOffbeat', 'pad']),
      S('breakdown', 64, 80, ['pad', 'stabs']),
      S('groove', 80, 112, ['kick', 'hat8', 'bassOffbeat', 'pad']),
      S('outro', 112, 120, ['pad'])
    ],
    'WAV'
  ),
  listTrack(
    'list-05',
    'Red Room',
    'Hollow Signal',
    'Red Room',
    130,
    'Cm',
    91,
    105,
    65.41,
    [
      S('intro', 0, 8, ['kick', 'hat16']),
      S('drop', 8, 40, FULL),
      S('build', 40, 48, ['hat16', 'riser', 'roll']),
      S('drop', 48, 88, FULL),
      S('outro', 88, 96, ['kick', 'hat16'])
    ],
    'MP3'
  ),
  listTrack(
    'list-06',
    'Tidal',
    'Sora Kim',
    'Tidal',
    125,
    'Ebm',
    76,
    106,
    38.89,
    [
      S('intro', 0, 16, ['kick', 'hat8']),
      S('groove', 16, 40, ROLL),
      S('build', 40, 48, ['pad', 'riser', 'roll']),
      S('drop', 48, 80, FULL),
      S('outro', 80, 96, ['kick', 'hat8'])
    ],
    'AIFF'
  ),
  listTrack('list-07', 'Glass Hours', 'Mira Vale', 'Night Transit', 124, 'Bbm', 64, 107, 58.27, [
    S('intro', 0, 16, ['kick', 'hat8', 'pad']),
    S('groove', 16, 56, ROLL),
    S('breakdown', 56, 72, ['pad']),
    S('groove', 72, 104, ROLL),
    S('outro', 104, 112, ['kick', 'pad'])
  ]),
  listTrack(
    'list-08',
    'Pressure Drop',
    'Kaito Ren',
    'Pressure',
    128,
    'F#m',
    86,
    108,
    46.25,
    [
      S('intro', 0, 8, ['kick']),
      S('build', 8, 16, ['kick', 'hat16', 'riser']),
      S('drop', 16, 48, FULL),
      S('breakdown', 48, 64, ['pad', 'riser']),
      S('drop', 64, 96, FULL),
      S('outro', 96, 104, ['kick', 'hat8'])
    ],
    'MP3'
  )
]

export const resolveHeroBeatSec = (spec: HeroTrackSpec) => 60 / spec.bpm

export const resolveHeroBarSec = (spec: HeroTrackSpec, bar: number) =>
  bar * HERO_BEATS_PER_BAR * resolveHeroBeatSec(spec)

export const resolveHeroDurationSec = (spec: HeroTrackSpec) => resolveHeroBarSec(spec, spec.bars)
