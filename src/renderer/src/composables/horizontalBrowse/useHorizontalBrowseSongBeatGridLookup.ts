import { computed } from 'vue'
import {
  createSongBeatGridRuntimeV2,
  resolveSongBeatGridV2RuntimeClipAtSec
} from '@shared/songBeatGridMapV2'

export const useHorizontalBrowseSongBeatGridLookup = (params: {
  beatGridMap: () => unknown
  durationSeconds: () => unknown
}) => {
  // 构建过程读取网格内部字段，Vue 会同时跟踪替换和原地编辑；播放时间不参与构建。
  const runtime = computed(() =>
    createSongBeatGridRuntimeV2(params.beatGridMap(), params.durationSeconds())
  )

  const resolveBpmAtSeconds = (seconds: number): number | null =>
    resolveSongBeatGridV2RuntimeClipAtSec(runtime.value, seconds)?.bpm ?? null

  return { runtime, resolveBpmAtSeconds }
}
