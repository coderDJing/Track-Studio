import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { log } from '../../log'

export const usbFileHash = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export const optionalUsbFileHash = async (filePath: string): Promise<string | null> => {
  try {
    return await usbFileHash(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const usbRelativePath = (root: string, filePath: string): string => {
  const relative = path.relative(root, filePath)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('文件路径超出 U 盘范围')
  return relative
}

/** Device paths begin with '/' relative to the volume, never a host drive prefix. */
export const resolveUsbFile = (root: string, devicePath: string): string => {
  if (!devicePath || /^[a-z]:/i.test(devicePath) || devicePath.startsWith('\\\\'))
    throw new Error('无效 U 盘文件路径')
  const parts = devicePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (
    !parts.length ||
    parts.some((part) => part === '.' || part === '..' || part.includes(':') || part.includes('\0'))
  )
    throw new Error('无效 U 盘文件路径')
  const result = path.resolve(root, ...parts)
  usbRelativePath(root, result)
  return result
}

export const assertUsbFileContainment = async (root: string, filePath: string): Promise<void> => {
  usbRelativePath(root, filePath)
  let candidate = filePath
  while (true) {
    try {
      const real = await fs.realpath(candidate)
      if (path.resolve(real) !== path.resolve(root)) usbRelativePath(root, real)
      const stat = await fs.lstat(candidate)
      if (stat.isSymbolicLink()) throw new Error('U 盘写入不支持符号链接')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(candidate)
      if (parent === candidate) throw new Error('无法校验 U 盘路径')
      candidate = parent
    }
  }
}

export const syncUsbFile = async (filePath: string): Promise<void> => {
  const handle = await fs.open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export type UsbReplacement = { target: string; staged: string }
type JournalEntry = { relative: string; before: string; after: string | null }
type UsbJournal = { version: 1; status: 'committing' | 'committed'; entries: JournalEntry[] }
const journalFolder = (root: string) =>
  path.join(root, 'PIONEER', 'rekordbox', '.frkb-write-transaction')

const writeJournal = async (directory: string, journal: UsbJournal): Promise<void> => {
  const temporary = path.join(directory, 'journal.next.json')
  await fs.writeFile(temporary, JSON.stringify(journal), { flag: 'w' })
  await syncUsbFile(temporary)
  await fs.rename(temporary, path.join(directory, 'journal.json'))
}

const readJournal = (value: unknown): UsbJournal => {
  if (!value || typeof value !== 'object') throw new Error('U 盘恢复记录无效')
  const data = value as Record<string, unknown>
  if (
    data.version !== 1 ||
    !['committing', 'committed'].includes(String(data.status)) ||
    !Array.isArray(data.entries)
  )
    throw new Error('U 盘恢复记录无效')
  const entries = data.entries.map((value): JournalEntry => {
    if (!value || typeof value !== 'object') throw new Error('U 盘恢复条目无效')
    const item = value as Record<string, unknown>
    if (
      typeof item.relative !== 'string' ||
      typeof item.before !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.before) ||
      (item.after !== null &&
        (typeof item.after !== 'string' || !/^[a-f0-9]{64}$/.test(item.after)))
    )
      throw new Error('U 盘恢复条目无效')
    return { relative: item.relative, before: item.before, after: item.after }
  })
  if (new Set(entries.map((item) => item.relative.toLowerCase())).size !== entries.length)
    throw new Error('恢复记录包含重复路径')
  return { version: 1, status: data.status as UsbJournal['status'], entries }
}

/** A interrupted write is restored before preparing another operation on that volume. */
export const recoverUsbWrite = async (root: string): Promise<void> => {
  const directory = journalFolder(root)
  await assertUsbFileContainment(root, directory)
  try {
    await fs.access(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let journal: UsbJournal
  try {
    journal = readJournal(
      JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8'))
    )
  } catch (error) {
    // Staging before a journal is durable never touches library files. Require explicit inspection
    // if a malformed journal exists rather than guessing whether the operation was started.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs.rm(directory, { recursive: true, maxRetries: 3, retryDelay: 100 })
    return
  }
  // Validate every path and hash before restoring even one file.
  for (let index = 0; index < journal.entries.length; index++) {
    const entry = journal.entries[index]
    const target = resolveUsbFile(root, entry.relative)
    if (usbRelativePath(root, target).replace(/\\/g, '/') !== entry.relative.replace(/\\/g, '/'))
      throw new Error('恢复路径不规范')
    await assertUsbFileContainment(root, target)
    if (journal.status === 'committing') {
      const backup = path.join(directory, 'before', String(index))
      await assertUsbFileContainment(root, backup)
      if ((await usbFileHash(backup)) !== entry.before) throw new Error('U 盘恢复备份校验失败')
    }
    const current = await optionalUsbFileHash(target)
    if (current !== null && current !== entry.before && current !== entry.after)
      throw new Error('U 盘文件在写入后被其他程序修改，无法自动恢复')
    if (journal.status === 'committed' && current !== entry.after)
      throw new Error('已提交的 U 盘文件发生变化，保留恢复记录供检查')
  }
  if (journal.status === 'committing') {
    for (let index = 0; index < journal.entries.length; index++) {
      const target = resolveUsbFile(root, journal.entries[index].relative)
      const temporary = path.join(directory, 'restore.tmp')
      await fs.copyFile(path.join(directory, 'before', String(index)), temporary)
      await syncUsbFile(temporary)
      await fs.rename(temporary, target)
    }
  }
  await fs.rm(directory, { recursive: true, maxRetries: 3, retryDelay: 100 })
}

export const commitUsbFiles = async (
  root: string,
  replacements: UsbReplacement[],
  deletions: string[],
  expected: Map<string, string | null>
): Promise<void> => {
  const directory = journalFolder(root)
  await assertUsbFileContainment(root, directory)
  for (const [target, hash] of expected) {
    await assertUsbFileContainment(root, target)
    if ((await optionalUsbFileHash(target)) !== hash)
      throw new Error('U 盘内容在预览后发生变化，请重新预览')
  }
  const targets = [...replacements.map((item) => item.target), ...deletions]
  if (new Set(targets.map((item) => item.toLowerCase())).size !== targets.length)
    throw new Error('写入计划包含重复文件')
  await fs.mkdir(directory, { recursive: false })
  try {
    await fs.mkdir(path.join(directory, 'before'))
    await fs.mkdir(path.join(directory, 'after'))
    const entries: JournalEntry[] = []
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]
      const before = expected.get(target)
      if (!before) throw new Error('写入目标缺少原始文件校验')
      const backup = path.join(directory, 'before', String(index))
      await fs.copyFile(target, backup)
      await syncUsbFile(backup)
      if ((await usbFileHash(backup)) !== before) throw new Error('备份期间 U 盘文件发生变化')
      let after: string | null = null
      if (index < replacements.length) {
        const destination = path.join(directory, 'after', String(index))
        await fs.copyFile(replacements[index].staged, destination)
        await syncUsbFile(destination)
        after = await usbFileHash(destination)
      }
      entries.push({ relative: usbRelativePath(root, target), before, after })
    }
    await writeJournal(directory, { version: 1, status: 'committing', entries })
    // Recheck after all backups, immediately before modifying the first library file.
    for (const [target, hash] of expected)
      if ((await optionalUsbFileHash(target)) !== hash) throw new Error('提交前 U 盘内容发生变化')
    for (let index = 0; index < replacements.length; index++)
      await fs.rename(path.join(directory, 'after', String(index)), targets[index])
    for (const target of deletions) await fs.unlink(target)
    await writeJournal(directory, { version: 1, status: 'committed', entries })
    // A durable committed journal means the operation succeeded. Cleanup errors
    // must not report a failed write or trigger an impossible rollback afterwards.
    try {
      await fs.rm(directory, { recursive: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      log.error('[pioneer-usb-write] committed backup cleanup failed', { root, error })
    }
  } catch (error) {
    try {
      await recoverUsbWrite(root)
    } catch (recoveryError) {
      throw new Error(
        `U 盘写入失败，恢复未完成：${String(recoveryError)}；请重新连接此 U 盘后重试。原始错误：${String(error)}`
      )
    }
    throw error
  }
}
