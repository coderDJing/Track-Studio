import fs from 'node:fs/promises'
import path from 'node:path'

const orderFileName = 'neworder.pref'

const decodeUtf16Be = (data: Buffer) => {
  const offset = data.length % 2 === 1 ? 1 : 0
  const swapped = Buffer.allocUnsafe(data.length - offset)
  for (let index = offset; index + 1 < data.length; index += 2) {
    swapped[index - offset] = data[index + 1]
    swapped[index - offset + 1] = data[index]
  }
  return swapped.toString('utf16le').replace(/^\uFEFF/, '')
}

const encodeUtf16Be = (value: string) => {
  const data = Buffer.from(value, 'utf16le')
  for (let index = 0; index + 1 < data.length; index += 2) {
    const byte = data[index]
    data[index] = data[index + 1]
    data[index + 1] = byte
  }
  return data
}

const resolveOrderPath = (seratoRoot: string) => path.join(seratoRoot, orderFileName)

export const readSeratoCrateOrder = async (seratoRoot: string) => {
  try {
    const text = decodeUtf16Be(await fs.readFile(resolveOrderPath(seratoRoot)))
    return text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('[crate]'))
      .map((line) => line.slice('[crate]'.length).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export const updateSeratoCrateOrder = async (
  seratoRoot: string,
  transform: (names: string[]) => string[]
) => {
  const orderPath = resolveOrderPath(seratoRoot)
  let text = ''
  try {
    text = decodeUtf16Be(await fs.readFile(orderPath))
  } catch {
    text = '[begin record]\n[end record]\n'
  }
  const lines = text.split(/\r?\n/)
  const existing = lines
    .filter((line) => line.startsWith('[crate]'))
    .map((line) => line.slice('[crate]'.length).trim())
    .filter(Boolean)
  const next = transform(existing).filter(Boolean)
  const nextLines: string[] = []
  let crateIndex = 0
  let inserted = false
  for (const line of lines) {
    if (line.startsWith('[crate]')) {
      const name = next[crateIndex]
      crateIndex += 1
      if (name) nextLines.push(`[crate]${name}`)
      continue
    }
    if (!inserted && line === '[end record]') {
      for (const name of next.slice(crateIndex)) nextLines.push(`[crate]${name}`)
      inserted = true
    }
    nextLines.push(line)
  }
  if (!inserted) {
    nextLines.push('[begin record]')
    for (const name of next) nextLines.push(`[crate]${name}`)
    nextLines.push('[end record]')
  }
  await fs.writeFile(orderPath, encodeUtf16Be(nextLines.join('\n')))
}

export const reorderSeratoCrateOrder = (
  names: string[],
  crateName: string,
  parentName: string | undefined,
  sequence: number
) => {
  const parentPrefix = parentName ? `${parentName}%%` : ''
  const isDirectChild = (name: string) => {
    if (!name.startsWith(parentPrefix)) return false
    const rest = name.slice(parentPrefix.length)
    return Boolean(rest) && !rest.includes('%%')
  }
  const isMovedBlock = (name: string) => name === crateName || name.startsWith(`${crateName}%%`)
  const movedBlock = names.filter(isMovedBlock)
  if (!movedBlock.length) return names
  const remaining = names.filter((name) => !isMovedBlock(name))
  const siblings = remaining.filter(isDirectChild)
  const targetSequence = Math.max(1, Number(sequence) || 1)
  let insertAt = remaining.length
  const target = siblings[targetSequence - 1]
  if (target) {
    insertAt = remaining.indexOf(target)
  } else if (siblings.length) {
    const lastSibling = siblings[siblings.length - 1]
    insertAt = remaining.indexOf(lastSibling) + 1
    while (insertAt < remaining.length && remaining[insertAt].startsWith(`${lastSibling}%%`)) {
      insertAt += 1
    }
  }
  return [...remaining.slice(0, insertAt), ...movedBlock, ...remaining.slice(insertAt)]
}
