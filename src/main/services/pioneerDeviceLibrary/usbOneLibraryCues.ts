import { isDeepStrictEqual } from 'node:util'
import { isValidPioneerUsbLoopBeatPair } from '../../../shared/pioneerUsbLoopBeats'
import type { PioneerUsbCue } from '../../../shared/pioneerUsbWrite'
import {
  quoteUsbSqlIdentifier,
  requireUsbOneLibraryColumns,
  usbOneLibraryRows,
  type UsbOneLibraryColumn,
  type UsbOneLibraryDatabase,
  type UsbOneLibraryRow
} from './usbOneLibraryConnection'

const positionSuffixes = [
  'Usec',
  '150FramePerSec',
  'MpegFrameNumber',
  'MpegAbs',
  'DecodingStartFramePosition',
  'FileOffsetInBlock',
  'NumberOfSampleInBlock'
]
const cueFields = [
  'cue_id',
  'content_id',
  'kind',
  'colorTableIndex',
  'cueComment',
  'isActiveLoop',
  'beatLoopNumerator',
  'beatLoopDenominator',
  ...positionSuffixes.flatMap((suffix) => [`in${suffix}`, `out${suffix}`])
]

function cueUsec(cue: PioneerUsbCue, end = false): number {
  const sec = end ? cue.loopEndSec : cue.sec
  if (sec === undefined) return -1
  if (!Number.isFinite(sec) || sec < 0 || !Number.isSafeInteger(Math.round(sec * 1e6))) {
    throw new Error('Cue 时间必须是有限的非负数')
  }
  return Math.round(sec * 1e6)
}

function normalizeCues(
  hotCues: PioneerUsbCue[],
  memoryCues: PioneerUsbCue[],
  requirePaletteIndex: boolean
) {
  if (hotCues.length > 8 || memoryCues.length > 10) throw new Error('超过设备 Cue 数量上限')
  const slots = new Set<number>()
  let activeCount = 0
  return [
    ...hotCues.map((cue) => {
      if (!Number.isInteger(cue.slot) || cue.slot! < 0 || cue.slot! > 7 || slots.has(cue.slot!)) {
        throw new Error('Hot Cue 槽位必须唯一且在 A–H 范围内')
      }
      slots.add(cue.slot!)
      return { cue, kind: cue.slot! + 1 }
    }),
    ...memoryCues.map((cue) => ({ cue, kind: 0 }))
  ].map(({ cue, kind }) => {
    const inUsec = cueUsec(cue)
    const outUsec = cueUsec(cue, true)
    if (outUsec !== -1 && outUsec <= inUsec) throw new Error('Loop 终点必须晚于起点')
    if (
      (cue.loopNumerator !== undefined || cue.loopDenominator !== undefined) &&
      (outUsec === -1 || !isValidPioneerUsbLoopBeatPair(cue.loopNumerator, cue.loopDenominator))
    ) {
      throw new Error('Loop 拍数必须是完整且有效的分子/分母，单点不能设置 Loop 拍数')
    }
    if (cue.activeLoop && outUsec === -1) throw new Error('Active Loop 必须有有效的 Loop 终点')
    if (cue.activeLoop && kind > 0) throw new Error('Active Loop 必须是 Memory Loop')
    if (cue.activeLoop && ++activeCount > 1) throw new Error('每首歌曲只能有一个 Active Loop')
    if (
      cue.colorIndex !== undefined &&
      (!Number.isInteger(cue.colorIndex) || cue.colorIndex < 0 || cue.colorIndex > 255)
    ) {
      throw new Error('Cue 颜色索引无效')
    }
    if (requirePaletteIndex && cue.color && cue.colorIndex === undefined) {
      throw new Error('OneLibrary Cue 颜色需要提供对应的 colorIndex')
    }
    if (
      cue.comment !== undefined &&
      (typeof cue.comment !== 'string' || cue.comment.length > 255)
    ) {
      throw new Error('Cue 备注不能超过 255 个字符')
    }
    return { cue, kind, inUsec, outUsec }
  })
}

/**
 * ANLZ-only 的普通歌曲标点由上层统一原子写入 ANLZ，独立 Bank List SQL 行完整保留。
 * 已有 SQL cue 的导出只复用设备原生、同毫秒显示位置的定位字段，保留原始微秒精度与 NULL。
 * 已有 SQL cue 的 OneLibrary 的 MPEG/decoder seek 信息尚无可验证生成算法；任意新位置必须拒绝，
 * 不能使用 0、旧位置定位信息或 ffprobe packet offset 冒充正确的 Pioneer seek 信息。
 * 原生位置可用于变更槽位、备注、颜色、active 状态或删除标点；Loop 仍需完整原生模板。
 */
