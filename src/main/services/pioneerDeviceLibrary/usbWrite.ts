import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type {
  PioneerUsbLibraryType,
  PioneerUsbWritePreview,
  PioneerUsbWriteRequest,
  PioneerUsbWriteResponse,
  PioneerUsbWriteSummary
} from '../../../shared/pioneerUsbWrite'
import { isPioneerUsbWriteRoot } from './deviceDetection'
import { isWindowsProcessRunning, probeWindowsUsbWriteRoot } from './windowsUsbWriteProbe'
import { UsbPdbEditor, pruneUsbPdbExtTracks } from './usbPdbEditor'
import { readUsbOneLibrarySnapshot, mutateUsbOneLibraryCopy } from './usbOneLibrary'
import {
  validateUsbCues,
  writeUsbAnlzCues,
  shiftUsbAnlzGrid,
  parseUsbAnlz,
  validateUsbAnlzMpegCueFamily
} from './usbAnlzWrite'
import { isKnownUsbThreeEx } from './usbThreeEx'
import { readUsbAnlzDurationMs } from './usbAnlzDuration'
import { createUsbFlacCueLocator, type UsbFlacCueLocator } from './usbFlacCueLocator'
import {
  createUsbMpegCueLocator,
  readUsbMpegCueIndex,
  type UsbMpegCueLocator
} from './usbMpegCueLocator'
import { validateUsbAnlzPhraseForGridShift } from './usbAnlzPhrase'
import { planUsbWrite, usbPathKey, type UsbSnapshotMap } from './usbWritePlan'
import {
  assertUsbFileContainment,
  commitUsbFiles,
  optionalUsbFileHash,
  recoverUsbWrite,
  resolveUsbFile,
  usbFileHash,
  type UsbReplacement
} from './usbWriteFiles'
import type { UsbLibrarySnapshot, UsbTrackRecord } from './usbWriteModel'
import { log } from '../../log'

type PreparedWrite = {
  owner: number
  root: string
  expiresAt: number
  stage: string
  expected: Map<string, string | null>
  replacements: UsbReplacement[]
  deletions: string[]
  summary: PioneerUsbWriteSummary
  deviceIdentity?: string
}
const pending = new Map<string, PreparedWrite>()
export type UsbWriteOperationResolver = (
  root: string,
  snapshots: UsbSnapshotMap,
  remember: (file: string) => Promise<string | null>,
  stage: string
) => Promise<PioneerUsbWriteRequest['operation']>
const activeRoots = new Set<string>()
const rootRevisions = new Map<string, number>()
const execFileAsync = promisify(execFile)
const keyOfRoot = (root: string) => path.resolve(root).toLowerCase()

const cleanupUsbStage = async (stage: string): Promise<void> => {
  const resolved = path.resolve(stage)
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('frkb-usb-write-')
  ) {
    throw new Error('无效 U 盘暂存清理路径')
  }
  try {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    log.error('[pioneer-usb-write] temporary copy cleanup failed', { stage, error })
  }
}

const assertRekordboxClosed = async () => {
  if (process.platform === 'win32') {
    if (await isWindowsProcessRunning('rekordbox.exe'))
      throw new Error('请先关闭 rekordbox，再写入 U 盘')
  } else if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-ix', 'rekordbox'], {
        timeout: 10000
      })
      if (stdout.trim()) throw new Error('请先关闭 rekordbox，再写入 U 盘')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error
    }
  } else throw new Error('U 盘写入仅支持 Windows 和 macOS')
}

const assertUsbRoot = async (
  rootPath: string
): Promise<{ root: string; deviceIdentity: string }> => {
  if (!path.isAbsolute(rootPath)) throw new Error('U 盘根目录必须为绝对路径')
  const root = await fs.realpath(rootPath)
  const device =
    process.platform === 'win32'
      ? await probeWindowsUsbWriteRoot(root)
      : {
          eligible: await isPioneerUsbWriteRoot(root),
          identity: String((await fs.stat(root)).dev)
        }
  if (!device.eligible || !device.identity) throw new Error('写入目标必须是已检测到的 USB 设备')
  await assertRekordboxClosed()
  return { root, deviceIdentity: device.identity }
}

