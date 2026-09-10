import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
  WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
  WAVEFORM_SURFACE_CACHE_VERSION,
  type WaveformGlobalOverviewData,
  type WaveformListPreviewData,
  type WaveformSurfaceKind
} from '../../shared/waveformSurfaceCache'
import { closeLibraryDb, initLibraryDb } from '../libraryDb'
import store from '../store'
import {
  loadWaveformSurfaceAvailabilityByMeta,
  upsertWaveformSurfaceCacheEntry
} from './waveformSurfaceCache'

const temporaryRoots: string[] = []
const previousDatabaseDir = store.databaseDir

const makeSurface = (
  surfaceKind: WaveformSurfaceKind,
  frameCount: number
): WaveformListPreviewData | WaveformGlobalOverviewData => {
  const bytes = () => new Uint8Array(frameCount).fill(1)
  return {
    surfaceKind,
    version: WAVEFORM_SURFACE_CACHE_VERSION,
    parameterVersion:
      surfaceKind === 'listPreview'
        ? WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION
        : WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
    duration: 60,
    sampleRate: 44_100,
    detailRate: 1,
    overviewRate: 1,
    bodyRateDivisor: 1,
    colorRateDivisor: 1,
    detailPeakTop: bytes(),
    detailPeakBottom: bytes(),
    detailBody: bytes(),
    colorIndex: bytes(),
    colorLow: bytes(),
    colorMid: bytes(),
    colorHigh: bytes(),
    colorRed: bytes(),
    colorGreen: bytes(),
    colorBlue: bytes(),
    overviewTop: bytes(),
    overviewBottom: bytes()
  }
}

const createLibraryRoot = async (): Promise<{ root: string; listRoot: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-waveform-surface-'))
  const listRoot = path.join(root, 'library', 'Local', 'Playlist')
  temporaryRoots.push(root)
  await fs.mkdir(listRoot, { recursive: true })
  store.databaseDir = root
  expect(initLibraryDb(root)).not.toBeNull()
  return { root, listRoot }
}

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('loadWaveformSurfaceAvailabilityByMeta', () => {
  it('returns targeted batch hits without treating stale or missing rows as available', async () => {
    const { listRoot } = await createLibraryRoot()
    const first = path.join(listRoot, 'first.mp3')
    const second = path.join(listRoot, 'second.mp3')
    const missing = path.join(listRoot, 'missing.mp3')
    const surfaceData = {
      listPreview: makeSurface('listPreview', 4) as WaveformListPreviewData,
      globalOverview: makeSurface('globalOverview', 6) as WaveformGlobalOverviewData
    }
    await upsertWaveformSurfaceCacheEntry(
      listRoot,
      first,
      { size: 100, mtimeMs: 1_000 },
      surfaceData
    )
    await upsertWaveformSurfaceCacheEntry(
      listRoot,
      second,
      { size: 200, mtimeMs: 2_000 },
      surfaceData
    )

    const availability = loadWaveformSurfaceAvailabilityByMeta(listRoot, [
      { filePath: first, size: 100, mtimeMs: 1_000 },
      { filePath: second, size: 201, mtimeMs: 2_000 },
      { filePath: missing, size: 300, mtimeMs: 3_000 }
    ])

    expect(availability.get(first)).toBe(true)
    expect(availability.get(second)).toBe(false)
    expect(availability.get(missing)).toBe(false)
  })
})
