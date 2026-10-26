import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { log } from '../log'
import { normalizeFilePathForComparison } from '../../shared/filePathComparison'

export const readBpmFixSourceIdentity = async (filePath: string) => {
  const realPath = await fs.realpath(filePath)
  const stat = await fs.stat(realPath)
  if (!stat.isFile()) throw new Error('BPM_FIX_INVALID_PATH')
  return { realPath, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }
}

export type BpmFixSource = Awaited<ReturnType<typeof readBpmFixSourceIdentity>>
export const assertBpmFixSourceUnchanged = async (source: BpmFixSource, at = source.realPath) => {
  const current = await readBpmFixSourceIdentity(at)
  if (
    source.size !== current.size ||
    source.mtimeMs !== current.mtimeMs ||
    source.ino !== current.ino
  )
    throw new Error('BPM_FIX_SOURCE_CHANGED')
}

// Preserve the original until the playlist transaction succeeds, including when
// an overwrite changes the extension. No reports or other sidecars are created.
export const publishBpmFixOutput = async (options: {
  source: BpmFixSource
  stagedAudio: string
  destination: string
  overwrite?: boolean
  commit?: (outputPath: string) => void
}) => {
  const { source, stagedAudio, overwrite = false, commit } = options
  const parent = await fs.realpath(path.dirname(options.destination))
  const destination = path.join(parent, path.basename(options.destination))
  const normalize = (value: string) =>
    normalizeFilePathForComparison(path.resolve(value), process.platform === 'win32')
  const samePath = normalize(source.realPath) === normalize(destination)
  if (samePath && !overwrite) throw new Error('BPM_FIX_INVALID_PATH')
  const token = randomUUID()
  const temporary = path.join(parent, `.frkb-bpm-${token}.tmp`)
  const backup = path.join(path.dirname(source.realPath), `.frkb-bpm-${token}.bak`)
  let backedUp = false
  let published = false
  try {
    await fs.copyFile(stagedAudio, temporary, constants.COPYFILE_EXCL)
    await assertBpmFixSourceUnchanged(source)
    if (overwrite) {
      await fs.rename(source.realPath, backup)
      backedUp = true
      await assertBpmFixSourceUnchanged(source, backup)
    }
    // COPYFILE_EXCL also protects a destination created during rendering.
    await fs.copyFile(temporary, destination, constants.COPYFILE_EXCL)
    published = true
    commit?.(destination)
  } catch (error) {
    if (published) await fs.unlink(destination)
    if (backedUp) {
      try {
        // Another application may have recreated the old filename meanwhile.
        // Never replace that new file while recovering the original.
        const stat = await fs.stat(backup)
        await fs.copyFile(backup, source.realPath, constants.COPYFILE_EXCL)
        await fs.utimes(source.realPath, stat.atime, stat.mtime)
        await fs.unlink(backup)
      } catch (recoveryError) {
        log.error('[bpm-fix] original retained in recovery backup', { backup, recoveryError })
        throw new Error(`BPM_FIX_RECOVERY_REQUIRED: ${backup}`, { cause: recoveryError })
      }
    }
    throw error
  } finally {
    await fs
      .rm(temporary, { force: true })
      .catch((error) => log.error('[bpm-fix] temporary audio cleanup failed', { temporary, error }))
  }
  // Cleanup must never roll back a committed database transaction.
  if (backedUp)
    await fs
      .unlink(backup)
      .catch((error) => log.error('[bpm-fix] backup cleanup failed', { backup, error }))
  return { outputPath: destination }
}
