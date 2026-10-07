import {
  hasPioneerUsbCueMillisecondPrecision,
  type PioneerUsbCue
} from '../../../shared/pioneerUsbWrite'
import { pioneerUsbHotCueDisplayColor } from '../../../shared/pioneerUsbCueColors'
import { isValidPioneerUsbLoopBeatPair } from '../../../shared/pioneerUsbLoopBeats'
import { validateUsbAnlzPhraseForGridShift } from './usbAnlzPhrase'
import type { UsbFlacCueLocator } from './usbFlacCueLocator'
import type { UsbMpegCueLocator } from './usbMpegCueLocator'

type AnlzSection = { kind: string; bytes: Buffer }
type AnlzDocument = { header: Buffer; sections: AnlzSection[] }

export const parseUsbAnlz = (bytes: Buffer): AnlzDocument => {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'PMAI')
    throw new Error('无效 ANLZ 文件')
  const headerLength = bytes.readUInt32BE(4)
  if (headerLength < 12 || headerLength > bytes.length || bytes.readUInt32BE(8) !== bytes.length) {
    throw new Error('ANLZ 文件长度不一致')
  }
  const sections: AnlzSection[] = []
  for (let offset = headerLength; offset < bytes.length; ) {
    if (offset + 12 > bytes.length) throw new Error('ANLZ 区段头被截断')
    const headerSize = bytes.readUInt32BE(offset + 4)
    const size = bytes.readUInt32BE(offset + 8)
    if (headerSize < 12 || size < headerSize || offset + size > bytes.length) {
      throw new Error('ANLZ 区段长度不合法')
    }
    sections.push({
      kind: bytes.toString('ascii', offset, offset + 4),
      bytes: Buffer.from(bytes.subarray(offset, offset + size))
    })
    offset += size
  }
  return { header: Buffer.from(bytes.subarray(0, headerLength)), sections }
}

const buildDocument = (document: AnlzDocument): Buffer => {
  const bytes = Buffer.concat([
    document.header,
    ...document.sections.map((section) => section.bytes)
  ])
  bytes.writeUInt32BE(bytes.length, 8)
  parseUsbAnlz(bytes)
  return bytes
}

const cueTime = (sec: number) => {
  const ms = Math.round(sec * 1000)
  if (!Number.isFinite(sec) || sec < 0 || ms > 0xfffffffe) throw new Error('Cue 时间超出范围')
  if (!hasPioneerUsbCueMillisecondPrecision(sec)) throw new Error('Cue 时间精度最多为毫秒')
  return ms
}

