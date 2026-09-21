import { app, powerMonitor } from 'electron'
import { log } from '../log'

// 本模块会被打包进 worker 也会加载的共享 chunk，@electron-toolkit/utils 在
// ELECTRON_RUN_AS_NODE 环境下初始化即崩溃（app 为 undefined），因此 dev 判定
// 只能依赖环境变量，不能引入该包；electron 的 app / powerMonitor 在 worker 中
// 同样不可用，所有访问必须带防御。
const isDevRuntime = (): boolean =>
  process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL

const isMainAppReady = (): boolean => {
  try {
    return !!app && typeof app.isReady === 'function' && app.isReady()
  } catch {
    return false
  }
}

type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown'
type ForegroundBusyProvider = () => boolean

type BackgroundIdleProfile = 'active' | 'idle' | 'deep-idle'

type BackgroundIdleSnapshot = {
  systemIdleSeconds: number
  systemIdleState: SystemIdleState
  systemIdleEnough: boolean
  foregroundBusy: boolean
  allowed: boolean
  profile: BackgroundIdleProfile
  idleThresholdSec: number
  deepIdleThresholdSec: number
}

const SYSTEM_IDLE_THRESHOLD_SEC = 120
const SYSTEM_DEEP_IDLE_THRESHOLD_SEC = 300
const DEV_SYSTEM_IDLE_THRESHOLD_SEC = 20
const DEV_SYSTEM_DEEP_IDLE_THRESHOLD_SEC = 30

const foregroundBusyProviderMap = new Map<string, ForegroundBusyProvider>()

const resolveIdleThresholdSec = (): number =>
  isDevRuntime() ? DEV_SYSTEM_IDLE_THRESHOLD_SEC : SYSTEM_IDLE_THRESHOLD_SEC

const resolveDeepIdleThresholdSec = (): number =>
  isDevRuntime() ? DEV_SYSTEM_DEEP_IDLE_THRESHOLD_SEC : SYSTEM_DEEP_IDLE_THRESHOLD_SEC

const normalizeSystemIdleState = (value: unknown): SystemIdleState => {
  if (value === 'active') return 'active'
  if (value === 'idle') return 'idle'
  if (value === 'locked') return 'locked'
  return 'unknown'
}

const getSystemIdleSecondsSafe = (): number => {
  if (!app.isReady()) return 0
  try {
    const idleSec = Number(powerMonitor.getSystemIdleTime())
    if (!Number.isFinite(idleSec) || idleSec < 0) return 0
    return Math.floor(idleSec)
  } catch {
    return 0
  }
}

const getSystemIdleStateSafe = (thresholdSec: number): SystemIdleState => {
  if (!isMainAppReady()) return 'active'
  try {
    const threshold = Math.max(1, Number(thresholdSec) || SYSTEM_IDLE_THRESHOLD_SEC)
    return normalizeSystemIdleState(powerMonitor.getSystemIdleState(threshold))
  } catch {
    return 'unknown'
  }
}

const isForegroundBusy = (): boolean => {
  if (foregroundBusyProviderMap.size === 0) return false
  for (const [providerName, provider] of foregroundBusyProviderMap.entries()) {
    try {
      if (provider()) return true
    } catch (error) {
      log.error('[background-idle-gate] foreground busy provider failed', {
        providerName,
        error
      })
    }
  }
  return false
}

export const registerBackgroundForegroundBusyProvider = (
  providerName: string,
  provider: ForegroundBusyProvider
) => {
  const normalizedName = String(providerName || '').trim()
  if (!normalizedName || typeof provider !== 'function') return
  foregroundBusyProviderMap.set(normalizedName, provider)
}

export const getBackgroundIdleSnapshot = (): BackgroundIdleSnapshot => {
  const idleThresholdSec = resolveIdleThresholdSec()
  const deepIdleThresholdSec = resolveDeepIdleThresholdSec()
  const systemIdleSeconds = getSystemIdleSecondsSafe()
  const systemIdleState = getSystemIdleStateSafe(idleThresholdSec)
  const systemIdleEnough = systemIdleSeconds >= idleThresholdSec && systemIdleState !== 'active'
  const foregroundBusy = isForegroundBusy()
  const allowed = systemIdleEnough && !foregroundBusy
  const profile: BackgroundIdleProfile = !allowed
    ? 'active'
    : systemIdleSeconds >= deepIdleThresholdSec
      ? 'deep-idle'
      : 'idle'
  return {
    systemIdleSeconds,
    systemIdleState,
    systemIdleEnough,
    foregroundBusy,
    allowed,
    profile,
    idleThresholdSec,
    deepIdleThresholdSec
  }
}

export const getStemBackgroundConcurrencyHint = () => {
  const snapshot = getBackgroundIdleSnapshot()
  const target = snapshot.profile === 'deep-idle' ? 2 : 1
  return {
    target,
    profile: snapshot.profile,
    allowed: snapshot.allowed,
    foregroundBusy: snapshot.foregroundBusy,
    systemIdleSeconds: snapshot.systemIdleSeconds,
    systemIdleState: snapshot.systemIdleState
  }
}
