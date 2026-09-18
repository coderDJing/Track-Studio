import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { SongsAreaPaneKey } from '@renderer/stores/runtime'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { canPlayHtmlAudio } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import emitter from '@renderer/utils/mitt'
import {
  resumeTransportAfterWaveformPreview,
  suspendTransportForWaveformPreview
} from '@renderer/utils/exclusivePlayback'
import {
  MAIN_WINDOW_VOLUME_CHANGED_EVENT,
  MAIN_WINDOW_VOLUME_STORAGE_KEY,
  clampVolumeValue,
  readWindowVolume
} from '@renderer/utils/windowVolume'
import type { ISongInfo } from '../../../../../../types/globals'

interface AudioOutputSinkTarget {
  setSinkId?(deviceId: string): Promise<void>
}

type AudioElementWithExtensions = HTMLAudioElement & AudioOutputSinkTarget
type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext
type WindowWithAudioContext = Window & {
  AudioContext?: AudioContextConstructor
  webkitAudioContext?: AudioContextConstructor
}

type PreviewPlayPayload = {
  filePath?: string
  startPercent?: number
  song?: ISongInfo
  sourceLibraryName?: string
  sourceSongListUUID?: string
  sourcePane?: SongsAreaPaneKey | ''
}

type PreviewStopPayload = {
  reason?: string
  resumeMain?: boolean
}

type PreviewStopReason = 'explicit' | 'auto-finish' | 'manual-play' | 'switch' | 'cancel' | 'error'

type PauseMainPayload = {
  onPaused?: (wasPlaying: boolean) => void
}

type PreviewPlaybackMode = 'html' | 'pcm'

type PcmDecodePayload = {
  pcmData: unknown
  sampleRate: number
  channels: number
  totalFrames: number
}

const AUDIO_FOLLOW_SYSTEM_ID = ''
const FORCE_PCM_PREVIEW_EXTENSIONS = new Set(['aif', 'aiff'])
let waveformPreviewTransportSessionSequence = 0

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

const normalizeExtension = (filePath: string) => {
  const raw = (filePath || '').trim().toLowerCase()
  if (!raw) return ''
  const match = raw.match(/\.([a-z0-9]+)$/i)
  return match ? match[1] : ''
}

const shouldUsePcmPreview = (filePath: string) => {
  const ext = normalizeExtension(filePath)
  if (FORCE_PCM_PREVIEW_EXTENSIONS.has(ext)) return true
  return !canPlayHtmlAudio(filePath)
}

const normalizeStopReason = (reason?: string): PreviewStopReason => {
  switch (reason) {
    case 'explicit':
    case 'auto-finish':
    case 'manual-play':
    case 'switch':
    case 'error':
      return reason
    default:
      return 'cancel'
  }
}

const toPreviewUrl = (filePath: string) => {
  const raw = (filePath || '').trim()
  if (!raw) return ''
  if (raw.startsWith('frkb-preview://')) return raw
  return `frkb-preview://local/?path=${encodeURIComponent(raw)}`
}

const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (pcmData instanceof ArrayBuffer) return new Float32Array(pcmData)
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

