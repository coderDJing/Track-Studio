import type { BpmFixSummary } from '../../shared/bpmFix'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export const readBpmFixSummary = (value: unknown): BpmFixSummary => {
  if (!isRecord(value) || !isRecord(value.verification) || value.verification.passed !== true) {
    throw new Error('BPM_FIX_INVALID_RESULT')
  }
  const number = (record: Record<string, unknown>, key: string) => {
    const field = record[key]
    if (typeof field !== 'number' || !Number.isFinite(field)) {
      throw new Error('BPM_FIX_INVALID_RESULT')
    }
    return field
  }
  return {
    sourceBpm: number(value, 'sourceBpm'),
    targetBpm: number(value, 'targetBpm'),
    gridOffsetSec: number(value, 'gridOffsetSec'),
    confidence: number(value, 'confidence'),
    durationInSec: number(value, 'durationInSec'),
    durationOutSec: number(value, 'durationOutSec'),
    noticeableSegments: number(value, 'noticeableSegments'),
    peakGain: number(value, 'peakGain'),
    verification: {
      passed: true,
      detectedBpm: number(value.verification, 'detectedBpm'),
      bpmError: number(value.verification, 'bpmError'),
      gridRmsMs: number(value.verification, 'gridRmsMs'),
      offGridBeats: number(value.verification, 'offGridBeats')
    }
  }
}
