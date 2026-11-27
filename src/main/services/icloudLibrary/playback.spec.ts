import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IcloudPlayback } from './playback'
let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-icloud-play-')))
  await fs.writeFile(path.join(root, 'song #1.mp3'), 'audio')
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
describe('iCloud preview authorization', () => {
  it('encodes filenames and rechecks eviction on subsequent range requests', async () => {
    let resident = true
    const playback = new IcloudPlayback(async () => (resident ? 'local' : 'cloud'))
    const file = path.join(root, 'song #1.mp3')
    const url = await playback.issue(root, 'song #1.mp3')
    expect(new URL(url).searchParams.get('path')).toBe(file)
    await expect(playback.validate(url, file)).resolves.toBeUndefined()
    resident = false
    await expect(playback.validate(url, file)).rejects.toThrow('download')
  })
  it('rejects changed paths, invalid tickets, symlink replacements and revoked configuration', async () => {
    const playback = new IcloudPlayback(async () => 'local')
    const file = path.join(root, 'song #1.mp3')
    const url = await playback.issue(root, 'song #1.mp3')
    await expect(playback.validate(url, path.join(root, 'else.mp3'))).rejects.toThrow('boundary')
    await expect(playback.validate('frkb-preview://icloud/?ticket=forged', file)).rejects.toThrow(
      'unavailable'
    )
    await fs.rename(file, path.join(root, 'outside.mp3'))
    await fs.symlink(path.join(root, 'outside.mp3'), file)
    await expect(playback.validate(url, file)).rejects.toThrow('boundary')
    playback.clear()
    await expect(playback.validate(url, file)).rejects.toThrow('unavailable')
  })
})