const validateRequest = (request: PioneerUsbWriteRequest) => {
  if (
    !request ||
    typeof request.rootPath !== 'string' ||
    !['deviceLibrary', 'oneLibrary'].includes(request.libraryType)
  )
    throw new Error('无效 U 盘写入请求')
  const operation = request.operation
  if (
    !operation ||
    ![
      'reorder',
      'add-to-playlist',
      'remove-from-playlist',
      'delete-tracks',
      'delete-playlist',
      'set-cues',
      'shift-grid'
    ].includes(operation.kind)
  )
    throw new Error('未知 U 盘写入操作')
  const validId = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
  if ('playlistId' in operation && !validId(operation.playlistId)) throw new Error('无效歌单 ID')
  if ('trackId' in operation && !validId(operation.trackId)) throw new Error('无效歌曲 ID')
  if (
    'trackIds' in operation &&
    (!Array.isArray(operation.trackIds) ||
      operation.trackIds.length > 50000 ||
      !operation.trackIds.every(validId))
  )
    throw new Error('无效歌曲 ID 列表')
  if (operation.kind === 'delete-playlist' && typeof operation.deleteExclusiveTracks !== 'boolean')
    throw new Error('必须指定独占歌曲清理策略')
  if (operation.kind === 'set-cues') validateUsbCues(operation.hotCues, operation.memoryCues)
  if (
    operation.kind === 'shift-grid' &&
    (!Number.isSafeInteger(operation.offsetMs) || Math.abs(operation.offsetMs) > 60000)
  )
    throw new Error('网格平移必须为整数毫秒且不超过 60 秒')
}

const withUsbLock = async <T>(root: string, task: () => Promise<T>): Promise<T> => {
  const key = keyOfRoot(root)
  if (activeRoots.has(key)) throw new Error('此 U 盘正在写入，请等待完成')
  activeRoots.add(key)
  rootRevisions.set(key, (rootRevisions.get(key) || 0) + 1)
  try {
    return await task()
  } finally {
    activeRoots.delete(key)
  }
}

/** Ejection changes device state and must serialize with write preflight/commit. */
export const withPioneerUsbExclusive = withUsbLock

