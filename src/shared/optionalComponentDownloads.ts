export const OPTIONAL_COMPONENT_IDS = [
  'stem-model-htdemucs',
  'stem-model-mdx_extra_q',
  'rekordbox-desktop-runtime'
] as const

export type OptionalComponentId = (typeof OPTIONAL_COMPONENT_IDS)[number]

export type OptionalComponentDownloadStatus =
  'idle' | 'downloading' | 'installing' | 'ready' | 'failed'

export type OptionalComponentDownloadState = {
  id: OptionalComponentId
  status: OptionalComponentDownloadStatus
  percent: number
  downloadedBytes: number
  totalBytes: number
  error: string
  updatedAt: number
}

export const isOptionalComponentId = (value: unknown): value is OptionalComponentId =>
  OPTIONAL_COMPONENT_IDS.some((id) => id === value)

export const OPTIONAL_COMPONENT_LABEL_KEYS: Record<OptionalComponentId, string> = {
  'stem-model-htdemucs': 'optionalComponents.stemHtdemucs',
  'stem-model-mdx_extra_q': 'optionalComponents.stemMdxExtraQ',
  'rekordbox-desktop-runtime': 'optionalComponents.rekordboxRuntime'
}
