import { onUnmounted } from 'vue'
export function usePlayerTransportButtons(
  emits: (
    event: 'pause' | 'play' | 'fastForward' | 'fastBackward' | 'nextSong' | 'previousSong'
  ) => void
) {
  const handlePause = () => {
    emits('pause')
  }

  const handlePlay = () => {
    emits('play')
  }

  let fastForwardInterval: NodeJS.Timeout
  const handleFastForwardMouseup = () => {
    clearInterval(fastForwardInterval)
    document.removeEventListener('mouseup', handleFastForwardMouseup)
  }
  const handleFastForward = () => {
    emits('fastForward')
    fastForwardInterval = setInterval(() => {
      emits('fastForward')
    }, 200)
    document.addEventListener('mouseup', handleFastForwardMouseup)
  }

  let fastBackwardInterval: NodeJS.Timeout
  const handleFastBackwardMouseup = () => {
    clearInterval(fastBackwardInterval)
    document.removeEventListener('mouseup', handleFastBackwardMouseup)
  }
  const handleFastBackward = () => {
    emits('fastBackward')
    fastBackwardInterval = setInterval(() => {
      emits('fastBackward')
    }, 200)
    document.addEventListener('mouseup', handleFastBackwardMouseup)
  }

  const handleNextSong = () => {
    emits('nextSong')
  }

  const handlePreviousSong = () => {
    emits('previousSong')
  }

  onUnmounted(() => {
    clearInterval(fastForwardInterval)
    clearInterval(fastBackwardInterval)
    document.removeEventListener('mouseup', handleFastForwardMouseup)
    document.removeEventListener('mouseup', handleFastBackwardMouseup)
  })

  return {
    handlePause,
    handlePlay,
    handleFastForward,
    handleFastBackward,
    handleNextSong,
    handlePreviousSong
  }
}
