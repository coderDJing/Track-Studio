import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultIcloudConfig, migrateIcloudConfig, resolveIcloudDriveRoot } from './config'
import { browseIcloudDirectory } from './files'
let root: string
const local = async () => 'local' as const
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-drive-root-')))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
describe('real Drive root, with read-only legacy location migration', () => {
  it('does not invent a music folder; old custom and managed roots become preferences only', () => {
    expect(defaultIcloudConfig()).toEqual({ version: 3, relativeFolder: '', mode: 'drive' })
    expect(migrateIcloudConfig({ version: 1, relativeFolder: '' })).toEqual(defaultIcloudConfig())
    expect(migrateIcloudConfig({ version: 1, relativeFolder: 'Old Music' })).toMatchObject({
      relativeFolder: '',
      mode: 'drive',
      legacyFolder: 'Old Music'
    })
    expect(
      migrateIcloudConfig({
        version: 2,
        mode: 'managed',
        relativeFolder: 'FRKB Music',
        writeAcknowledged: true
      })
    ).toMatchObject({ relativeFolder: '', legacyFolder: 'FRKB Music' })
    expect(
      migrateIcloudConfig({
        version: 3,
        relativeFolder: '',
        mode: 'drive',
        writeAcknowledged: true
      }).writeAcknowledged
    ).toBe(true)
  })
  it.each(['../outside', '/outside', 'a/../../outside', 'bad\0name'])(
    'rejects escaping old preferences %j',
    (relativeFolder) => {
      expect(() => migrateIcloudConfig({ relativeFolder })).toThrow('boundary')
    }
  )
  it('resolves Drive itself despite an absent old custom folder, with no creation side effects', async () => {
    const legacy = migrateIcloudConfig({
      version: 2,
      mode: 'custom',
      relativeFolder: 'Does Not Exist'
    })
    expect(legacy).toMatchObject({ relativeFolder: '', legacyFolder: 'Does Not Exist' })
    expect(await resolveIcloudDriveRoot(root, local)).toBe(root)
    expect(await fs.readdir(root)).toEqual([])
  })
  it('exposes multiple non-music folders and leaves every existing byte and path untouched', async () => {
    for (const folder of ['FRKB Music', 'Documents', 'Empty', 'Old Custom'])
      await fs.mkdir(path.join(root, folder))
    await fs.writeFile(path.join(root, 'Documents/note.txt'), 'unchanged')
    await fs.writeFile(path.join(root, 'Old Custom/song.mp3'), 'unchanged audio')
    const actual = await resolveIcloudDriveRoot(root, local)
    const view = await browseIcloudDirectory(actual, '', local)
    expect(
      view.entries
        .filter((entry) => entry.directory)
        .map((entry) => entry.name)
        .sort()
    ).toEqual(['Documents', 'Empty', 'FRKB Music', 'Old Custom'].sort())
    expect(await fs.readFile(path.join(root, 'Documents/note.txt'), 'utf8')).toBe('unchanged')
    expect(await fs.readFile(path.join(root, 'Old Custom/song.mp3'), 'utf8')).toBe(
      'unchanged audio'
    )
  })
  it('never follows a root symlink or creates a missing Drive path', async () => {
    const link = path.join(root, 'link')
    await fs.symlink(root, link)
    await expect(resolveIcloudDriveRoot(link, local)).rejects.toThrow('boundary')
    await expect(resolveIcloudDriveRoot(path.join(root, 'missing'), local)).rejects.toThrow()
    await expect(fs.access(path.join(root, 'missing'))).rejects.toThrow()
  })
})
