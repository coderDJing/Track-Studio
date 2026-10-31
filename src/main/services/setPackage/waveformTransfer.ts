import { createHash } from 'node:crypto'
import path = require('path')
import fs = require('fs-extra')
import * as LibraryCacheDb from '../../libraryCacheDb'
import { findSongListRoot } from '../cacheMaintenance'
import { SET_PACKAGE_ANALYSIS_DIR_NAME } from '../../../shared/setPackage'
import { normalizeFilePathForComparison } from '../../../shared/filePathComparison'
import { buildUnifiedDisplayWaveformDetailFromPersistedMixxx } from '../../../shared/unifiedDisplayWaveform'
import { buildWaveformSurfaceCacheDataFromUnifiedDisplay } from '../../../shared/waveformSurfaceCache'
import { SetPackageError, resolvePackageFilePath, type SetPackageAssetEntry } from './manifest'
import {
  encodeSetPackageWaveforms,
  decodeSetPackageWaveforms,
  MAX_PACKAGE_WAVEFORM_BYTES,
  type SetPackageWaveforms
} from './waveformCodec'

type FileStat = { size: number; mtimeMs: number }
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')

export async function exportTrackWaveforms(params: {
  filePath: string
  stat: FileStat
  rootHints: string[]
  packageDir: string
  fileId: string
  audioSha256: string
}): Promise<SetPackageAssetEntry | undefined> {
  const { filePath, stat } = params
  const roots = [...params.rootHints, (await findSongListRoot(path.dirname(filePath))) || '']
    .map((root) => LibraryCacheDb.resolveCacheListRootAbs(root))
    .filter((root): root is string => !!root)
  const seen = new Set<string>()
  const data: SetPackageWaveforms = {}
  for (const root of roots) {
    const key = normalizeFilePathForComparison(root, process.platform === 'win32')
    if (seen.has(key)) continue
    seen.add(key)
    const detail = await LibraryCacheDb.loadUnifiedDisplayWaveformCacheData(root, filePath, stat)
    const listPreview = await LibraryCacheDb.loadWaveformListPreviewCacheData(root, filePath, stat)
    const globalOverview = await LibraryCacheDb.loadWaveformGlobalOverviewCacheData(
      root,
      filePath,
      stat
    )
    if (detail === undefined || listPreview === undefined || globalOverview === undefined) {
      throw new SetPackageError('FAILED', '读取曲目波形缓存失败', [path.basename(filePath)])
    }
    if (!data.detail && detail) data.detail = detail
    if (!data.surfaces && listPreview && globalOverview)
      data.surfaces = { listPreview, globalOverview }
    if (data.detail && data.surfaces) break
  }
  if (!data.detail && !data.surfaces) {
    const external = await LibraryCacheDb.loadExternalAnalysisWaveformCacheDataByFilePath(
      filePath,
      stat
    )
    if (external === undefined) throw new SetPackageError('FAILED', '读取外部曲目波形缓存失败')
    if (external)
      data.detail = buildUnifiedDisplayWaveformDetailFromPersistedMixxx(external) || undefined
  }
  if (!data.surfaces && data.detail) {
    data.surfaces = buildWaveformSurfaceCacheDataFromUnifiedDisplay(data.detail) || undefined
  }
  if (!data.detail && !data.surfaces) return undefined
  const payload = await encodeSetPackageWaveforms(data, params.audioSha256)
  const relPath = `${SET_PACKAGE_ANALYSIS_DIR_NAME}/${params.fileId}.frkbwave`
  await fs.outputFile(path.join(params.packageDir, ...relPath.split('/')), payload, { flag: 'wx' })
  return { path: relPath, size: payload.byteLength, sha256: digest(payload) }
}

export async function importTrackWaveforms(params: {
  packageDir: string
  asset: SetPackageAssetEntry
  listRoot: string
  filePath: string
  stat: FileStat
  audioSha256: string
}): Promise<void> {
  const { asset, listRoot, filePath, stat } = params
  const assetPath = resolvePackageFilePath(params.packageDir, asset.path)
  if (!assetPath || asset.size > MAX_PACKAGE_WAVEFORM_BYTES) {
    throw new SetPackageError('MANIFEST_INVALID', 'SET 波形文件路径或大小非法')
  }
  const payload = await fs.readFile(assetPath)
  if (payload.byteLength !== asset.size || digest(payload) !== asset.sha256) {
    throw new SetPackageError('PACKAGE_FILE_CORRUPTED', 'SET 波形文件已损坏', [
      path.basename(assetPath)
    ])
  }
  const data = await decodeSetPackageWaveforms(payload, params.audioSha256)
  const surfaces = data.surfaces || buildWaveformSurfaceCacheDataFromUnifiedDisplay(data.detail)
  if (
    data.detail &&
    !(await LibraryCacheDb.upsertUnifiedDisplayWaveformCacheEntry(
      listRoot,
      filePath,
      stat,
      data.detail
    ))
  ) {
    throw new SetPackageError('FAILED', '写入详细波形失败')
  }
  if (
    surfaces &&
    !(await LibraryCacheDb.upsertWaveformSurfaceCacheEntry(listRoot, filePath, stat, surfaces))
  ) {
    throw new SetPackageError('FAILED', '写入列表与总览波形失败')
  }
}
