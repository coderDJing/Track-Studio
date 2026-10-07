import assert from 'node:assert/strict'
import fs from 'node:fs'
import { emptyUsbMutation } from './usbWriteModel'
import { mutateUsbOneLibraryCopy, readUsbOneLibrarySnapshot } from './usbOneLibrary'
import { openUsbOneLibraryDatabase } from './usbOneLibraryConnection'

/** Native Bank point and loop both use kind 101; audio and user paths are omitted. */
const addBankCues = (file: string, bankOnly: boolean) => {
  const db = openUsbOneLibraryDatabase(file, false)
  try {
    if (bankOnly) db.exec('DELETE FROM hotCueBankList_cue; DELETE FROM cue')
    db.exec(`
      CREATE TABLE hotCueBankList (hotCueBankList_id INTEGER PRIMARY KEY, attribute INTEGER);
      INSERT INTO hotCueBankList VALUES (9, 0);
      INSERT INTO cue VALUES (103, 1, 101, 0, '', NULL, 0, 0, 9907000, -1,
        1486, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'preserve-native-bank');
      INSERT INTO hotCueBankList_cue VALUES (9, 103, 3);
      INSERT INTO cue VALUES (104, 1, 101, 0, '', NULL, 0, 0, 30005000, 33315000,
        4500, 4997, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'preserve-native-bank-loop');
      INSERT INTO hotCueBankList_cue VALUES (9, 104, 2);
    `)
  } finally {
    db.close()
  }
}

const bankState = (file: string) => {
  const db = openUsbOneLibraryDatabase(file, true)
  try {
    return {
      cues: db.prepare('SELECT * FROM cue WHERE cue_id IN (103, 104) ORDER BY cue_id').all(),
      references: db
        .prepare('SELECT * FROM hotCueBankList_cue WHERE cue_id IN (103, 104) ORDER BY cue_id')
        .all(),
      list: db.prepare('SELECT * FROM hotCueBankList WHERE hotCueBankList_id = 9').get()
    }
  } finally {
    db.close()
  }
}

