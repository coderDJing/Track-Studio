import type { KeyAnalysisJob, KeyAnalysisRequestFlags, KeyAnalysisTargets } from './types'

export type ResolvedKeyAnalysisNeeds = {
  needsKey: boolean
  needsBpm: boolean
  needsWaveform: boolean
  needsEnergy: boolean
  needsStructure: boolean
  forceKey: boolean
  forceBpm: boolean
  forceWaveform: boolean
  forceEnergy: boolean
  forceStructure: boolean
}

export type ForcedKeyAnalysisTargets = {
  key: boolean
  bpm: boolean
  waveform: boolean
  energy: boolean
  structure: boolean
}

const EMPTY_FORCED_TARGETS: ForcedKeyAnalysisTargets = {
  key: false,
  bpm: false,
  waveform: false,
  energy: false,
  structure: false
}

export const hasAnyKeyAnalysisTarget = (targets?: KeyAnalysisTargets | null) =>
  Boolean(
    targets &&
    (targets.key === true ||
      targets.bpm === true ||
      targets.waveform === true ||
      targets.energy === true ||
      targets.structure === true)
  )

export const normalizeKeyAnalysisTargets = (
  targets?: KeyAnalysisTargets | null
): KeyAnalysisTargets | undefined => {
  if (!hasAnyKeyAnalysisTarget(targets)) return undefined
  const energy = targets?.energy === true
  return {
    key: targets?.key === true,
    // v11 energy analysis uses the beat grid as a formal prerequisite.
    bpm: targets?.bpm === true || energy,
    waveform: targets?.waveform === true,
    energy,
    structure: targets?.structure === true
  }
}

export const mergeKeyAnalysisTargets = (
  current?: KeyAnalysisTargets | null,
  incoming?: KeyAnalysisTargets | null
): KeyAnalysisTargets | undefined =>
  normalizeKeyAnalysisTargets({
    key: current?.key === true || incoming?.key === true,
    bpm: current?.bpm === true || incoming?.bpm === true,
    waveform: current?.waveform === true || incoming?.waveform === true,
    energy: current?.energy === true || incoming?.energy === true,
    structure: current?.structure === true || incoming?.structure === true
  })

export const resolveForcedReanalysisTargets = (
  job: Pick<KeyAnalysisJob, 'forceAnalysis' | 'analysisTargets' | 'includeStructure'> &
    KeyAnalysisRequestFlags
): ForcedKeyAnalysisTargets => {
  if (job.forceAnalysis === true) {
    return {
      key: true,
      bpm: true,
      waveform: true,
      energy: true,
      structure: job.includeStructure !== false
    }
  }
  const targets = normalizeKeyAnalysisTargets(job.analysisTargets)
  if (!targets) return { ...EMPTY_FORCED_TARGETS }
  return {
    key: targets.key === true,
    bpm: targets.bpm === true,
    waveform: targets.waveform === true,
    energy: targets.energy === true,
    structure: targets.structure === true
  }
}

export const hasUncoveredForcedReanalysisTarget = (
  active: Pick<KeyAnalysisJob, 'forceAnalysis' | 'analysisTargets' | 'includeStructure'>,
  options: KeyAnalysisRequestFlags & { includeStructure?: boolean }
) => {
  const requested = resolveForcedReanalysisTargets({
    forceAnalysis: options.forceAnalysis,
    analysisTargets: options.analysisTargets,
    includeStructure: options.includeStructure
  })
  const covered = resolveForcedReanalysisTargets(active)
  return (
    (requested.key && !covered.key) ||
    (requested.bpm && !covered.bpm) ||
    (requested.waveform && !covered.waveform) ||
    (requested.energy && !covered.energy) ||
    (requested.structure && !covered.structure)
  )
}

export const shouldSkipStructureWithoutPreparedGrid = (
  needsStructure: boolean,
  needsBpm: boolean,
  hasPreparedGrid: boolean
) => needsStructure === true && needsBpm !== true && hasPreparedGrid !== true

export const shouldSkipEnergyWithoutPreparedGrid = (
  needsEnergy: boolean,
  needsBpm: boolean,
  hasPreparedGrid: boolean
) => needsEnergy === true && needsBpm !== true && hasPreparedGrid !== true

export const resolveInitialAnalysisNeeds = (
  job: Pick<KeyAnalysisJob, 'forceAnalysis' | 'analysisTargets' | 'includeStructure'>
): ResolvedKeyAnalysisNeeds => {
  const forceAll = job.forceAnalysis === true
  const targets = normalizeKeyAnalysisTargets(job.analysisTargets)
  const restrict = !forceAll && Boolean(targets)
  const needsKey = restrict ? targets?.key === true : true
  const needsBpm = restrict ? targets?.bpm === true : true
  const needsWaveform = restrict ? targets?.waveform === true : true
  const needsEnergy = restrict ? targets?.energy === true : true
  const needsStructure = restrict ? targets?.structure === true : job.includeStructure === true
  return {
    needsKey,
    needsBpm,
    needsWaveform,
    needsEnergy,
    needsStructure,
    forceKey: forceAll,
    forceBpm: forceAll,
    forceWaveform: forceAll,
    forceEnergy: forceAll,
    forceStructure: forceAll
  }
}
