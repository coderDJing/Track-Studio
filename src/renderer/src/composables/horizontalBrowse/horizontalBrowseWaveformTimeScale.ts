// 两轨共享实际播放时间标尺：可见源音频时长随播放倍率变化，抵消时钟的快慢。
// BPM 只决定节拍线的位置；相同实际 BPM 的两轨自然得到相同拍宽。
export const resolveHorizontalBrowseWaveformTimeScale = (playbackRate: unknown) => {
  const rate = Number(playbackRate)
  if (!Number.isFinite(rate) || rate <= 0) return 1
  return Math.max(0.25, rate)
}
