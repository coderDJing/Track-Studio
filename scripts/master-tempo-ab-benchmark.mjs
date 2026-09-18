import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const require = createRequire(import.meta.url)
const RUNNER_VERSION = 'master-tempo-ab-benchmark-v2'

const resolveManagedRuntimePython = () => {
  const configuredDemucsRoot = String(process.env.FRKB_DEMUCS_ROOT || '').trim()
  const demucsRoot = configuredDemucsRoot
    ? path.resolve(configuredDemucsRoot)
    : path.join(repoRoot, 'vendor', 'demucs')
  return path.join(demucsRoot, 'win32-x64', 'runtime-cpu', 'python.exe')
}

const parseArgs = (argv) => {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`参数格式错误：${key || '<empty>'}`)
    }
    args.set(key.slice(2), value)
  }
  return args
}

const requireFinitePositive = (args, name) => {
  const value = Number(args.get(name))
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} 必须是大于 0 的数字`)
  }
  return value
}

const safeSlug = (value) =>
  value
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'audio'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const writeFloatWav = (filePath, samples, sampleRate, channels) => {
  const dataBytes = samples.length * 4
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(3, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 4, 28)
  header.writeUInt16LE(channels * 4, 32)
  header.writeUInt16LE(32, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  fs.writeFileSync(filePath, Buffer.concat([header, data]))
}

const linearTempoResample = (input, channels, tempo) => {
  const inputFrames = input.length / channels
  const outputFrames = Math.ceil(inputFrames / tempo)
  const output = new Float32Array(outputFrames * channels)
  for (let outputFrame = 0; outputFrame < outputFrames; outputFrame += 1) {
    const sourceFrame = Math.min(outputFrame * tempo, inputFrames - 1)
    const baseFrame = Math.floor(sourceFrame)
    const nextFrame = Math.min(baseFrame + 1, inputFrames - 1)
    const fraction = sourceFrame - baseFrame
    for (let channel = 0; channel < channels; channel += 1) {
      const left = input[baseFrame * channels + channel]
      const right = input[nextFrame * channels + channel]
      output[outputFrame * channels + channel] = left + (right - left) * fraction
    }
  }
  return output
}

const resolvePython = () => {
  const configured = String(process.env.FRKB_MASTER_TEMPO_BENCHMARK_PYTHON || '').trim()
  const candidate = configured
    ? path.resolve(configured)
    : resolveManagedRuntimePython()
  if (!fs.existsSync(candidate)) {
    throw new Error(
      '找不到 benchmark Python；请设置 FRKB_MASTER_TEMPO_BENCHMARK_PYTHON 或 FRKB_DEMUCS_ROOT'
    )
  }
  return candidate
}

const main = () => {
  const args = parseArgs(process.argv.slice(2))
  const inputPath = path.resolve(String(args.get('input') || ''))
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('--input 必须指向存在的音频文件')
  }
  const sourceBpm = requireFinitePositive(args, 'source-bpm')
  const targetBpm = requireFinitePositive(args, 'target-bpm')
  const startSec = Number(args.get('start-sec') || 0)
  const durationSec = Number(args.get('duration-sec') || 120)
  if (!Number.isFinite(startSec) || startSec < 0) throw new Error('--start-sec 必须大于等于 0')
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('--duration-sec 必须大于 0')
  }
  const tempo = targetBpm / sourceBpm
  if (tempo < 0.25 || tempo > 4) throw new Error('目标/源 BPM 比例必须在 0.25 到 4.0 之间')
  const r3Mode = String(args.get('r3-mode') || 'r3-mw')
  if (!['r3-mw', 'r3-sw', 'faster'].includes(r3Mode)) {
    throw new Error('--r3-mode 必须是 r3-mw、r3-sw 或 faster')
  }

  const r3Library = path.join(repoRoot, 'vendor', 'r3-stretch', 'win32-x64', 'rubberband-2.dll')
  if (!fs.existsSync(r3Library)) throw new Error(`找不到受管 R3 library：${r3Library}`)
  if (!process.env.FRKB_R3_STRETCH_LIBRARY) process.env.FRKB_R3_STRETCH_LIBRARY = r3Library
  if (process.platform === 'win32') {
    process.env.PATH = [path.dirname(r3Library), process.env.PATH || ''].join(path.delimiter)
  }
  const binding = require(path.join(repoRoot, 'rust_package'))
  if (typeof binding.processR3MasterTempoOffline !== 'function') {
    throw new Error('native binding 缺少 processR3MasterTempoOffline，请先重新构建 rust_package')
  }

  const sampleRate = 44_100
  const channels = 2
  const decoded = binding.decodeAudioFileNativePcm(
    inputPath,
    startSec,
    durationSec,
    sampleRate,
    channels
  )
  if (decoded.error) throw new Error(`解码失败：${decoded.error}`)
  const inputBuffer = Buffer.from(decoded.pcmData)
  const source = new Float32Array(
    inputBuffer.buffer,
    inputBuffer.byteOffset,
    inputBuffer.byteLength / 4
  )
  const mtOff = linearTempoResample(source, channels, tempo)
  const r3 = binding.processR3MasterTempoOffline(inputBuffer, sampleRate, channels, tempo, r3Mode)
  const r3Buffer = Buffer.from(r3.pcmData)
  const mtOn = new Float32Array(r3Buffer.buffer, r3Buffer.byteOffset, r3Buffer.byteLength / 4)

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  const defaultOutput = path.join(
    repoRoot,
    'master-tempo-benchmarks',
    `${timestamp}-${safeSlug(path.basename(inputPath, path.extname(inputPath)))}`
  )
  const outputDir = args.get('output-dir') ? path.resolve(args.get('output-dir')) : defaultOutput
  fs.mkdirSync(outputDir, { recursive: true })
  writeFloatWav(path.join(outputDir, 'source.wav'), source, sampleRate, channels)
  writeFloatWav(path.join(outputDir, 'mt-off.wav'), mtOff, sampleRate, channels)
  writeFloatWav(path.join(outputDir, 'mt-on-r3.wav'), mtOn, sampleRate, channels)

  const manifest = {
    schemaVersion: 1,
    runnerVersion: RUNNER_VERSION,
    input: {
      filePath: inputPath,
      fileSha256: sha256(fs.readFileSync(inputPath)),
      decodedPcmSha256: sha256(inputBuffer),
      sourceBpm,
      targetBpm,
      tempo,
      startSec,
      requestedDurationSec: durationSec,
      decodedFrames: source.length / channels,
      sampleRate,
      channels,
      decoderBackend: decoded.decoderBackend
    },
    outputs: {
      source: 'source.wav',
      mtOff: 'mt-off.wav',
      mtOnR3: 'mt-on-r3.wav'
    },
    r3: {
      mode: r3.mode,
      engineVersion: r3.engineVersion,
      library: process.env.FRKB_R3_STRETCH_LIBRARY,
      librarySha256: sha256(fs.readFileSync(process.env.FRKB_R3_STRETCH_LIBRARY)),
      inputFrames: r3.inputFrames,
      outputFrames: r3.outputFrames,
      preferredStartPad: r3.preferredStartPad,
      startDelay: r3.startDelay,
      feedCalls: r3.feedCalls,
      retrieveCalls: r3.retrieveCalls,
      zeroRetrieveCalls: r3.zeroRetrieveCalls
    }
  }
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const analysis = spawnSync(
    resolvePython(),
    [path.join(scriptDir, 'analyze_master_tempo_ab.py'), '--input-dir', outputDir],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  if (analysis.status !== 0) {
    throw new Error(`瞬态分析失败：${analysis.stderr || analysis.stdout}`)
  }
  process.stdout.write(analysis.stdout)
  console.log(`[master-tempo-ab] output=${outputDir}`)
}

try {
  main()
} catch (error) {
  console.error(`[master-tempo-ab] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