export const validateUsbCues = (hotCues: PioneerUsbCue[], memoryCues: PioneerUsbCue[]) => {
  if (!Array.isArray(hotCues) || !Array.isArray(memoryCues)) throw new Error('无效 Cue 列表')
  if (hotCues.length > 8 || memoryCues.length > 10)
    throw new Error('最多支持 8 个 Hot Cue 和 10 个 Memory Cue')
  const slots = new Set<number>()
  const memory = new Set<string>()
  let activeCount = 0
  for (const [hot, cues] of [
    [true, hotCues],
    [false, memoryCues]
  ] as const) {
    for (const cue of cues) {
      if (!cue || typeof cue !== 'object') throw new Error('无效 Cue')
      const start = cueTime(cue.sec)
      if (cue.loopEndSec !== undefined && cueTime(cue.loopEndSec) <= start)
        throw new Error('Loop 终点必须晚于起点')
      if (cue.loopNumerator !== undefined || cue.loopDenominator !== undefined) {
        const numerator = cue.loopNumerator
        const denominator = cue.loopDenominator
        if (
          numerator === undefined ||
          denominator === undefined ||
          !isValidPioneerUsbLoopBeatPair(numerator, denominator)
        )
          throw new Error('Loop 节拍必须为 0/0，或一项为 1、另一项为 1–32768 的 2 次幂')
        if (cue.loopEndSec === undefined && numerator > 0)
          throw new Error('单点 Cue 不能设置 Loop 节拍')
      }
      if (cue.activeLoop !== undefined && typeof cue.activeLoop !== 'boolean')
        throw new Error('无效 Active Loop 状态')
      if (cue.activeLoop) {
        if (hot || cue.loopEndSec === undefined) throw new Error('Active Loop 必须是 Memory Loop')
        activeCount++
      }
      if (
        cue.comment !== undefined &&
        (typeof cue.comment !== 'string' || cue.comment.includes('\0') || cue.comment.length > 1024)
      )
        throw new Error('Cue 备注无效或过长')
      if (cue.color !== undefined && !/^#[0-9a-f]{6}$/i.test(cue.color))
        throw new Error('无效 Cue 颜色')
      if (
        cue.colorIndex !== undefined &&
        (!Number.isInteger(cue.colorIndex) || cue.colorIndex < 0 || cue.colorIndex > (hot ? 62 : 8))
      )
        throw new Error('Cue 颜色编号超出范围')
      if (hot) {
        if (!Number.isInteger(cue.slot) || cue.slot! < 0 || cue.slot! > 7 || slots.has(cue.slot!))
          throw new Error('Hot Cue 槽位无效或重复')
        slots.add(cue.slot!)
      } else {
        const key = `${start}:${cue.loopEndSec === undefined ? '' : cueTime(cue.loopEndSec)}`
        if (memory.has(key)) throw new Error('Memory Cue 位置重复')
        memory.add(key)
      }
    }
  }
  if (activeCount > 1) throw new Error('一首歌曲最多只能有一个 Active Loop')
}

const entriesOf = (section: Buffer, extended: boolean): Buffer[] => {
  const minimum = extended ? 20 : 24
  if (section.length < minimum || section.readUInt32BE(4) !== minimum)
    throw new Error('不支持的 Cue 区段头')
  const count = section.readUInt16BE(extended ? 16 : 18)
  const entries: Buffer[] = []
  let offset = minimum
  for (let index = 0; index < count; index++) {
    if (offset + 12 > section.length) throw new Error('Cue 条目被截断')
    const size = section.readUInt32BE(offset + 8)
    if (
      size < (extended ? 40 : 56) ||
      (extended && size > 40 && size < 44) ||
      section.readUInt32BE(offset + 4) !== (extended ? 16 : 28) ||
      offset + size > section.length ||
      section.toString('ascii', offset, offset + 4) !== (extended ? 'PCP2' : 'PCPT')
    )
      throw new Error('不支持的 Cue 条目')
    entries.push(Buffer.from(section.subarray(offset, offset + size)))
    offset += size
  }
  if (offset !== section.length) throw new Error('Cue 区段包含未解析数据')
  return entries
}

const findTemplate = (entries: Buffer[], cue: PioneerUsbCue, hot: boolean, extended: boolean) =>
  entries.find((entry) =>
    hot
      ? entry.readUInt32BE(12) === cue.slot! + 1
      : entry.readUInt32BE(extended ? 20 : 32) === cueTime(cue.sec) &&
        entry.readUInt32BE(extended ? 24 : 36) ===
          (cue.loopEndSec === undefined ? 0xffffffff : cueTime(cue.loopEndSec))
  )

const utf16Be = (value: string): Buffer => {
  const result = Buffer.from(value + '\0', 'utf16le')
  return result.swap16()
}

const extendedCueSuffix = (entry: Buffer): Buffer => {
  if (entry.length < 44) return Buffer.alloc(0)
  const commentSize = entry.readUInt32BE(40)
  if (commentSize > entry.length - 44) throw new Error('Cue 备注长度无效')
  return entry.subarray(44 + commentSize)
}

/** Check all legacy slot partitions before adding points without a verified locator. */
export const validateUsbAnlzMpegCueFamily = (
  files: Buffer[],
  hotCues: PioneerUsbCue[],
  memoryCues: PioneerUsbCue[]
) => {
  const sections = files.flatMap((bytes) =>
    parseUsbAnlz(bytes)
      .sections.filter((section) => section.kind === 'PCOB')
      .map((section) => ({
        hot: section.bytes.readUInt32BE(12) === 1,
        entries: entriesOf(section.bytes, false)
      }))
  )
  if (
    !sections.some(({ entries }) =>
      entries.some((entry) => entry.subarray(40).some((byte) => byte !== 0))
    )
  )
    return
  for (const [hot, cues] of [
    [true, hotCues],
    [false, memoryCues]
  ] as const) {
    const entries = sections
      .filter((section) => section.hot === hot)
      .flatMap((section) => section.entries)
    for (const cue of cues) {
      const matches = entries.filter((entry) =>
        hot
          ? entry.readUInt32BE(12) === cue.slot! + 1
          : entry.readUInt32BE(32) === cueTime(cue.sec) &&
            entry.readUInt32BE(36) ===
              (cue.loopEndSec === undefined ? 0xffffffff : cueTime(cue.loopEndSec))
      )
      if (
        !matches.length ||
        matches.some(
          (entry) =>
            entry.readUInt32BE(32) !== cueTime(cue.sec) ||
            entry.readUInt32BE(36) !==
              (cue.loopEndSec === undefined ? 0xffffffff : cueTime(cue.loopEndSec))
        )
      )
        throw new Error(
          '旧式 ANLZ 标点含设备 MPEG 定位，尚不能新增或移动位置；可修改原位置属性或删除标点'
        )
    }
  }
}

const validateExistingMpegPositions = (
  document: AnlzDocument,
  extension: string,
  hotCues: PioneerUsbCue[],
  memoryCues: PioneerUsbCue[],
  locator?: UsbMpegCueLocator
) => {
  const sections = document.sections
    .filter((section) => section.kind === 'PCOB')
    .map((section) => ({
      hot: section.bytes.readUInt32BE(12) === 1,
      entries: entriesOf(section.bytes, false)
    }))
  if (locator) {
    for (const { entries } of sections)
      for (const entry of entries) {
        if (entry.length !== 56) throw new Error('MPEG Cue 含未知旧式条目布局')
        if (!entry.subarray(40).some((byte) => byte !== 0)) continue
        const start = locator(entry.readUInt32BE(32))
        const endMs = entry.readUInt32BE(36)
        const end = endMs === 0xffffffff ? undefined : locator(endMs)
        if (
          entry.readUInt32BE(40) !== start.mpegFrame ||
          entry.readUInt32BE(44) !== (end?.mpegFrame ?? 0) ||
          entry.readUInt32BE(48) !== start.mpegAbs ||
          entry.readUInt32BE(52) !== (end?.mpegAbs ?? 0)
        )
          throw new Error('MPEG Cue 原有定位与音频不一致，已停止写入')
      }
    return
  }
  if (
    !sections.some(({ entries }) =>
      entries.some((entry) => entry.subarray(40).some((byte) => byte !== 0))
    )
  )
    return
  for (const { hot, entries } of sections) {
    if (!hot && extension === '.EXT' && !entries.length) continue
    const requested = hot
      ? hotCues.filter((cue) => (extension === '.DAT' ? cue.slot! < 3 : cue.slot! >= 3))
      : memoryCues
    for (const cue of requested) {
      const template = findTemplate(entries, cue, hot, false)
      if (
        !template ||
        template.readUInt32BE(32) !== cueTime(cue.sec) ||
        template.readUInt32BE(36) !==
          (cue.loopEndSec === undefined ? 0xffffffff : cueTime(cue.loopEndSec))
      )
        throw new Error(
          '旧式 ANLZ 标点含设备 MPEG 定位，尚不能新增或移动位置；可修改原位置属性或删除标点'
        )
    }
  }
}

const validateExistingCueSeekPositions = (
  document: AnlzDocument,
  hotCues: PioneerUsbCue[],
  memoryCues: PioneerUsbCue[],
  flacLocator?: UsbFlacCueLocator,
  mpegLocator?: UsbMpegCueLocator
) => {
  const extended = document.sections
    .filter((section) => section.kind === 'PCO2')
    .map((section) => {
      const entries = entriesOf(section.bytes, true)
      return { hot: section.bytes.readUInt32BE(12) === 1, entries }
    })
  if (mpegLocator)
    for (const { entries } of extended)
      for (const entry of entries) {
        const suffix = extendedCueSuffix(entry)
        if (![0, 4, 44].includes(suffix.length) || suffix.subarray(4).some((byte) => byte !== 0))
          throw new Error('MPEG Cue 含尚未验证的扩展解码定位，已停止写入')
      }
  // Native PCP2 suffixes contain RGB followed by four BE u64 seek values and
  // two BE u32 sample counts (44 bytes total). Nonzero seek values depend on
  // the cue endpoints; retaining them after a move would point at old audio.
  // Treat an unknown nonzero suffix the same way until its layout is verified.
  if (flacLocator) {
    for (const { entries } of extended)
      for (const entry of entries) {
        const suffix = extendedCueSuffix(entry)
        if (![0, 4, 44].includes(suffix.length))
          throw new Error('FLAC Cue 含未知扩展布局，无法生成解码定位')
        if (suffix.length !== 44 || !suffix.subarray(4).some((byte) => byte !== 0)) continue
        const start = flacLocator(entry.readUInt32BE(20))
        const endMs = entry.readUInt32BE(24)
        const end = endMs === 0xffffffff ? undefined : flacLocator(endMs)
        if (
          suffix.readBigUInt64BE(4) !== BigInt(start.decodingStartFramePosition) ||
          suffix.readBigUInt64BE(12) !== BigInt(end?.decodingStartFramePosition ?? 0) ||
          suffix.readBigUInt64BE(20) !== BigInt(start.fileOffsetInBlock) ||
          suffix.readBigUInt64BE(28) !== BigInt(end?.fileOffsetInBlock ?? 0) ||
          suffix.readUInt32BE(36) !== start.numberOfSampleInBlock ||
          suffix.readUInt32BE(40) !== (end?.numberOfSampleInBlock ?? 0)
        )
          throw new Error('FLAC Cue 原有定位与音频不一致，已停止写入')
      }
    return
  }
  const hasSeekData = extended.some(({ entries }) =>
    entries.some((entry) =>
      extendedCueSuffix(entry)
        .subarray(4)
        .some((byte) => byte !== 0)
    )
  )
  if (!hasSeekData) return
  for (const { hot, entries } of extended) {
    for (const cue of hot ? hotCues : memoryCues) {
      const template = findTemplate(entries, cue, hot, true)
      if (
        !template ||
        template.readUInt32BE(20) !== cueTime(cue.sec) ||
        template.readUInt32BE(24) !==
          (cue.loopEndSec === undefined ? 0xffffffff : cueTime(cue.loopEndSec))
      ) {
        throw new Error('ANLZ 标点含设备解码定位，尚不能新增或移动位置；可修改原位置属性或删除标点')
      }
    }
  }
  for (const [hot, cues] of [
    [true, hotCues],
    [false, memoryCues]
  ] as const) {
    if (cues.length && !extended.some((section) => section.hot === hot))
      throw new Error('ANLZ 标点含设备解码定位，尚不能新增或移动位置；可修改原位置属性或删除标点')
  }
}

const encodeCue = (
  cue: PioneerUsbCue,
  hot: boolean,
  extended: boolean,
  template: Buffer | undefined,
  index: number,
  count: number,
  flacLocator?: UsbFlacCueLocator,
  mpegLocator?: UsbMpegCueLocator
): Buffer => {
  const isLoop = cue.loopEndSec !== undefined
  if (!extended) {
    // Native PCPT also carries four position-dependent MPEG values at 40–55.
    // Do not retain those values under different cue/loop endpoints.
    if (
      !mpegLocator &&
      template?.subarray(40).some((byte) => byte !== 0) &&
      (template.readUInt32BE(32) !== cueTime(cue.sec) ||
        template.readUInt32BE(36) !==
          (cue.loopEndSec === undefined ? 0xffffffff : cueTime(cue.loopEndSec)))
    )
      throw new Error('旧式 ANLZ 标点含设备 MPEG 定位，尚不能移动位置；可修改原位置属性或删除标点')
    const entry = template ? Buffer.from(template) : Buffer.alloc(56)
    entry.write('PCPT', 0, 'ascii')
    entry.writeUInt32BE(28, 4)
    entry.writeUInt32BE(entry.length, 8)
    entry.writeUInt32BE(hot ? cue.slot! + 1 : 0, 12)
    if (cue.activeLoop !== undefined || !template || !isLoop)
      entry.writeUInt32BE(cue.activeLoop ? 4 : 0, 16)
    if (!template) entry.writeUInt32BE(0x10000, 20)
    // Native Hot Cue entries use FFFF in both order fields, independent of bank/slot.
    entry.writeUInt16BE(hot || index === 0 ? 0xffff : index - 1, 24)
    entry.writeUInt16BE(hot || index === count - 1 ? 0xffff : index + 1, 26)
    entry[28] = isLoop ? 2 : 1
    if (!template) entry.writeUInt16BE(1000, 30)
    entry.writeUInt32BE(cueTime(cue.sec), 32)
    entry.writeUInt32BE(isLoop ? cueTime(cue.loopEndSec!) : 0xffffffff, 36)
    if (mpegLocator) {
      const start = mpegLocator(cueTime(cue.sec))
      const end = isLoop ? mpegLocator(cueTime(cue.loopEndSec!)) : undefined
      entry.writeUInt32BE(start.mpegFrame, 40)
      entry.writeUInt32BE(end?.mpegFrame ?? 0, 44)
      entry.writeUInt32BE(start.mpegAbs, 48)
      entry.writeUInt32BE(end?.mpegAbs ?? 0, 52)
    }
    return entry
  }
  const oldCommentSize = template && template.length >= 44 ? template.readUInt32BE(40) : 0
  if (template && template.length >= 44 && oldCommentSize > template.length - 44)
    throw new Error('Cue 备注长度无效')
  const oldComment = template?.subarray(44, 44 + oldCommentSize)
  const comment =
    cue.comment === undefined && oldComment
      ? Buffer.from(oldComment)
      : cue.comment
        ? utf16Be(cue.comment)
        : Buffer.alloc(0)
  const oldSuffix = template?.subarray(44 + oldCommentSize)
  if (oldSuffix && oldSuffix.length > 0 && oldSuffix.length < 4)
    throw new Error('Cue 颜色字段被截断')
  const oldColorIndex = oldSuffix && oldSuffix.length >= 4 ? oldSuffix[0] : 0
  const oldColor = pioneerUsbHotCueDisplayColor(
    oldColorIndex,
    oldSuffix && oldSuffix.length >= 4 ? `#${oldSuffix.subarray(1, 4).toString('hex')}` : undefined
  )
  const colorChanged =
    cue.color !== undefined && (!template || cue.color.toLowerCase() !== oldColor)
  const indexChanged =
    cue.colorIndex !== undefined && (!template || cue.colorIndex !== oldColorIndex)
  const needsColor = hot && (indexChanged || colorChanged)
  // Older native PCP2 memory entries may stop at byte 40 or 44. Keep their
  // compact form until an actual new comment/RGB field requires the modern suffix.
  const compact = !flacLocator && template && template.length < 44 && !comment.length && !needsColor
  // New Hot Cue points have index + RGB; plain Memory Cue points end after
  // their comment length. Keep existing seek/opaque bytes only after the
  // document preflight has ruled out changes to their positions.
  // Native USB MP3 and zero-seek AAC moves drop the exported zero decoder
  // trailer. Only this known layout or verified MPEG locators permit rebuilding;
  // unchanged entries and opaque layouts keep their original suffix.
  const zeroSeekTrailer =
    oldSuffix?.length === 44 && oldSuffix.subarray(4).every((byte) => byte === 0)
  const movedWithoutSeek =
    !flacLocator &&
    template !== undefined &&
    (mpegLocator !== undefined || zeroSeekTrailer) &&
    (template.readUInt32BE(20) !== cueTime(cue.sec) ||
      template.readUInt32BE(24) !== (isLoop ? cueTime(cue.loopEndSec!) : 0xffffffff))
  const suffix = flacLocator
    ? Buffer.alloc(44)
    : movedWithoutSeek
      ? Buffer.alloc(hot ? 4 : 0)
      : !template
        ? Buffer.alloc(hot ? 4 : 0)
        : hot && (comment.length || needsColor) && (oldSuffix?.length ?? 0) < 4
          ? Buffer.alloc(4)
          : oldSuffix || Buffer.alloc(0)
  if (flacLocator || movedWithoutSeek) oldSuffix?.copy(suffix, 0, 0, Math.min(4, oldSuffix.length))
  if (flacLocator) {
    const start = flacLocator(cueTime(cue.sec))
    const end = isLoop ? flacLocator(cueTime(cue.loopEndSec!)) : undefined
    suffix.writeBigUInt64BE(BigInt(start.decodingStartFramePosition), 4)
    suffix.writeBigUInt64BE(BigInt(end?.decodingStartFramePosition ?? 0), 12)
    suffix.writeBigUInt64BE(BigInt(start.fileOffsetInBlock), 20)
    suffix.writeBigUInt64BE(BigInt(end?.fileOffsetInBlock ?? 0), 28)
    suffix.writeUInt32BE(start.numberOfSampleInBlock, 36)
    suffix.writeUInt32BE(end?.numberOfSampleInBlock ?? 0, 40)
  }
  const entry = Buffer.alloc(compact ? template.length : 44 + comment.length + suffix.length)
  if (template) template.copy(entry, 0, 0, Math.min(40, template.length))
  entry.write('PCP2', 0, 'ascii')
  entry.writeUInt32BE(16, 4)
  entry.writeUInt32BE(entry.length, 8)
  entry.writeUInt32BE(hot ? cue.slot! + 1 : 0, 12)
  entry[16] = isLoop ? 2 : 1
  if (!template) entry.writeUInt16BE(1000, 18)
  entry.writeUInt32BE(cueTime(cue.sec), 20)
  entry.writeUInt32BE(isLoop ? cueTime(cue.loopEndSec!) : 0xffffffff, 24)
  if (!hot && cue.colorIndex !== undefined) entry[28] = cue.colorIndex
  if (!template) entry[29] = 1
  // The paired BE u16 fields record quantized beats (native eight-beat loop:
  // 8/1). Preserve existing values when endpoints are unchanged, otherwise
  // the edited loop is manual unless its beat ratio is explicitly provided.
  if (cue.loopNumerator !== undefined && cue.loopDenominator !== undefined) {
    entry.writeUInt16BE(cue.loopNumerator, 36)
    entry.writeUInt16BE(cue.loopDenominator, 38)
  } else if (
    !template ||
    template.readUInt32BE(24) !== entry.readUInt32BE(24) ||
    template.readUInt32BE(20) !== entry.readUInt32BE(20)
  )
    entry.fill(0, 36, 40)
  if (!compact) {
    entry.writeUInt32BE(comment.length, 40)
    comment.copy(entry, 44)
    const colorOffset = 44 + comment.length
    suffix.copy(entry, colorOffset)
    if (hot && indexChanged) entry[colorOffset] = cue.colorIndex!
    if (hot && colorChanged) Buffer.from(cue.color!.slice(1), 'hex').copy(entry, colorOffset + 1)
  }
  return entry
}

const encodeCueSection = (
  kind: 'PCOB' | 'PCO2',
  hot: boolean,
  cues: PioneerUsbCue[],
  original?: Buffer,
  flacLocator?: UsbFlacCueLocator,
  mpegLocator?: UsbMpegCueLocator
): Buffer => {
  const extended = kind === 'PCO2'
  const size = extended ? 20 : 24
  const templates = original ? entriesOf(original, extended) : []
  // Native memory order is insertion order and can differ between DAT and EXT.
  // Existing entries keep each section's physical order; new entries append.
  const sorted = cues
    .map((cue, index) => {
      const template = findTemplate(templates, cue, hot, extended)
      return {
        cue,
        template,
        rank: template ? templates.indexOf(template) : templates.length + index
      }
    })
    .sort((left, right) => left.rank - right.rank)
  const entries = sorted.map(({ cue, template }, index) =>
    encodeCue(cue, hot, extended, template, index, sorted.length, flacLocator, mpegLocator)
  )
  if (!hot && !extended && entries.filter((entry) => entry.readUInt32BE(16) === 4).length > 1) {
    throw new Error('保留现有标点后出现多个 Active Loop，请明确关闭其他 Active Loop')
  }
  const header = original ? Buffer.from(original.subarray(0, size)) : Buffer.alloc(size)
  header.write(kind, 0, 'ascii')
  header.writeUInt32BE(size, 4)
  header.writeUInt32BE(size + entries.reduce((sum, entry) => sum + entry.length, 0), 8)
  header.writeUInt32BE(hot ? 1 : 0, 12)
  header.writeUInt16BE(sorted.length, extended ? 16 : 18)
  if (!extended) {
    if (hot) {
      if (!original) header.writeUInt32BE(0xffffffff, 20)
    } else {
      const nativeLastIndex = templates.length ? templates.length - 1 : 0xffffffff
      if (!original || original.readUInt32BE(20) === nativeLastIndex)
        header.writeUInt32BE(sorted.length ? sorted.length - 1 : 0xffffffff, 20)
      else if (sorted.length !== templates.length)
        throw new Error('尚未验证此 Memory Cue 索引布局，无法修改条目数量')
    }
  }
  return Buffer.concat([header, ...entries])
}

/** Replace only cue tags; every waveform/seek/unknown section remains byte-identical. */
export const writeUsbAnlzCues = (
  bytes: Buffer,
  extension: string,
  hotCues: PioneerUsbCue[],
  memoryCues: PioneerUsbCue[],
  flacLocator?: UsbFlacCueLocator,
  mpegLocator?: UsbMpegCueLocator
): Buffer => {
  validateUsbCues(hotCues, memoryCues)
  const document = parseUsbAnlz(bytes)
  if (flacLocator && mpegLocator) throw new Error('Cue 音频定位类型冲突')
  validateExistingMpegPositions(document, extension.toUpperCase(), hotCues, memoryCues, mpegLocator)
  validateExistingCueSeekPositions(document, hotCues, memoryCues, flacLocator, mpegLocator)
  const format = extension.toUpperCase()
  const cuesFor = (kind: 'PCOB' | 'PCO2', hot: boolean, original?: Buffer) => {
    if (!hot) {
      // Native EXT keeps its legacy memory container empty: DAT's PCOB and
      // EXT's PCO2 carry memory points. Preserve an existing populated variant.
      if (
        format === '.EXT' &&
        kind === 'PCOB' &&
        (!original || entriesOf(original, false).length === 0)
      )
        return []
      return memoryCues
    }
    if (kind === 'PCO2') return hotCues
    // Native exports split legacy hot cues into DAT A–C and EXT D–H;
    // PCO2 in EXT is the complete A–H list. Older players only read DAT.
    if (format === '.DAT') return hotCues.filter((cue) => cue.slot! < 3)
    if (format === '.EXT') return hotCues.filter((cue) => cue.slot! >= 3)
    throw new Error('尚未验证此分析格式的旧式 Hot Cue 分组')
  }
  const seen = new Set<string>()
  for (const section of document.sections) {
    if (section.kind !== 'PCOB' && section.kind !== 'PCO2') continue
    if (section.bytes.length < 16) throw new Error('Cue 区段被截断')
    const type = section.bytes.readUInt32BE(12)
    if (type > 1) throw new Error('未知 Cue 列表类型')
    const key = `${section.kind}:${type}`
    if (seen.has(key)) throw new Error('重复 Cue 区段')
    seen.add(key)
    section.bytes = encodeCueSection(
      section.kind,
      type === 1,
      cuesFor(section.kind, type === 1, section.bytes),
      section.bytes,
      flacLocator,
      mpegLocator
    )
  }
  const kinds: ('PCOB' | 'PCO2')[] =
    format === '.EXT' ? ['PCOB', 'PCO2'] : format === '.DAT' ? ['PCOB'] : []
  for (const kind of kinds)
    for (const hot of [false, true]) {
      if (seen.has(`${kind}:${hot ? 1 : 0}`)) continue
      document.sections.push({
        kind,
        bytes: encodeCueSection(kind, hot, cuesFor(kind, hot), undefined, flacLocator, mpegLocator)
      })
    }
  return buildDocument(document)
}

const shiftPrimaryGrid = (
  grid: Buffer,
  offsetMs: number,
  durationMs: number | undefined
): { bytes: Buffer; changesBeatIndices: boolean } => {
  if (
    grid.length < 24 ||
    grid.readUInt32BE(4) !== 24 ||
    grid.readUInt32BE(16) !== 0x80000 ||
    grid.readUInt32BE(20) > (grid.length - 24) / 8
  )
    throw new Error('无效 PQTZ 网格')
  const count = grid.readUInt32BE(20)
  if (grid.length !== 24 + count * 8 || !count) throw new Error('PQTZ 网格为空或包含未知数据')
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > 0xffffffff
  )
    throw new Error('网格平移需要有效的分析毫秒时长，不能使用数据库整数秒长度')
  let previousTime = -1
  let negativeCount = 0
  const shifted: number[] = []
  for (let index = 0; index < count; index++) {
    const time = grid.readUInt32BE(28 + index * 8)
    if (time <= previousTime) throw new Error('PQTZ 网格时间必须严格递增')
    previousTime = time
    const next = time + offsetMs
    if (next > 0xffffffff) throw new Error('网格平移会超出音频时间范围，请减小平移量')
    if (next < 0) negativeCount++
    shifted.push(next)
  }
  if (negativeCount === count) throw new Error('网格平移不能删除全部原始拍点')
  const tempo = grid.readUInt16BE(26)
  if (!tempo) throw new Error('网格平移需要有效的 BPM')
  const period = 6000000 / tempo
  const tailTempo = grid.readUInt16BE(26 + (count - 1) * 8)
  if (!tailTempo) throw new Error('网格平移需要有效的末尾 BPM')
  let variableTempo = false
  for (let index = 1; index < count; index++) {
    if (grid.readUInt16BE(26 + index * 8) !== tempo) {
      variableTempo = true
      break
    }
  }
  // Dynamic analysis can store a BPM value that disagrees with its edge spacing.
  // Native tail captures extend using the last integer interval, retaining BPM bytes.
  const headStepMs = variableTempo ? shifted[1] - shifted[0] : Math.round(period)
  const tailStepMs = variableTempo
    ? shifted[count - 1] - shifted[count - 2]
    : Math.round(6000000 / tailTempo)
  const needsPrefix = offsetMs > 0 && shifted[0] >= headStepMs
  const needsSuffix = offsetMs < 0 && shifted[count - 1] + tailStepMs <= durationMs
  const trimmedTail = offsetMs > 0 ? shifted.filter((time) => time > durationMs).length : 0
  if (trimmedTail === count) throw new Error('网格平移不能删除全部原始拍点')
  if (!negativeCount && !needsPrefix && !needsSuffix && !trimmedTail) {
    const result = Buffer.from(grid)
    shifted.forEach((time, index) => result.writeUInt32BE(time, 28 + index * 8))
    return { bytes: result, changesBeatIndices: false }
  }
  let previousBeat = 0
  for (let index = 0; index < count; index++) {
    const beat = grid.readUInt16BE(24 + index * 8)
    if (
      !grid.readUInt16BE(26 + index * 8) ||
      beat < 1 ||
      beat > 4 ||
      (index > 0 && beat !== (previousBeat % 4) + 1)
    )
      throw new Error('跨零网格平移需要有效 BPM 和连续四拍拍号')
    previousBeat = beat
  }
  const validateExtrapolationEdge = (tail: boolean) => {
    const label = tail ? '末尾' : '开头'
    // Extrapolate only a verified boundary; preserve internal Dynamic timing and
    // manual reset seams as opaque native timestamps rather than normalizing them.
    const edgeCount = variableTempo ? 4 : Math.min(count, 4)
    if (count < edgeCount || edgeCount < 2)
      throw new Error(`网格${label}拍点不足，无法确认补拍间隔`)
    const start = tail ? count - edgeCount : 0
    const intervals = Array.from(
      { length: edgeCount - 1 },
      (_, index) => shifted[start + index + 1] - shifted[start + index]
    )
    const edgeTempo = tail ? tailTempo : tempo
    if (
      Math.max(...intervals) - Math.min(...intervals) > 1 ||
      Array.from({ length: edgeCount }, (_, index) =>
        grid.readUInt16BE(26 + (start + index) * 8)
      ).some((value) => value !== edgeTempo)
    )
      throw new Error(`网格${label}仍在变化，无法确认补拍间隔`)
    if (!variableTempo) {
      const edgePeriod = 6000000 / edgeTempo
      if (
        intervals.some((value) => value < Math.floor(edgePeriod) || value > Math.ceil(edgePeriod))
      )
        throw new Error('网格边界拍点间隔与 BPM 不一致，无法确认补拍间隔')
      return
    }
    // The captured head has equal integer spacing and agrees with its BPM.
    // A disagreeing head needs its own native evidence before extrapolation.
    if (
      !tail &&
      (Math.min(...intervals) !== headStepMs ||
        Math.max(...intervals) !== headStepMs ||
        headStepMs !== Math.round(period))
    )
      throw new Error('变速网格开头间隔与 BPM 不一致，尚未验证补拍规则')
  }
  if (needsPrefix) validateExtrapolationEdge(false)
  if (needsSuffix) validateExtrapolationEdge(true)
  const entries: Buffer[] = []
  for (let index = negativeCount; index < count - trimmedTail; index++) {
    const entry = Buffer.from(grid.subarray(24 + index * 8, 32 + index * 8))
    entry.writeUInt32BE(shifted[index], 4)
    entries.push(entry)
  }
  // Native left shifts discard negative beats, then extend the tail only
  // while the next integer beat is within the exported analysis duration. The inverse
  // capture proves this is not a fixed-count replacement of discarded beats.
  while (offsetMs < 0 && entries[entries.length - 1].readUInt32BE(4) + tailStepMs <= durationMs) {
    const previous = entries[entries.length - 1]
    const time = previous.readUInt32BE(4) + tailStepMs
    if (time > 0xffffffff) throw new Error('补齐网格拍点会超出音频时间范围')
    const next = Buffer.from(previous)
    next.writeUInt16BE((previous.readUInt16BE(0) % 4) + 1, 0)
    next.writeUInt32BE(time, 4)
    entries.push(next)
  }
  // Right shifts prepend the preceding beat when it enters the track and
  // discard tail records beyond the exported detail half-frame coverage.
  while (offsetMs > 0 && entries[0].readUInt32BE(4) >= headStepMs) {
    const previous = Buffer.from(entries[0])
    previous.writeUInt16BE(((previous.readUInt16BE(0) + 2) % 4) + 1, 0)
    previous.writeUInt32BE(previous.readUInt32BE(4) - headStepMs, 4)
    entries.unshift(previous)
  }
  const header = Buffer.from(grid.subarray(0, 24))
  header.writeUInt32BE(24 + entries.length * 8, 8)
  header.writeUInt32BE(entries.length, 20)
  return {
    bytes: Buffer.concat([header, ...entries]),
    changesBeatIndices: true
  }
}