/** Discard reads overlapping a multi-file commit, including an interrupted write. */
export const withPioneerUsbRead = async <T>(root: string, read: () => Promise<T>): Promise<T> => {
  const key = keyOfRoot(root)
  const revision = rootRevisions.get(key)
  const assertReadable = async () => {
    if (activeRoots.has(key)) throw new Error('此 U 盘正在写入，请等待完成后刷新')
    const journal = path.join(root, 'PIONEER', 'rekordbox', '.frkb-write-transaction')
    try {
      await fs.access(journal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const state: unknown = JSON.parse(await fs.readFile(path.join(journal, 'journal.json'), 'utf8'))
    if (
      state &&
      typeof state === 'object' &&
      'version' in state &&
      state.version === 1 &&
      'status' in state &&
      state.status === 'committed'
    )
      return
    throw new Error('此 U 盘存在未完成的写入，请重新进行写入预览，恢复后再读取')
  }
  await assertReadable()
  const result = await read()
  await assertReadable()
  if (rootRevisions.get(key) !== revision) throw new Error('读取期间 U 盘已更新，请刷新后重试')
  return result
}

const analysisFiles = async (
  root: string,
  track: UsbTrackRecord,
  remember: (file: string) => Promise<string | null>
): Promise<string[]> => {
  if (!track.analyzePath) throw new Error('歌曲缺少分析文件路径')
  const base = resolveUsbFile(root, track.analyzePath)
  const stem = base.slice(0, -path.extname(base).length)
  const candidates = ['.DAT', '.EXT', '.2EX', '.3EX', '.CUE'].map((extension) => stem + extension)
  const result: string[] = []
  for (const file of candidates) {
    await assertUsbFileContainment(root, file)
    if ((await remember(file)) !== null) result.push(file)
  }
  return result
}

const sameAnalyzeFamily = (left: string, right: string) => {
  const stem = (value: string) => usbPathKey(value).replace(/\.[^.\/]+$/, '')
  return Boolean(left && right) && stem(left) === stem(right)
}

const deleteCandidates = async (
  root: string,
  removed: UsbTrackRecord[],
  retained: UsbTrackRecord[],
  protectedArtwork: string[],
  remember: (file: string) => Promise<string | null>
) => {
  const files = new Set<string>()
  const preserved = new Set<string>()
  for (const track of removed) {
    const audio = resolveUsbFile(root, track.filePath)
    if (retained.some((item) => usbPathKey(item.filePath) === usbPathKey(track.filePath)))
      preserved.add(audio)
    else files.add(audio)
    if (track.analyzePath) {
      const analyzed = await analysisFiles(root, track, remember)
      if (retained.some((item) => sameAnalyzeFamily(item.analyzePath, track.analyzePath)))
        analyzed.forEach((file) => preserved.add(file))
      else analyzed.forEach((file) => files.add(file))
    }
    if (track.artworkPath) {
      const artwork = resolveUsbFile(root, track.artworkPath)
      if (
        retained.some(
          (item) =>
            item.artworkPath && usbPathKey(item.artworkPath) === usbPathKey(track.artworkPath)
        ) ||
        protectedArtwork.some((item) => usbPathKey(item) === usbPathKey(track.artworkPath))
      )
        preserved.add(artwork)
      else files.add(artwork)
    }
  }
  for (const file of preserved) files.delete(file)
  const existing: string[] = []
  for (const file of files) {
    await assertUsbFileContainment(root, file)
    if ((await optionalUsbFileHash(file)) !== null) existing.push(file)
  }
  return { files: existing, preserved: preserved.size }
}

/** Exported for copy-only integration tests; production entry points additionally verify volume. */
export const prepareUsbWriteFiles = async (
  root: string,
  request: PioneerUsbWriteRequest,
  owner = 0,
  resolveOperation?: UsbWriteOperationResolver
): Promise<PreparedWrite> => {
  validateRequest(request)
  await recoverUsbWrite(root)
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-usb-write-'))
  const expected = new Map<string, string | null>()
  const remember = async (file: string) => {
    await assertUsbFileContainment(root, file)
    const hash = await optionalUsbFileHash(file)
    if (expected.has(file) && expected.get(file) !== hash)
      throw new Error('读取期间 U 盘内容发生变化')
    expected.set(file, hash)
    return hash
  }
  try {
    const dbDirectory = path.join(root, 'PIONEER', 'rekordbox')
    const pdbPath = path.join(dbDirectory, 'export.pdb')
    const onePath = path.join(dbDirectory, 'exportLibrary.db')
    const extPath = path.join(dbDirectory, 'exportExt.pdb')
    for (const file of [pdbPath, onePath, extPath, path.join(root, '.frkb-usb-id.json')])
      await remember(file)
    const cleanSidecars: string[] = []
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = onePath + suffix
      if ((await remember(sidecar)) === null) continue
      if (suffix !== '-shm' && (await fs.stat(sidecar)).size !== 0)
        throw new Error('OneLibrary 存在未结束的数据库事务，请先用 rekordbox 正常弹出设备')
      if (!expected.get(onePath)) throw new Error('设备存在孤立的 OneLibrary 事务文件')
      cleanSidecars.push(sidecar)
    }
    const snapshots: UsbSnapshotMap = {}
    let pdb: UsbPdbEditor | undefined
    if (expected.get(pdbPath)) {
      const bytes = await fs.readFile(pdbPath)
      if ((await remember(pdbPath)) !== expected.get(pdbPath)) throw new Error('数据库发生变化')
      pdb = new UsbPdbEditor(bytes)
      snapshots.deviceLibrary = pdb.snapshot()
    }
    const stagedOneLibrary = path.join(stage, 'exportLibrary.db')
    if (expected.get(onePath)) {
      // Read SQLCipher on a private copy as even SQLite readonly connections can create SHM.
      await fs.copyFile(onePath, stagedOneLibrary)
      if ((await usbFileHash(stagedOneLibrary)) !== expected.get(onePath))
        throw new Error('OneLibrary 在复制期间发生变化')
      snapshots.oneLibrary = readUsbOneLibrarySnapshot(stagedOneLibrary)
    }
    if (resolveOperation) {
      request = {
        ...request,
        operation: await resolveOperation(root, snapshots, remember, stage)
      }
      validateRequest(request)
    }
    const mutations = planUsbWrite(snapshots, request.libraryType, request.operation)
    const replacements: UsbReplacement[] = []
    const addReplacement = async (target: string, bytes: Buffer) => {
      const before = await remember(target)
      if (!before) throw new Error('目标文件不存在')
      const staged = path.join(stage, String(replacements.length))
      await fs.writeFile(staged, bytes)
      if ((await usbFileHash(staged)) !== before) replacements.push({ target, staged })
    }
    if (pdb && mutations.deviceLibrary) {
      pdb.apply(mutations.deviceLibrary)
      await addReplacement(pdbPath, pdb.toBuffer())
      if (mutations.deviceLibrary.deleteTrackIds.length && expected.get(extPath)) {
        await addReplacement(
          extPath,
          pruneUsbPdbExtTracks(await fs.readFile(extPath), mutations.deviceLibrary.deleteTrackIds)
        )
      }
    }
    if (mutations.oneLibrary) {
      await mutateUsbOneLibraryCopy(stagedOneLibrary, mutations.oneLibrary, root)
      if ((await usbFileHash(stagedOneLibrary)) !== expected.get(onePath))
        replacements.push({ target: onePath, staged: stagedOneLibrary })
    }
    const removed: UsbTrackRecord[] = []
    const retained: UsbTrackRecord[] = []
    for (const type of Object.keys(snapshots) as PioneerUsbLibraryType[]) {
      const snapshot: UsbLibrarySnapshot = snapshots[type]!
      for (const track of snapshot.tracks)
        (mutations[type]!.deleteTrackIds.includes(track.id) ? removed : retained).push(track)
    }
    if (request.operation.kind === 'set-cues' || request.operation.kind === 'shift-grid') {
      const operation = request.operation
      const targets = new Set<string>()
      let hasGrid = false
      const phraseSections: Buffer[] = []
      let changesBeatIndices = false
      const gridDurations = new Map<string, number>()
      const flacLocators = new Map<string, UsbFlacCueLocator>()
      const mpegAudio = new Map<string, Buffer>()
      for (const type of Object.keys(snapshots) as PioneerUsbLibraryType[]) {
        const id =
          operation.kind === 'set-cues'
            ? mutations[type]!.cueUpdates[0].trackId
            : mutations[type]!.gridUpdates[0].trackId
        const track = snapshots[type]!.tracks.find((item) => item.id === id)!
        const audio = resolveUsbFile(root, track.filePath)
        const audioKey = usbPathKey(track.filePath)
        if ((await remember(audio)) === null) throw new Error('歌曲音频文件不存在')
        if (
          operation.kind === 'set-cues' &&
          ['.flac', '.fla'].includes(path.extname(audio).toLowerCase()) &&
          !flacLocators.has(audioKey)
        )
          flacLocators.set(audioKey, createUsbFlacCueLocator(await fs.readFile(audio)))
        const files = await analysisFiles(root, track, remember)
        if (!files.some((file) => path.extname(file).toUpperCase() === '.DAT'))
          throw new Error('歌曲缺少 DAT 分析文件')
        if (
          operation.kind === 'set-cues' &&
          !files.some((file) => path.extname(file).toUpperCase() === '.EXT')
        )
          throw new Error('歌曲缺少 EXT 分析文件，无法完整写入 Cue')
        let mpegLocator: UsbMpegCueLocator | undefined
        if (operation.kind === 'set-cues' && path.extname(audio).toLowerCase() === '.mp3') {
          const dat = files.find((file) => path.extname(file).toUpperCase() === '.DAT')!
          const index = readUsbMpegCueIndex(await fs.readFile(dat))
          if (index) {
            if (!mpegAudio.has(audioKey)) mpegAudio.set(audioKey, await fs.readFile(audio))
            mpegLocator = createUsbMpegCueLocator(mpegAudio.get(audioKey)!, index)
          }
        }
        if (operation.kind === 'set-cues' && !mpegLocator)
          validateUsbAnlzMpegCueFamily(
            await Promise.all(
              files
                .filter((file) =>
                  ['.DAT', '.EXT', '.2EX'].includes(path.extname(file).toUpperCase())
                )
                .map((file) => fs.readFile(file))
            ),
            operation.hotCues,
            operation.memoryCues
          )
        if (operation.kind === 'shift-grid' && operation.offsetMs !== 0) {
          const detailFiles = files.filter((file) =>
            ['.DAT', '.EXT', '.2EX'].includes(path.extname(file).toUpperCase())
          )
          const durationMs = readUsbAnlzDurationMs(
            await Promise.all(detailFiles.map((file) => fs.readFile(file)))
          )
          const previousDuration = gridDurations.get(audioKey)
          if (previousDuration !== undefined && previousDuration !== durationMs)
            throw new Error('两种库的歌曲分析时长不一致，已停止网格写入')
          gridDurations.set(audioKey, durationMs)
        }
        for (const file of files) {
          if (targets.has(file)) continue
          const extension = path.extname(file).toUpperCase()
          if (extension === '.CUE')
            throw new Error(`歌曲包含尚未验证的分析格式 ${extension}，为避免覆盖设备数据已停止写入`)
          targets.add(file)
          await remember(file)
          const bytes = await fs.readFile(file)
          if (extension === '.3EX') {
            if (!isKnownUsbThreeEx(bytes))
              throw new Error('歌曲包含未知的 .3EX 数据，无法确认其独立于 Cue 和网格，已停止写入')
            // Verified embedding-only payloads have no cue/grid fields. Keep
            // them in the read set, but preserve their complete original bytes.
            continue
          }
          if (operation.kind === 'set-cues')
            await addReplacement(
              file,
              writeUsbAnlzCues(
                bytes,
                extension,
                operation.hotCues,
                operation.memoryCues,
                flacLocators.get(audioKey),
                mpegLocator
              )
            )
          else {
            for (const section of parseUsbAnlz(bytes).sections)
              if (section.kind === 'PSSI') phraseSections.push(section.bytes)
            const shifted = shiftUsbAnlzGrid(bytes, operation.offsetMs, gridDurations.get(audioKey))
            hasGrid ||= shifted.hasGrid
            changesBeatIndices ||= shifted.changesBeatIndices
            await addReplacement(file, shifted.bytes)
          }
        }
      }
      // Phrase analysis can live in a different file from the primary grid.
      // Native shifts retain these tags byte-for-byte; validate their known encoding.
      if (changesBeatIndices)
        for (const section of phraseSections) validateUsbAnlzPhraseForGridShift(section)
      if (operation.kind === 'shift-grid' && !hasGrid) throw new Error('歌曲没有可编辑的网格')
    }
    const deletion = await deleteCandidates(
      root,
      removed,
      retained,
      Object.values(snapshots).flatMap((snapshot) => snapshot?.protectedArtworkPaths || []),
      remember
    )
    const deletions = [
      ...deletion.files,
      ...(replacements.some((item) => item.target === onePath) ? cleanSidecars : [])
    ]
    for (const file of deletions) await remember(file)
    // All files must still match the complete read set when the preview becomes visible.
    for (const [file, hash] of expected)
      if ((await optionalUsbFileHash(file)) !== hash) throw new Error('准备期间 U 盘内容发生变化')
    return {
      owner,
      root,
      stage,
      expected,
      replacements,
      deletions,
      expiresAt: Date.now() + 10 * 60 * 1000,
      summary: {
        libraries: Object.keys(snapshots) as PioneerUsbLibraryType[],
        changedFileCount: replacements.length,
        deletedTrackCount: new Set(removed.map((track) => usbPathKey(track.filePath))).size,
        ...(removed.length
          ? {
              deletedTrackFilePaths: [
                ...new Set(removed.map((track) => resolveUsbFile(root, track.filePath)))
              ]
            }
          : {}),
        deletedFiles: deletion.files.map((file) => path.relative(root, file)),
        preservedSharedFileCount: deletion.preserved
      }
    }
  } catch (error) {
    await cleanupUsbStage(stage)
    throw error
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const discardUsbPreviews = async (root: string, owner: number) => {
  for (const [token, prepared] of pending)
    if (
      prepared.expiresAt < Date.now() ||
      (prepared.owner === owner && keyOfRoot(prepared.root) === keyOfRoot(root))
    ) {
      pending.delete(token)
      await cleanupUsbStage(prepared.stage)
    }
}

const commitPreparedUsbWrite = async (prepared: PreparedWrite) => {
  if (prepared.replacements.length || prepared.deletions.length)
    await commitUsbFiles(
      prepared.root,
      prepared.replacements,
      prepared.deletions,
      prepared.expected
    )
}

/** Immediate edits hold one lock through preparation and commit, with no preview wait. */
export const executePioneerUsbWrite = async (
  request: PioneerUsbWriteRequest,
  owner: number,
  resolveOperation?: UsbWriteOperationResolver,
  inspectPrepared?: (replacements: readonly UsbReplacement[]) => Promise<void>
): Promise<PioneerUsbWriteResponse> => {
  try {
    validateRequest(request)
    if (['delete-tracks', 'delete-playlist'].includes(request.operation.kind))
      throw new Error('删除操作必须经过删除确认')
    const { root, deviceIdentity } = await assertUsbRoot(request.rootPath)
    return await withUsbLock(root, async () => {
      await discardUsbPreviews(root, owner)
      const prepared = await prepareUsbWriteFiles(root, request, owner, resolveOperation)
      try {
        await inspectPrepared?.(prepared.replacements)
        // Preparation can take time; still reject another editor starting before commit.
        const current = await assertUsbRoot(root)
        if (current.deviceIdentity !== deviceIdentity)
          throw new Error('准备期间 U 盘设备发生变化，请重新操作')
        await commitPreparedUsbWrite(prepared)
        return { ok: true, result: prepared.summary }
      } finally {
        await cleanupUsbStage(prepared.stage)
      }
    })
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export const preparePioneerUsbWrite = async (
  request: PioneerUsbWriteRequest,
  owner: number,
  resolveOperation?: UsbWriteOperationResolver,
  inspectPrepared?: (replacements: readonly UsbReplacement[]) => Promise<void>
): Promise<PioneerUsbWriteResponse<PioneerUsbWritePreview>> => {
  try {
    validateRequest(request)
    const { root, deviceIdentity } = await assertUsbRoot(request.rootPath)
    return await withUsbLock(root, async () => {
      await discardUsbPreviews(root, owner)
      if (pending.size >= 16) throw new Error('待确认的 U 盘操作过多')
      const prepared = await prepareUsbWriteFiles(root, request, owner, resolveOperation)
      prepared.deviceIdentity = deviceIdentity
      try {
        await inspectPrepared?.(prepared.replacements)
      } catch (error) {
        await cleanupUsbStage(prepared.stage)
        throw error
      }
      const token = randomUUID()
      pending.set(token, prepared)
      const timer = setTimeout(
        () => {
          if (pending.get(token) !== prepared) return
          pending.delete(token)
          void cleanupUsbStage(prepared.stage)
        },
        Math.max(1, prepared.expiresAt - Date.now())
      )
      timer.unref()
      return { ok: true, result: { token, summary: prepared.summary } }
    })
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export const applyPioneerUsbWrite = async (
  token: string,
  owner: number
): Promise<PioneerUsbWriteResponse> => {
  const prepared = pending.get(token)
  if (!prepared || prepared.owner !== owner)
    return { ok: false, error: '写入预览不存在，请重新预览' }
  pending.delete(token)
  try {
    if (prepared.expiresAt < Date.now()) throw new Error('写入预览已过期，请重新预览')
    const current = await assertUsbRoot(prepared.root)
    if (current.deviceIdentity !== prepared.deviceIdentity)
      throw new Error('预览后 U 盘设备发生变化，请重新预览')
    return await withUsbLock(prepared.root, async () => {
      await commitPreparedUsbWrite(prepared)
      return { ok: true, result: prepared.summary }
    })
  } catch (error) {
    return { ok: false, error: errorText(error) }
  } finally {
    await cleanupUsbStage(prepared.stage)
  }
}
