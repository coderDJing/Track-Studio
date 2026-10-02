export const SONG_BEAT_GRID_MAP_V2_VERSION = 2
export const SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL = 4

const SIGNATURE_HASH_OFFSET = 2166136261
const SIGNATURE_HASH_PRIME = 16777619
const SECONDS_DECIMALS = 6
const BPM_DECIMALS = 6
const BPM_DISPLAY_DECIMALS = 2
const BPM_DISPLAY_SCALE = 10 ** BPM_DISPLAY_DECIMALS
const PHASE_EPSILON_BEATS = 0.0001
const LINE_EPSILON_SEC = 0.000001

export type SongBeatGridV2Source = 'analysis' | 'manual' | 'rekordbox' | 'serato' | 'traktor'

export type SongBeatGridClipV2 = {
  startSec: number
  anchorSec: number
  bpm: number
  downbeatBeatOffset: number
}

export type SongBeatGridMapV2 = {
  version: typeof SONG_BEAT_GRID_MAP_V2_VERSION
  source: SongBeatGridV2Source
  clips: SongBeatGridClipV2[]
  signature: string
}

export type SongBeatGridFixedProjectionV2 = {
  bpm: number
  firstBeatMs: number
  downbeatBeatOffset: number
}

export type RekordboxBeatGridEntry = {
  timeMs: number
  bpm: number
  beatNumber: number
}

export type SongBeatGridBpmSummaryV2 = {
  displayText: string
  titleText: string
  values: number[]
  minimumBpm: number | null
  isDynamic: boolean
}

export type SongBeatGridLineLevelV2 = 'downbeat' | 'beat'

export type SongBeatGridLineV2 = {
  sec: number
  clipIndex: number
  beatOrdinal: number
  clipBeatIndex: number
  bpm: number
  level: SongBeatGridLineLevelV2
}

export type SongBeatGridRuntimeClipV2 = SongBeatGridClipV2 & {
  index: number
  endSec: number
  beatSec: number
  firstBeatIndex: number
  lastBeatIndex: number
  firstBeatOrdinal: number
  lineCount: number
}

export type SongBeatGridRuntimeV2 = {
  map: SongBeatGridMapV2
  signature: string
  durationSec: number
  clips: SongBeatGridRuntimeClipV2[]
  lines: SongBeatGridLineV2[]
  clipBoundaries: number[]
}

export type NormalizeSongBeatGridMapV2Options = {
  durationSec?: number
  allowSingleClip?: boolean
  mergeContinuousClips?: boolean
}

const normalizeSecond = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Number(numeric.toFixed(SECONDS_DECIMALS))
}

const normalizeStartSec = (value: unknown): number | null => {
  const normalized = normalizeSecond(value)
  if (normalized === null || normalized < 0) return null
  return Object.is(normalized, -0) ? 0 : normalized
}

export const normalizeSongBeatGridV2Bpm = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Number(numeric.toFixed(BPM_DECIMALS))
}

export const normalizeSongBeatGridV2BpmDisplayScaled = (value: unknown): number | null => {
  const bpm = normalizeSongBeatGridV2Bpm(value)
  if (bpm === null) return null
  return Math.round(bpm * BPM_DISPLAY_SCALE)
}

const formatSongBeatGridV2BpmDisplay = (value: unknown, fallback = 'N/A') => {
  const scaled = normalizeSongBeatGridV2BpmDisplayScaled(value)
  if (scaled === null) return fallback
  return String(Number((scaled / BPM_DISPLAY_SCALE).toFixed(BPM_DISPLAY_DECIMALS)))
}

export const normalizeSongBeatGridDownbeatBeatOffset = (value: unknown): number | null => {
  const numeric = Number(value)
  if (
    !Number.isInteger(numeric) ||
    numeric < 0 ||
    numeric >= SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL
  ) {
    return null
  }
  return numeric
}

const normalizeClip = (value: unknown): SongBeatGridClipV2 | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const startSec = normalizeStartSec(record.startSec)
  const anchorSec = normalizeSecond(record.anchorSec)
  const bpm = normalizeSongBeatGridV2Bpm(record.bpm)
  const downbeatBeatOffset = normalizeSongBeatGridDownbeatBeatOffset(record.downbeatBeatOffset)
  if (startSec === null || anchorSec === null || bpm === null || downbeatBeatOffset === null)
    return null
  return { startSec, anchorSec, bpm, downbeatBeatOffset }
}

