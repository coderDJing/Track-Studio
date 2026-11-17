import type { SupportedAudioFormat } from '../../../shared/audioFormats'

export type ConvertOptions = {
  targetFormat: SupportedAudioFormat
  bitrateKbps?: number
  sampleRate?: 44100 | 48000
  channels?: 1 | 2
  preserveMetadata?: boolean
  normalize?: boolean
  strategy: 'new_file' | 'replace'
  overwrite?: boolean
  backupOnReplace?: boolean
  addFingerprint?: boolean
  outputDir?: string
}

export type OpenAudioConvertDialogArgs = {
  sourceExts?: string[]
  standaloneMode?: boolean
  presetTargetFormat?: SupportedAudioFormat
  lockTargetFormat?: boolean
  lockNewFile?: boolean
  requireOutputDir?: boolean
}

export type StandaloneConvertPayload = {
  files: string[]
  outputDir?: string
  options: ConvertOptions
}

export type AudioConvertDialogResult = ConvertOptions | StandaloneConvertPayload | 'cancel'
