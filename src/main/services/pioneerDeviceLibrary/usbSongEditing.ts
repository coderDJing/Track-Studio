import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  PioneerUsbSongEditRequest,
  PioneerUsbSongEditResponse,
  PioneerUsbSongEditResult
} from '../../../shared/pioneerUsbEditing'
import { upsertSongHotCueDefinition } from '../../../shared/hotCues'
import { upsertSongMemoryCueDefinition } from '../../../shared/memoryCues'
import { createSongBeatGridMapV2FromRekordboxEntries } from '../../../shared/songBeatGridMapV2'
import { emitSongHotCuesUpdated } from '../songHotCueEvents'
import { emitSongMemoryCuesUpdated } from '../songMemoryCueEvents'
import { emitSongGridUpdated } from '../songGridEvents'
import { normalizeRequiredPioneerCueDump } from './cues'
import { readPioneerCuesInWorker } from './workerPool'
import { resolveUsbFile, usbFileHash } from './usbWriteFiles'
import { parseUsbAnlz, validateUsbCues } from './usbAnlzWrite'
import { executePioneerUsbWrite, type UsbWriteOperationResolver } from './usbWrite'
import type {
  PioneerUsbWriteRequest,
  PioneerUsbWriteResponse
} from '../../../shared/pioneerUsbWrite'

const queue = new Map<string, Promise<unknown>>()
const pathKey = (value: string) =>
  process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

/** Resolve a small edit against the same fingerprinted snapshot that will be committed. */
export const createUsbSongEditResolver =
  (
    request: PioneerUsbSongEditRequest,
    result: PioneerUsbSongEditResult,
    onAnalyzePath: (file: string) => void
  ): UsbWriteOperationResolver =>
  async (root, snapshots, remember, stage) => {
    const track = snapshots[request.source.libraryType]?.tracks.find(
      (item) => item.id === request.source.trackId
    )
    if (!track || pathKey(resolveUsbFile(root, track.filePath)) !== pathKey(request.filePath))
      throw new Error('U 盘歌曲已变化，请重新加载歌曲')
    const analyze = resolveUsbFile(root, track.analyzePath)
    onAnalyzePath(analyze)
    if (request.edit.kind === 'shift-grid')
      return { kind: 'shift-grid', trackId: track.id, offsetMs: request.edit.offsetMs }

    const cueDirectory = path.join(stage, 'cue-source')
    await fs.mkdir(cueDirectory)
    const stem = analyze.replace(/\.(DAT|EXT|2EX|3EX)$/i, '')
    for (const extension of ['DAT', 'EXT', '2EX', '3EX', 'CUE']) {
      const file = `${stem}.${extension}`
      const hash = await remember(file)
      if (hash === null) continue
      const copy = path.join(cueDirectory, path.basename(file))
      await fs.copyFile(file, copy)
      if ((await usbFileHash(copy)) !== hash) throw new Error('读取期间 U 盘标点发生变化')
    }
    let cues: ReturnType<typeof normalizeRequiredPioneerCueDump> | undefined
    let readError: unknown
    await readPioneerCuesInWorker([path.join(cueDirectory, path.basename(analyze))], (progress) => {
      const item = progress as { dump?: Parameters<typeof normalizeRequiredPioneerCueDump>[0] }
      try {
        cues = normalizeRequiredPioneerCueDump(item?.dump)
      } catch (error) {
        readError = error
      }
    })
    if (readError) throw readError
    if (!cues?.hotCues || !cues.memoryCues) throw new Error('未能完整读取 U 盘标点')
    let hotCues = cues.hotCues
    let memoryCues = cues.memoryCues
    const edit = request.edit
    if (
      (edit.kind === 'set-hot-cue' || edit.kind === 'add-memory-cue') &&
      Boolean(edit.cue?.isLoop) !== (edit.cue?.loopEndSec !== undefined)
    )
      throw new Error('Loop 状态与终点不一致')
    if (edit.kind === 'set-hot-cue') {
      const previous = hotCues.find((cue) => cue.slot === edit.cue.slot)
      const updated = upsertSongHotCueDefinition(previous ? [previous] : [], {
        ...edit.cue,
        source: 'rekordbox'
      })[0]
      if (edit.cue.comment === undefined) updated.comment = previous?.comment
      hotCues = [...hotCues.filter((cue) => cue.slot !== edit.cue.slot), updated].sort(
        (a, b) => a.slot - b.slot
      )
    }
    if (edit.kind === 'delete-hot-cue') hotCues = hotCues.filter((cue) => cue.slot !== edit.slot)
    if (edit.kind === 'add-memory-cue') {
      const previous = memoryCues.find(
        (cue) =>
          Math.round(cue.sec * 1000) === Math.round(edit.cue.sec * 1000) &&
          Math.round((cue.loopEndSec || 0) * 1000) === Math.round((edit.cue.loopEndSec || 0) * 1000)
      )
      const updated = upsertSongMemoryCueDefinition(previous ? [previous] : [], {
        ...edit.cue,
        source: 'rekordbox'
      })[0]
      if (previous) updated.comment = previous.comment
      memoryCues = [...memoryCues.filter((cue) => cue !== previous), updated].sort(
        (a, b) => a.sec - b.sec
      )
    }
    if (edit.kind === 'delete-memory-cue')
      memoryCues = memoryCues.filter(
        (cue) => Math.round(cue.sec * 1000) !== Math.round(edit.sec * 1000)
      )
    result.hotCues = hotCues
    result.memoryCues = memoryCues
    return { kind: 'set-cues', trackId: track.id, hotCues, memoryCues }
  }

