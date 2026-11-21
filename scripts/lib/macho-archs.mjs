/**
 * 极简 Mach-O 解析：只读取「架构列表」，用于给 macOS 产物做审计。
 *
 * 背景：macOS 审计是在 Windows 上跑的（本地没有 mac 构建机），
 * 但产物里混进 Windows 二进制、或 universal 包只剩单架构，
 * 都只需要读文件头就能发现，不必真的把包跑起来。
 *
 * 只解析：
 *   - fat / fat_64 头（0xCAFEBABE / 0xCAFEBABF）的架构表；
 *   - thin 头（0xFEEDFACF / 0xFEEDFACE）的 cputype。
 * 不解析 LC_* 加载命令，也不做签名与 entitlements 校验。
 */

import fs from 'node:fs'

const CPU_LABELS = new Map([
  [0x00000007, 'i386'],
  [0x01000007, 'x86_64'],
  [0x0000000c, 'arm'],
  [0x0100000c, 'arm64'],
  [0x0200000c, 'arm64_32']
])

const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const THIN_MAGIC_64 = 0xfeedfacf
const THIN_MAGIC_32 = 0xfeedface

const label = (cpuType) => CPU_LABELS.get(cpuType) || `unknown(0x${cpuType.toString(16)})`

export function readMachOInfo(filePath) {
  const data = fs.readFileSync(filePath)
  if (data.length < 8) return { ok: false, reason: 'file too small for a Mach-O header' }

  const bigEndianMagic = data.readUInt32BE(0)
  if (bigEndianMagic === FAT_MAGIC || bigEndianMagic === FAT_MAGIC_64) {
    const fat64 = bigEndianMagic === FAT_MAGIC_64
    const archCount = data.readUInt32BE(4)
    // universal 包正常只有 2 个架构；异常大的计数说明这不是 fat 头。
    if (archCount === 0 || archCount > 32) {
      return { ok: false, reason: `unreasonable fat arch count ${archCount}` }
    }
    const entrySize = fat64 ? 32 : 20
    const rawArchs = []
    for (let index = 0; index < archCount; index += 1) {
      const base = 8 + index * entrySize
      if (base + 4 > data.length) return { ok: false, reason: 'truncated fat arch table' }
      rawArchs.push(data.readUInt32BE(base))
    }
    const unique = [...new Set(rawArchs)]
    return { ok: true, kind: `fat${fat64 ? '64' : ''}`, archs: unique.map(label), rawArchs: unique }
  }

  const littleEndianMagic = data.readUInt32LE(0)
  if (littleEndianMagic === THIN_MAGIC_64 || littleEndianMagic === THIN_MAGIC_32) {
    const cpuType = data.readUInt32LE(4)
    return {
      ok: true,
      kind: littleEndianMagic === THIN_MAGIC_64 ? 'thin64' : 'thin32',
      archs: [label(cpuType)],
      rawArchs: [cpuType]
    }
  }

  return { ok: false, reason: `unknown magic 0x${bigEndianMagic.toString(16)}` }
}
