import type { ReleaseNotesRangePayload } from './releaseNotes'

/** 统一下载卡片式更新的状态机取值，Windows 与 macOS 共用。 */
export type AppUpdateStatus =
  'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'

export type AppUpdateChannel = 'stable' | 'rc'

/**
 * 安装方式：
 * - auto：交给 electron-updater 原地替换（Windows 的 NSIS、macOS 的 Squirrel.Mac）；
 * - manual：当前环境无法原地替换（例如从 DMG 直接运行、应用目录只读、旧版本未签名），
 *   只能引导用户手动下载安装包替换。
 */
export type AppUpdateInstallMode = 'auto' | 'manual'

export type AppUpdateErrorKind = '' | 'network' | 'signature' | 'install' | 'gone' | 'unknown'

export type AppUpdateState = {
  status: AppUpdateStatus
  version: string
  releaseDate: string
  channel: AppUpdateChannel
  installMode: AppUpdateInstallMode
  percent: number
  transferredBytes: number
  totalBytes: number
  errorKind: AppUpdateErrorKind
  error: string
  manualUrl: string
  releaseNotes: ReleaseNotesRangePayload | null
  releaseNotesLoading: boolean
  /** 本次检查是启动时的静默检查：结果不主动打扰用户。 */
  silent: boolean
  updatedAt: number
}

export const EMPTY_APP_UPDATE_STATE: AppUpdateState = {
  status: 'idle',
  version: '',
  releaseDate: '',
  channel: 'stable',
  installMode: 'auto',
  percent: 0,
  transferredBytes: 0,
  totalBytes: 0,
  errorKind: '',
  error: '',
  manualUrl: '',
  releaseNotes: null,
  releaseNotesLoading: false,
  silent: false,
  updatedAt: 0
}

const STATUSES: readonly AppUpdateStatus[] = [
  'idle',
  'checking',
  'latest',
  'available',
  'downloading',
  'downloaded',
  'error'
]

const ERROR_KINDS: readonly AppUpdateErrorKind[] = [
  '',
  'network',
  'signature',
  'install',
  'gone',
  'unknown'
]

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const readNumber = (value: unknown): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

const normalizeReleaseNotes = (value: unknown): ReleaseNotesRangePayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.releases)) return null
  return value as ReleaseNotesRangePayload
}

/** 主进程事件属于边界输入：坏 payload 必须被裁成可用状态，不能把未知值带进 UI。 */
export const normalizeAppUpdateState = (value: unknown): AppUpdateState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_APP_UPDATE_STATE }
  }
  const record = value as Record<string, unknown>
  const status = STATUSES.includes(record.status as AppUpdateStatus)
    ? (record.status as AppUpdateStatus)
    : 'idle'
  const errorKind = ERROR_KINDS.includes(record.errorKind as AppUpdateErrorKind)
    ? (record.errorKind as AppUpdateErrorKind)
    : ''
  return {
    status,
    version: readString(record.version),
    releaseDate: readString(record.releaseDate),
    channel: record.channel === 'rc' ? 'rc' : 'stable',
    installMode: record.installMode === 'manual' ? 'manual' : 'auto',
    percent: Math.max(0, Math.min(100, Math.round((Number(record.percent) || 0) * 10) / 10)),
    transferredBytes: readNumber(record.transferredBytes),
    totalBytes: readNumber(record.totalBytes),
    errorKind,
    error: readString(record.error).slice(0, 300),
    manualUrl: readString(record.manualUrl),
    releaseNotes: normalizeReleaseNotes(record.releaseNotes),
    releaseNotesLoading: record.releaseNotesLoading === true,
    silent: record.silent === true,
    updatedAt: Math.max(0, Math.floor(Number(record.updatedAt) || 0))
  }
}
