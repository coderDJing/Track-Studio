import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { KEY_ANALYSIS_TIMEOUT_PROBE_TIMEOUT_MS, type KeyAnalysisAudioProbe } from './types'

const execFileAsync = promisify(execFile)

const resolveBundledFfprobePath = (): string | null => {
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  // main 在创建 worker 前统一解析随包工具路径；此模块也会被 worker 加载，不能导入 electron.app。
  const envFfmpeg = String(process.env.FRKB_FFMPEG_PATH || '').trim()
  if (!envFfmpeg) return null
  const candidate = path.join(path.dirname(envFfmpeg), ffprobeName)
  return existsSync(candidate) ? candidate : null
}

export const probeAudioFile = async (filePath: string): Promise<KeyAnalysisAudioProbe> => {
  const ffprobePath = resolveBundledFfprobePath()
  if (!ffprobePath) {
    return { error: 'ffprobe-not-found' }
  }
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_entries',
        'format=duration,bit_rate:stream=codec_name,sample_rate,channels',
        '-select_streams',
        'a:0',
        filePath
      ],
      {
        windowsHide: true,
        timeout: KEY_ANALYSIS_TIMEOUT_PROBE_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024
      }
    )
    const parsed = JSON.parse(String(stdout || '{}')) as {
      format?: { duration?: string; bit_rate?: string }
      streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>
    }
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined
    const durationSec = Number(parsed.format?.duration)
    const bitRate = Number(parsed.format?.bit_rate)
    const sampleRate = Number(stream?.sample_rate)
    const channels = Number(stream?.channels)
    return {
      durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
      bitRate: Number.isFinite(bitRate) ? bitRate : undefined,
      sampleRate: Number.isFinite(sampleRate) ? sampleRate : undefined,
      channels: Number.isFinite(channels) ? channels : undefined,
      codec: stream?.codec_name
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
