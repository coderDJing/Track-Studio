import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reorderSeratoCrateOrder, updateSeratoCrateOrder } from './seratoCrateOrder'

const execFileAsync = promisify(execFile)

type SeratoChunk = { tag: string; payload: Buffer }

export type SeratoMutationRequest = {
  operation:
    | 'create-playlist'
    | 'create-folder'
    | 'rename'
    | 'move'
    | 'delete'
    | 'remove-tracks'
    | 'reorder-tracks'
    | 'write-tracks'
  sourcePath: string
  externalId?: string
  parentExternalId?: string
  name?: string
  rowKeys?: string[]
  targetIndex?: number
  seq?: number
  trackPaths?: string[]
  trackPathMappings?: Array<{ sourcePath: string; storedPath: string }>
}

export type SeratoMutationSummary = {
  externalId?: string
  parentExternalId?: string
  removedCount?: number
  playlistId?: number
  addedCount?: number
  skippedDuplicateCount?: number
}

const parseChunks = (data: Buffer): SeratoChunk[] => {
  const chunks: SeratoChunk[] = []
  let offset = 0
  while (offset + 8 <= data.length) {
    const tag = data.subarray(offset, offset + 4).toString('ascii')
    const length = data.readUInt32BE(offset + 4)
    offset += 8
    if (length > data.length - offset) break
    chunks.push({ tag, payload: data.subarray(offset, offset + length) })
    offset += length
  }
  return chunks
}

