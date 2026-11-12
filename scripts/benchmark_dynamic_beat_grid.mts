import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  evaluateDynamicBeatGrid,
  type DynamicBeatGridEvaluationCandidate,
  type DynamicBeatGridEvaluationOptions,
  type DynamicBeatGridEvaluationTruth
} from '../src/shared/dynamicBeatGridEvaluation'

const HELP_TEXT = `动态多 clip 网格离线评测

用法：
  pnpm exec tsx scripts/benchmark_dynamic_beat_grid.mts --truth <truth.json> --candidate <map.json> [--out <report.json>] [--tolerance-ms <80>]

只接收显式本地文件，不读取中央 registry、数据库或旧 consumed 数据。
truth：{ durationSec, coordinate, beatGridMap | beatTimesSec, downbeatTimesSec?, boundarySecs?, clipCount?, identity?, audioIdentity? }
candidate：{ beatGridMap, durationSec, coordinate, identity?, policyVersion?, audioIdentity? }

报告中的 status=ok 只表示评测执行成功，不表示独立科学验证通过；输入若为手工/合成数据，报告会明确 qualification。`

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readArgument = (args: readonly string[], name: string): string | null => {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const readNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const readNumberArray = (value: unknown, label: string): number[] => {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数字数组`)
  const result: number[] = []
  for (const item of value) {
    const numeric = readNumber(item)
    if (numeric === null) throw new Error(`${label} 包含非有限数字`)
    result.push(numeric)
  }
  return result
}

const readCoordinate = (value: unknown, label: string): 'audio' | 'timeline' => {
  if (value === 'audio' || value === 'timeline') return value
  throw new Error(`${label}.coordinate 必须是 audio 或 timeline`)
}

const readCandidate = (value: unknown): DynamicBeatGridEvaluationCandidate => {
  if (!isRecord(value)) throw new Error('candidate 必须是 JSON 对象')
  const durationSec = readNumber(value.durationSec)
  if (durationSec === null) throw new Error('candidate.durationSec 无效')
  if (value.beatGridMap === undefined) throw new Error('candidate.beatGridMap 缺失')
  return {
    beatGridMap: value.beatGridMap,
    durationSec,
    coordinate: readCoordinate(value.coordinate, 'candidate'),
    identity: readString(value.identity),
    policyVersion: readString(value.policyVersion),
    audioIdentity: readString(value.audioIdentity)
  }
}

const readTruth = (value: unknown): DynamicBeatGridEvaluationTruth => {
  if (!isRecord(value)) throw new Error('truth 必须是 JSON 对象')
  const durationSec = readNumber(value.durationSec)
  if (durationSec === null) throw new Error('truth.durationSec 无效')
  if (value.beatGridMap === undefined && value.beatTimesSec === undefined) {
    throw new Error('truth 必须提供 beatGridMap 或 beatTimesSec')
  }
  const beatTimesSec =
    value.beatTimesSec === undefined
      ? undefined
      : readNumberArray(value.beatTimesSec, 'truth.beatTimesSec')
  const downbeatTimesSec =
    value.downbeatTimesSec === undefined
      ? undefined
      : readNumberArray(value.downbeatTimesSec, 'truth.downbeatTimesSec')
  const boundarySecs =
    value.boundarySecs === undefined
      ? undefined
      : readNumberArray(value.boundarySecs, 'truth.boundarySecs')
  const clipCount = readNumber(value.clipCount)
  return {
    durationSec,
    coordinate: readCoordinate(value.coordinate, 'truth'),
    beatGridMap: value.beatGridMap,
    beatTimesSec: beatTimesSec ?? undefined,
    downbeatTimesSec,
    boundarySecs,
    clipCount: clipCount === null ? undefined : Math.trunc(clipCount),
    identity: readString(value.identity),
    audioIdentity: readString(value.audioIdentity)
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP_TEXT)
    return
  }
  const truthPath = readArgument(args, '--truth')
  const candidatePath = readArgument(args, '--candidate')
  if (!truthPath || !candidatePath) {
    process.stderr.write(HELP_TEXT)
    process.exitCode = 1
    return
  }
  const outputPath = readArgument(args, '--out')
  const toleranceMs = readNumber(readArgument(args, '--tolerance-ms'))
  const options: DynamicBeatGridEvaluationOptions =
    toleranceMs === null ? {} : { matchToleranceSec: toleranceMs / 1000 }

  const truth = readTruth(JSON.parse(await readFile(path.resolve(truthPath), 'utf8')))
  const candidate = readCandidate(JSON.parse(await readFile(path.resolve(candidatePath), 'utf8')))
  const report = evaluateDynamicBeatGrid(candidate, truth, options)
  const serialized = JSON.stringify(report, null, 2)
  process.stdout.write(`${serialized}\n`)
  if (outputPath) {
    const resolved = path.resolve(outputPath)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, `${serialized}\n`, 'utf8')
  }
  if (report.status !== 'ok') process.exitCode = 2
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 3
})