const areClipPhasesContinuous = (left: SongBeatGridClipV2, right: SongBeatGridClipV2): boolean => {
  if (Math.abs(left.bpm - right.bpm) > 0.000001) return false
  if (left.downbeatBeatOffset !== right.downbeatBeatOffset) return false
  const beatSec = 60 / left.bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return false
  const leftBeat = (right.startSec - left.anchorSec) / beatSec
  const rightBeat = (right.startSec - right.anchorSec) / beatSec
  return (
    Math.abs(Math.abs(leftBeat - rightBeat) - Math.round(Math.abs(leftBeat - rightBeat))) <=
    PHASE_EPSILON_BEATS
  )
}

const normalizeClips = (
  rawClips: unknown,
  options: NormalizeSongBeatGridMapV2Options
): SongBeatGridClipV2[] | null => {
  if (!Array.isArray(rawClips)) return null
  const durationSec =
    typeof options.durationSec === 'number' && Number.isFinite(options.durationSec)
      ? Math.max(0, options.durationSec)
      : null
  const clips = rawClips.map(normalizeClip)
  if (clips.some((clip) => clip === null)) return null
  const sorted = (clips as SongBeatGridClipV2[]).sort(
    (left, right) => left.startSec - right.startSec
  )
  if (!sorted.length || Math.abs(sorted[0].startSec) > LINE_EPSILON_SEC) return null
  sorted[0] = { ...sorted[0], startSec: 0 }
  for (let index = 1; index < sorted.length; index += 1) {
    const clip = sorted[index]
    if (clip.startSec <= sorted[index - 1].startSec || clip.startSec <= 0) return null
    if (durationSec !== null && durationSec > 0 && clip.startSec >= durationSec) return null
  }
  const normalized = options.mergeContinuousClips
    ? sorted.reduce<SongBeatGridClipV2[]>((merged, clip) => {
        const previous = merged[merged.length - 1]
        if (!previous || !areClipPhasesContinuous(previous, clip)) merged.push(clip)
        return merged
      }, [])
    : sorted
  return !options.allowSingleClip && normalized.length < 2 ? null : normalized
}

const buildSignaturePayload = (clips: readonly SongBeatGridClipV2[]) =>
  clips
    .map((clip) =>
      [
        clip.startSec.toFixed(SECONDS_DECIMALS),
        clip.anchorSec.toFixed(SECONDS_DECIMALS),
        clip.bpm.toFixed(BPM_DECIMALS),
        String(clip.downbeatBeatOffset)
      ].join(',')
    )
    .join('|')