const encodeChunk = (tag: string, payload: Buffer) => {
  const header = Buffer.allocUnsafe(8)
  header.write(tag.slice(0, 4).padEnd(4, ' '), 0, 4, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

const encodeUtf16Be = (value: string) => {
  const utf16 = Buffer.from(value, 'utf16le')
  for (let index = 0; index + 1 < utf16.length; index += 2) {
    const byte = utf16[index]
    utf16[index] = utf16[index + 1]
    utf16[index + 1] = byte
  }
  return utf16
}

const decodeUtf16Be = (payload: Buffer) => {
  const evenLength = payload.length - (payload.length % 2)
  const swapped = Buffer.allocUnsafe(evenLength)
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = payload[index + 1]
    swapped[index + 1] = payload[index]
  }
  return swapped.toString('utf16le').replaceAll('\0', '').trim()
}

const toSeratoTrackPath = (value: string, seratoRoot: string) => {
  const normalized = String(value || '')
    .trim()
    .replaceAll('\\', '/')
  const match = normalized.match(/^\/?([A-Za-z]):\/?(.*)$/)
  if (!match) return normalized.replace(/^\/+/, '')
  const seratoDrive = path.win32
    .parse(path.win32.normalize(seratoRoot))
    .root.slice(0, 1)
    .toUpperCase()
  const drive = match[1].toUpperCase()
  const rest = match[2].replace(/^\/+/, '')
  // Serato stores same-volume paths without the drive letter, but keeps the
  // drive letter for tracks located on another volume.
  return drive === seratoDrive ? rest : `${drive}:/${rest}`
}

const toLegacySeratoTrackPath = (value: string) =>
  String(value || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/?[A-Za-z]:\/?/, '')
    .replace(/^\/+/, '')

const encodeTrackChunk = (filePath: string, seratoRoot: string) =>
  encodeChunk('otrk', encodeChunk('ptrk', encodeUtf16Be(toSeratoTrackPath(filePath, seratoRoot))))

const normalizeTrackPathKey = (value: string) =>
  String(value || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .toLowerCase()

const resolveSeratoRoot = (inputPath: string) => {
  const normalized = path.normalize(String(inputPath || '').trim())
  return path.basename(normalized).toLowerCase() === '_serato_'
    ? normalized
    : path.join(normalized, '_Serato_')
}

const normalizeExternalId = (value: string | undefined) => {
  const raw = String(value || '').trim()
  return raw.startsWith('serato:') ? raw.slice('serato:'.length) : raw
}

const splitExternalId = (value: string | undefined) =>
  normalizeExternalId(value)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)

const validateName = (value: string | undefined) => {
  const name = String(value || '').trim()
  if (!name) throw new Error('Serato 歌单名称不能为空。')
  if (name.includes('%%') || /[<>:"/\\|?*\u0000]/.test(name)) {
    throw new Error('Serato 歌单名称包含不支持的字符。')
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new Error('Serato 歌单名称不能以空格或句点结尾。')
  }
  return name
}

const crateFileName = (parts: string[]) => `${parts.join('%%')}.crate`
const cratePath = (subcratesPath: string, parts: string[]) =>
  path.join(subcratesPath, crateFileName(parts))

const frkbFolderMetadataPath = (seratoRoot: string) => path.join(seratoRoot, 'FRKB folders.json')

const readFrkbFolderNames = async (seratoRoot: string): Promise<string[]> => {
  try {
    const value: unknown = JSON.parse(await fs.readFile(frkbFolderMetadataPath(seratoRoot), 'utf8'))
    return Array.isArray(value)
      ? value.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

const updateFrkbFolderNames = async (
  seratoRoot: string,
  transform: (names: string[]) => string[]
) => {
  const next = Array.from(new Set(transform(await readFrkbFolderNames(seratoRoot)).filter(Boolean)))
  await atomicWrite(
    frkbFolderMetadataPath(seratoRoot),
    Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
  )
}

const extractTrackPath = (chunk: SeratoChunk) => {
  const nested = parseChunks(chunk.payload)
  const ptrk = nested.find((item) => item.tag === 'ptrk')
  return ptrk ? decodeUtf16Be(ptrk.payload) : ''
}

const readCrate = async (filePath: string) => {
  const data = await fs.readFile(filePath)
  const chunks = parseChunks(data)
  const trackChunks = chunks.filter((chunk) => chunk.tag === 'otrk')
  return { chunks, trackChunks }
}

const makeEmptyCrate = async (subcratesPath: string, folder: boolean) => {
  const entries: import('node:fs').Dirent[] = await fs
    .readdir(subcratesPath, { withFileTypes: true })
    .catch(() => [] as import('node:fs').Dirent[])
  const template = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.crate')
  )
  if (template) {
    const parsed = await readCrate(path.join(subcratesPath, template.name))
    const nonTrackChunks = parsed.chunks.filter(
      (chunk) => chunk.tag !== 'otrk' && chunk.tag !== 'frkb'
    )
    if (nonTrackChunks.length) {
      return Buffer.concat([
        ...nonTrackChunks.map((chunk) => encodeChunk(chunk.tag, chunk.payload)),
        ...(folder ? [encodeChunk('frkb', Buffer.from('folder', 'utf8'))] : [])
      ])
    }
  }
  return Buffer.concat([
    encodeChunk('vrsn', encodeUtf16Be('1.0/Serato ScratchLive Crate')),
    ...(folder ? [encodeChunk('frkb', Buffer.from('folder', 'utf8'))] : [])
  ])
}

const backupFile = async (seratoRoot: string, filePath: string) => {
  const backupRoot = path.join(seratoRoot, 'FRKB Backups', 'Subcrates')
  await fs.mkdir(backupRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(
    backupRoot,
    `${path.basename(filePath)}.${stamp}.${crypto.randomUUID()}.bak`
  )
  await fs.copyFile(filePath, backupPath)
}

const atomicWrite = async (filePath: string, data: Buffer) => {
  const tempPath = `${filePath}.frkb-${crypto.randomUUID()}.tmp`
  const handle = await fs.open(tempPath, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tempPath, filePath)
}

const assertSeratoClosed = async () => {
  if (process.platform !== 'win32') return
  try {
    const result = await execFileAsync('tasklist', [])
    if (/serato/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error('请先退出 Serato，再修改 Serato 歌单。')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('请先退出 Serato')) throw error
  }
}

const rowKeyEntryIndex = (rowKey: string) => {
  const match = String(rowKey || '').match(/:(\d+)$/)
  return match ? Number(match[1]) : -1
}

const writeTrackOrder = async (filePath: string, rowKeys: string[], targetIndex: number) => {
  const parsed = await readCrate(filePath)
  const selectedIndexes = [...new Set(rowKeys.map(rowKeyEntryIndex).filter((index) => index >= 0))]
    .filter((index) => index < parsed.trackChunks.length)
    .sort((left, right) => left - right)
  if (!selectedIndexes.length) return 0
  const selectedSet = new Set(selectedIndexes)
  const selected = selectedIndexes.map((index) => parsed.trackChunks[index])
  const remaining = parsed.trackChunks.filter((_chunk, index) => !selectedSet.has(index))
  const insertAt = Math.max(0, Math.min(Number(targetIndex) || 0, remaining.length))
  const nextTracks = [...remaining.slice(0, insertAt), ...selected, ...remaining.slice(insertAt)]
  const nonTrack = parsed.chunks.filter((chunk) => chunk.tag !== 'otrk')
  const output = Buffer.concat([
    ...nonTrack.map((chunk) => encodeChunk(chunk.tag, chunk.payload)),
    ...nextTracks.map((chunk) => encodeChunk(chunk.tag, chunk.payload))
  ])
  await backupFile(path.dirname(path.dirname(filePath)), filePath)
  await atomicWrite(filePath, output)
  return selectedIndexes.length
}

export const mutateSeratoCrate = async (
  request: SeratoMutationRequest
): Promise<SeratoMutationSummary> => {
  await assertSeratoClosed()
  const seratoRoot = resolveSeratoRoot(request.sourcePath)
  const subcratesPath = path.join(seratoRoot, 'Subcrates')
  await fs.mkdir(subcratesPath, { recursive: true })
  const parts = splitExternalId(request.externalId)

  if (request.operation === 'create-playlist' || request.operation === 'create-folder') {
    const name = validateName(request.name)
    const nextParts = [...splitExternalId(request.parentExternalId), name]
    const targetPath = cratePath(subcratesPath, nextParts)
    try {
      await fs.access(targetPath)
      throw new Error('同名 Serato 歌单已经存在。')
    } catch (error) {
      if (error instanceof Error && error.message.includes('同名')) throw error
    }
    if (request.operation === 'create-folder') {
      // A standalone empty .crate is shown by Serato as a playlist. Keep
      // empty folder state in FRKB metadata instead, and let child crates
      // provide the visible Serato hierarchy when they exist.
      await updateFrkbFolderNames(seratoRoot, (names) => [...names, nextParts.join('%%')])
    } else {
      await atomicWrite(targetPath, await makeEmptyCrate(subcratesPath, false))
      await updateSeratoCrateOrder(seratoRoot, (names) => [...names, nextParts.join('%%')])
    }
    return {
      externalId: `serato:${nextParts.join('/')}`,
      parentExternalId: request.parentExternalId
    }
  }

  if (!parts.length) throw new Error('Serato 歌单无效。')
  if (request.operation === 'rename') {
    const name = validateName(request.name)
    const nextParts = [...parts.slice(0, -1), name]
    const oldPrefix = crateFileName(parts).slice(0, -'.crate'.length)
    const nextPrefix = crateFileName(nextParts).slice(0, -'.crate'.length)
    const entries = await fs.readdir(subcratesPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.crate')) continue
      const base = entry.name.slice(0, -'.crate'.length)
      if (base !== oldPrefix && !base.startsWith(`${oldPrefix}%%`)) continue
      const suffix = base.slice(oldPrefix.length)
      await fs.rename(
        path.join(subcratesPath, entry.name),
        path.join(subcratesPath, `${nextPrefix}${suffix}.crate`)
      )
    }
    await updateSeratoCrateOrder(seratoRoot, (names) =>
      names.map((name) =>
        name === oldPrefix || name.startsWith(`${oldPrefix}%%`)
          ? `${nextPrefix}${name.slice(oldPrefix.length)}`
          : name
      )
    )
    await updateFrkbFolderNames(seratoRoot, (names) =>
      names.map((name) =>
        name === oldPrefix || name.startsWith(`${oldPrefix}%%`)
          ? `${nextPrefix}${name.slice(oldPrefix.length)}`
          : name
      )
    )
    return {
      externalId: `serato:${nextParts.join('/')}`,
      parentExternalId: parts.length > 1 ? `serato:${nextParts.slice(0, -1).join('/')}` : undefined
    }
  }

  if (request.operation === 'move') {
    const name = validateName(request.name || parts[parts.length - 1])
    const nextParts = [...splitExternalId(request.parentExternalId), name]
    const oldPrefix = crateFileName(parts).slice(0, -'.crate'.length)
    const nextPrefix = crateFileName(nextParts).slice(0, -'.crate'.length)
    if (oldPrefix === nextPrefix) {
      await updateSeratoCrateOrder(seratoRoot, (names) =>
        reorderSeratoCrateOrder(
          names,
          nextPrefix,
          splitExternalId(request.parentExternalId).join('%%') || undefined,
          request.seq || 1
        )
      )
      await updateFrkbFolderNames(seratoRoot, (names) => names)
      return { externalId: `serato:${nextParts.join('/')}` }
    }
    if (await fs.stat(cratePath(subcratesPath, nextParts)).catch(() => null)) {
      throw new Error('目标位置已经存在同名 Serato 歌单。')
    }
    const entries = await fs.readdir(subcratesPath, { withFileTypes: true })
    const matches = entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.crate') &&
        (entry.name.slice(0, -'.crate'.length) === oldPrefix ||
          entry.name.slice(0, -'.crate'.length).startsWith(`${oldPrefix}%%`))
    )
    for (const entry of matches) {
      const base = entry.name.slice(0, -'.crate'.length)
      const suffix = base.slice(oldPrefix.length)
      const source = path.join(subcratesPath, entry.name)
      const target = path.join(subcratesPath, `${nextPrefix}${suffix}.crate`)
      await backupFile(seratoRoot, source)
      await fs.rename(source, target)
    }
    await updateSeratoCrateOrder(seratoRoot, (names) => {
      const mapped = names.map((name) =>
        name === oldPrefix || name.startsWith(`${oldPrefix}%%`)
          ? `${nextPrefix}${name.slice(oldPrefix.length)}`
          : name
      )
      return reorderSeratoCrateOrder(
        mapped,
        nextPrefix,
        splitExternalId(request.parentExternalId).join('%%') || undefined,
        request.seq || 1
      )
    })
    await updateFrkbFolderNames(seratoRoot, (names) =>
      names.map((name) =>
        name === oldPrefix || name.startsWith(`${oldPrefix}%%`)
          ? `${nextPrefix}${name.slice(oldPrefix.length)}`
          : name
      )
    )
    return {
      externalId: `serato:${nextParts.join('/')}`,
      parentExternalId: request.parentExternalId
    }
  }

  if (request.operation === 'delete') {
    const prefix = crateFileName(parts).slice(0, -'.crate'.length)
    const entries = await fs.readdir(subcratesPath, { withFileTypes: true })
    let deleted = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.crate')) continue
      const base = entry.name.slice(0, -'.crate'.length)
      if (base !== prefix && !base.startsWith(`${prefix}%%`)) continue
      const filePath = path.join(subcratesPath, entry.name)
      await backupFile(seratoRoot, filePath)
      await fs.unlink(filePath)
      deleted += 1
    }
    await updateSeratoCrateOrder(seratoRoot, (names) =>
      names.filter((name) => name !== prefix && !name.startsWith(`${prefix}%%`))
    )
    await updateFrkbFolderNames(seratoRoot, (names) =>
      names.filter((name) => name !== prefix && !name.startsWith(`${prefix}%%`))
    )
    return {
      parentExternalId: parts.length > 1 ? `serato:${parts.slice(0, -1).join('/')}` : undefined,
      removedCount: deleted
    }
  }

  const targetPath = cratePath(subcratesPath, parts)
  await fs.access(targetPath)
  if (request.operation === 'remove-tracks') {
    const parsed = await readCrate(targetPath)
    const indexes = [
      ...new Set((request.rowKeys || []).map(rowKeyEntryIndex).filter((index) => index >= 0))
    ].filter((index) => index < parsed.trackChunks.length)
    if (!indexes.length) return { removedCount: 0 }
    const removeSet = new Set(indexes)
    const output = Buffer.concat(
      parsed.chunks
        .filter(
          (chunk) => chunk.tag !== 'otrk' || !removeSet.delete(parsed.trackChunks.indexOf(chunk))
        )
        .map((chunk) => encodeChunk(chunk.tag, chunk.payload))
    )
    await backupFile(seratoRoot, targetPath)
    await atomicWrite(targetPath, output)
    return { removedCount: indexes.length }
  }
  if (request.operation === 'reorder-tracks') {
    return {
      removedCount: await writeTrackOrder(
        targetPath,
        request.rowKeys || [],
        Number(request.targetIndex) || 0
      )
    }
  }
  if (request.operation === 'write-tracks') {
    const mappings = (request.trackPathMappings || [])
      .map((item) => ({
        sourcePath: toLegacySeratoTrackPath(item.sourcePath),
        storedPath: toSeratoTrackPath(item.storedPath, seratoRoot)
      }))
      .filter((item) => item.storedPath)
    const trackPaths = Array.from(
      new Set(
        (mappings.length ? mappings.map((item) => item.storedPath) : request.trackPaths || [])
          .map((item) => toSeratoTrackPath(item, seratoRoot))
          .filter(Boolean)
      )
    )
    if (!trackPaths.length) {
      return { externalId: request.externalId, addedCount: 0, skippedDuplicateCount: 0 }
    }
    const parsed = await readCrate(targetPath)
    const existing = new Set(parsed.trackChunks.map(extractTrackPath).map(normalizeTrackPathKey))
    const legacyKeys = new Set(mappings.map((item) => normalizeTrackPathKey(item.sourcePath)))
    const storedKeys = new Set(trackPaths.map(normalizeTrackPathKey))
    const replacedLegacyKeys = new Set(
      [...legacyKeys].filter((key) => key && !storedKeys.has(key) && existing.has(key))
    )
    const newPaths = trackPaths.filter((item) => !existing.has(normalizeTrackPathKey(item)))
    if (!newPaths.length) {
      if (replacedLegacyKeys.size > 0) {
        const output = Buffer.concat(
          parsed.chunks
            .filter(
              (chunk) =>
                chunk.tag !== 'otrk' ||
                !replacedLegacyKeys.has(normalizeTrackPathKey(extractTrackPath(chunk)))
            )
            .map((chunk) => encodeChunk(chunk.tag, chunk.payload))
        )
        await backupFile(seratoRoot, targetPath)
        await atomicWrite(targetPath, output)
      }
      return {
        externalId: request.externalId,
        addedCount: 0,
        skippedDuplicateCount: trackPaths.length
      }
    }
    const output = Buffer.concat([
      ...parsed.chunks
        .filter(
          (chunk) =>
            chunk.tag !== 'otrk' ||
            !replacedLegacyKeys.has(normalizeTrackPathKey(extractTrackPath(chunk)))
        )
        .map((chunk) => encodeChunk(chunk.tag, chunk.payload)),
      ...newPaths.map((item) => encodeTrackChunk(item, seratoRoot))
    ])
    await backupFile(seratoRoot, targetPath)
    await atomicWrite(targetPath, output)
    return {
      externalId: request.externalId,
      addedCount: newPaths.length,
      skippedDuplicateCount: trackPaths.length - newPaths.length
    }
  }
  throw new Error('不支持的 Serato 歌单操作。')
}
