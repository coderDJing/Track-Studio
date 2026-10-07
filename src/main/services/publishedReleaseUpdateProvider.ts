import type { AppUpdater, UpdateInfo } from 'electron-updater'
import type { CustomPublishOptions } from 'builder-util-runtime'
import {
  Provider,
  getFileList,
  parseUpdateInfo,
  resolveFiles,
  type ProviderRuntimeOptions
} from 'electron-updater/out/providers/Provider'
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import {
  GITHUB_RELEASES_API_URL,
  buildGithubReleaseDownloadUrl,
  buildProductUserAgent
} from '../../shared/productBrand'
import {
  compareReleaseVersions,
  isReleaseInNotesChannel,
  normalizeReleaseVersion,
  resolveReleaseNotesChannel
} from '../../shared/releaseNotes'

type PublishedRelease = {
  tag: string
  version: string
  name: string
  notes: string
  publishedAt: string
  assets: Map<string, number>
}

type PublishedUpdateInfo = UpdateInfo & { tag: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const toString = (value: unknown): string => (typeof value === 'string' ? value : '')

const readPublishedRelease = (value: unknown, currentVersion: string): PublishedRelease | null => {
  if (!isRecord(value) || value.draft !== false || !toString(value.published_at)) return null
  const tag = toString(value.tag_name)
  const version = normalizeReleaseVersion(tag)
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) return null
  if (
    !isReleaseInNotesChannel(
      version,
      value.prerelease === true,
      resolveReleaseNotesChannel(currentVersion)
    ) ||
    compareReleaseVersions(version, currentVersion) <= 0
  ) {
    return null
  }
  const assets = new Map<string, number>()
  for (const asset of Array.isArray(value.assets) ? value.assets : []) {
    if (
      isRecord(asset) &&
      asset.state === 'uploaded' &&
      typeof asset.name === 'string' &&
      typeof asset.size === 'number' &&
      asset.size > 0
    ) {
      assets.set(asset.name, asset.size)
    }
  }
  return {
    tag,
    version,
    name: toString(value.name) || tag,
    notes: toString(value.body),
    publishedAt: toString(value.published_at),
    assets
  }
}

const request = async (url: string, currentVersion: string) =>
  fetchWithSystemProxy(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': buildProductUserAgent(currentVersion),
      'Cache-Control': 'no-cache'
    },
    signal: AbortSignal.timeout(30_000)
  })

const httpError = (response: Response, url: string): Error =>
  Object.assign(new Error(`Update request failed: HTTP ${response.status} (${url})`), {
    statusCode: response.status
  })

/** Only published releases with a complete platform manifest can become update targets.
 * GitHub's Atom feed can expose tags before packaging finishes or retain deleted releases.
 */
export class PublishedReleaseUpdateProvider extends Provider<PublishedUpdateInfo> {
  constructor(
    _options: CustomPublishOptions,
    private readonly updater: AppUpdater,
    private readonly options: ProviderRuntimeOptions
  ) {
    super({ ...options, isUseMultipleRangeRequest: false })
  }

  async getLatestVersion(): Promise<PublishedUpdateInfo> {
    const currentVersion = this.updater.currentVersion.version
    const releases: PublishedRelease[] = []
    for (let page = 1; page <= 3; page += 1) {
      const url = `${GITHUB_RELEASES_API_URL}?per_page=100&page=${page}`
      const response = await request(url, currentVersion)
      if (!response.ok) throw httpError(response, url)
      const data: unknown = await response.json()
      if (!Array.isArray(data)) throw new Error('Invalid GitHub releases response')
      for (const value of data) {
        const release = readPublishedRelease(value, currentVersion)
        if (release) releases.push(release)
      }
      if (data.length < 100) break
      if (page === 3) throw new Error('GitHub update release search exceeded pagination limit')
    }
    releases.sort((left, right) => compareReleaseVersions(right.version, left.version))
    const channelFile = this.options.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
    for (const release of releases) {
      if (!release.assets.has(channelFile)) continue
      const url = buildGithubReleaseDownloadUrl(release.tag, channelFile)
      const response = await request(url, currentVersion)
      // A release can be removed between listing it and fetching its manifest.
      if (response.status === 404 || response.status === 410) continue
      if (!response.ok) throw httpError(response, url)
      const info = parseUpdateInfo(await response.text(), channelFile, new URL(url))
      if (!info || info.version !== release.version) continue
      const files = getFileList(info)
      const baseUrl = new URL(buildGithubReleaseDownloadUrl(release.tag, ''))
      const resolved = resolveFiles(info, baseUrl)
      const requiredExtension = this.options.platform === 'darwin' ? '.zip' : '.exe'
      if (
        !files.length ||
        !resolved.some((file) => file.url.pathname.endsWith(requiredExtension))
      ) {
        continue
      }
      const complete = resolved.every((file) => {
        if (!file.url.href.startsWith(baseUrl.href)) return false
        const name = decodeURIComponent(file.url.pathname.slice(baseUrl.pathname.length))
        const size = release.assets.get(name)
        return size !== undefined && (file.info.size === undefined || file.info.size === size)
      })
      if (!complete) continue
      return {
        ...info,
        tag: release.tag,
        releaseName: info.releaseName ?? release.name,
        releaseNotes: info.releaseNotes ?? release.notes,
        releaseDate: info.releaseDate || release.publishedAt
      }
    }
    // The existing updater emits update-not-available for the current version.
    return { version: currentVersion, files: [], path: '', sha512: '', releaseDate: '', tag: '' }
  }

  resolveFiles(info: PublishedUpdateInfo) {
    return resolveFiles(info, new URL(buildGithubReleaseDownloadUrl(info.tag, '')))
  }
}

const installed = new WeakSet<AppUpdater>()

export const installPublishedReleaseUpdateProvider = (updater: AppUpdater): void => {
  if (installed.has(updater)) return
  updater.setFeedURL({ provider: 'custom', updateProvider: PublishedReleaseUpdateProvider })
  installed.add(updater)
}
