import { computed, reactive, ref } from 'vue'
import {
  isOptionalComponentId,
  OPTIONAL_COMPONENT_IDS,
  OPTIONAL_COMPONENT_LABEL_KEYS,
  type OptionalComponentDownloadState,
  type OptionalComponentDownloadStatus,
  type OptionalComponentId
} from '@shared/optionalComponentDownloads'

const READY_VISIBLE_MS = 4000

const states = reactive(new Map<OptionalComponentId, OptionalComponentDownloadState>())
const readyTimers = new Map<OptionalComponentId, ReturnType<typeof setTimeout>>()
const retryingIds = reactive(new Set<OptionalComponentId>())
let statesLoaded = false
let statesLoadTask: Promise<void> | null = null

const STATUSES: readonly OptionalComponentDownloadStatus[] = [
  'idle',
  'downloading',
  'installing',
  'ready',
  'failed'
]

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const readPercent = (value: unknown): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, numeric))
}

/** 主进程事件是边界输入：坏 payload 直接丢弃，不能把未知 id/状态带进 UI。 */
export const normalizeOptionalComponentDownloadState = (
  value: unknown
): OptionalComponentDownloadState | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!isOptionalComponentId(record.id)) return undefined
  if (!STATUSES.includes(record.status as OptionalComponentDownloadStatus)) return undefined
  return {
    id: record.id,
    status: record.status as OptionalComponentDownloadStatus,
    percent: readPercent(record.percent),
    downloadedBytes: readNumber(record.downloadedBytes) ?? 0,
    totalBytes: readNumber(record.totalBytes) ?? 0,
    // error 只保留在主进程上下文；UI 只展示本地化通用失败文案。
    error: typeof record.error === 'string' ? record.error.slice(0, 300) : '',
    updatedAt: readNumber(record.updatedAt) ?? 0
  }
}

/**
 * 失败原因只用于简短提示：去掉 URL、绝对路径、文件名与 pid/token 等敏感片段，
 * 避免把凭据、manifest 路径或实现细节显示给用户。
 */
export const sanitizeOptionalComponentErrorMessage = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/\r?\n/g, ' ')
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, ' ')
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, ' ')
    .replace(/\\\\[^\s"'<>]+/g, ' ')
    .replace(/(?:\/[^\s/]+){2,}\/?/g, ' ')
    .replace(/\b[\w.-]+\.(?:json|zip|7z|tar|gz|whl|py|exe|dll|node)\b/gi, ' ')
    .replace(/\b(?:pid|token|secret|password|authorization|signature)\b\s*[:=]?\s*\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 120)
}

const clearReadyTimer = (id: OptionalComponentId) => {
  const timer = readyTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    readyTimers.delete(id)
  }
}

export const applyOptionalComponentDownloadState = (state: OptionalComponentDownloadState) => {
  const previous = states.get(state.id)
  if (
    previous &&
    state.updatedAt > 0 &&
    previous.updatedAt > 0 &&
    state.updatedAt < previous.updatedAt
  ) {
    return
  }
  clearReadyTimer(state.id)
  states.set(state.id, state)
  if (state.status === 'ready') {
    readyTimers.set(
      state.id,
      setTimeout(() => {
        states.delete(state.id)
        readyTimers.delete(state.id)
      }, READY_VISIBLE_MS)
    )
  }
}

const invokeOptionalComponent = (channel: string, ...args: unknown[]) =>
  window.electron.ipcRenderer.invoke(channel, ...args)

const syncStates = async () => {
  try {
    const list = await invokeOptionalComponent('optional-component:states')
    if (!Array.isArray(list)) return
    for (const item of list) {
      const state = normalizeOptionalComponentDownloadState(item)
      if (state) applyOptionalComponentDownloadState(state)
    }
  } catch {
    // 纯内存状态读取失败不应影响正常使用，也不触发任何下载。
  }
}

/** 启动时只读取主进程内存状态；绝不自动下载。 */
export const ensureOptionalComponentStatesLoaded = async () => {
  if (statesLoaded) return
  if (!statesLoadTask) {
    statesLoadTask = syncStates().finally(() => {
      statesLoaded = true
      statesLoadTask = null
    })
  }
  await statesLoadTask
}

export const downloadOptionalComponent = async (
  id: OptionalComponentId
): Promise<{ ok: boolean; error?: string }> => {
  try {
    const result = await invokeOptionalComponent('optional-component:download', id)
    const ok = Boolean(result && typeof result === 'object' && result.ok === true)
    if (ok) await syncStates()
    const error =
      result && typeof result === 'object' && typeof result.error === 'string'
        ? result.error
        : undefined
    return ok ? { ok: true } : { ok: false, error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error || '') }
  }
}

export const isOptionalComponentReady = (id: OptionalComponentId): boolean =>
  states.get(id)?.status === 'ready'

/** ready 状态可能 4 秒后消失；用 updatedAt 作为“这一次就绪”的令牌。 */
export const getOptionalComponentReadyToken = (id: OptionalComponentId): number => {
  const state = states.get(id)
  return state?.status === 'ready' ? state.updatedAt : 0
}

/** 主进程未推送本地失败状态时，让 UI 也能显示脱敏失败原因并允许重试。 */
export const reportOptionalComponentFailure = (id: OptionalComponentId, error: unknown) => {
  applyOptionalComponentDownloadState({
    id,
    status: 'failed',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    error: typeof error === 'string' ? error : error instanceof Error ? error.message : '',
    updatedAt: Date.now()
  })
}

const bindOptionalComponentEvents = () => {
  if (typeof window === 'undefined' || !window.electron?.ipcRenderer) return
  window.electron.ipcRenderer.on(
    'optional-component:state',
    (_event: unknown, payload: unknown) => {
      const state = normalizeOptionalComponentDownloadState(payload)
      if (state) applyOptionalComponentDownloadState(state)
    }
  )
}
bindOptionalComponentEvents()

/** 仅测试使用：清空模块级状态与 ready 定时器。 */
export const resetOptionalComponentDownloadsForTests = () => {
  for (const id of Array.from(readyTimers.keys())) clearReadyTimer(id)
  states.clear()
  retryingIds.clear()
  statesLoaded = false
  statesLoadTask = null
}

export function useOptionalComponentDownloads() {
  const collapsed = ref(false)
  const entries = computed(() =>
    OPTIONAL_COMPONENT_IDS.map((id) => states.get(id)).filter(
      (state): state is OptionalComponentDownloadState => Boolean(state && state.status !== 'idle')
    )
  )
  const hasEntries = computed(() => entries.value.length > 0)
  const activeCount = computed(
    () => entries.value.filter((state) => state.status !== 'ready').length
  )

  const retry = async (id: OptionalComponentId) => {
    if (retryingIds.has(id)) return
    retryingIds.add(id)
    try {
      await downloadOptionalComponent(id)
    } finally {
      retryingIds.delete(id)
    }
  }

  return {
    entries,
    hasEntries,
    activeCount,
    collapsed,
    toggleCollapsed: () => {
      collapsed.value = !collapsed.value
    },
    retry,
    isRetrying: (id: OptionalComponentId) => retryingIds.has(id),
    labelKeyFor: (id: OptionalComponentId) => OPTIONAL_COMPONENT_LABEL_KEYS[id]
  }
}
