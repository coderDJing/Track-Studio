import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initLibraryDb, closeLibraryDb, getLibraryDb } from '../libraryDb'
import store from '../store'
import { appendMixtapeItems, listMixtapeItems } from '../mixtapeDb'
import {
  getMixtapeProjectBpmEnvelope,
  upsertMixtapeProjectBpmEnvelope
} from '../mixtapeProjectTempoDb'
import { applyMixtapeArrangement } from './mixtapeArrangement'
import type { MixtapeArrangementRequest } from '../../shared/mixtapeArrangement'

vi.mock('./libraryMerge/runtime', () => ({ assertLibraryMergeMutationAllowed: vi.fn() }))
const previousRoot = store.databaseDir
let root = ''
let request: MixtapeArrangementRequest

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-arrangement-'))
  await fs.mkdir(path.join(root, 'library'))
  store.databaseDir = root
  const db = initLibraryDb(root)
  if (!db) throw new Error('database unavailable')
  db.prepare(
    "INSERT INTO library_nodes(uuid,parent_uuid,dir_name,node_type) VALUES('mix',NULL,'Mix','mixtapeList')"
  ).run()
  const files = [path.join(root, '1.mp3'), path.join(root, '2.mp3')]
  await Promise.all(files.map((file) => fs.writeFile(file, Buffer.from('audio'))))
  const inserted = appendMixtapeItems(
    'mix',
    files.map((filePath, index) => ({
      filePath,
      info: {
        title: `Song ${index + 1}`,
        startSec: index * 120,
        hotCues: [{ slot: 0, sec: 10 }],
        gainEnvelope: [
          { sec: 0, gain: 0.5 },
          { sec: 120, gain: 1 }
        ],
        loopSegment: { startSec: 2, endSec: 4, repeatCount: 1 }
      }
    }))
  )
  expect(inserted.inserted).toBe(2)
  const rows = listMixtapeItems('mix')
  upsertMixtapeProjectBpmEnvelope('mix', {
    bpmEnvelope: [
      { sec: 0, bpm: 100 },
      { sec: 300, bpm: 140 }
    ],
    bpmEnvelopeDurationSec: 300,
    gridPhaseOffsetSec: 0.05
  })
  request = {
    playlistId: 'mix',
    entries: rows.map((row, index) => ({ itemId: row.id, startSec: index * 80 })),
    bpmEnvelope: [
      { sec: 0, bpm: 128 },
      { sec: 200, bpm: 128 }
    ],
    bpmEnvelopeDurationSec: 200,
    gridPhaseOffsetSec: 0
  }
})
afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousRoot
  await fs.rm(root, { recursive: true, force: true })
})

describe('atomic Mixtape arrangement persistence', () => {
  it('persists starts and BPM together and retains cues, envelopes, and Loop metadata', async () => {
    const before = listMixtapeItems('mix').map((item) => JSON.parse(item.infoJson || '{}'))
    const result = await applyMixtapeArrangement(request)
    expect(result.updated).toBe(2)
    const after = listMixtapeItems('mix').map((item) => JSON.parse(item.infoJson || '{}'))
    expect(after.map((info) => info.startSec)).toEqual([0, 80])
    after.forEach((info, index) => {
      expect(info.hotCues).toEqual(before[index].hotCues)
      expect(info.gainEnvelope).toEqual(before[index].gainEnvelope)
      expect(info.loopSegment).toEqual(before[index].loopSegment)
    })
    expect(getMixtapeProjectBpmEnvelope('mix').bpmEnvelope).toEqual(request.bpmEnvelope)
  })

  it('rolls back every update if a track write fails', async () => {
    const before = listMixtapeItems('mix')
    const tempo = getMixtapeProjectBpmEnvelope('mix')
    getLibraryDb()?.exec(`CREATE TRIGGER fail_arrangement BEFORE UPDATE ON mixtape_items
      WHEN OLD.id = '${request.entries[1].itemId}' BEGIN SELECT RAISE(ABORT, 'test write failure'); END`)
    await expect(applyMixtapeArrangement(request)).rejects.toThrow('test write failure')
    expect(listMixtapeItems('mix')).toEqual(before)
    expect(getMixtapeProjectBpmEnvelope('mix')).toEqual(tempo)
  })

  it('rejects missing audio and changed rosters without writing', async () => {
    const before = listMixtapeItems('mix')
    await fs.unlink(before[0].filePath)
    await expect(applyMixtapeArrangement(request)).rejects.toThrow('MISSING_FILE')
    expect(listMixtapeItems('mix')).toEqual(before)
    await expect(
      applyMixtapeArrangement({ ...request, entries: [request.entries[0]] })
    ).rejects.toThrow()
  })

  it('rejects duplicate IDs and nonfinite or negative positions', async () => {
    await expect(
      applyMixtapeArrangement({ ...request, entries: [request.entries[0], request.entries[0]] })
    ).rejects.toThrow('INVALID')
    await expect(
      applyMixtapeArrangement({
        ...request,
        entries: request.entries.map((entry) => ({ ...entry, startSec: -1 }))
      })
    ).rejects.toThrow('INVALID')
    await expect(
      applyMixtapeArrangement({ ...request, bpmEnvelopeDurationSec: NaN })
    ).rejects.toThrow('INVALID')
  })
})
