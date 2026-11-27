import path from 'node:path'
import { boundedPath, isInside, type ResidencyReader } from './files'

export type IcloudConfig = {
  version: 3
  relativeFolder: ''
  mode: 'drive'
  legacyFolder?: string
  writeAcknowledged?: boolean
}
// Old music-location settings are retained as a preference, NEVER as a browsing boundary.
export function migrateIcloudConfig(data: unknown): IcloudConfig {
  if (
    !data ||
    typeof data !== 'object' ||
    !('relativeFolder' in data) ||
    typeof data.relativeFolder !== 'string'
  )
    throw new Error('boundary')
  const old = data as {
    version?: unknown
    relativeFolder: string
    legacyFolder?: unknown
    writeAcknowledged?: unknown
  }
  const relative = old.version === 3 ? (old.legacyFolder ?? '') : old.relativeFolder
  if (
    typeof relative !== 'string' ||
    path.isAbsolute(relative) ||
    relative.includes('\0') ||
    !isInside('/icloud', path.resolve('/icloud', relative))
  )
    throw new Error('boundary')
  const normalized = path.relative('/icloud', path.resolve('/icloud', relative))
  return {
    version: 3,
    relativeFolder: '',
    mode: 'drive',
    ...(normalized ? { legacyFolder: normalized } : {}),
    ...(old.version === 3 && old.writeAcknowledged === true ? { writeAcknowledged: true } : {})
  }
}
export const defaultIcloudConfig = (): IcloudConfig => ({
  version: 3,
  relativeFolder: '',
  mode: 'drive'
})
// com~apple~CloudDocs is the user-file root, NOT all of Mobile Documents.
// Never create a root or an app-defined music folder, even on write.
export async function resolveIcloudDriveRoot(cloud: string, residency: ResidencyReader) {
  return boundedPath(cloud, '', residency)
}
