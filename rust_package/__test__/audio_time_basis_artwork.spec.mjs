import test from 'ava'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const ffmpegPath = path.join(
  repoRoot,
  'vendor/ffmpeg',
  process.platform === 'win32' ? 'win32-x64/ffmpeg.exe' : `darwin-${process.arch}/ffmpeg`
)
const syncSafeSize = (length) => Buffer.from([
  (length >> 21) & 127, (length >> 14) & 127, (length >> 7) & 127, length & 127
])

test('native audio probing ignores JPEG artwork mislabeled as PNG', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frkb-artwork-probe-'))
  try {
    const cleanPath = path.join(dir, 'clean.mp3')
    const taggedPath = path.join(dir, 'tagged.mp3')
    const generated = spawnSync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
      '-c:a', 'libmp3lame', '-y', cleanPath
    ], { windowsHide: true, encoding: 'utf8' })
    t.is(generated.status, 0, generated.stderr)
    const mp3 = readFileSync(cleanPath)
    const tagSize = mp3.subarray(6, 10).reduce((size, byte) => (size << 7) | byte, 0)
    const audio = mp3.subarray(mp3.subarray(0, 3).toString() === 'ID3' ? 10 + tagSize : 0)
    // The same JPEG signature reported by the user, declared as image/png in APIC.
    const picture = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
    const apic = Buffer.concat([Buffer.from('\0image/png\0\x03\0', 'binary'), picture])
    const frameHeader = Buffer.alloc(10)
    frameHeader.write('APIC')
    frameHeader.writeUInt32BE(apic.length, 4)
    const tag = Buffer.concat([frameHeader, apic])
    writeFileSync(taggedPath, Buffer.concat([
      Buffer.from('ID3\x03\0\0', 'binary'), syncSafeSize(tag.length), tag, audio
    ]))
    const probe = spawnSync(process.execPath, ['-e', `
      const rust = require('./rust_package');
      (async () => {
        const values = await rust.probeAudioTimeBasisOffsetMsBatch(process.argv.slice(1));
        process.stdout.write(JSON.stringify(values));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, cleanPath, taggedPath], { cwd: repoRoot, windowsHide: true, encoding: 'utf8' })
    t.is(probe.status, 0, probe.stderr)
    const offsets = JSON.parse(probe.stdout)
    t.is(offsets[0], 25.057)
    t.is(offsets[1], offsets[0])
    t.false(probe.stderr.includes('Invalid PNG signature'), probe.stderr)
    t.false(probe.stderr.includes('Could not find codec parameters for stream 1'), probe.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
