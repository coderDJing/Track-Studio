import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyUsbMutation } from './usbWriteModel'
import type { UsbLibraryMutation } from './usbWriteModel'
import { mutateUsbOneLibraryCopy, readUsbOneLibrarySnapshot } from './usbOneLibrary'
import { openUsbOneLibraryDatabase } from './usbOneLibraryConnection'
import { createUsbOneLibraryFixture } from './usbOneLibraryFixtureSupport'
import { assertNativeBankCueProfileCases } from './usbOneLibraryBankCue.fixture'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-one-library-'))
const root = path.join(directory, 'usb')
const original = path.join(root, 'PIONEER', 'rekordbox', 'exportLibrary.db')
fs.mkdirSync(path.dirname(original), { recursive: true })
const assertEncrypted = (databasePath: string) => {
  assert.notEqual(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\0')
}

function copyFixture(name: string) {
  const destination = path.join(directory, `${name}.db`)
  fs.copyFileSync(original, destination)
  return destination
}

function query<T>(databasePath: string, sql: string): T[] {
  const db = openUsbOneLibraryDatabase(databasePath, true)
  try {
    return db.prepare<[], T>(sql).all()
  } finally {
    db.close()
  }
}

function readAnlzOnlyDatabaseState(databasePath: string) {
  const db = openUsbOneLibraryDatabase(databasePath, true)
  try {
    return {
      content: db.prepare('SELECT * FROM content ORDER BY content_id').all(),
      property: db.prepare('SELECT * FROM property').all(),
      journal: db.pragma('journal_mode', { simple: true }),
      cueCount: db.prepare('SELECT COUNT(*) AS total FROM cue').get()!.total,
      bankCueCount: db.prepare('SELECT COUNT(*) AS total FROM hotCueBankList_cue').get()!.total
    }
  } finally {
    db.close()
  }
}

function assertAnlzOnlyAnalysisWritePreservesDatabase(
  databasePath: string,
  mutation: UsbLibraryMutation,
  dbVersion: string
) {
  const before = fs.readFileSync(databasePath)
  const beforeState = readAnlzOnlyDatabaseState(databasePath)
  mutateUsbOneLibraryCopy(databasePath, mutation, root)
  assert.deepEqual(fs.readFileSync(databasePath), before)
  const afterState = readAnlzOnlyDatabaseState(databasePath)
  assert.deepEqual(afterState, beforeState)
  assert.equal(afterState.cueCount, 0)
  assert.equal(afterState.bankCueCount, 0)
  assert.deepEqual(
    afterState.property.map((row) => row.dbVersion),
    [dbVersion]
  )
  assertEncrypted(databasePath)
}

function runCases() {
  assertNativeBankCueProfileCases(copyFixture, root)
  const before = fs.readFileSync(original)
  const snapshot = readUsbOneLibrarySnapshot(original)
  assert.deepEqual(
    snapshot.tracks.map((track) => track.id),
    [1, 2, 3]
  )
  assert.equal(snapshot.tracks[2].artworkPath, '/PIONEER/rekordbox/artwork/shared.jpg')
  assert.throws(() => mutateUsbOneLibraryCopy(original, emptyUsbMutation(), root), /暂存副本/)

  const ordered = copyFixture('order')
  const reorder = emptyUsbMutation()
  reorder.reorders = [{ playlistId: 11, trackIds: [2, 1] }]
  mutateUsbOneLibraryCopy(ordered, reorder, root)
  assert.deepEqual(
    readUsbOneLibrarySnapshot(ordered)
      .entries.filter((entry) => entry.playlistId === 11)
      .map((entry) => [entry.trackId, entry.entryIndex]),
    [
      [2, 1],
      [1, 2]
    ]
  )
  assert.deepEqual(
    query<{ content_id: number; nativeMarker: string }>(
      ordered,
      'SELECT content_id, nativeMarker FROM playlist_content WHERE playlist_id = 11 ORDER BY sequenceNo'
    ),
    [
      { content_id: 2, nativeMarker: 'second' },
      { content_id: 1, nativeMarker: 'first' }
    ]
  )
  assertEncrypted(ordered)

  const wal = copyFixture('wal-mode')
  const walDb = openUsbOneLibraryDatabase(wal, false)
  walDb.pragma('journal_mode = WAL')
  walDb.close()
  fs.writeFileSync(`${wal}-wal`, Buffer.alloc(0))
  fs.writeFileSync(`${wal}-shm`, Buffer.alloc(32768))
  mutateUsbOneLibraryCopy(wal, reorder, root)
  assert.deepEqual(
    readUsbOneLibrarySnapshot(wal)
      .entries.filter((entry) => entry.playlistId === 11)
      .map((entry) => entry.trackId),
    [2, 1]
  )
  assertEncrypted(wal)
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert.equal(fs.existsSync(`${wal}${suffix}`), false)
  fs.writeFileSync(`${wal}-wal`, Buffer.from('unmerged'))
  assert.throws(() => mutateUsbOneLibraryCopy(wal, reorder, root), /未合并/)
  fs.unlinkSync(`${wal}-wal`)

  const added = copyFixture('addition')
  const add = emptyUsbMutation()
  add.additions = [{ playlistId: 12, trackIds: [1, 2] }]
  mutateUsbOneLibraryCopy(added, add, root)
  const afterAdd = readUsbOneLibrarySnapshot(added)
  assert.equal(afterAdd.entries.filter((entry) => entry.playlistId === 11).length, 2)
  assert.deepEqual(
    afterAdd.entries.filter((entry) => entry.playlistId === 12).map((entry) => entry.trackId),
    [2, 1]
  )
  const remove = emptyUsbMutation()
  remove.removals = [{ playlistId: 12, trackIds: [2] }]
  mutateUsbOneLibraryCopy(added, remove, root)
  assert.deepEqual(
    readUsbOneLibrarySnapshot(added).entries.filter((entry) => entry.playlistId === 12),
    [{ playlistId: 12, trackId: 1, entryIndex: 1 }]
  )

  const removed = copyFixture('deletion')
  const deletion = emptyUsbMutation()
  deletion.deleteTrackIds = [1]
  deletion.deletePlaylistIds = [10, 11]
  mutateUsbOneLibraryCopy(removed, deletion, root)
  assert.deepEqual(
    readUsbOneLibrarySnapshot(removed).tracks.map((track) => track.id),
    [2, 3]
  )
  for (const table of ['cue', 'hotCueBankList_cue'])
    assert.equal(query(removed, `SELECT * FROM ${table}`).length, 0)
  assert.deepEqual(query(removed, 'SELECT content_id FROM history_content'), [{ content_id: 2 }])
  assert.deepEqual(query(removed, 'SELECT content_id FROM myTag_content'), [{ content_id: 2 }])
  assert.deepEqual(query(removed, 'SELECT content_id_1, content_id_2 FROM recommendedLike'), [
    { content_id_1: 2, content_id_2: 3 }
  ])
  assert.deepEqual(query(removed, 'SELECT numberOfContents FROM property'), [
    { numberOfContents: 2 }
  ])
  assert.equal(query(removed, 'SELECT * FROM image').length, 1)

  const artwork = copyFixture('artwork-protection')
  const artworkDb = openUsbOneLibraryDatabase(artwork, false)
  artworkDb.exec(`INSERT INTO image VALUES (2, '/PIONEER/rekordbox/artwork/album.jpg');
    INSERT INTO image VALUES (3, '/PIONEER/rekordbox/artwork/orphan.jpg');
    INSERT INTO image VALUES (4, '/PIONEER/rekordbox/artwork/orphan.jpg');
    CREATE TABLE album (album_id INTEGER PRIMARY KEY, image_id INTEGER REFERENCES image(image_id));
    INSERT INTO album VALUES (17, 2);
    UPDATE content SET image_id = 2 WHERE content_id = 2;
    UPDATE content SET image_id = 3 WHERE content_id = 1;`)
  artworkDb.close()
  assert.deepEqual(readUsbOneLibrarySnapshot(artwork).protectedArtworkPaths, [
    '/PIONEER/rekordbox/artwork/album.jpg'
  ])
  const artworkDelete = emptyUsbMutation()
  artworkDelete.deleteTrackIds = [1, 2]
  mutateUsbOneLibraryCopy(artwork, artworkDelete, root)
  assert.deepEqual(query(artwork, 'SELECT image_id FROM image ORDER BY image_id'), [
    { image_id: 1 },
    { image_id: 2 }
  ])
  assert.deepEqual(readUsbOneLibrarySnapshot(artwork).protectedArtworkPaths, [
    '/PIONEER/rekordbox/artwork/album.jpg'
  ])

  const cues = copyFixture('cues')
  const cueMutation = emptyUsbMutation()
  cueMutation.cueUpdates = [
    {
      trackId: 1,
      hotCues: [
        { slot: 0, sec: 1, comment: 'updated', colorIndex: 5 },
        { slot: 1, sec: 2, loopEndSec: 4, activeLoop: false, colorIndex: 9 }
      ],
      memoryCues: [{ sec: 2, loopEndSec: 4, activeLoop: true }]
    }
  ]
  mutateUsbOneLibraryCopy(cues, cueMutation, root)
  const cueRows = query<Record<string, unknown>>(cues, 'SELECT * FROM cue ORDER BY cue_id')
  assert.equal(cueRows.length, 3)
  assert.equal(cueRows[0].inMpegAbs, 12345)
  assert.equal(cueRows[0].inDecodingStartFramePosition, 70)
  assert.equal(cueRows[0].nativeMarker, 'native-point')
  assert.equal(cueRows[0].cueComment, 'updated')
  assert.equal(cueRows[0].colorTableIndex, 5)
  assert.equal(cueRows[1].isActiveLoop, 1)
  assert.equal(cueRows[2].outMpegAbs, 98765)
  assert.equal(cueRows[2].OutFileOffsetInBlock, 76)
  assert.equal(cueRows[2].beatLoopNumerator, 4)
  assert.equal(query(cues, 'SELECT * FROM hotCueBankList_cue').length, 2)
  assert.deepEqual(
    query(cues, 'SELECT hasModified, cueUpdateCount FROM content WHERE content_id = 1'),
    [{ hasModified: 1, cueUpdateCount: 5 }]
  )

  const unchangedCueBytes = fs.readFileSync(cues)
  mutateUsbOneLibraryCopy(cues, cueMutation, root)
  assert.deepEqual(fs.readFileSync(cues), unchangedCueBytes)
  assert.deepEqual(query(cues, 'SELECT * FROM cue ORDER BY cue_id'), cueRows)
  assert.deepEqual(
    query(cues, 'SELECT hasModified, cueUpdateCount FROM content WHERE content_id = 1'),
    [{ hasModified: 1, cueUpdateCount: 5 }]
  )

  const loopBeats = copyFixture('editable-loop-beats')
  const changedLoopBeats = emptyUsbMutation()
  changedLoopBeats.cueUpdates = [
    {
      trackId: 1,
      hotCues: [
        { slot: 0, sec: 1 },
        {
          slot: 1,
          sec: 2,
          loopEndSec: 4,
          activeLoop: false,
          loopNumerator: 1,
          loopDenominator: 2
        }
      ],
      memoryCues: [
        { sec: 2, loopEndSec: 4, activeLoop: true, loopNumerator: 8, loopDenominator: 1 }
      ]
    }
  ]
  mutateUsbOneLibraryCopy(loopBeats, changedLoopBeats, root)
  const editedBeatRows = query<Record<string, unknown>>(
    loopBeats,
    'SELECT * FROM cue ORDER BY cue_id'
  )
  assert.deepEqual(
    editedBeatRows.map((row) => [row.kind, row.beatLoopNumerator, row.beatLoopDenominator]),
    [
      [1, 0, 0],
      [0, 8, 1],
      [2, 1, 2]
    ]
  )
  for (const row of editedBeatRows.slice(1)) {
    for (const name of [
      'inUsec',
      'outUsec',
      'in150FramePerSec',
      'out150FramePerSec',
      'inMpegFrameNumber',
      'outMpegFrameNumber',
      'inMpegAbs',
      'outMpegAbs',
      'inDecodingStartFramePosition',
      'outDecodingStartFramePosition',
      'inFileOffsetInBlock',
      'OutFileOffsetInBlock',
      'inNumberOfSampleInBlock',
      'outNumberOfSampleInBlock'
    ])
      assert.equal(row[name], cueRows[1][name])
  }
  const loopBeatsBytes = fs.readFileSync(loopBeats)
  mutateUsbOneLibraryCopy(loopBeats, changedLoopBeats, root)
  assert.deepEqual(fs.readFileSync(loopBeats), loopBeatsBytes)
  // Omission preserves each template's own beat ratio at a shared seek position.
  const omittedLoopBeats = emptyUsbMutation()
  omittedLoopBeats.cueUpdates = [
    {
      trackId: 1,
      hotCues: [
        { slot: 0, sec: 1 },
        { slot: 1, sec: 2, loopEndSec: 4, activeLoop: false }
      ],
      memoryCues: [{ sec: 2, loopEndSec: 4, activeLoop: true }]
    }
  ]
  mutateUsbOneLibraryCopy(loopBeats, omittedLoopBeats, root)
  assert.deepEqual(fs.readFileSync(loopBeats), loopBeatsBytes)
  assert.deepEqual(query(loopBeats, 'SELECT * FROM hotCueBankList_cue'), [
    { hotCueBankList_id: 9, cue_id: 101, sequenceNo: 1 },
    { hotCueBankList_id: 9, cue_id: 102, sequenceNo: 2 }
  ])
  for (const fields of [
    { loopNumerator: 8 },
    { loopNumerator: 3, loopDenominator: 1 },
    { loopNumerator: 8, loopDenominator: 2 }
  ]) {
    const invalidBeatMutation = emptyUsbMutation()
    invalidBeatMutation.cueUpdates = [
      { trackId: 1, hotCues: [], memoryCues: [{ sec: 2, loopEndSec: 4, ...fields }] }
    ]
    assert.throws(() => mutateUsbOneLibraryCopy(loopBeats, invalidBeatMutation, root), /Loop 拍数/)
    assert.deepEqual(fs.readFileSync(loopBeats), loopBeatsBytes)
  }
  const singlePointBeats = emptyUsbMutation()
  singlePointBeats.cueUpdates = [
    {
      trackId: 1,
      hotCues: [{ slot: 0, sec: 1, loopNumerator: 8, loopDenominator: 1 }],
      memoryCues: []
    }
  ]
  assert.throws(() => mutateUsbOneLibraryCopy(loopBeats, singlePointBeats, root), /Loop 拍数/)
  assert.deepEqual(fs.readFileSync(loopBeats), loopBeatsBytes)

  const hotFromMemory = copyFixture('hot-loop-from-active-memory')
  const copyActiveLoopToHot = emptyUsbMutation()
  copyActiveLoopToHot.cueUpdates = [
    {
      trackId: 1,
      hotCues: [
        { slot: 0, sec: 1 },
        { slot: 1, sec: 2, loopEndSec: 4 }
      ],
      memoryCues: [{ sec: 2, loopEndSec: 4, activeLoop: true }]
    }
  ]
  mutateUsbOneLibraryCopy(hotFromMemory, copyActiveLoopToHot, root)
  assert.deepEqual(query(hotFromMemory, 'SELECT kind, isActiveLoop FROM cue ORDER BY cue_id'), [
    { kind: 1, isActiveLoop: 0 },
    { kind: 0, isActiveLoop: 1 },
    { kind: 2, isActiveLoop: 0 }
  ])
  const invalidHotActiveBytes = fs.readFileSync(hotFromMemory)
  copyActiveLoopToHot.cueUpdates[0].hotCues[1].activeLoop = true
  assert.throws(
    () => mutateUsbOneLibraryCopy(hotFromMemory, copyActiveLoopToHot, root),
    /Active Loop 必须是 Memory Loop/
  )
  assert.deepEqual(fs.readFileSync(hotFromMemory), invalidHotActiveBytes)

  const nullableLocators = copyFixture('nullable-native-locators')
  const nullableDb = openUsbOneLibraryDatabase(nullableLocators, false)
  const nullableColumns = [
    'beatLoopNumerator',
    'beatLoopDenominator',
    'in150FramePerSec',
    'out150FramePerSec',
    'inMpegFrameNumber',
    'outMpegFrameNumber',
    'inMpegAbs',
    'outMpegAbs',
    'inDecodingStartFramePosition',
    'outDecodingStartFramePosition',
    'inFileOffsetInBlock',
    'OutFileOffsetInBlock',
    'inNumberOfSampleInBlock',
    'outNumberOfSampleInBlock'
  ]
  nullableDb.exec(`UPDATE cue SET ${nullableColumns.map((name) => `${name} = NULL`).join(', ')}`)
  nullableDb.close()
  const unchangedPositions = emptyUsbMutation()
  unchangedPositions.cueUpdates = [
    {
      trackId: 1,
      hotCues: [{ slot: 0, sec: 1, comment: 'keep native null locators', colorIndex: 5 }],
      memoryCues: [{ sec: 2, loopEndSec: 4, activeLoop: true }]
    }
  ]
  mutateUsbOneLibraryCopy(nullableLocators, unchangedPositions, root)
  const preservedNullable = query<Record<string, unknown>>(
    nullableLocators,
    'SELECT * FROM cue ORDER BY cue_id'
  )
  assert.equal(preservedNullable.length, 2)
  for (const row of preservedNullable) {
    for (const name of nullableColumns) assert.equal(row[name], null)
  }
  assert.equal(preservedNullable[0].cueComment, 'keep native null locators')
  assert.equal(preservedNullable[0].colorTableIndex, 5)
  assert.deepEqual(query(nullableLocators, 'SELECT * FROM hotCueBankList_cue'), [
    { hotCueBankList_id: 9, cue_id: 101, sequenceNo: 1 },
    { hotCueBankList_id: 9, cue_id: 102, sequenceNo: 2 }
  ])
  const nullablePositionChange = emptyUsbMutation()
  nullablePositionChange.cueUpdates = [
    { trackId: 1, hotCues: [{ slot: 0, sec: 1.234 }], memoryCues: [] }
  ]
  assert.throws(
    () => mutateUsbOneLibraryCopy(nullableLocators, nullablePositionChange, root),
    /定位字段/
  )
  assert.deepEqual(query(nullableLocators, 'SELECT * FROM cue ORDER BY cue_id'), preservedNullable)

  const malformedLocator = copyFixture('malformed-native-locator')
  const malformedDb = openUsbOneLibraryDatabase(malformedLocator, false)
  malformedDb.exec("UPDATE cue SET inMpegAbs = 'not-a-native-integer' WHERE cue_id = 101")
  malformedDb.close()
  assert.throws(
    () => mutateUsbOneLibraryCopy(malformedLocator, unchangedPositions, root),
    /定位字段不完整/
  )

  const nativeMicroseconds = copyFixture('native-microseconds')
  const microsecondsDb = openUsbOneLibraryDatabase(nativeMicroseconds, false)
  microsecondsDb.exec(`UPDATE cue SET inUsec = 1000499 WHERE cue_id = 101;
    UPDATE cue SET inUsec = 1999510, outUsec = 4000499 WHERE cue_id = 102`)
  microsecondsDb.close()
  const preciseNativeBefore = query<Record<string, unknown>>(
    nativeMicroseconds,
    'SELECT * FROM cue ORDER BY cue_id'
  )
  mutateUsbOneLibraryCopy(nativeMicroseconds, unchangedPositions, root)
  const preciseNativeAfter = query<Record<string, unknown>>(
    nativeMicroseconds,
    'SELECT * FROM cue ORDER BY cue_id'
  )
  assert.deepEqual(
    preciseNativeAfter.map((row) => row.cue_id),
    [101, 102]
  )
  assert.equal(preciseNativeAfter[0].inUsec, 1000499)
  assert.equal(preciseNativeAfter[1].inUsec, 1999510)
  assert.equal(preciseNativeAfter[1].outUsec, 4000499)
  for (const [index, row] of preciseNativeAfter.entries()) {
    for (const name of nullableColumns) assert.equal(row[name], preciseNativeBefore[index][name])
  }
  assert.deepEqual(query(nativeMicroseconds, 'SELECT * FROM hotCueBankList_cue'), [
    { hotCueBankList_id: 9, cue_id: 101, sequenceNo: 1 },
    { hotCueBankList_id: 9, cue_id: 102, sequenceNo: 2 }
  ])

  const ambiguousNative = copyFixture('ambiguous-native-microseconds')
  const ambiguousDb = openUsbOneLibraryDatabase(ambiguousNative, false)
  ambiguousDb.exec(`INSERT INTO cue SELECT 103,content_id,2,colorTableIndex,cueComment,
    isActiveLoop,beatLoopNumerator,beatLoopDenominator,1000499,outUsec,
    in150FramePerSec,out150FramePerSec,inMpegFrameNumber,outMpegFrameNumber,inMpegAbs,outMpegAbs,
    inDecodingStartFramePosition,outDecodingStartFramePosition,inFileOffsetInBlock,OutFileOffsetInBlock,
    inNumberOfSampleInBlock,outNumberOfSampleInBlock,nativeMarker FROM cue WHERE cue_id = 101`)
  ambiguousDb.close()
  const ambiguousBefore = query(ambiguousNative, 'SELECT * FROM cue ORDER BY cue_id')
  assert.throws(
    () => mutateUsbOneLibraryCopy(ambiguousNative, unchangedPositions, root),
    /同一毫秒位置.*多个不同/
  )
  assert.deepEqual(query(ambiguousNative, 'SELECT * FROM cue ORDER BY cue_id'), ambiguousBefore)

  const conflictingLocator = copyFixture('conflicting-native-seek')
  const conflictingDb = openUsbOneLibraryDatabase(conflictingLocator, false)
  conflictingDb.exec(`INSERT INTO cue SELECT 103,content_id,2,colorTableIndex,cueComment,
    isActiveLoop,beatLoopNumerator,beatLoopDenominator,inUsec,outUsec,
    in150FramePerSec,out150FramePerSec,inMpegFrameNumber,outMpegFrameNumber,inMpegAbs + 1,outMpegAbs,
    inDecodingStartFramePosition,outDecodingStartFramePosition,inFileOffsetInBlock,OutFileOffsetInBlock,
    inNumberOfSampleInBlock,outNumberOfSampleInBlock,nativeMarker FROM cue WHERE cue_id = 101`)
  conflictingDb.close()
  assert.throws(
    () => mutateUsbOneLibraryCopy(conflictingLocator, unchangedPositions, root),
    /同一毫秒位置.*多个不同/
  )

  const anlzOnly = copyFixture('anlz-only-profile')
  const anlzDb = openUsbOneLibraryDatabase(anlzOnly, false)
  anlzDb.exec(`DELETE FROM hotCueBankList_cue; DELETE FROM cue;
    UPDATE content SET cueUpdateCount = NULL WHERE content_id = 1;
    UPDATE content SET hasModified = 1 WHERE content_id = 2`)
  anlzDb.close()
  const newPositions = emptyUsbMutation()
  newPositions.cueUpdates = [
    {
      trackId: 1,
      hotCues: [
        { slot: 0, sec: 1.234, color: '#123456', comment: 'new point' },
        { slot: 7, sec: 3.456, loopEndSec: 6.789, activeLoop: false }
      ],
      memoryCues: [{ sec: 9.123, loopEndSec: 12.234, activeLoop: true }]
    }
  ]
  assertAnlzOnlyAnalysisWritePreservesDatabase(anlzOnly, newPositions, '10000')

  const anlzVersion1000 = copyFixture('anlz-only-version-1000')
  const version1000Db = openUsbOneLibraryDatabase(anlzVersion1000, false)
  version1000Db.exec(
    "DELETE FROM hotCueBankList_cue; DELETE FROM cue; UPDATE property SET dbVersion = '1000'"
  )
  assert.equal(version1000Db.pragma('journal_mode = WAL', { simple: true }), 'wal')
  version1000Db.close()
  assertAnlzOnlyAnalysisWritePreservesDatabase(anlzVersion1000, newPositions, '1000')

  for (const [databasePath, dbVersion] of [
    [anlzOnly, '10000'],
    [anlzVersion1000, '1000']
  ]) {
    for (const offsetMs of [-25, 0, 25]) {
      const gridOnly = emptyUsbMutation()
      gridOnly.gridUpdates = [{ trackId: 1, offsetMs }]
      assertAnlzOnlyAnalysisWritePreservesDatabase(databasePath, gridOnly, dbVersion)
    }
    const cuesAndGrid = { ...newPositions, gridUpdates: [{ trackId: 1, offsetMs: 25 }] }
    assertAnlzOnlyAnalysisWritePreservesDatabase(databasePath, cuesAndGrid, dbVersion)
    const beforeInvalid = fs.readFileSync(databasePath)
    for (const offsetMs of [0.5, 60001, -60001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalidGrid = emptyUsbMutation()
      invalidGrid.gridUpdates = [{ trackId: 1, offsetMs }]
      assert.throws(() => mutateUsbOneLibraryCopy(databasePath, invalidGrid, root), /网格平移量/)
      assert.deepEqual(fs.readFileSync(databasePath), beforeInvalid)
    }
    const unknownGridTrack = emptyUsbMutation()
    unknownGridTrack.gridUpdates = [{ trackId: 999, offsetMs: 25 }]
    assert.throws(
      () => mutateUsbOneLibraryCopy(databasePath, unknownGridTrack, root),
      /未找到目标歌曲/
    )
    assert.deepEqual(fs.readFileSync(databasePath), beforeInvalid)
    const mixedBefore = readAnlzOnlyDatabaseState(databasePath)
    mutateUsbOneLibraryCopy(
      databasePath,
      { ...cuesAndGrid, additions: [{ playlistId: 12, trackIds: [1] }] },
      root
    )
    const mixedAfter = readAnlzOnlyDatabaseState(databasePath)
    assert.deepEqual(mixedAfter.content, mixedBefore.content)
    assert.deepEqual(mixedAfter.property, mixedBefore.property)
    assert.equal(mixedAfter.cueCount, 0)
    assert.equal(mixedAfter.bankCueCount, 0)
    assert.deepEqual(
      query(
        databasePath,
        'SELECT content_id FROM playlist_content WHERE playlist_id = 12 ORDER BY sequenceNo'
      ),
      [{ content_id: 2 }, { content_id: 1 }]
    )
  }

  const brokenAnlzOnly = copyFixture('anlz-only-invalid-foreign-key')
  const brokenAnlzDb = openUsbOneLibraryDatabase(brokenAnlzOnly, false)
  brokenAnlzDb.pragma('foreign_keys = OFF')
  brokenAnlzDb.exec(`DELETE FROM hotCueBankList_cue; DELETE FROM cue;
    INSERT INTO playlist_content VALUES (11, 999, 3, 'orphan')`)
  brokenAnlzDb.close()
  const brokenGrid = emptyUsbMutation()
  brokenGrid.gridUpdates = [{ trackId: 1, offsetMs: 25 }]
  const brokenBefore = fs.readFileSync(brokenAnlzOnly)
  assert.throws(() => mutateUsbOneLibraryCopy(brokenAnlzOnly, brokenGrid, root), /外键检查失败/)
  assert.deepEqual(fs.readFileSync(brokenAnlzOnly), brokenBefore)

  const unknownProfile = copyFixture('unknown-profile')
  const unknownProfileDb = openUsbOneLibraryDatabase(unknownProfile, false)
  unknownProfileDb.exec(
    "DELETE FROM hotCueBankList_cue; DELETE FROM cue; UPDATE property SET dbVersion = 'unknown'"
  )
  unknownProfileDb.close()
  const unknownPositions = emptyUsbMutation()
  unknownPositions.cueUpdates = [{ trackId: 1, hotCues: [{ slot: 0, sec: 1.234 }], memoryCues: [] }]
  assert.throws(() => mutateUsbOneLibraryCopy(unknownProfile, unknownPositions, root), /定位字段/)

  const originallySql = copyFixture('original-sql-profile')
  const switching = emptyUsbMutation()
  switching.cueUpdates = [
    { trackId: 1, hotCues: [], memoryCues: [] },
    { trackId: 2, hotCues: [{ slot: 0, sec: 1.234 }], memoryCues: [] }
  ]
  assert.throws(() => mutateUsbOneLibraryCopy(originallySql, switching, root), /定位字段/)
  assert.equal(query(originallySql, 'SELECT * FROM cue').length, 2)

  const rollback = copyFixture('rollback')
  const bad = emptyUsbMutation()
  bad.additions = [{ playlistId: 12, trackIds: [1] }]
  bad.cueUpdates = [{ trackId: 1, hotCues: [{ slot: 0, sec: 1.25 }], memoryCues: [] }]
  assert.throws(() => mutateUsbOneLibraryCopy(rollback, bad, root), /定位字段/)
  assert.deepEqual(readUsbOneLibrarySnapshot(rollback), snapshot)
  assert.equal(query(rollback, 'SELECT * FROM hotCueBankList_cue').length, 2)
  assert.deepEqual(query(rollback, 'SELECT cueUpdateCount FROM content WHERE content_id = 1'), [
    { cueUpdateCount: 4 }
  ])

  const invalidOrder = emptyUsbMutation()
  invalidOrder.reorders = [{ playlistId: 11, trackIds: [1] }]
  assert.throws(() => mutateUsbOneLibraryCopy(rollback, invalidOrder, root), /全部成员/)
  const folder = emptyUsbMutation()
  folder.deletePlaylistIds = [10]
  assert.throws(() => mutateUsbOneLibraryCopy(rollback, folder, root), /所有子歌单/)

  const grid = emptyUsbMutation()
  grid.gridUpdates = [{ trackId: 1, offsetMs: 25 }]
  mutateUsbOneLibraryCopy(rollback, grid, root)
  assert.deepEqual(
    query(
      rollback,
      'SELECT hasModified, analysisDataUpdateCount FROM content WHERE content_id = 1'
    ),
    [{ hasModified: 1, analysisDataUpdateCount: 8 }]
  )

  const unknown = copyFixture('unknown-reference')
  const db = openUsbOneLibraryDatabase(unknown, false)
  db.exec('CREATE TABLE unknownUsage (content_id INTEGER); INSERT INTO unknownUsage VALUES (1)')
  db.close()
  assert.throws(() => mutateUsbOneLibraryCopy(unknown, deletion, root), /未支持.*引用/)
  assert.equal(readUsbOneLibrarySnapshot(unknown).tracks.length, 3)
  assert.deepEqual(fs.readFileSync(original), before)
}

try {
  for (const profile of [null, 4]) {
    if (fs.existsSync(original)) fs.unlinkSync(original)
    createUsbOneLibraryFixture(original, profile)
    assertEncrypted(original)
    runCases()
  }
  process.stdout.write(
    'OneLibrary encrypted fixture checks passed (default + SQLCipher legacy=4)\n'
  )
} finally {
  const resolved = path.resolve(directory)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('frkb-one-library-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}
