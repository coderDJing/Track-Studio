import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getRekordboxDesktopSourceRevision } from './sourceRevision'

const { resolveDbPath } = vi.hoisted(() => ({ resolveDbPath: vi.fn() }))
vi.mock('./detect', () => ({ requireRekordboxDesktopSourceDbPath: resolveDbPath }))

describe('Rekordbox desktop source revision', () => {
  let tempDir = ''

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
    tempDir = ''
    resolveDbPath.mockReset()
  })

  it('stays stable without changes and detects DB and WAL updates', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-rekordbox-revision-'))
    const dbPath = path.join(tempDir, 'master.db')
    await fs.writeFile(dbPath, 'db')
    const original = await getRekordboxDesktopSourceRevision(dbPath)
    expect(await getRekordboxDesktopSourceRevision(dbPath)).toBe(original)

    await fs.writeFile(`${dbPath}-wal`, 'wal')
    const withWal = await getRekordboxDesktopSourceRevision(dbPath)
    expect(withWal).not.toBe(original)

    await fs.writeFile(dbPath, 'updated-db')
    expect(await getRekordboxDesktopSourceRevision(dbPath)).not.toBe(withWal)
  })

  it('uses the lightweight path check and includes the exact path and cause on file errors', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-rekordbox-revision-'))
    const dbPath = path.join(tempDir, 'master.db')
    resolveDbPath.mockResolvedValue(dbPath)
    await fs.writeFile(dbPath, 'db')
    const original = await getRekordboxDesktopSourceRevision()
    expect(original).toBe(await getRekordboxDesktopSourceRevision(dbPath))
    await fs.unlink(dbPath)
    await expect(getRekordboxDesktopSourceRevision()).rejects.toThrow(dbPath)
    await expect(getRekordboxDesktopSourceRevision()).rejects.toThrow('ENOENT')
  })
})
