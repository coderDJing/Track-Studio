/**
 * 极简二维码生成器（byte 模式，纠错等级 L，版本 4/5，掩码 0）。
 *
 * 只为网易云登录二维码服务：内容是一条 ~72 字符的 URL，容量落在版本 4（78 字节）
 * 与版本 5（106 字节）之间，因此不做通用实现，只覆盖这两个版本的单块结构。
 *
 * 输出 PNG（灰度），渲染层用 <img src="data:image/png;base64,..."> 直接显示：
 * 不引入任何二维码依赖，也不依赖终端字符画或浏览器页面。
 *
 * 踩过的坑：15 位格式信息横竖两臂的位序写反后，格子集合仍然正确、肉眼看着完全正常，
 * 但解码器读出的格式串是乱的、整个码作废。改动本文件后必须用独立解码器验一次。
 */

import { deflateSync } from 'node:zlib'

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)

{
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value
    GF_LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]
}

type VersionSpec = {
  version: number
  size: number
  dataCodewords: number
  ecCodewords: number
  alignment: number[]
  remainderBits: number
}

const VERSIONS: VersionSpec[] = [
  {
    version: 4,
    size: 33,
    dataCodewords: 80,
    ecCodewords: 20,
    alignment: [6, 26],
    remainderBits: 7
  },
  {
    version: 5,
    size: 37,
    dataCodewords: 108,
    ecCodewords: 26,
    alignment: [6, 30],
    remainderBits: 7
  }
]

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]

function rsGeneratorPoly(count: number): number[] {
  let poly = [1]
  for (let i = 0; i < count; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

function rsRemainder(data: number[], ecCount: number): number[] {
  const generator = rsGeneratorPoly(ecCount)
  const buffer = [...data, ...new Array<number>(ecCount).fill(0)]
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i]
    if (factor === 0) continue
    for (let j = 0; j < generator.length; j += 1) {
      buffer[i + j] ^= gfMul(generator[j], factor)
    }
  }
  return buffer.slice(data.length)
}

function buildBitStream(text: string, spec: VersionSpec): number[] {
  const bytes = Array.from(Buffer.from(text, 'utf8'))
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, spec.version < 10 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)

  const capacity = spec.dataCodewords * 8
  const terminator = Math.min(4, capacity - bits.length)
  for (let i = 0; i < terminator; i += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j]
    codewords.push(value)
  }
  const pads = [0xec, 0x11]
  let padIndex = 0
  while (codewords.length < spec.dataCodewords) {
    codewords.push(pads[padIndex % 2])
    padIndex += 1
  }
  return codewords
}

function formatInfoBits(mask: number): number {
  const data = (0b01 << 3) | mask
  let value = data << 10
  while (bitLength(value) - bitLength(0x537) >= 0) {
    value ^= 0x537 << (bitLength(value) - bitLength(0x537))
  }
  return ((data << 10) | value) ^ 0x5412
}

function bitLength(value: number): number {
  let length = 0
  let rest = value
  while (rest !== 0) {
    length += 1
    rest >>>= 1
  }
  return length
}

type Matrix = {
  size: number
  cells: Int8Array
  reserved: Uint8Array
}

const at = (matrix: Matrix, x: number, y: number): number => y * matrix.size + x

function setModule(matrix: Matrix, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return
  matrix.cells[at(matrix, x, y)] = dark ? 1 : 0
  matrix.reserved[at(matrix, x, y)] = 1
}

function drawFinder(matrix: Matrix, originX: number, originY: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = originX + dx
      const y = originY + dy
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
      const dark =
        inRing &&
        (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
      setModule(matrix, x, y, dark)
    }
  }
}

function drawAlignment(matrix: Matrix, centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      setModule(matrix, centerX + dx, centerY + dy, distance !== 1)
    }
  }
}

function drawFunctionPatterns(matrix: Matrix, spec: VersionSpec): void {
  drawFinder(matrix, 0, 0)
  drawFinder(matrix, matrix.size - 7, 0)
  drawFinder(matrix, 0, matrix.size - 7)

  for (let i = 8; i < matrix.size - 8; i += 1) {
    setModule(matrix, i, 6, i % 2 === 0)
    setModule(matrix, 6, i, i % 2 === 0)
  }

  const centers = spec.alignment
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === matrix.size - 7) ||
        (cx === matrix.size - 7 && cy === 6)
      if (!nearFinder) drawAlignment(matrix, cx, cy)
    }
  }

  // 暗模块 + 两处格式信息区预留
  setModule(matrix, 8, matrix.size - 8, true)
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setModule(matrix, 8, i, false)
      setModule(matrix, i, 8, false)
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setModule(matrix, 8, matrix.size - 1 - i, false)
    setModule(matrix, matrix.size - 1 - i, 8, false)
  }
}

function placeData(matrix: Matrix, codewords: number[], remainderBits: number): void {
  const bits: number[] = []
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((codeword >> i) & 1)
  }
  for (let i = 0; i < remainderBits; i += 1) bits.push(0)

  let bitIndex = 0
  let upward = true
  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < matrix.size; step += 1) {
      const y = upward ? matrix.size - 1 - step : step
      for (let column = 0; column < 2; column += 1) {
        const x = right - column
        if (matrix.reserved[at(matrix, x, y)]) continue
        let dark = bitIndex < bits.length ? bits[bitIndex] === 1 : false
        bitIndex += 1
        // 掩码 0：(行 + 列) % 2 === 0 时取反
        if ((x + y) % 2 === 0) dark = !dark
        matrix.cells[at(matrix, x, y)] = dark ? 1 : 0
      }
    }
    upward = !upward
  }
  // 数据位必须正好填满非功能区，多一位或少一位都说明版本参数写错了。
  if (bitIndex !== bits.length) {
    throw new Error(`二维码数据位不匹配：放置 ${bitIndex} 位，实际 ${bits.length} 位`)
  }
}

