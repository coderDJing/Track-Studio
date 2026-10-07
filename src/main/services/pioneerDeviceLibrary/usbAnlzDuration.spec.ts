import { expect, it } from 'vitest'
import { readUsbAnlzDurationMs } from './usbAnlzDuration'

const document = (kind: string, entrySize: number, count: number) => {
  const header = Buffer.alloc(28)
  header.write('PMAI')
  header.writeUInt32BE(28, 4)
  const tag = Buffer.alloc(24 + count * entrySize)
  tag.write(kind)
  tag.writeUInt32BE(24, 4)
  tag.writeUInt32BE(tag.length, 8)
  tag.writeUInt32BE(entrySize, 12)
  tag.writeUInt32BE(count, 16)
  tag.writeUInt32BE(0x960000, 20)
  const bytes = Buffer.concat([header, tag])
  bytes.writeUInt32BE(bytes.length, 8)
  return bytes
}

it('uses consistent native detail half-frame coverage and preserves every payload byte', () => {
  const files = [document('PWV3', 1, 59842), document('PWV5', 2, 59842), document('PWV7', 3, 59842)]
  const before = files.map((bytes) => Buffer.from(bytes))
  expect(readUsbAnlzDurationMs(files)).toBeCloseTo(398946.666666667, 6)
  expect(files).toEqual(before)
})

it('rejects conflicting, missing, truncated or unknown detail metadata', () => {
  expect(() => readUsbAnlzDurationMs([document('PWV3', 1, 150), document('PWV5', 2, 151)])).toThrow(
    '不一致'
  )
  expect(() => readUsbAnlzDurationMs([document('UNKN', 1, 150)])).toThrow('缺少')
  const invalid = document('PWV3', 1, 150)
  invalid.writeUInt32BE(149, 28 + 16)
  expect(() => readUsbAnlzDurationMs([invalid])).toThrow('长度无效')
  const unknown = document('PWV5', 2, 150)
  unknown.writeUInt32BE(0x970000, 28 + 20)
  expect(() => readUsbAnlzDurationMs([unknown])).toThrow('未知')
})
