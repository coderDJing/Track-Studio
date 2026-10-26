import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishBpmFixOutput, readBpmFixSourceIdentity } from './bpmFixFiles'

describe('BPM correction publication', () => {
  let folder: string
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-bpm-publication-test-'))
    await Promise.all([
      fs.writeFile(path.join(folder, 'source.mp3'), 'original'),
      fs.writeFile(path.join(folder, 'staged.wav'), 'corrected')
    ])
  })
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true })
  })
  const publish = async (source = readBpmFixSourceIdentity(path.join(folder, 'source.mp3'))) =>
    publishBpmFixOutput({
      source: await source,
      stagedAudio: path.join(folder, 'staged.wav'),
      destination: path.join(folder, 'fixed.wav')
    })

  it('saves only audio without creating a report or changing the source', async () => {
    const result = await publish()
    expect(await fs.readFile(path.join(folder, 'source.mp3'), 'utf8')).toBe('original')
    expect(await fs.readFile(result.outputPath, 'utf8')).toBe('corrected')
    expect((await fs.readdir(folder)).sort()).toEqual(['fixed.wav', 'source.mp3', 'staged.wav'])
  })

  it('does not overwrite a destination created while analysis was running', async () => {
    await fs.writeFile(path.join(folder, 'fixed.wav'), 'existing song')
    await expect(publish()).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path.join(folder, 'fixed.wav'), 'utf8')).toBe('existing song')
  })

  it('does not touch an old sidecar or let it block the audio output', async () => {
    await fs.writeFile(path.join(folder, 'fixed.wav.bpm-fix.json'), 'existing report')
    await publish()
    expect(await fs.readFile(path.join(folder, 'fixed.wav'), 'utf8')).toBe('corrected')
    expect(await fs.readFile(path.join(folder, 'fixed.wav.bpm-fix.json'), 'utf8')).toBe(
      'existing report'
    )
  })

  it('rejects a source changed after processing began', async () => {
    const source = await readBpmFixSourceIdentity(path.join(folder, 'source.mp3'))
    await fs.writeFile(source.realPath, 'source changed during analysis')
    await expect(publish(Promise.resolve(source))).rejects.toThrow('BPM_FIX_SOURCE_CHANGED')
    await expect(fs.access(path.join(folder, 'fixed.wav'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  const replace = async (destination: string, commit?: () => void) =>
    publishBpmFixOutput({
      source: await readBpmFixSourceIdentity(path.join(folder, 'source.mp3')),
      stagedAudio: path.join(folder, 'staged.wav'),
      destination,
      overwrite: true,
      commit
    })

  it('replaces the same path only after verification staging exists', async () => {
    const source = path.join(folder, 'source.mp3')
    await replace(source)
    expect(await fs.readFile(source, 'utf8')).toBe('corrected')
    expect((await fs.readdir(folder)).sort()).toEqual(['source.mp3', 'staged.wav'])
  })

  it('supports a format-changing overwrite without leaving the old song', async () => {
    await replace(path.join(folder, 'source.wav'))
    expect(await fs.readFile(path.join(folder, 'source.wav'), 'utf8')).toBe('corrected')
    await expect(fs.access(path.join(folder, 'source.mp3'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('restores the original if the playlist transaction fails', async () => {
    const source = path.join(folder, 'source.mp3')
    await expect(
      replace(source, () => {
        throw new Error('database failed')
      })
    ).rejects.toThrow('database failed')
    expect(await fs.readFile(source, 'utf8')).toBe('original')
    expect((await fs.readdir(folder)).sort()).toEqual(['source.mp3', 'staged.wav'])
  })

  it('preserves both songs when the format-changing destination collides', async () => {
    const destination = path.join(folder, 'source.wav')
    await fs.writeFile(destination, 'another song')
    await expect(replace(destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path.join(folder, 'source.mp3'), 'utf8')).toBe('original')
    expect(await fs.readFile(destination, 'utf8')).toBe('another song')
  })

  it('does not clobber an external writer during rollback and retains the original backup', async () => {
    const source = path.join(folder, 'source.mp3')
    await expect(
      replace(path.join(folder, 'source.wav'), () => {
        writeFileSync(source, 'external new song')
        throw new Error('commit failed')
      })
    ).rejects.toThrow('BPM_FIX_RECOVERY_REQUIRED')
    expect(await fs.readFile(source, 'utf8')).toBe('external new song')
    const backups = (await fs.readdir(folder)).filter((name) => name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(folder, backups[0]), 'utf8')).toBe('original')
  })
})
