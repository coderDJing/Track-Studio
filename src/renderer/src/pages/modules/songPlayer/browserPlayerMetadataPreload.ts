import {
  canPlayHtmlAudio,
  toPreviewUrl,
  type AudioElementWithExtensions
} from './webAudioPlayer.shared'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

type MetadataPreloadEntry = {
  filePath: string
  src: string
  audio: AudioElementWithExtensions
  ready: boolean
  cleanup: () => void
}

type MetadataPreloadHit = {
  audio: AudioElementWithExtensions
  src: string
}

type MetadataPreloadOptions = {
  reason?: string
}

type PendingMetadataPreload = {
  key: string
  filePath: string
}

const MAX_METADATA_PRELOADS = 2
const MAX_ACTIVE_METADATA_PRELOADS = 1

const normalizePathKey = (value: string) =>
  normalizeFilePathForComparison(value, isCurrentRendererWindowsPathPlatform())

const createHiddenAudio = (): AudioElementWithExtensions => {
  const audio = document.createElement('audio') as AudioElementWithExtensions
  audio.preload = 'metadata'
  audio.autoplay = false
  audio.muted = true
  audio.crossOrigin = 'anonymous'
  audio.volume = 0
  audio.setAttribute('playsinline', 'true')
  audio.style.display = 'none'
  document.body.appendChild(audio)
  return audio
}

const releaseEntry = (entry: MetadataPreloadEntry, clearSrc = true) => {
  entry.cleanup()
  try {
    entry.audio.pause()
  } catch {}
  if (clearSrc) {
    try {
      entry.audio.src = ''
      entry.audio.load()
    } catch {}
  }
  if (entry.audio.parentNode) {
    try {
      entry.audio.parentNode.removeChild(entry.audio)
    } catch {}
  }
}

export const createBrowserPlayerMetadataPreloadPool = () => {
  const entries = new Map<string, MetadataPreloadEntry>()
  let pendingPreloads: PendingMetadataPreload[] = []
  let blockedUntil = 0
  let blockedTimer: number | null = null

  const clearBlockedTimer = () => {
    if (blockedTimer === null) return
    window.clearTimeout(blockedTimer)
    blockedTimer = null
  }

  const releaseByKey = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    releaseEntry(entry)
  }

  const hasActivePreload = () => {
    let active = 0
    for (const entry of entries.values()) {
      if (!entry.ready) active += 1
      if (active >= MAX_ACTIVE_METADATA_PRELOADS) return true
    }
    return false
  }

  const scheduleNextPendingPreload = () => {
    clearBlockedTimer()
    const waitMs = blockedUntil - performance.now()
    if (waitMs > 0) {
      blockedTimer = window.setTimeout(() => {
        blockedTimer = null
        startNextPendingPreload()
      }, waitMs)
      return
    }
    startNextPendingPreload()
  }

  const startNextPendingPreload = () => {
    clearBlockedTimer()
    const waitMs = blockedUntil - performance.now()
    if (waitMs > 0) {
      blockedTimer = window.setTimeout(() => {
        blockedTimer = null
        startNextPendingPreload()
      }, waitMs)
      return
    }
    if (hasActivePreload()) return
    const next = pendingPreloads.shift()
    if (!next) return
    if (entries.has(next.key)) {
      startNextPendingPreload()
      return
    }

    const { key, filePath } = next

    const audio = createHiddenAudio()
    const src = toPreviewUrl(filePath)
    const entry: MetadataPreloadEntry = {
      filePath,
      src,
      audio,
      ready: false,
      cleanup: () => {}
    }

    const onLoadedMetadata = () => {
      if (entry.ready) return
      entry.ready = true
      scheduleNextPendingPreload()
    }
    const onError = () => {
      releaseByKey(key)
      scheduleNextPendingPreload()
    }

    entry.cleanup = () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('error', onError)
    }
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('error', onError)
    entries.set(key, entry)

    try {
      audio.src = src
      audio.load()
      if (audio.readyState >= 1) onLoadedMetadata()
    } catch {
      releaseByKey(key)
      scheduleNextPendingPreload()
    }
  }

  const preload = (filePaths: string[], _options: MetadataPreloadOptions = {}) => {
    const nextPaths = Array.from(
      new Map(
        filePaths
          .map((filePath) => String(filePath || '').trim())
          .filter((filePath) => filePath && canPlayHtmlAudio(filePath))
          .map((filePath) => [normalizePathKey(filePath), filePath])
      ).entries()
    ).slice(0, MAX_METADATA_PRELOADS)
    const nextKeys = new Set(nextPaths.map(([key]) => key))

    for (const key of Array.from(entries.keys())) {
      if (!nextKeys.has(key)) releaseByKey(key)
    }

    pendingPreloads = pendingPreloads.filter((pending) => nextKeys.has(pending.key))

    for (const [key, filePath] of nextPaths) {
      const alreadyPending = pendingPreloads.some((pending) => pending.key === key)
      if (entries.has(key) || alreadyPending) continue
      pendingPreloads.push({ key, filePath })
    }

    scheduleNextPendingPreload()
  }

  const take = (filePath: string): MetadataPreloadHit | null => {
    const key = normalizePathKey(filePath)
    const entry = entries.get(key)
    if (!entry) return null
    entries.delete(key)
    if (!entry.ready || entry.audio.readyState < 1) {
      releaseEntry(entry)
      scheduleNextPendingPreload()
      return null
    }
    entry.cleanup()
    if (entry.audio.parentNode) {
      try {
        entry.audio.parentNode.removeChild(entry.audio)
      } catch {}
    }
    return {
      audio: entry.audio,
      src: entry.src
    }
  }

  const clear = (_options?: unknown) => {
    pendingPreloads = []
    clearBlockedTimer()
    for (const key of Array.from(entries.keys())) {
      releaseByKey(key)
    }
  }

  const defer = (durationMs: number, _options?: unknown) => {
    const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    if (safeDurationMs <= 0) return
    blockedUntil = Math.max(blockedUntil, performance.now() + safeDurationMs)
    if (pendingPreloads.length > 0) {
      scheduleNextPendingPreload()
    }
  }

  return {
    preload,
    take,
    clear,
    defer
  }
}
