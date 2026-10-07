import {
  requireUsbOneLibraryColumns,
  usbOneLibraryRows,
  type UsbOneLibraryColumn,
  type UsbOneLibraryDatabase
} from './usbOneLibraryConnection'

const hasNativeBankVersion = (
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>
): boolean => {
  if (!schema.get('property')?.some((column) => column.name === 'dbVersion')) return false
  const rows = usbOneLibraryRows(db, 'SELECT dbVersion FROM property')
  return rows.length === 1 && ['1000', '10000'].includes(String(rows[0].dbVersion))
}

/** Native deletion leaves an unlinked kind-101 row, including after content ID reuse. */
export const readUsbOneLibraryDeletedBankCueIds = (
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>
): ReadonlySet<number> => {
  if (!hasNativeBankVersion(db, schema) || !schema.has('cue') || !schema.has('hotCueBankList_cue'))
    return new Set()
  const zeroFields = [
    'beatLoopNumerator',
    'beatLoopDenominator',
    ...[
      'MpegFrameNumber',
      'MpegAbs',
      'DecodingStartFramePosition',
      'FileOffsetInBlock',
      'NumberOfSampleInBlock'
    ].flatMap((suffix) => [`in${suffix}`, `out${suffix}`])
  ]
  requireUsbOneLibraryColumns(schema, 'cue', [
    'cue_id',
    'content_id',
    'kind',
    'isActiveLoop',
    'inUsec',
    'outUsec',
    'colorTableIndex',
    'cueComment',
    'in150FramePerSec',
    'out150FramePerSec',
    ...zeroFields
  ])
  requireUsbOneLibraryColumns(schema, 'hotCueBankList_cue', ['cue_id'])
  const names = new Map(
    schema.get('cue')!.map((column) => [column.name.toLowerCase(), column.name])
  )
  return new Set(
    usbOneLibraryRows(
      db,
      `SELECT q.* FROM cue q
    WHERE q.kind = 101
    AND NOT EXISTS (SELECT 1 FROM hotCueBankList_cue r WHERE r.cue_id = q.cue_id)`
    )
      .filter(
        (row) =>
          Number.isSafeInteger(row.cue_id) &&
          Number(row.cue_id) > 0 &&
          Number.isSafeInteger(row.content_id) &&
          Number(row.content_id) > 0 &&
          row.isActiveLoop === null &&
          row.colorTableIndex === 0 &&
          row.cueComment === '' &&
          zeroFields.every((field) => row[names.get(field.toLowerCase())!] === 0) &&
          Number.isSafeInteger(row.inUsec) &&
          Number(row.inUsec) >= 0 &&
          (row.outUsec === -1 ||
            (Number.isSafeInteger(row.outUsec) && Number(row.outUsec) > Number(row.inUsec))) &&
          row[names.get('in150framepersec')!] === Math.floor((Number(row.inUsec) / 1000) * 0.15) &&
          row[names.get('out150framepersec')!] ===
            (row.outUsec === -1 ? 0 : Math.floor((Number(row.outUsec) / 1000) * 0.15))
      )
      .map((row) => Number(row.cue_id))
  )
}

/** Native rekordbox 7.2.19 Bank points and loops share kind 101, separately from ANLZ cues. */
export const readUsbOneLibraryBankCueIds = (
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>
): ReadonlySet<number> => {
  if (!schema.has('cue')) return new Set()
  requireUsbOneLibraryColumns(schema, 'cue', ['cue_id', 'kind'])
  const points = usbOneLibraryRows(db, 'SELECT cue_id FROM cue WHERE kind = 101')
  if (!points.length) return new Set()
  requireUsbOneLibraryColumns(schema, 'hotCueBankList_cue', ['hotCueBankList_id', 'cue_id'])
  requireUsbOneLibraryColumns(schema, 'hotCueBankList', ['hotCueBankList_id', 'attribute'])
  const linked = new Set(
    usbOneLibraryRows(
      db,
      `SELECT DISTINCT c.cue_id FROM cue c
      INNER JOIN hotCueBankList_cue r ON r.cue_id = c.cue_id
      INNER JOIN hotCueBankList b ON b.hotCueBankList_id = r.hotCueBankList_id
      WHERE c.kind = 101 AND b.attribute = 0`
    ).map((row) => Number(row.cue_id))
  )
  const deleted = readUsbOneLibraryDeletedBankCueIds(db, schema)
  if (
    points.some(
      (row) =>
        !Number.isSafeInteger(row.cue_id) ||
        Number(row.cue_id) < 1 ||
        (!linked.has(Number(row.cue_id)) && !deleted.has(Number(row.cue_id)))
    )
  ) {
    throw new Error('OneLibrary Bank List 标点缺少有效列表引用，无法确认标点保存方式')
  }
  return new Set([...linked, ...deleted])
}

/** Lock the observed export profile before mutation; bank rows do not describe normal song cues. */
export const isUsbOneLibraryAnlzCueProfile = (
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>,
  bankCueIds: ReadonlySet<number>
): boolean => {
  if (!schema.get('property')?.some((column) => column.name === 'dbVersion') || !schema.has('cue'))
    return false
  const properties = usbOneLibraryRows(db, 'SELECT dbVersion FROM property')
  if (properties.length !== 1 || !['1000', '10000'].includes(String(properties[0].dbVersion)))
    return false
  return usbOneLibraryRows(db, 'SELECT cue_id, kind FROM cue').every(
    (row) => row.kind === 101 && bankCueIds.has(Number(row.cue_id))
  )
}