const calculateSongBeatGridMapV2Signature = (clips: readonly SongBeatGridClipV2[]): string => {
  const payload = `v${SONG_BEAT_GRID_MAP_V2_VERSION}:${buildSignaturePayload(clips)}`
  let hash = SIGNATURE_HASH_OFFSET
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index)
    hash = Math.imul(hash, SIGNATURE_HASH_PRIME)
  }
  return `sbgm_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export const normalizeSongBeatGridMapV2 = (
  value: unknown,
  options: NormalizeSongBeatGridMapV2Options = {}
): SongBeatGridMapV2 | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.version !== SONG_BEAT_GRID_MAP_V2_VERSION ||
    (record.source !== 'analysis' &&
      record.source !== 'manual' &&
      record.source !== 'rekordbox' &&
      record.source !== 'serato' &&
      record.source !== 'traktor')
  ) {
    return null
  }
  const clips = normalizeClips(record.clips, options)
  if (!clips) return null
  return {
    version: SONG_BEAT_GRID_MAP_V2_VERSION,
    source: record.source,
    clips,
    signature: calculateSongBeatGridMapV2Signature(clips)
  }
}

export const createSongBeatGridMapV2FromClips = (
  clips: readonly SongBeatGridClipV2[],
  source: SongBeatGridV2Source,
  options: NormalizeSongBeatGridMapV2Options = {}
): SongBeatGridMapV2 | null =>
  normalizeSongBeatGridMapV2({ version: SONG_BEAT_GRID_MAP_V2_VERSION, source, clips }, options)

const REKORDBOX_GRID_CONTINUITY_TOLERANCE_SEC = 0.003

const isRekordboxGridEntryContinuousWithPrevious = (
  previous: RekordboxBeatGridEntry,
  current: RekordboxBeatGridEntry
) => {
  if (Math.abs(previous.bpm - current.bpm) > 0.000001) return false
  if (current.beatNumber !== (previous.beatNumber % SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL) + 1)
    return false
  const expectedTimeMs = previous.timeMs + 60_000 / previous.bpm
  return Math.abs(current.timeMs - expectedTimeMs) <= REKORDBOX_GRID_CONTINUITY_TOLERANCE_SEC * 1000
}

// PQTZ 给出的是每一拍的真值。这里仅合并连续拍为渲染所需的 tempo clip，绝不重新分析或改写真值。
export const createSongBeatGridMapV2FromRekordboxEntries = (
  entries: readonly RekordboxBeatGridEntry[]
): SongBeatGridMapV2 | null => {
  if (!entries.length) return null
  const first = entries[0]
  const clips: SongBeatGridClipV2[] = [
    {
      startSec: 0,
      anchorSec: first.timeMs / 1000,
      bpm: first.bpm,
      downbeatBeatOffset:
        (SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL + 1 - first.beatNumber) %
        SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL
    }
  ]
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]
    const current = entries[index]
    if (isRekordboxGridEntryContinuousWithPrevious(previous, current)) continue
    clips.push({
      startSec: current.timeMs / 1000,
      anchorSec: current.timeMs / 1000,
      bpm: current.bpm,
      downbeatBeatOffset:
        (SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL + 1 - current.beatNumber) %
        SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL
    })
  }
  return createSongBeatGridMapV2FromClips(clips, 'rekordbox', { allowSingleClip: true })
}

export const createSongBeatGridMapV2FromFixedGrid = (input: {
  bpm?: unknown
  firstBeatMs?: unknown
  downbeatBeatOffset?: unknown
  source?: SongBeatGridV2Source
}): SongBeatGridMapV2 | null => {
  const bpm = normalizeSongBeatGridV2Bpm(input.bpm)
  const firstBeatSec = normalizeSecond((Number(input.firstBeatMs) || 0) / 1000)
  const downbeatBeatOffset = normalizeSongBeatGridDownbeatBeatOffset(input.downbeatBeatOffset)
  if (bpm === null || firstBeatSec === null || downbeatBeatOffset === null) return null
  return createSongBeatGridMapV2FromClips(
    [{ startSec: 0, anchorSec: firstBeatSec, bpm, downbeatBeatOffset }],
    input.source || 'analysis',
    { allowSingleClip: true }
  )
}

export const projectSongBeatGridMapV2ToFixedGrid = (
  value: unknown
): SongBeatGridFixedProjectionV2 | null => {
  const map = normalizeSongBeatGridMapV2(value, { allowSingleClip: true })
  const firstClip = map?.clips[0]
  if (!firstClip) return null
  const beatSec = 60 / firstClip.bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return null
  const firstBeatSec =
    firstClip.anchorSec + Math.ceil((0 - firstClip.anchorSec) / beatSec) * beatSec
  return {
    bpm: firstClip.bpm,
    firstBeatMs: Number((Math.max(0, firstBeatSec) * 1000).toFixed(3)),
    downbeatBeatOffset: firstClip.downbeatBeatOffset
  }
}

const roundSec = (value: number): number => Number(value.toFixed(SECONDS_DECIMALS))

const createRuntimeClip = (
  clip: SongBeatGridClipV2,
  index: number,
  endSec: number,
  firstBeatOrdinal: number
): SongBeatGridRuntimeClipV2 | null => {
  const beatSec = 60 / clip.bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0 || endSec <= clip.startSec) return null
  const firstBeatIndex = Math.ceil((clip.startSec - clip.anchorSec - LINE_EPSILON_SEC) / beatSec)
  const lastBeatIndex = Math.floor((endSec - clip.anchorSec - LINE_EPSILON_SEC) / beatSec)
  return {
    ...clip,
    index,
    endSec,
    beatSec,
    firstBeatIndex,
    lastBeatIndex,
    firstBeatOrdinal,
    lineCount: Math.max(0, lastBeatIndex - firstBeatIndex + 1)
  }
}

const resolveLineLevel = (
  clipBeatIndex: number,
  downbeatBeatOffset: number
): SongBeatGridLineLevelV2 =>
  (clipBeatIndex - downbeatBeatOffset) % SONG_BEAT_GRID_DOWNBEAT_BEAT_INTERVAL === 0
    ? 'downbeat'
    : 'beat'

export const createSongBeatGridRuntimeV2 = (
  value: unknown,
  durationSecInput: unknown
): SongBeatGridRuntimeV2 | null => {
  const durationSec = normalizeSecond(durationSecInput)
  if (durationSec === null || durationSec <= 0) return null
  const map = normalizeSongBeatGridMapV2(value, { durationSec, allowSingleClip: true })
  if (!map) return null
  const clips: SongBeatGridRuntimeClipV2[] = []
  const lines: SongBeatGridLineV2[] = []
  let nextBeatOrdinal = 0
  for (let index = 0; index < map.clips.length; index += 1) {
    const clip = map.clips[index]
    const nextClip = map.clips[index + 1]
    const runtimeClip = createRuntimeClip(
      clip,
      index,
      nextClip?.startSec || durationSec,
      nextBeatOrdinal
    )
    if (!runtimeClip) continue
    clips.push(runtimeClip)
    for (
      let clipBeatIndex = runtimeClip.firstBeatIndex;
      clipBeatIndex <= runtimeClip.lastBeatIndex;
      clipBeatIndex += 1
    ) {
      const sec = roundSec(clip.anchorSec + clipBeatIndex * runtimeClip.beatSec)
      if (sec < runtimeClip.startSec - LINE_EPSILON_SEC || sec > durationSec + LINE_EPSILON_SEC)
        continue
      if (sec >= runtimeClip.endSec - LINE_EPSILON_SEC && runtimeClip.endSec < durationSec) continue
      lines.push({
        sec: Math.max(0, Math.min(durationSec, sec)),
        clipIndex: index,
        beatOrdinal: nextBeatOrdinal,
        clipBeatIndex,
        bpm: clip.bpm,
        level: resolveLineLevel(clipBeatIndex, clip.downbeatBeatOffset)
      })
      nextBeatOrdinal += 1
    }
    runtimeClip.lineCount = nextBeatOrdinal - runtimeClip.firstBeatOrdinal
  }
  if (!clips.length || !lines.length) return null
  return {
    map,
    signature: map.signature,
    durationSec,
    clips,
    lines,
    clipBoundaries: map.clips.slice(1).map((clip) => clip.startSec)
  }
}

export const resolveNearestSongBeatGridV2Line = (
  value: unknown,
  durationSec: unknown,
  secInput: unknown,
  options: { minSec?: number; maxSec?: number; levels?: SongBeatGridLineLevelV2[] } = {}
): SongBeatGridLineV2 | null => {
  const runtime = createSongBeatGridRuntimeV2(value, durationSec)
  if (!runtime) return null
  const sec = Math.max(0, Math.min(runtime.durationSec, Number(secInput) || 0))
  const minSec = Number.isFinite(Number(options.minSec)) ? Number(options.minSec) : 0
  const maxSec = Number.isFinite(Number(options.maxSec))
    ? Number(options.maxSec)
    : runtime.durationSec
  const levels = Array.isArray(options.levels) ? new Set(options.levels) : null
  let nearest: SongBeatGridLineV2 | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const line of runtime.lines) {
    if (line.sec < minSec - LINE_EPSILON_SEC || line.sec > maxSec + LINE_EPSILON_SEC) continue
    if (levels && !levels.has(line.level)) continue
    const distance = Math.abs(line.sec - sec)
    if (distance >= nearestDistance) continue
    nearest = line
    nearestDistance = distance
  }
  return nearest
}

export const resolveSongBeatGridV2ClipAtSec = (
  value: unknown,
  durationSecInput: unknown,
  secInput: unknown
): SongBeatGridRuntimeClipV2 | null => {
  const runtime = createSongBeatGridRuntimeV2(value, durationSecInput)
  return resolveSongBeatGridV2RuntimeClipAtSec(runtime, secInput)
}

// 播放中的查询复用已构建的 runtime，避免每次查 BPM 都生成整曲节拍线。
export const resolveSongBeatGridV2RuntimeClipAtSec = (
  runtime: SongBeatGridRuntimeV2 | null,
  secInput: unknown
): SongBeatGridRuntimeClipV2 | null => {
  if (!runtime) return null
  const sec = Math.max(0, Math.min(runtime.durationSec, Number(secInput) || 0))
  let answer = runtime.clips[0] || null
  for (const clip of runtime.clips) {
    if (clip.startSec > sec + LINE_EPSILON_SEC) break
    answer = clip
  }
  return answer && sec <= answer.endSec + LINE_EPSILON_SEC ? answer : null
}

export const resolveSongBeatGridV2BpmAtSec = (
  value: unknown,
  durationSecInput: unknown,
  secInput: unknown
): number | null => resolveSongBeatGridV2ClipAtSec(value, durationSecInput, secInput)?.bpm ?? null

const resolveSongBeatGridV2BeatOrdinalAtSec = (
  value: unknown,
  durationSecInput: unknown,
  secInput: unknown
): number | null => {
  const runtime = createSongBeatGridRuntimeV2(value, durationSecInput)
  if (!runtime) return null
  const sec = Math.max(0, Math.min(runtime.durationSec, Number(secInput) || 0))
  const lines = runtime.lines
  if (!lines.length) return null
  for (let index = 0; index < lines.length - 1; index += 1) {
    const left = lines[index]
    const right = lines[index + 1]
    if (sec < left.sec || sec > right.sec) continue
    const spanSec = right.sec - left.sec
    if (!Number.isFinite(spanSec) || spanSec <= 0) return left.beatOrdinal
    return left.beatOrdinal + (sec - left.sec) / spanSec
  }
  const clip = resolveSongBeatGridV2ClipAtSec(runtime.map, runtime.durationSec, sec)
  if (!clip) return lines[0].beatOrdinal
  const referenceLine = sec < lines[0].sec ? lines[0] : lines[lines.length - 1]
  return referenceLine.beatOrdinal + (sec - referenceLine.sec) / clip.beatSec
}

const resolveSongBeatGridV2SecAtBeatOrdinal = (
  value: unknown,
  durationSecInput: unknown,
  beatOrdinalInput: unknown
): number | null => {
  const runtime = createSongBeatGridRuntimeV2(value, durationSecInput)
  if (!runtime) return null
  const beatOrdinal = Number(beatOrdinalInput)
  if (!Number.isFinite(beatOrdinal)) return null
  const lines = runtime.lines
  if (!lines.length) return null
  if (beatOrdinal <= lines[0].beatOrdinal) return 0
  const lastLine = lines[lines.length - 1]
  if (beatOrdinal >= lastLine.beatOrdinal) return runtime.durationSec
  const leftOrdinal = Math.floor(beatOrdinal)
  const rightOrdinal = Math.ceil(beatOrdinal)
  const leftLine = lines.find((line) => line.beatOrdinal === leftOrdinal) || null
  const rightLine = lines.find((line) => line.beatOrdinal === rightOrdinal) || null
  if (!leftLine || !rightLine) return null
  if (leftOrdinal === rightOrdinal) return leftLine.sec
  return roundSec(leftLine.sec + (rightLine.sec - leftLine.sec) * (beatOrdinal - leftOrdinal))
}

export const resolveSongBeatGridV2BeatJumpSec = (
  value: unknown,
  durationSecInput: unknown,
  secInput: unknown,
  beatDeltaInput: unknown
): number | null => {
  const beatOrdinal = resolveSongBeatGridV2BeatOrdinalAtSec(value, durationSecInput, secInput)
  const beatDelta = Number(beatDeltaInput)
  if (beatOrdinal === null || !Number.isFinite(beatDelta)) return null
  return resolveSongBeatGridV2SecAtBeatOrdinal(value, durationSecInput, beatOrdinal + beatDelta)
}

export const summarizeSongBeatGridV2Bpm = (
  beatGridMap: unknown,
  fixedBpm?: unknown
): SongBeatGridBpmSummaryV2 => {
  const map = normalizeSongBeatGridMapV2(beatGridMap, { allowSingleClip: true })
  const values = map
    ? Array.from(
        new Map(
          map.clips.map((clip) => [normalizeSongBeatGridV2BpmDisplayScaled(clip.bpm), clip.bpm])
        ).values()
      )
    : []
  const normalizedValues = values.filter((value): value is number => Number.isFinite(value))
  const fallbackBpm = normalizeSongBeatGridV2Bpm(fixedBpm)
  const resolvedValues =
    normalizedValues.length > 0 ? normalizedValues : fallbackBpm === null ? [] : [fallbackBpm]
  const formattedValues = resolvedValues.map((value) => formatSongBeatGridV2BpmDisplay(value, ''))
  const displayValues =
    formattedValues.length > 3
      ? [...formattedValues.slice(0, 2), '...', formattedValues[formattedValues.length - 1]]
      : formattedValues
  return {
    displayText: displayValues.join(' -> '),
    titleText: formattedValues.join(' -> '),
    values: resolvedValues,
    minimumBpm: resolvedValues.length > 0 ? Math.min(...resolvedValues) : null,
    isDynamic: (map?.clips.length || 0) > 1
  }
}

export const resolveSongBeatGridV2BpmFilterValues = (beatGridMap: unknown, fixedBpm?: unknown) =>
  summarizeSongBeatGridV2Bpm(beatGridMap, fixedBpm).values

export const resolveSongBeatGridV2BpmSortValue = (beatGridMap: unknown, fixedBpm?: unknown) =>
  summarizeSongBeatGridV2Bpm(beatGridMap, fixedBpm).minimumBpm