export const assertNativeBankCueProfileCases = (
  copyFixture: (name: string) => string,
  root: string
): void => {
  const bankOnly = copyFixture('native-bank-only')
  addBankCues(bankOnly, true)
  const original = fs.readFileSync(bankOnly)
  const cue = emptyUsbMutation()
  cue.cueUpdates = [{ trackId: 1, hotCues: [{ slot: 0, sec: 20.019 }], memoryCues: [] }]
  mutateUsbOneLibraryCopy(bankOnly, cue, root)
  assert.deepEqual(fs.readFileSync(bankOnly), original)
  const grid = emptyUsbMutation()
  grid.gridUpdates = [{ trackId: 1, offsetMs: -1 }]
  mutateUsbOneLibraryCopy(bankOnly, grid, root)
  assert.deepEqual(fs.readFileSync(bankOnly), original)
  const nativeBank = bankState(bankOnly)
  const compound = emptyUsbMutation()
  compound.additions = [{ playlistId: 12, trackIds: [1] }]
  compound.cueUpdates = cue.cueUpdates
  compound.gridUpdates = grid.gridUpdates
  mutateUsbOneLibraryCopy(bankOnly, compound, root)
  assert.deepEqual(bankState(bankOnly), nativeBank)
  assert.deepEqual(readUsbOneLibrarySnapshot(bankOnly).protectedTrackIds, [1])
  const db = openUsbOneLibraryDatabase(bankOnly, true)
  try {
    assert.deepEqual(
      db
        .prepare(
          'SELECT hasModified, cueUpdateCount, analysisDataUpdateCount FROM content WHERE content_id = 1'
        )
        .get(),
      { hasModified: 0, cueUpdateCount: 4, analysisDataUpdateCount: 7 }
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM cue').get()!.total, 2)
  } finally {
    db.close()
  }

  const nativeDeleted = copyFixture('native-deleted-bank-cue')
  addBankCues(nativeDeleted, true)
  const editDeleted = openUsbOneLibraryDatabase(nativeDeleted, false)
  try {
    // Native D WAV deletion removes the Bank link/content, but keeps a kind-101 row.
    // Native export has no cue/content FK; keep stricter FKs in all other fixture cases.
    editDeleted.pragma('foreign_keys = OFF')
    editDeleted.exec(`CREATE TABLE native_cue AS SELECT * FROM cue;
      DROP TABLE cue; ALTER TABLE native_cue RENAME TO cue;
      CREATE UNIQUE INDEX native_cue_id ON cue(cue_id)`)
    editDeleted.exec(
      'DELETE FROM hotCueBankList_cue WHERE cue_id = 103; UPDATE cue SET content_id = 42 WHERE cue_id = 103'
    )
  } finally {
    editDeleted.close()
  }
  const beforeDeleted = fs.readFileSync(nativeDeleted)
  assert.doesNotThrow(() => readUsbOneLibrarySnapshot(nativeDeleted))
  mutateUsbOneLibraryCopy(nativeDeleted, cue, root)
  assert.deepEqual(fs.readFileSync(nativeDeleted), beforeDeleted)
  const reuseDeleted = openUsbOneLibraryDatabase(nativeDeleted, false)
  try {
    // Native re-export reused a deleted WAV's content ID for a new FLAC, while
    // the unlinked zero-locator Bank row survived. It is still not a song cue.
    reuseDeleted.exec('UPDATE cue SET content_id = 1 WHERE cue_id = 103')
  } finally {
    reuseDeleted.close()
  }
  const beforeReuse = fs.readFileSync(nativeDeleted)
  mutateUsbOneLibraryCopy(nativeDeleted, cue, root)
  assert.deepEqual(fs.readFileSync(nativeDeleted), beforeReuse)
  const breakDeleted = openUsbOneLibraryDatabase(nativeDeleted, false)
  try {
    breakDeleted.exec('UPDATE cue SET content_id = 42, inMpegAbs = 1 WHERE cue_id = 103')
  } finally {
    breakDeleted.close()
  }
  assert.throws(() => readUsbOneLibrarySnapshot(nativeDeleted), /悬空引用/)

  const deletion = copyFixture('native-bank-true-delete')
  addBankCues(deletion, true)
  const remove = emptyUsbMutation()
  remove.deleteTrackIds = [1]
  const listBefore = bankState(deletion).list
  mutateUsbOneLibraryCopy(deletion, remove, root)
  const deletedState = bankState(deletion)
  assert.deepEqual(deletedState.cues, [])
  assert.deepEqual(deletedState.references, [])
  assert.deepEqual(deletedState.list, listBefore)

  const mixed = copyFixture('native-bank-and-song-cues')
  addBankCues(mixed, false)
  const beforeMixedBank = bankState(mixed)
  const update = emptyUsbMutation()
  update.cueUpdates = [
    {
      trackId: 1,
      hotCues: [{ slot: 0, sec: 1, comment: 'updated song cue' }],
      memoryCues: [{ sec: 2, loopEndSec: 4, activeLoop: true }]
    }
  ]
  mutateUsbOneLibraryCopy(mixed, update, root)
  assert.deepEqual(bankState(mixed), beforeMixedBank)
  const preserved = fs.readFileSync(mixed)
  // The Bank point's exact position must not become a seek template for ordinary song cues.
  for (const sec of [19.123, 9.907]) {
    update.cueUpdates[0].hotCues[0].sec = sec
    assert.throws(() => mutateUsbOneLibraryCopy(mixed, update, root), /尚未验证此 Cue 位置/)
    assert.deepEqual(fs.readFileSync(mixed), preserved)
    assert.deepEqual(bankState(mixed), beforeMixedBank)
  }
  update.cueUpdates[0].hotCues[0] = { slot: 0, sec: 30.005, loopEndSec: 33.315 }
  assert.throws(() => mutateUsbOneLibraryCopy(mixed, update, root), /尚未验证此 Cue 位置/)
  assert.deepEqual(fs.readFileSync(mixed), preserved)
  assert.deepEqual(bankState(mixed), beforeMixedBank)

  for (const invalid of ['missing-reference', 'folder-reference', 'unknown-kind'] as const) {
    const file = copyFixture(`native-bank-${invalid}`)
    addBankCues(file, true)
    const edit = openUsbOneLibraryDatabase(file, false)
    try {
      edit.exec(
        invalid === 'missing-reference'
          ? 'DELETE FROM hotCueBankList_cue WHERE cue_id = 103; UPDATE cue SET inMpegAbs = 1 WHERE cue_id = 103'
          : invalid === 'folder-reference'
            ? 'UPDATE hotCueBankList SET attribute = 1 WHERE hotCueBankList_id = 9'
            : 'UPDATE cue SET kind = 102 WHERE cue_id = 103'
      )
    } finally {
      edit.close()
    }
    const beforeInvalid = fs.readFileSync(file)
    assert.throws(() => mutateUsbOneLibraryCopy(file, cue, root), /有效列表引用|未知.*kind/)
    assert.deepEqual(fs.readFileSync(file), beforeInvalid)
  }
}