export function useWaveformPreviewPlayer() {
  const runtime = useRuntimeStore()
  const previewActive = ref(false)
  const previewMode = ref<PreviewPlaybackMode>('html')
  const previewFilePath = ref('')
  const previewSong = ref<ISongInfo | null>(null)
  const previewSourceLibraryName = ref('')
  const previewSourceSongListUUID = ref('')
  const previewSourcePane = ref<SongsAreaPaneKey | ''>('')
  const resumeMainPlayer = ref(false)
  const pendingStartPercent = ref(0)
  const playToken = ref(0)
  const pcmFallbackToken = ref(-1)
  const audioElement = ref<AudioElementWithExtensions | null>(null)
  const activeSrc = ref('')
  const volumeValue = ref(0.8)
  let pendingOutputDeviceId = runtime.setting.audioOutputDeviceId || AUDIO_FOLLOW_SYSTEM_ID
  let progressRaf: number | null = null
  let stopping = false
  let transportSuspensionSessionId = ''
  let transportSuspensionPromise: Promise<void> | null = null

  let pcmContext: AudioContext | null = null
  let pcmGainNode: GainNode | null = null
  let pcmSourceNode: AudioBufferSourceNode | null = null
  let pcmBuffer: AudioBuffer | null = null
  let pcmBufferFilePath = ''
  let pcmStartTime = 0
  let pcmOffset = 0

  const stopPcmSource = (resetOffset = true) => {
    const source = pcmSourceNode
    if (source) {
      source.onended = null
      try {
        source.stop()
      } catch {}
      try {
        source.disconnect()
      } catch {}
      pcmSourceNode = null
    }
    if (resetOffset) {
      pcmOffset = 0
    }
  }

  const releasePcm = () => {
    stopPcmSource(true)
    pcmBuffer = null
    pcmBufferFilePath = ''
    if (pcmGainNode) {
      try {
        pcmGainNode.disconnect()
      } catch {}
    }
    pcmGainNode = null
    if (pcmContext) {
      try {
        void pcmContext.close()
      } catch {}
    }
    pcmContext = null
  }

  const ensurePcmContext = (sampleRate?: number): AudioContext | null => {
    const windowWithAudio = window as WindowWithAudioContext
    const AudioContextCtor = windowWithAudio.AudioContext || windowWithAudio.webkitAudioContext
    if (!AudioContextCtor) return null

    if (pcmContext) {
      if (sampleRate && pcmContext.sampleRate !== sampleRate) {
        releasePcm()
      } else {
        return pcmContext
      }
    }

    try {
      pcmContext = sampleRate ? new AudioContextCtor({ sampleRate }) : new AudioContextCtor()
      // 注册到全局列表，窗口关闭时可立即挂起所有 AudioContext
      const contexts = (window.__FRKB_AUDIO_CONTEXTS__ ??= [])
      contexts.push(pcmContext)
    } catch {
      pcmContext = null
      return null
    }

    if (!pcmContext) return null
    pcmGainNode = pcmContext.createGain()
    pcmGainNode.gain.value = volumeValue.value
    pcmGainNode.connect(pcmContext.destination)
    return pcmContext
  }

  const getPcmCurrentTime = () => {
    if (!pcmBuffer) return 0
    if (!pcmSourceNode || !pcmContext) return Math.max(0, pcmOffset)
    const current = pcmContext.currentTime - pcmStartTime
    const duration = Number.isFinite(pcmBuffer.duration) ? pcmBuffer.duration : 0
    if (duration <= 0) return Math.max(0, current)
    return Math.max(0, Math.min(duration, current))
  }

  const emitPreviewState = (active: boolean, filePath: string | null) => {
    emitter.emit('waveform-preview:state', {
      filePath: filePath || '',
      active,
      song: previewSong.value ? { ...previewSong.value } : null,
      sourceLibraryName: previewSourceLibraryName.value || '',
      sourceSongListUUID: previewSourceSongListUUID.value || '',
      sourcePane: previewSourcePane.value || ''
    })
  }

  const emitPreviewProgress = (currentTime?: number) => {
    if (!previewActive.value) return
    const filePath = previewFilePath.value
    if (!filePath) return

    let duration = 0
    let timeValue = 0

    if (previewMode.value === 'pcm') {
      duration = pcmBuffer && Number.isFinite(pcmBuffer.duration) ? pcmBuffer.duration : 0
      if (duration <= 0) return
      timeValue =
        typeof currentTime === 'number' && Number.isFinite(currentTime)
          ? currentTime
          : getPcmCurrentTime()
    } else {
      const audio = audioElement.value
      if (!audio) return
      duration = Number.isFinite(audio.duration) ? audio.duration : 0
      if (duration <= 0) return
      timeValue =
        typeof currentTime === 'number' && Number.isFinite(currentTime)
          ? currentTime
          : audio.currentTime
    }

    const percent = duration > 0 ? clamp01(timeValue / duration) : 0
    emitter.emit('waveform-preview:progress', {
      filePath,
      percent
    })
  }

  const stopProgressLoop = () => {
    if (progressRaf !== null) {
      cancelAnimationFrame(progressRaf)
      progressRaf = null
    }
  }

  const startProgressLoop = () => {
    stopProgressLoop()
    const loop = () => {
      const htmlPlaying = (() => {
        const audio = audioElement.value
        return !!audio && !audio.paused && !audio.ended
      })()
      const pcmPlaying = Boolean(pcmSourceNode)
      const isPlaying = previewMode.value === 'pcm' ? pcmPlaying : htmlPlaying
      if (!isPlaying) {
        progressRaf = null
        return
      }
      emitPreviewProgress()
      progressRaf = requestAnimationFrame(loop)
    }
    progressRaf = requestAnimationFrame(loop)
  }

  const applySavedVolume = () => {
    volumeValue.value = readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY)

    const audio = audioElement.value
    if (audio) {
      audio.volume = volumeValue.value
    }
    if (pcmGainNode) {
      pcmGainNode.gain.value = volumeValue.value
    }
  }

  const handleMainWindowVolumeChanged = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    volumeValue.value = clampVolumeValue(value)
    applySavedVolume()
  }

  const applyAudioOutputDevice = async (deviceId: string) => {
    pendingOutputDeviceId = deviceId || AUDIO_FOLLOW_SYSTEM_ID
    if (previewMode.value === 'pcm') return
    const audio = audioElement.value
    if (!audio) {
      return
    }
    const setSinkId = audio.setSinkId
    if (typeof setSinkId !== 'function') {
      return
    }
    try {
      await setSinkId.call(audio, pendingOutputDeviceId)
    } catch (error) {
      if (pendingOutputDeviceId !== AUDIO_FOLLOW_SYSTEM_ID) {
        pendingOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
        try {
          await setSinkId.call(audio, AUDIO_FOLLOW_SYSTEM_ID)
        } catch {}
      }
    }
  }

  const pauseMainPlayerIfNeeded = () => {
    resumeMainPlayer.value = false
    emitter.emit('waveform-preview:pause-main', {
      onPaused: (wasPlaying: boolean) => {
        resumeMainPlayer.value = wasPlaying
      }
    } satisfies PauseMainPayload)
  }

  const acquireTransportSuspension = () => {
    if (transportSuspensionPromise) return transportSuspensionPromise
    waveformPreviewTransportSessionSequence += 1
    transportSuspensionSessionId = `waveform-preview-${Date.now()}-${waveformPreviewTransportSessionSequence}`
    transportSuspensionPromise = suspendTransportForWaveformPreview(transportSuspensionSessionId)
    return transportSuspensionPromise
  }

  const releaseTransportSuspension = () => {
    const sessionId = transportSuspensionSessionId
    const suspensionPromise = transportSuspensionPromise
    transportSuspensionSessionId = ''
    transportSuspensionPromise = null
    if (!sessionId) return
    void (async () => {
      try {
        await suspensionPromise
      } catch {}
      try {
        await resumeTransportAfterWaveformPreview(sessionId)
      } catch {}
    })()
  }

  const stopWaveformPreview = (reason: PreviewStopReason, options?: { resumeMain?: boolean }) => {
    if (!previewActive.value || stopping) return
    stopping = true
    const filePath = previewFilePath.value
    previewActive.value = false
    previewMode.value = 'html'
    previewFilePath.value = ''
    pendingStartPercent.value = 0
    pcmFallbackToken.value = -1
    playToken.value += 1
    stopProgressLoop()

    const audio = audioElement.value
    if (audio) {
      audio.pause()
      try {
        audio.currentTime = 0
      } catch {}
      audio.muted = false
    }
    stopPcmSource(true)
    emitPreviewState(false, filePath || null)
    previewSong.value = null
    previewSourceLibraryName.value = ''
    previewSourceSongListUUID.value = ''
    previewSourcePane.value = ''
    releaseTransportSuspension()

    const shouldResume =
      resumeMainPlayer.value &&
      (options?.resumeMain === true || reason === 'explicit' || reason === 'auto-finish')
    resumeMainPlayer.value = false
    if (shouldResume) {
      emitter.emit('waveform-preview:resume-main')
    }
    stopping = false
  }

  const tryFallbackToPcmPreview = (filePath: string, startPercent: number, token: number) => {
    if (!filePath) {
      stopWaveformPreview('error')
      return
    }
    if (playToken.value !== token) return
    if (!previewActive.value || previewFilePath.value !== filePath) return
    if (previewMode.value !== 'html') return
    if (pcmFallbackToken.value === token) {
      stopWaveformPreview('error')
      return
    }
    pcmFallbackToken.value = token
    stopProgressLoop()
    void startPcmPreview(filePath, startPercent, token).catch(() => {
      if (playToken.value !== token) return
      if (!previewActive.value || previewFilePath.value !== filePath) return
      stopWaveformPreview('error')
    })
  }

  const ensureAudioElement = () => {
    if (!audioElement.value) {
      const audio = document.createElement('audio')
      audio.preload = 'auto'
      audio.addEventListener('play', () => {
        emitPreviewProgress()
        startProgressLoop()
      })
      audio.addEventListener('pause', () => {
        emitPreviewProgress()
        stopProgressLoop()
      })
      audio.addEventListener('timeupdate', () => emitPreviewProgress())
      audio.addEventListener('ended', () => stopWaveformPreview('auto-finish'))
      audio.addEventListener('error', () => {
        if (previewMode.value !== 'html') return
        const filePath = previewFilePath.value
        const startPercent = clamp01(pendingStartPercent.value)
        const token = playToken.value
        tryFallbackToPcmPreview(filePath, startPercent, token)
      })
      audioElement.value = audio
      if (!audio.parentNode && typeof document !== 'undefined') {
        audio.style.display = 'none'
        document.body.appendChild(audio)
      }
      applySavedVolume()
      void applyAudioOutputDevice(pendingOutputDeviceId)
    }
    return audioElement.value
  }

  const playFromPercent = (
    audio: HTMLAudioElement,
    token: number,
    filePath: string,
    startPercent: number
  ) => {
    if (playToken.value !== token) return
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0
    const startTime = duration > 0 ? duration * clamp01(startPercent) : 0
    try {
      if (typeof audio.fastSeek === 'function') {
        audio.fastSeek(startTime)
      } else {
        audio.currentTime = startTime
      }
    } catch {}
    if (audio.paused) {
      const playPromise = audio.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          if (playToken.value !== token) return
          tryFallbackToPcmPreview(filePath, startPercent, token)
        })
      }
    }
    emitPreviewProgress(startTime)
  }

  const decodePreviewPcmBuffer = async (filePath: string): Promise<AudioBuffer> => {
    const result = (await window.electron.ipcRenderer.invoke(
      'mixtape:decode-for-transport',
      filePath
    )) as PcmDecodePayload

    const pcmData = normalizePcmData(result?.pcmData)
    const sampleRate = Number(result?.sampleRate) || 44100
    const channels = Math.max(1, Number(result?.channels) || 1)
    const totalFrames = Number(result?.totalFrames) || 0
    const frameCount =
      totalFrames > 0
        ? Math.min(totalFrames, Math.floor(pcmData.length / channels))
        : Math.floor(pcmData.length / channels)

    if (!pcmData.length || frameCount <= 0) {
      throw new Error('preview pcm decode empty')
    }

    const ctx = ensurePcmContext(sampleRate)
    if (!ctx) {
      throw new Error('AudioContext unavailable')
    }

    const buffer = ctx.createBuffer(channels, frameCount, sampleRate)
    for (let channel = 0; channel < channels; channel++) {
      const channelData = buffer.getChannelData(channel)
      let readIndex = channel
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = pcmData[readIndex] || 0
        readIndex += channels
      }
    }
    return buffer
  }

  const startPcmPreview = async (filePath: string, startPercent: number, token: number) => {
    previewMode.value = 'pcm'

    const audio = ensureAudioElement()
    if (audio) {
      audio.pause()
      audio.muted = false
    }

    let buffer: AudioBuffer
    if (pcmBuffer && pcmBufferFilePath === filePath) {
      buffer = pcmBuffer
    } else {
      buffer = await decodePreviewPcmBuffer(filePath)
      if (playToken.value !== token || !previewActive.value || previewFilePath.value !== filePath) {
        return
      }
      pcmBuffer = buffer
      pcmBufferFilePath = filePath
    }

    const ctx = ensurePcmContext(buffer.sampleRate)
    if (!ctx) {
      throw new Error('AudioContext unavailable')
    }

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {}
    }

    if (playToken.value !== token || !previewActive.value || previewFilePath.value !== filePath) {
      return
    }

    stopPcmSource(false)

    const startTime = Math.max(
      0,
      (Number.isFinite(buffer.duration) ? buffer.duration : 0) * clamp01(startPercent)
    )
    const source = ctx.createBufferSource()
    source.buffer = buffer
    if (pcmGainNode) {
      source.connect(pcmGainNode)
    } else {
      source.connect(ctx.destination)
    }

    source.onended = () => {
      if (playToken.value !== token) return
      if (!previewActive.value || previewFilePath.value !== filePath) return
      stopWaveformPreview('auto-finish')
    }

    pcmSourceNode = source
    pcmOffset = startTime
    pcmStartTime = ctx.currentTime - startTime
    source.start(0, startTime)
    emitPreviewProgress(startTime)
    startProgressLoop()
  }

  const startWaveformPreviewAudio = (filePath: string, startPercent: number, token: number) => {
    if (playToken.value !== token) return
    if (!previewActive.value || previewFilePath.value !== filePath) return

    if (shouldUsePcmPreview(filePath)) {
      stopProgressLoop()
      void startPcmPreview(filePath, startPercent, token).catch(() => {
        if (playToken.value !== token) return
        if (!previewActive.value || previewFilePath.value !== filePath) return
        stopWaveformPreview('error')
      })
      return
    }

    stopPcmSource(true)
    const audio = ensureAudioElement()
    if (!audio) return
    applySavedVolume()

    const nextSrc = toPreviewUrl(filePath)
    if (!nextSrc) {
      stopWaveformPreview('error')
      return
    }

    if (activeSrc.value !== nextSrc) {
      audio.pause()
      audio.src = nextSrc
      audio.load()
      activeSrc.value = nextSrc
    } else {
      audio.pause()
    }

    const needsSeek = startPercent > 0.0001
    audio.muted = needsSeek ? true : false

    const playPromise = audio.play()
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        if (playToken.value !== token) return
        tryFallbackToPcmPreview(filePath, startPercent, token)
      })
    }

    if (!needsSeek) {
      emitPreviewProgress(0)
      return
    }

    const applySeek = () => {
      if (playToken.value !== token) return
      playFromPercent(audio, token, filePath, startPercent)
      audio.muted = false
    }

    if (audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) {
      applySeek()
      return
    }

    audio.addEventListener('loadedmetadata', applySeek, { once: true })
  }

  const startWaveformPreview = (payload: PreviewPlayPayload) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return

    const startPercent = clamp01(payload?.startPercent ?? 0)
    const wasPreviewActive = previewActive.value
    if (!wasPreviewActive) {
      pauseMainPlayerIfNeeded()
    }
    const suspensionPromise = wasPreviewActive
      ? transportSuspensionPromise || acquireTransportSuspension()
      : acquireTransportSuspension()
    previewActive.value = true
    previewMode.value = 'html'
    previewFilePath.value = filePath
    previewSong.value = payload?.song ? { ...payload.song } : null
    previewSourceLibraryName.value = String(payload?.sourceLibraryName || '').trim()
    previewSourceSongListUUID.value = String(payload?.sourceSongListUUID || '').trim()
    previewSourcePane.value =
      payload?.sourcePane === 'single' ||
      payload?.sourcePane === 'left' ||
      payload?.sourcePane === 'right'
        ? payload.sourcePane
        : ''
    pendingStartPercent.value = startPercent
    emitPreviewState(true, filePath)

    const token = playToken.value + 1
    playToken.value = token
    pcmFallbackToken.value = -1

    void suspensionPromise
      .then(() => startWaveformPreviewAudio(filePath, startPercent, token))
      .catch(() => {
        if (playToken.value !== token) return
        if (!previewActive.value || previewFilePath.value !== filePath) return
        stopWaveformPreview('error')
      })
  }

  const handlePreviewPlay = (payload: PreviewPlayPayload) => {
    startWaveformPreview(payload)
  }

  const handlePreviewStop = (payload?: PreviewStopPayload) => {
    const reason = normalizeStopReason(payload?.reason)
    stopWaveformPreview(reason, { resumeMain: payload?.resumeMain === true })
  }

  onMounted(() => {
    emitter.on('waveform-preview:play', handlePreviewPlay)
    emitter.on('waveform-preview:stop', handlePreviewStop)
    emitter.on(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeChanged)
  })

  watch(
    () => runtime.setting.audioOutputDeviceId,
    (newValue) => {
      const nextId = newValue || AUDIO_FOLLOW_SYSTEM_ID
      pendingOutputDeviceId = nextId
      void applyAudioOutputDevice(nextId)
    },
    { immediate: true }
  )

  watch(
    () => runtime.songsArea.songListUUID,
    (nextValue, prevValue) => {
      if (nextValue === prevValue) return
      if (!previewActive.value) return
      stopWaveformPreview('switch')
    }
  )

  onUnmounted(() => {
    emitter.off('waveform-preview:play', handlePreviewPlay)
    emitter.off('waveform-preview:stop', handlePreviewStop)
    emitter.off(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeChanged)
    stopWaveformPreview('cancel')
    stopProgressLoop()
    releasePcm()
    if (audioElement.value) {
      audioElement.value.pause()
      audioElement.value.src = ''
      audioElement.value.load()
      if (audioElement.value.parentNode) {
        audioElement.value.parentNode.removeChild(audioElement.value)
      }
      audioElement.value = null
    }
  })
}
