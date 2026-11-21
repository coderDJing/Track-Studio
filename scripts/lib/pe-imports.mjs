/**
 * 极简 PE 解析：只读取「机器类型」与导入表中出现的 DLL 名。
 *
 * 打包审计需要回答两个问题：
 *   1. 某个 .node / .dll 是哪个架构的（防止把 darwin / arm64 二进制混进 Windows 包）；
 *   2. 它静态依赖哪些 DLL（据此反推运行时真正需要哪个版本的 FFmpeg DLL，
 *      而不是在脚本里硬编码一份可能在下次升级后失效的清单）。
 *
 * 只解析 DOS 头、PE 头、节表、导入目录（下标 1）与延迟导入目录（下标 13），
 * 不解析序号导入、绑定导入、重定位等其余内容。
 */

import fs from 'node:fs'

const MACHINE_LABELS = new Map([
  [0x014c, 'x86'],
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
  [0x01c0, 'arm'],
  [0x01c4, 'armv7']
])

/** 延迟导入目录里 name 字段的偏移与 import 目录不同，这里分开处理。 */
const IMPORT_DESCRIPTOR_SIZE = 20
const DELAY_DESCRIPTOR_SIZE = 32

const readCString = (data, offset) => {
  if (offset == null || offset < 0 || offset >= data.length) return ''
  const end = data.indexOf(0, offset)
  if (end < 0) return ''
  return data.subarray(offset, end).toString('latin1')
}

export function readPeInfo(filePath) {
  const data = fs.readFileSync(filePath)
  if (data.length < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) {
    return { ok: false, reason: 'missing MZ signature' }
  }

  const peOffset = data.readUInt32LE(0x3c)
  if (peOffset + 24 > data.length || data.readUInt32LE(peOffset) !== 0x00004550) {
    return { ok: false, reason: 'missing PE signature' }
  }

  const coffOffset = peOffset + 4
  const machine = data.readUInt16LE(coffOffset)
  const sectionCount = data.readUInt16LE(coffOffset + 2)
  const optionalHeaderSize = data.readUInt16LE(coffOffset + 16)
  const optionalOffset = coffOffset + 20
  const magic = data.readUInt16LE(optionalOffset)
  const is64 = magic === 0x20b
  if (!is64 && magic !== 0x10b) {
    return { ok: false, reason: `unknown optional header magic 0x${magic.toString(16)}` }
  }

  const numberOfDirectories = data.readUInt32LE(optionalOffset + (is64 ? 108 : 92))
  const directoriesOffset = optionalOffset + (is64 ? 112 : 96)

  const sections = []
  const sectionTableOffset = optionalOffset + optionalHeaderSize
  for (let index = 0; index < sectionCount; index += 1) {
    const base = sectionTableOffset + index * 40
    if (base + 40 > data.length) break
    sections.push({
      name: data
        .subarray(base, base + 8)
        .toString('latin1')
        .replace(/\0+$/, ''),
      virtualSize: data.readUInt32LE(base + 8),
      virtualAddress: data.readUInt32LE(base + 12),
      rawSize: data.readUInt32LE(base + 16),
      rawPointer: data.readUInt32LE(base + 20)
    })
  }

  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize)
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        const delta = rva - section.virtualAddress
        if (delta >= section.rawSize) return null
        return section.rawPointer + delta
      }
    }
    return null
  }

  const readDirectory = (index) => {
    if (index >= numberOfDirectories) return { rva: 0, size: 0 }
    const offset = directoriesOffset + index * 8
    if (offset + 8 > data.length) return { rva: 0, size: 0 }
    return { rva: data.readUInt32LE(offset), size: data.readUInt32LE(offset + 4) }
  }

  const collect = (index, descriptorSize) => {
    const { rva, size } = readDirectory(index)
    if (!rva || !size) return []
    const start = rvaToOffset(rva)
    if (start == null) return []
    const names = []
    for (let cursor = start; cursor + descriptorSize <= data.length; cursor += descriptorSize) {
      const nameFieldOffset = descriptorSize === IMPORT_DESCRIPTOR_SIZE ? 12 : 4
      const nameRva = data.readUInt32LE(cursor + nameFieldOffset)
      if (nameRva === 0) break
      const name = readCString(data, rvaToOffset(nameRva))
      if (name) names.push(name)
    }
    return names
  }

  const importNames = collect(1, IMPORT_DESCRIPTOR_SIZE)
  const delayNames = collect(13, DELAY_DESCRIPTOR_SIZE)
  const importedDlls = [
    ...new Set([...importNames, ...delayNames].map((name) => name.toLowerCase()))
  ]

  return {
    ok: true,
    machine,
    architecture: MACHINE_LABELS.get(machine) || `unknown(0x${machine.toString(16)})`,
    importedDlls,
    directImportCount: importNames.length,
    delayImportCount: delayNames.length
  }
}