/** Preserve other sections; native manual edits invalidate the extended grid cache. */
export const shiftUsbAnlzGrid = (
  bytes: Buffer,
  offsetMs: number,
  durationMs?: number
): { bytes: Buffer; hasGrid: boolean; changesBeatIndices: boolean } => {
  if (!Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > 60000)
    throw new Error('网格平移必须为整数毫秒且不超过 60 秒')
  const document = parseUsbAnlz(bytes)
  if (offsetMs === 0) {
    return {
      bytes: Buffer.from(bytes),
      hasGrid: document.sections.some((section) => section.kind === 'PQTZ'),
      changesBeatIndices: false
    }
  }
  let hasGrid = false
  let changesBeatIndices = false
  for (const section of document.sections) {
    const grid = section.bytes
    if (section.kind === 'PQTZ') {
      const shifted = shiftPrimaryGrid(grid, offsetMs, durationMs)
      section.bytes = shifted.bytes
      changesBeatIndices ||= shifted.changesBeatIndices
      hasGrid = true
    } else if (section.kind === 'PQT2') {
      if (
        grid.length < 56 ||
        grid.readUInt32BE(4) !== 56 ||
        ![0x01000002, 0x02000002].includes(grid.readUInt32BE(16)) ||
        grid.length !== 56 + grid.readUInt32BE(40) * 2
      )
        throw new Error('不支持的 PQT2 网格版本')
      const invalidated = Buffer.from(grid.subarray(0, 56))
      invalidated.writeUInt32BE(56, 8)
      invalidated.fill(0, 24, 56)
      section.bytes = invalidated
    }
  }
  if (changesBeatIndices)
    for (const section of document.sections)
      if (section.kind === 'PSSI') validateUsbAnlzPhraseForGridShift(section.bytes)
  return { bytes: buildDocument(document), hasGrid, changesBeatIndices }
}