function placeFormatInfo(matrix: Matrix, mask: number): void {
  const bits = formatInfoBits(mask)
  const set = (x: number, y: number, index: number): void => {
    matrix.cells[at(matrix, x, y)] = ((bits >> index) & 1) === 1 ? 1 : 0
  }
  // 第一份：绕着左上定位图案的 L 形。竖臂放低位、横臂放高位，位置不能互换，
  // 换过来仍是同一批格子，但解码器读出的 15 位就乱了。
  for (let i = 0; i <= 5; i += 1) set(8, i, i)
  set(8, 7, 6)
  set(8, 8, 7)
  set(7, 8, 8)
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, i)
  // 第二份：左下竖条 + 右上横条
  for (let i = 0; i < 8; i += 1) set(matrix.size - 1 - i, 8, i)
  for (let i = 8; i < 15; i += 1) set(8, matrix.size - 15 + i, i)
  // 固定深色模块必须最后写：预留阶段会把它清成浅色。
  matrix.cells[at(matrix, 8, matrix.size - 8)] = 1
}

function pickVersion(text: string): VersionSpec {
  const length = Buffer.byteLength(text, 'utf8')
  for (const spec of VERSIONS) {
    const capacityBits = spec.dataCodewords * 8
    if (4 + 8 + length * 8 <= capacityBits) return spec
  }
  throw new Error(`内容过长，超出 ${VERSIONS[VERSIONS.length - 1].version} 版容量`)
}

export function buildQrMatrix(text: string): { size: number; cells: Int8Array } {
  const spec = pickVersion(text)
  const matrix: Matrix = {
    size: spec.size,
    cells: new Int8Array(spec.size * spec.size).fill(0),
    reserved: new Uint8Array(spec.size * spec.size)
  }
  drawFunctionPatterns(matrix, spec)
  const data = buildBitStream(text, spec)
  const ec = rsRemainder(data, spec.ecCodewords)
  placeData(matrix, [...data, ...ec], spec.remainderBits)
  placeFormatInfo(matrix, 0)
  return { size: matrix.size, cells: matrix.cells }
}

/** 用半块字符渲染，深色模块始终配浅色底，避免终端主题导致反色。 */
export function renderQr(text: string, quietZone = 2): string {
  const { size, cells } = buildQrMatrix(text)
  const total = size + quietZone * 2
  const dark = (x: number, y: number): boolean => {
    const mx = x - quietZone
    const my = y - quietZone
    if (mx < 0 || my < 0 || mx >= size || my >= size) return false
    return cells[my * size + mx] === 1
  }

  const BLACK = '\u001b[30m'
  const BLUE = '\u001b[34m'
  const RESET = '\u001b[0m'
  const lines: string[] = []
  for (let y = 0; y < total; y += 2) {
    let line = ''
    for (let x = 0; x < total; x += 1) {
      const top = dark(x, y)
      const bottom = y + 1 < total ? dark(x, y + 1) : false
      if (top && bottom) line += `${BLACK}\u2588${RESET}`
      else if (top) line += `${BLACK}\u2580${RESET}`
      else if (bottom) line += `${BLUE}\u2584${RESET}`
      else line += ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- PNG 输出

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/** 输出 8 位灰度 PNG（深色模块纯黑，其余纯白），供手机扫码。 */
export function createQrPng(
  text: string,
  options?: { scale?: number; quietZone?: number }
): { buffer: Buffer; size: number; pixels: number } {
  const { size, cells } = buildQrMatrix(text)
  const scale = Math.max(1, Math.floor(options?.scale ?? 8))
  const quietZone = Math.max(0, Math.floor(options?.quietZone ?? 4))
  const pixels = (size + quietZone * 2) * scale

  // 每行前面有一个 filter 字节（0 = 不过滤），PNG 扫描线的固定格式。
  const raw = Buffer.alloc(pixels * (pixels + 1))
  let offset = 0
  for (let y = 0; y < pixels; y += 1) {
    raw[offset] = 0
    offset += 1
    const my = Math.floor(y / scale) - quietZone
    for (let x = 0; x < pixels; x += 1) {
      const mx = Math.floor(x / scale) - quietZone
      const inside = mx >= 0 && my >= 0 && mx < size && my < size
      raw[offset] = inside && cells[my * size + mx] === 1 ? 0 : 255
      offset += 1
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(pixels, 0)
  ihdr.writeUInt32BE(pixels, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type 0 = 灰度
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return { buffer, size, pixels }
}

/** 渲染层直接用这个：data URL，省一次 IPC 传二进制 */
export function createQrDataUrl(text: string, options?: { scale?: number }): string {
  const { buffer } = createQrPng(text, { scale: options?.scale ?? 8, quietZone: 4 })
  return `data:image/png;base64,${buffer.toString('base64')}`
}
