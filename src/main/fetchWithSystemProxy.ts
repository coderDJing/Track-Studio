import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { getSystemProxy } from './utils'

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
type UndiciFetchInput = Parameters<typeof undiciFetch>[0]
type UndiciFetchInit = Parameters<typeof undiciFetch>[1]
type ProxyFetchInit = FetchInit & { dispatcher?: ProxyAgent }

let systemProxyDispatcher: ProxyAgent | undefined
let systemProxyInitialization: Promise<void> | undefined

const isLocalhostInput = (input: FetchInput): boolean => {
  try {
    const href = typeof input === 'string' ? input : String(input)
    const host = new URL(href).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

async function ensureSystemProxyInitialized() {
  if (!systemProxyInitialization) {
    systemProxyInitialization = getSystemProxy().then((proxyUrl) => {
      if (proxyUrl) {
        systemProxyDispatcher = new ProxyAgent(proxyUrl)
      }
    })
  }

  const initialization = systemProxyInitialization
  try {
    await initialization
  } catch (error) {
    // 初始化失败后允许下一次请求重新读取系统代理，避免永久停留在直连状态。
    if (systemProxyInitialization === initialization) {
      systemProxyInitialization = undefined
    }
    throw error
  }
}

export async function fetchWithSystemProxy(input: FetchInput, init?: FetchInit) {
  await ensureSystemProxyInitialized()
  const requestInit: ProxyFetchInit = {
    ...(init || {})
  }
  if (systemProxyDispatcher && !isLocalhostInput(input)) {
    requestInit.dispatcher = systemProxyDispatcher
  }
  return (await undiciFetch(
    input as unknown as UndiciFetchInput,
    requestInit as unknown as UndiciFetchInit
  )) as unknown as Response
}
