import { ref } from 'vue'

// 首页多处下载按钮共用同一份 Release 信息，只请求一次 GitHub API
const LATEST_RELEASE_PAGE = 'https://github.com/coderDJing/Track-Studio/releases/latest'
const LATEST_RELEASE_API = 'https://api.github.com/repos/coderDJing/Track-Studio/releases/latest'

export type Platform = 'win' | 'mac' | 'unknown'

interface ReleaseAsset {
  name: string
  browser_download_url?: string
}

const winUrl = ref(LATEST_RELEASE_PAGE)
const macUrl = ref(LATEST_RELEASE_PAGE)
const version = ref('')
const loading = ref(true)
const platform = ref<Platform>('unknown')
let started = false

const findAssetUrl = (assets: ReleaseAsset[], matchers: RegExp[]) => {
  for (const matcher of matchers) {
    const match = assets.find((asset) => matcher.test(asset.name))
    if (match?.browser_download_url) return match.browser_download_url
  }
  return ''
}

const detectPlatform = (): Platform => {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'win'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  return 'unknown'
}

const load = async () => {
  platform.value = detectPlatform()
  try {
    const res = await fetch(LATEST_RELEASE_API)
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') throw new Error('Invalid release payload')
    const release = data as { assets?: ReleaseAsset[]; html_url?: unknown; tag_name?: unknown }
    const assets = Array.isArray(release.assets) ? release.assets : []
    const releaseUrl =
      typeof release.html_url === 'string' && release.html_url
        ? release.html_url
        : LATEST_RELEASE_PAGE
    winUrl.value = findAssetUrl(assets, [/setup.*\.exe$/i, /\.exe$/i, /\.msi$/i]) || releaseUrl
    macUrl.value = findAssetUrl(assets, [/\.dmg$/i, /\.pkg$/i, /\.zip$/i]) || releaseUrl
    if (typeof release.tag_name === 'string' && release.tag_name) {
      version.value = release.tag_name.startsWith('v') ? release.tag_name : `v${release.tag_name}`
    }
  } catch (err) {
    // 拿不到资产时按钮仍指向 Release 页面，用户可以手动选择安装包
    console.error('Failed to load download links:', err)
  } finally {
    loading.value = false
  }
}

export const useLatestRelease = () => {
  if (!started && typeof window !== 'undefined') {
    started = true
    void load()
  }
  return { winUrl, macUrl, version, loading, platform, releasePage: LATEST_RELEASE_PAGE }
}