export function replaceUsbOneLibraryCues(
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>,
  trackId: number,
  hotCues: PioneerUsbCue[],
  memoryCues: PioneerUsbCue[],
  anlzOnly: boolean,
  bankCueIds: ReadonlySet<number>
): void {
  requireUsbOneLibraryColumns(schema, 'cue', cueFields)
  const columns = schema.get('cue')!
  const names = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]))
  const field = (name: string) => names.get(name.toLowerCase())!
  const value = (row: UsbOneLibraryRow, name: string) => row[field(name)]
  const current = usbOneLibraryRows(
    db,
    'SELECT * FROM cue WHERE content_id = ? ORDER BY cue_id',
    trackId
  ).filter((row) => !bankCueIds.has(Number(value(row, 'cue_id'))))
  // 原生 dbVersion 10000/1000 样本分别有 140/833 首 DAT 含 PCOB，
  // 而普通歌曲 SQL Cue 为空；已识别 kind 101 Bank List 标点另行保存并完整保留。
  // 该 profile 以 ANLZ 保存歌曲标点；不能为了更新 ANLZ 而凭空建立带未知 seek 的 SQL 行。
  // OneLibrary 直接编辑 Hot Cue 的原生前后样本确认，SQL 所有表和修改计数均保持不变。
  // 上层负责修改 DAT/EXT/2EX；此处只校验，不能凭空写入标记或同步计数。
  const requested = normalizeCues(hotCues, memoryCues, !anlzOnly)
  if (anlzOnly) {
    const content = db
      .prepare('SELECT analysisDataFilePath FROM content WHERE content_id = ?')
      .get(trackId)
    if (
      !content ||
      typeof content.analysisDataFilePath !== 'string' ||
      !content.analysisDataFilePath
    ) {
      throw new Error('ANLZ-only OneLibrary 歌曲缺少分析文件路径')
    }
    return
  }
  if (
    current.some(
      (row) =>
        !Number.isInteger(value(row, 'kind')) ||
        Number(value(row, 'kind')) < 0 ||
        Number(value(row, 'kind')) > 8
    )
  ) {
    throw new Error('检测到未知的 OneLibrary Cue kind，拒绝覆盖')
  }
  const assignedIds = new Set<number>()
  let nextId = Number(db.prepare('SELECT COALESCE(MAX(cue_id), 0) AS id FROM cue').get()?.id) + 1
  const replacements = requested.map(({ cue, kind, inUsec, outUsec }) => {
    // 编辑器读取 ANLZ 的毫秒位置，SQL 原生位置还可能含微秒余数。
    // 一个毫秒显示位置只允许对应一个原生 seek 模板；保留其原始微秒，不能从显示时间重算定位。
    const templates = current.filter(
      (row) =>
        Math.round(Number(value(row, 'inUsec')) / 1000) === Math.round(inUsec / 1000) &&
        (outUsec === -1
          ? Number(value(row, 'outUsec')) <= Number(value(row, 'inUsec'))
          : Number(value(row, 'outUsec')) > Number(value(row, 'inUsec')) &&
            Math.round(Number(value(row, 'outUsec')) / 1000) === Math.round(outUsec / 1000))
    )
    if (!templates.length) {
      throw new Error(
        `OneLibrary 尚未验证此 Cue 位置的设备定位字段 (${inUsec / 1e6}s${outUsec >= 0 ? `–${outUsec / 1e6}s` : ''})；需要 rekordbox 原生导出样本确认后才能写入`
      )
    }
    const requiredIntegers = ['cue_id', 'content_id', 'kind', 'inUsec', 'outUsec', 'isActiveLoop']
    const preservedIntegers = [
      'beatLoopNumerator',
      'beatLoopDenominator',
      ...positionSuffixes
        .filter((suffix) => suffix !== 'Usec')
        .flatMap((suffix) => [`in${suffix}`, `out${suffix}`])
    ]
    if (
      templates.some(
        (template) =>
          requiredIntegers.some((name) => !Number.isSafeInteger(value(template, name))) ||
          preservedIntegers.some(
            (name) => value(template, name) !== null && !Number.isSafeInteger(value(template, name))
          )
      )
    ) {
      throw new Error('OneLibrary 原有 Cue 定位字段不完整，无法复用')
    }
    const fingerprints = new Set(
      templates.map((template) =>
        JSON.stringify([
          value(template, 'inUsec'),
          value(template, 'outUsec'),
          ...positionSuffixes
            .filter((suffix) => suffix !== 'Usec')
            .flatMap((suffix) => [`in${suffix}`, `out${suffix}`])
            .map((name) => value(template, name))
        ])
      )
    )
    if (fingerprints.size !== 1) {
      throw new Error('同一毫秒位置对应多个不同的 OneLibrary 原生 Cue 定位，无法确定编辑目标')
    }
    const template =
      templates.find(
        (row) => value(row, 'kind') === kind && !assignedIds.has(Number(value(row, 'cue_id')))
      ) ?? templates[0]
    // 有些现存库仅保存 usec，frame/decoder 列为 NULL。原时间不变时保留 NULL，
    // 不把 NULL 解释成可生成新位置的算法，也不将其替换成猜测的零值。
    const identity = current.find(
      (row) =>
        !assignedIds.has(Number(value(row, 'cue_id'))) &&
        value(row, 'kind') === kind &&
        (kind > 0 ||
          (value(row, 'inUsec') === value(template, 'inUsec') &&
            value(row, 'outUsec') === value(template, 'outUsec')))
    )
    const id = identity ? Number(value(identity, 'cue_id')) : nextId++
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff)
      throw new Error('OneLibrary Cue ID 已耗尽')
    assignedIds.add(id)
    const replacement = { ...template, ...(identity || {}) }
    for (const name of cueFields) replacement[field(name)] = value(template, name)
    replacement[field('cue_id')] = id
    replacement[field('content_id')] = trackId
    replacement[field('kind')] = kind
    replacement[field('cueComment')] = cue.comment ?? value(identity || template, 'cueComment')
    replacement[field('colorTableIndex')] =
      cue.colorIndex ?? value(identity || template, 'colorTableIndex')
    replacement[field('isActiveLoop')] =
      kind > 0 || outUsec === -1
        ? 0
        : cue.activeLoop === undefined
          ? value(identity || template, 'isActiveLoop')
          : Number(cue.activeLoop)
    // 拍数是 Loop 的可编辑属性，不属于定位信息。同一位置可同时有
    // 不同拍数的 Hot / Memory Loop，未提供拍数时保留各自原生模板。
    if (cue.loopNumerator !== undefined && cue.loopDenominator !== undefined) {
      replacement[field('beatLoopNumerator')] = cue.loopNumerator
      replacement[field('beatLoopDenominator')] = cue.loopDenominator
    }
    return replacement
  })
  if (replacements.filter((row) => value(row, 'isActiveLoop') === 1).length > 1) {
    throw new Error('每首歌曲只能有一个 Active Loop')
  }

  const removedIds = current
    .map((row) => Number(value(row, 'cue_id')))
    .filter((id) => !assignedIds.has(id))
  const currentById = new Map(current.map((row) => [Number(value(row, 'cue_id')), row]))
  const changedReplacements = replacements.filter((row) => {
    const previous = currentById.get(Number(value(row, 'cue_id')))
    return (
      !previous ||
      columns.some((column) => !isDeepStrictEqual(previous[column.name], row[column.name]))
    )
  })
  if (!removedIds.length && !changedReplacements.length) return
  if (schema.has('hotCueBankList_cue')) {
    requireUsbOneLibraryColumns(schema, 'hotCueBankList_cue', ['cue_id'])
    const removeBankReference = db.prepare('DELETE FROM hotCueBankList_cue WHERE cue_id = ?')
    removedIds.forEach((id) => removeBankReference.run(id))
  }
  // 更新保留的 ID，避免 FK 存在时先删后插破坏仍在使用的 Hot Cue Bank 引用。
  const currentIds = new Set(current.map((row) => Number(value(row, 'cue_id'))))
  const writable = columns.map((column) => column.name).filter((name) => name !== field('cue_id'))
  const update = db.prepare(
    `UPDATE cue SET ${writable.map((name) => `${quoteUsbSqlIdentifier(name)} = ?`).join(', ')} WHERE cue_id = ?`
  )
  const insert = db.prepare(
    `INSERT INTO cue (${columns.map((column) => quoteUsbSqlIdentifier(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  )
  for (const row of changedReplacements) {
    const id = Number(value(row, 'cue_id'))
    if (currentIds.has(id)) update.run(...writable.map((name) => row[name]), id)
    else insert.run(...columns.map((column) => row[column.name]))
  }
  const removeCue = db.prepare('DELETE FROM cue WHERE cue_id = ?')
  removedIds.forEach((id) => removeCue.run(id))
  db.prepare(
    `UPDATE content SET hasModified = 1,
    cueUpdateCount = COALESCE(cueUpdateCount, 0) + 1 WHERE content_id = ?`
  ).run(trackId)
}
