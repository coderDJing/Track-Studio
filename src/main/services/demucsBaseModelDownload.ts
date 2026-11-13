import { Readable } from 'node:stream'
import path from 'node:path'
import { app } from 'electron'
import modelManifestRaw from '../../../scripts/demucs-model-manifest.json'
import { resolveBaseDemucsModelsRootPath, resolveDevVendorDemucsModelsPath } from '../demucs'
import type {
  OptionalComponentDownloadState,
  OptionalComponentId
} from '../../shared/optionalComponentDownloads'
import { publishOptionalComponentState } from './optionalComponentEvents'
import { fetchDemucsAsset } from './mixtapeStemRuntimeDownload'
import {
  createDemucsBaseModelEnsurer,
  DemucsBaseModelDownloadError,
  isDemucsBaseModelName,
  normalizeDemucsBaseModelEntry,
  verifyDemucsBaseModelRepo,
  type DemucsBaseModelEntry,
  type DemucsBaseModelFetchResponse,
  type DemucsBaseModelManifest,
  type DemucsBaseModelName,
  type DemucsBaseModelProgress
} from './demucsBaseModelDownloadCore'

type ComponentStateInput = Omit<OptionalComponentDownloadState, 'updatedAt'>

export type DemucsBaseModelInspection = {
  available: boolean
  path: string
  source: 'installed' | 'vendor' | 'none'
  reason: string
}

export type DemucsBaseModelServiceParams = {
  modelsRoot: string
  manifest: DemucsBaseModelManifest
  fetchAsset: (url: string) => Promise<DemucsBaseModelFetchResponse>
  vendorRoot?: string | null
  publish?: (state: ComponentStateInput) => void
}

export const resolveDemucsBaseModelComponentId = (
  modelName: DemucsBaseModelName
): OptionalComponentId =>
  modelName === 'htdemucs' ? 'stem-model-htdemucs' : 'stem-model-mdx_extra_q'

const toErrorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error || '')
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
    .trim()
    .slice(0, 600)
}

export const createDemucsBaseModelService = (params: DemucsBaseModelServiceParams) => {
  const progressByModel = new Map<DemucsBaseModelName, DemucsBaseModelProgress>()
  const progressVersions = new Map<DemucsBaseModelName, number>()
  const ensurer = createDemucsBaseModelEnsurer({
    modelsRoot: params.modelsRoot,
    manifest: params.manifest,
    fetchAsset: params.fetchAsset,
    vendorRoot: params.vendorRoot,
    onProgress: (progress) => {
      progressVersions.set(progress.modelName, (progressVersions.get(progress.modelName) ?? 0) + 1)
      progressByModel.set(progress.modelName, progress)
      params.publish?.({
        id: resolveDemucsBaseModelComponentId(progress.modelName),
        status: progress.status,
        percent: progress.percent,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        error: ''
      })
    }
  })

  const findEntry = (modelName: DemucsBaseModelName): DemucsBaseModelEntry | null =>
    params.manifest.models.find((item) => item.name === modelName) || null

  return {
    ensure: async (modelName: string): Promise<string> => {
      if (!isDemucsBaseModelName(modelName)) {
        throw new DemucsBaseModelDownloadError(
          'UNSUPPORTED_MODEL',
          `unsupported base stem model: ${modelName || '<empty>'}`
        )
      }
      const initialProgressVersion = progressVersions.get(modelName) ?? 0
      try {
        const entry = findEntry(modelName)
        if (!entry) {
          throw new DemucsBaseModelDownloadError(
            'MANIFEST_MISSING',
            `embedded model manifest is missing ${modelName}`
          )
        }
        const modelPath = await ensurer(modelName)
        const progress = progressByModel.get(modelName)
        if ((progressVersions.get(modelName) ?? 0) > initialProgressVersion) {
          params.publish?.({
            id: resolveDemucsBaseModelComponentId(modelName),
            status: 'ready',
            percent: 100,
            downloadedBytes: progress?.downloadedBytes ?? 0,
            totalBytes: progress?.totalBytes ?? 0,
            error: ''
          })
        }
        return modelPath
      } catch (error) {
        const progress = progressByModel.get(modelName)
        params.publish?.({
          id: resolveDemucsBaseModelComponentId(modelName),
          status: 'failed',
          percent: progress?.percent ?? 0,
          downloadedBytes: progress?.downloadedBytes ?? 0,
          totalBytes: progress?.totalBytes ?? 0,
          error: toErrorText(error)
        })
        throw error
      }
    },
    inspect: async (modelName: string): Promise<DemucsBaseModelInspection> => {
      if (!isDemucsBaseModelName(modelName)) {
        return { available: false, path: '', source: 'none', reason: 'unsupported-model' }
      }
      const entry = findEntry(modelName)
      if (!entry) {
        return { available: false, path: '', source: 'none', reason: 'manifest-missing' }
      }
      const vendorRoot = String(params.vendorRoot || '').trim()
      if (vendorRoot) {
        const vendor = await verifyDemucsBaseModelRepo(vendorRoot, entry)
        if (vendor.ok) {
          return { available: true, path: vendorRoot, source: 'vendor', reason: vendor.reason }
        }
      }
      const installedPath = path.join(params.modelsRoot, modelName)
      const installed = await verifyDemucsBaseModelRepo(installedPath, entry)
      return installed.ok
        ? { available: true, path: installedPath, source: 'installed', reason: installed.reason }
        : { available: false, path: installedPath, source: 'none', reason: installed.reason }
    }
  }
}

const normalizeEmbeddedManifest = (raw: unknown): DemucsBaseModelManifest => {
  if (!raw || typeof raw !== 'object') return { models: [] }
  const models = Array.isArray((raw as { models?: unknown[] }).models)
    ? (raw as { models: unknown[] }).models
    : []
  return {
    models: models
      .map((entry) => normalizeDemucsBaseModelEntry(entry))
      .filter((entry): entry is DemucsBaseModelEntry => entry !== null)
  }
}

const embeddedManifest = normalizeEmbeddedManifest(modelManifestRaw)

const fetchAsset = async (url: string): Promise<DemucsBaseModelFetchResponse> => {
  const response = await fetchDemucsAsset(url)
  const contentLength = Math.max(0, Number(response.headers.get('content-length') || 0) || 0)
  return {
    ok: response.ok,
    status: response.status,
    contentLength,
    body: response.body ? Readable.fromWeb(response.body) : null
  }
}

let service: ReturnType<typeof createDemucsBaseModelService> | null = null

const getService = () => {
  if (!service) {
    service = createDemucsBaseModelService({
      modelsRoot: resolveBaseDemucsModelsRootPath(),
      manifest: embeddedManifest,
      fetchAsset,
      vendorRoot: app.isPackaged ? null : resolveDevVendorDemucsModelsPath(),
      publish: (state) => publishOptionalComponentState(state)
    })
  }
  return service
}

export const ensureDemucsBaseModel = (modelName: DemucsBaseModelName): Promise<string> =>
  getService().ensure(modelName)

export const inspectDemucsBaseModel = (
  modelName: DemucsBaseModelName
): Promise<DemucsBaseModelInspection> => getService().inspect(modelName)

export { isDemucsBaseModelName } from './demucsBaseModelDownloadCore'
export type { DemucsBaseModelName } from './demucsBaseModelDownloadCore'
