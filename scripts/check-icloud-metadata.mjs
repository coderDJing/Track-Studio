import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url),
    electron = require('electron')
  const helper = path.resolve('resources/icloud-native/icloud-localize')
  const worker = path.resolve('out/main/workers/icloudMetadataWorker.js')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-metadata-native-'))
  const root = await fs.realpath(temp)
  const info = await fs.lstat(root),
    rootIdentity = `${root}:${info.dev}:${info.ino}`
  const chunk = (name, data) => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(data.length)
    return Buffer.concat([
      Buffer.from(name),
      size,
      data,
      ...(data.length % 2 ? [Buffer.alloc(1)] : [])
    ])
  }
  const frames = Object.entries({
    TIT2: 'Real title',
    TPE1: 'Real artist',
    TALB: 'Real album',
    TCON: 'House',
    TBPM: '124.5',
    TKEY: 'Am'
  }).map(([key, value]) => {
    const text = Buffer.from('\0' + value),
      header = Buffer.alloc(10)
    header.write(key)
    header.writeUInt32BE(text.length, 4)
    return Buffer.concat([header, text])
  })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64'
  )
  const apic = Buffer.concat([Buffer.from('\0image/png\0\x03\0', 'binary'), png]),
    apicHeader = Buffer.alloc(10)
  apicHeader.write('APIC')
  apicHeader.writeUInt32BE(apic.length, 4)
  frames.push(Buffer.concat([apicHeader, apic]))
  const tags = Buffer.concat(frames),
    id3 = Buffer.alloc(10)
  id3.write('ID3')
  id3[3] = 3
  for (let i = 0; i < 4; i++) id3[9 - i] = (tags.length >>> (i * 7)) & 127
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(8000, 4)
  fmt.writeUInt32LE(16000, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const wave = (tagged) => {
    const body = Buffer.concat([
      Buffer.from('WAVE'),
      chunk('fmt ', fmt),
      chunk('data', Buffer.alloc(32000)),
      ...(tagged ? [chunk('id3 ', Buffer.concat([id3, tags]))] : [])
    ])
    const header = Buffer.alloc(8)
    header.write('RIFF')
    header.writeUInt32LE(body.length, 4)
    return Buffer.concat([header, body])
  }
  try {
    await fs.writeFile(path.join(root, 'tagged.wav'), wave(true))
    await fs.writeFile(path.join(root, 'plain.wav'), wave(false))
    const args = [
      'metadata',
      electron,
      worker,
      root,
      JSON.stringify(['tagged.wav', 'plain.wav', '../outside.wav']),
      rootIdentity
    ]
    const results = JSON.parse(execFileSync(helper, args, { encoding: 'utf8', timeout: 15000 }))
    const [cover] = JSON.parse(
      execFileSync(
        helper,
        [
          'metadata',
          electron,
          worker,
          root,
          JSON.stringify({ paths: ['tagged.wav'], cover: true }),
          rootIdentity
        ],
        { encoding: 'utf8', timeout: 15000 }
      )
    )
    assert.equal(cover.metadata.picture.data, png.toString('base64'))
    assert.match(cover.metadata.picture.hash, /^[a-f0-9]{64}$/)
    assert.equal(results[0].metadata.picture, undefined)
    console.log('iCloud real embedded PNG extraction under materialization-OFF policy passed')
    assert.equal(results[0].metadata.title, 'Real title')
    assert.equal(results[0].metadata.artist, 'Real artist')
    assert.equal(results[0].metadata.album, 'Real album')
    assert.equal(results[0].metadata.duration, '0:02')
    assert.equal(results[0].metadata.bpm, 124.5)
    assert.equal(results[0].metadata.key, 'Am')
    assert.equal(results[1].metadata.bpm, undefined)
    assert.equal(results[1].metadata.key, undefined)
    assert.equal(results[2].metadata, undefined)
    const [stale] = JSON.parse(
      execFileSync(
        helper,
        ['metadata', electron, worker, root, JSON.stringify(['tagged.wav']), `${root}:old:inode`],
        { encoding: 'utf8', timeout: 15000 }
      )
    )
    assert.equal(stale.metadata, undefined)
    // Use only generated temporary audio, never the user's library or cloud files.
    const ffmpeg = path.resolve('vendor/ffmpeg/darwin/ffmpeg')
    if (
      await fs.access(ffmpeg).then(
        () => true,
        () => false
      )
    ) {
      for (const ext of ['mp3', 'flac', 'm4a']) {
        execFileSync(
          ffmpeg,
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            path.join(root, 'plain.wav'),
            '-metadata',
            'title=Encoded title',
            '-metadata',
            'artist=Encoded artist',
            '-metadata',
            'album=Encoded album',
            '-metadata',
            'TBPM=128',
            '-metadata',
            'TKEY=Am',
            path.join(root, `encoded.${ext}`)
          ],
          { timeout: 15000 }
        )
        const [item] = JSON.parse(
          execFileSync(
            helper,
            ['metadata', electron, worker, root, JSON.stringify([`encoded.${ext}`]), rootIdentity],
            { encoding: 'utf8', timeout: 15000 }
          )
        )
        assert.equal(item.metadata.title, 'Encoded title')
        assert.equal(item.metadata.artist, 'Encoded artist')
        assert.equal(item.metadata.album, 'Encoded album')
        assert.equal(item.metadata.duration, '0:02')
      }
      console.log('iCloud metadata generated MP3/FLAC/M4A tag/duration checks passed')
    }
    const code = `process.stdout.write(require('node:child_process').execFileSync(${JSON.stringify(helper)},['materialization-policy']))`
    assert.equal(
      execFileSync(helper, ['metadata', electron, '-e', code, 'unused'], {
        encoding: 'utf8'
      }).trim(),
      '1'
    )
    console.log(
      'iCloud metadata native check passed: real WAV/ID3 tags, duration, absent BPM/key, boundary and inherited materialization-OFF policy'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
