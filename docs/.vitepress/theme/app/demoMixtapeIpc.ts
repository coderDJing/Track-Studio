// Mixtape 章节演示用的 IPC 数据：按主进程 mixtape:list 的返回格式给一个 4 首歌的 EQ 模式项目，
// 时间线、包络、静音段、Loop 都写在每首歌的 infoJson 里，由应用原版 parseSnapshot 解析。
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import { HERO_TRACKS, resolveHeroBarSec, resolveHeroDurationSec } from './demoTrackSpecs'
import { registerDemoIpcHandler } from './demoIpc'
import { demoSongFilePath } from './demoSongs'

export const DEMO_MIXTAPE_PLAYLIST_ID = 'demo-mixtape'

// 两首示范曲交替四次：A(0) → B → A → B，每首与上一首重叠 16 小节做过渡
const buildItems = () => {
  const [deckA, deckB] = HERO_TRACKS
  const order = [deckA, deckB, deckA, deckB]
  let startSec = 0
  return order.map((spec, index) => {
    const durationSec = resolveHeroDurationSec(spec)
    const overlapSec = resolveHeroBarSec(spec, 16)
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: spec.bpm,
      firstBeatMs: 0,
      downbeatBeatOffset: 0
    })
    const fadeIn = index > 0
    const fadeOut = index < order.length - 1
    // 音量包络：入场淡入、出场淡出（应用的包络点 gain 必须 > 0，最低用 0.0001 ≈ 静音）
    const SILENT = 0.0001
    const volumeEnvelope = [
      { sec: 0, gain: fadeIn ? SILENT : 1 },
      { sec: fadeIn ? overlapSec : 0.001, gain: 1 },
      { sec: fadeOut ? durationSec - overlapSec : durationSec - 0.001, gain: 1 },
      { sec: durationSec, gain: fadeOut ? SILENT : 1 }
    ]
    // 低频包络：过渡时先压住进场歌的低频，避免两个底鼓打架
    const lowEnvelope = fadeIn
      ? [
          { sec: 0, gain: 0.15 },
          { sec: overlapSec * 0.75, gain: 0.15 },
          { sec: overlapSec, gain: 1 },
          { sec: durationSec, gain: 1 }
        ]
      : undefined
    const info = {
      title: spec.title,
      artist: spec.artist,
      duration: `${Math.floor(durationSec / 60)}:${String(Math.round(durationSec % 60)).padStart(2, '0')}`,
      durationSec,
      key: spec.keyText,
      originalBpm: spec.bpm,
      gridBaseBpm: spec.bpm,
      masterTempo: true,
      startSec,
      laneIndex: index % 2,
      volumeEnvelope,
      lowEnvelope,
      volumeMuteSegments:
        index === 1
          ? [{ startSec: resolveHeroBarSec(spec, 40), endSec: resolveHeroBarSec(spec, 44) }]
          : undefined,
      loopSegments:
        index === 2
          ? [
              {
                startSec: resolveHeroBarSec(spec, 32),
                endSec: resolveHeroBarSec(spec, 36),
                repeatCount: 1
              }
            ]
          : undefined
    }
    startSec += durationSec - overlapSec
    return {
      id: `demo-mixtape-${index + 1}`,
      filePath: demoSongFilePath(spec),
      mixOrder: index + 1,
      originPlaylistUuid: null,
      originPathSnapshot: '精选库 / Peak Time',
      infoJson: JSON.stringify(info),
      canonicalGrid: { beatGridMap: beatGridMap ?? undefined, timeBasisOffsetMs: 0 }
    }
  })
}

// 时间线挂载后会预解码每首歌以便播放。示范曲是 .flac：应用判定可由浏览器直接解码，会 fetch
// frkb-preview:// 地址（官网没有这个协议，已在 demoIpc 的 fetch 替身里改指向静音 WAV）；
// 其他格式走 IPC 解码，这里按主进程返回格式给一段 0.1 秒静音 PCM
registerDemoIpcHandler('mixtape:decode-for-transport', () => {
  const sampleRate = 44100
  const totalFrames = Math.round(sampleRate * 0.1)
  return { pcmData: new Float32Array(totalFrames * 2), sampleRate, channels: 2, totalFrames }
})

registerDemoIpcHandler('mixtape:list', () => ({
  items: buildItems(),
  recovery: null,
  mixMode: 'eq',
  stemProfile: 'quality',
  stemSummary: null
}))
registerDemoIpcHandler('mixtape:project:get-bpm-envelope', () => null)
registerDemoIpcHandler('mixtape:project:get-mix-mode', () => ({ mixMode: 'eq' }))
