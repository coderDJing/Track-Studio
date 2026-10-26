import { BPM_INTERNAL_DECIMALS, formatBpmDisplay } from '@renderer/utils/bpm'
import { rendererFilePathKey } from '@renderer/utils/filePathComparison'

export const PREVIEW_WARMUP_DELAY_MS = 600
export const PREVIEW_WARMUP_EAGER_DELAY_MS = 0
export const PREVIEW_MAX_SAMPLES_PER_PIXEL = 180
export const PREVIEW_SHORTCUT_FALLBACK_BPM = 128
const PREVIEW_BPM_INTERNAL_DECIMALS = BPM_INTERNAL_DECIMALS
export const PREVIEW_BPM_STEP = 0.01
export const PREVIEW_BPM_MIN = 1
export const PREVIEW_BPM_MAX = 300
export const PREVIEW_SHORTCUT_BEATS = 4
export const PREVIEW_DOWNBEAT_BEAT_INTERVAL = 4
export const PREVIEW_BPM_TAP_RESET_MS = 5000
export const PREVIEW_BPM_TAP_MIN_DELTA_MS = 50
export const PREVIEW_BPM_TAP_MAX_DELTA_MS = 2000
export const PREVIEW_BPM_TAP_MAX_COUNT = 8

export const normalizePathKey = (value: unknown) =>
  rendererFilePathKey(typeof value === 'string' ? value : '')

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const normalizeBeatOffset = (value: number, interval: number) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

export const normalizePreviewBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return PREVIEW_SHORTCUT_FALLBACK_BPM
  const clamped = Math.max(PREVIEW_BPM_MIN, Math.min(PREVIEW_BPM_MAX, numeric))
  return Number(clamped.toFixed(PREVIEW_BPM_INTERNAL_DECIMALS))
}

export const formatPreviewBpm = (value: unknown) => formatBpmDisplay(normalizePreviewBpm(value))

export const parsePreviewBpmInput = (value: string) => {
  const normalized = String(value || '')
    .trim()
    .replace(',', '.')
  if (!normalized) return null
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return null
  const numeric = Number(normalized)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return normalizePreviewBpm(numeric)
}

export const isEditableEventTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase() || ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}
