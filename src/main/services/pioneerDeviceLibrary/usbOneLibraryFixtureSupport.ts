import fs from 'node:fs'
import path from 'node:path'
import {
  USB_ONE_LIBRARY_KEY,
  type UsbOneLibraryDatabaseConstructor
} from './usbOneLibraryConnection'

/** Synthetic encrypted device database; never import a real library as a test fixture. */
export function createUsbOneLibraryFixture(
  databasePath: string,
  legacy: number | null = null,
  anlzOnly = false
): void {
  if (!path.isAbsolute(databasePath) || fs.existsSync(databasePath)) {
    throw new Error('OneLibrary 测试数据库必须写入不存在的绝对路径')
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const Constructor = require('better-sqlite3-multiple-ciphers') as UsbOneLibraryDatabaseConstructor
  const db = new Constructor(databasePath)
  try {
    db.pragma("cipher = 'sqlcipher'")
    if (legacy !== null) db.pragma(`legacy = ${legacy}`)
    db.pragma(`key = '${USB_ONE_LIBRARY_KEY}'`)
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE image (image_id INTEGER PRIMARY KEY, path TEXT);
      CREATE TABLE content (content_id INTEGER PRIMARY KEY, path TEXT, analysisDataFilePath TEXT,
        image_id INTEGER REFERENCES image(image_id), hasModified INTEGER, cueUpdateCount INTEGER,
        analysisDataUpdateCount INTEGER, informationUpdateCount INTEGER);
      CREATE TABLE playlist (playlist_id INTEGER PRIMARY KEY, sequenceNo INTEGER, name TEXT,
        attribute INTEGER, playlist_id_parent INTEGER REFERENCES playlist(playlist_id));
      CREATE TABLE playlist_content (playlist_id INTEGER REFERENCES playlist(playlist_id),
        content_id INTEGER REFERENCES content(content_id), sequenceNo INTEGER CHECK(sequenceNo > 0),
        nativeMarker TEXT DEFAULT 'native', PRIMARY KEY(playlist_id, content_id),
        UNIQUE(playlist_id, sequenceNo));
      CREATE TABLE property (numberOfContents INTEGER, dbVersion TEXT);
      CREATE TABLE cue (cue_id INTEGER PRIMARY KEY, content_id INTEGER REFERENCES content(content_id),
        kind INTEGER, colorTableIndex INTEGER, cueComment TEXT, isActiveLoop INTEGER,
        beatLoopNumerator INTEGER, beatLoopDenominator INTEGER, inUsec INTEGER, outUsec INTEGER,
        in150FramePerSec INTEGER, out150FramePerSec INTEGER,
        inMpegFrameNumber INTEGER, outMpegFrameNumber INTEGER, inMpegAbs INTEGER, outMpegAbs INTEGER,
        inDecodingStartFramePosition INTEGER, outDecodingStartFramePosition INTEGER,
        inFileOffsetInBlock INTEGER, OutFileOffsetInBlock INTEGER,
        inNumberOfSampleInBlock INTEGER, outNumberOfSampleInBlock INTEGER, nativeMarker TEXT);
      CREATE TABLE hotCueBankList_cue (hotCueBankList_id INTEGER,
        cue_id INTEGER REFERENCES cue(cue_id), sequenceNo INTEGER);
      CREATE TABLE history_content (history_id INTEGER,
        content_id INTEGER REFERENCES content(content_id), sequenceNo INTEGER);
      CREATE TABLE myTag_content (myTag_id INTEGER, content_id INTEGER REFERENCES content(content_id));
      CREATE TABLE recommendedLike (content_id_1 INTEGER REFERENCES content(content_id),
        content_id_2 INTEGER REFERENCES content(content_id), rating INTEGER);
      INSERT INTO image VALUES (1, '/PIONEER/rekordbox/artwork/shared.jpg');
      INSERT INTO content VALUES (1, '/Contents/one.mp3', '/PIONEER/USBANLZ/one/ANLZ0000.DAT', 1, 0, 4, 7, 9);
      INSERT INTO content VALUES (2, '/Contents/two.mp3', '/PIONEER/USBANLZ/two/ANLZ0000.DAT', 1, 0, 0, 0, 0);
      INSERT INTO content VALUES (3, '/Contents/unlisted.mp3', '/PIONEER/USBANLZ/three/ANLZ0000.DAT', 1, 0, 0, 0, 0);
      INSERT INTO playlist VALUES (10, 1, 'Folder', 1, NULL), (11, 1, 'A', 0, 10), (12, 2, 'B', 0, NULL);
      INSERT INTO playlist_content VALUES (11, 1, 1, 'first'), (11, 2, 2, 'second'), (12, 2, 1, 'shared');
      INSERT INTO property VALUES (3, '10000');
      INSERT INTO cue VALUES (101, 1, 1, 1, 'point', 0, 0, 0, 1000000, -1,
        150, 0, 73, 0, 12345, 0, 70, 0, 52, 0, 576, 0, 'native-point');
      INSERT INTO cue VALUES (102, 1, 0, 2, 'loop', 1, 4, 1, 2000000, 4000000,
        300, 600, 144, 290, 54321, 98765, 140, 285, 23, 76, 576, 576, 'native-loop');
      INSERT INTO hotCueBankList_cue VALUES (9, 101, 1), (9, 102, 2);
      INSERT INTO history_content VALUES (7, 1, 1), (7, 2, 2);
      INSERT INTO myTag_content VALUES (8, 1), (8, 2);
      INSERT INTO recommendedLike VALUES (1, 2, 5), (2, 3, 4);
    `)
    if (anlzOnly) db.exec('DELETE FROM hotCueBankList_cue; DELETE FROM cue')
  } finally {
    db.close()
  }
}