const runEdit = async (
  request: PioneerUsbSongEditRequest,
  owner: number
): Promise<PioneerUsbSongEditResponse> => {
  try {
    const source = request?.source
    if (
      !source ||
      typeof source.rootPath !== 'string' ||
      !['deviceLibrary', 'oneLibrary'].includes(source.libraryType) ||
      !Number.isSafeInteger(source.trackId) ||
      source.trackId <= 0 ||
      typeof request.filePath !== 'string' ||
      !path.isAbsolute(request.filePath) ||
      !request.edit ||
      ![
        'set-hot-cue',
        'delete-hot-cue',
        'add-memory-cue',
        'delete-memory-cue',
        'shift-grid'
      ].includes(request.edit.kind)
    )
      throw new Error('无效 U 盘歌曲编辑请求')
    const edit = request.edit
    if (edit.kind === 'set-hot-cue') validateUsbCues([edit.cue], [])
    if (edit.kind === 'add-memory-cue') validateUsbCues([], [edit.cue])
    if (
      edit.kind === 'delete-hot-cue' &&
      (!Number.isSafeInteger(edit.slot) || edit.slot < 0 || edit.slot > 7)
    )
      throw new Error('无效 Hot Cue 槽位')
    if (
      edit.kind === 'delete-memory-cue' &&
      (typeof edit.sec !== 'number' || !Number.isFinite(edit.sec) || edit.sec < 0)
    )
      throw new Error('无效 Memory Cue 时间')
    if (edit.kind === 'shift-grid' && !Number.isSafeInteger(edit.offsetMs))
      throw new Error('网格平移必须使用整数毫秒')
    const result: PioneerUsbSongEditResult = { filePath: request.filePath }
    let analyze = ''
    const committed = await executePioneerUsbWrite(
      {
        rootPath: source.rootPath,
        libraryType: source.libraryType,
        operation: { kind: 'shift-grid', trackId: source.trackId, offsetMs: 0 }
      },
      owner,
      createUsbSongEditResolver(request, result, (file) => {
        analyze = file
      }),
      async (replacements) => {
        if (request.edit.kind !== 'shift-grid') return
        const file =
          replacements.find((item) => pathKey(item.target) === pathKey(analyze))?.staged || analyze
        const grid = parseUsbAnlz(await fs.readFile(file)).sections.find(
          (s) => s.kind === 'PQTZ'
        )?.bytes
        if (!grid || grid.length < 24 || grid.length !== 24 + grid.readUInt32BE(20) * 8)
          throw new Error('未能读取待保存的 U 盘网格')
        result.rekordboxGridEntries = Array.from({ length: grid.readUInt32BE(20) }, (_, index) => ({
          beatNumber: grid.readUInt16BE(24 + index * 8),
          bpm: grid.readUInt16BE(26 + index * 8) / 100,
          timeMs: grid.readUInt32BE(28 + index * 8)
        }))
      }
    )
    if (!committed.ok) return committed
    if (result.rekordboxGridEntries) {
      const beatGridMap = createSongBeatGridMapV2FromRekordboxEntries(result.rekordboxGridEntries)
      emitSongGridUpdated({
        filePath: result.filePath,
        beatGridMap,
        rekordboxGridEntries: result.rekordboxGridEntries
      })
    } else {
      emitSongHotCuesUpdated(result)
      emitSongMemoryCuesUpdated(result)
    }
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const enqueueEdit = <T>(rootPath: string, task: () => Promise<T>): Promise<T> => {
  const key = pathKey(rootPath)
  const previous = queue.get(key) || Promise.resolve()
  const pending = previous.catch(() => undefined).then(task)
  queue.set(key, pending)
  void pending
    .finally(() => {
      if (queue.get(key) === pending) queue.delete(key)
    })
    .catch(() => undefined)
  return pending
}

export const editPioneerUsbSong = (request: PioneerUsbSongEditRequest, owner: number) =>
  enqueueEdit(String(request?.source?.rootPath || ''), () => runEdit(request, owner))

export const waitForPioneerUsbEdits = async (rootPath: string) => {
  const key = pathKey(rootPath)
  while (queue.has(key)) await queue.get(key)?.catch(() => undefined)
}

export const writePioneerUsbOperation = (
  request: PioneerUsbWriteRequest,
  owner: number
): Promise<PioneerUsbWriteResponse> =>
  enqueueEdit(String(request?.rootPath || ''), async () => {
    if (
      !request?.operation ||
      ['delete-tracks', 'delete-playlist'].includes(request.operation.kind)
    )
      return { ok: false, error: '删除操作必须经过删除确认' }
    return executePioneerUsbWrite(request, owner)
  })
