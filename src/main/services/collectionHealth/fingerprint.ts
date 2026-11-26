// Chromaprint 指纹解码与“同一录音”判定。
// 指纹字符串是 chromaprint 的压缩格式：base64(算法字节 + 3 字节条数 + int3 打包的位序列 + int5 打包的异常位)。
// 这里独立解码为 32 位条目序列，再按“跳过开头、取样、允许少量移位、平均汉明位低”判定同一录音。

const SOUND_SKIP = 20
const SOUND_ITEMS = 400
const SOUND_COMMON = 12
/** 进入对齐比对的候选至少要有这么多共同指纹值；占比门槛对循环性强的段落过严，交给对齐比对判定。 */
const MIN_SHARED_ITEMS = 8
const SHIFT_RANGE = 8
const MAX_AVG_HAMMING_BITS = 6
const MIN_COMPARED_ITEMS = 50

function unpackInt3(packed: Buffer): number[] {
  const out: number[] = []
  const count = Math.floor((packed.length * 8) / 3)
  let p = 0
  let produced = 0

  while (packed.length - p >= 3) {
    const s0 = packed[p]
    const s1 = packed[p + 1]
    const s2 = packed[p + 2]
    p += 3
    out.push(s0 & 0x07)
    out.push((s0 & 0x38) >> 3)
    out.push(((s0 & 0xc0) >> 6) | ((s1 & 0x01) << 2))
    out.push((s1 & 0x0e) >> 1)
    out.push((s1 & 0x70) >> 4)
    out.push(((s1 & 0x80) >> 7) | ((s2 & 0x03) << 1))
    out.push((s2 & 0x1c) >> 2)
    out.push((s2 & 0xe0) >> 5)
    produced += 8
  }
  const rest = Math.min(packed.length - p, 2)
  if (rest === 2) {
    const s0 = packed[p]
    const s1 = packed[p + 1]
    out.push(s0 & 0x07)
    out.push((s0 & 0x38) >> 3)
    out.push(((s0 & 0xc0) >> 6) | ((s1 & 0x01) << 2))
    out.push((s1 & 0x0e) >> 1)
    out.push((s1 & 0x70) >> 4)
    produced += 5
  } else if (rest === 1) {
    const s0 = packed[p]
    out.push(s0 & 0x07)
    out.push((s0 & 0x38) >> 3)
    produced += 2
  }
  return out.slice(0, Math.min(count, produced))
}

function unpackInt5(packed: Buffer): number[] {
  const out: number[] = []
  let p = 0
  while (packed.length - p >= 5) {
    const s0 = packed[p]
    const s1 = packed[p + 1]
    const s2 = packed[p + 2]
    const s3 = packed[p + 3]
    const s4 = packed[p + 4]
    p += 5
    out.push(s0 & 0x1f)
    out.push(((s0 & 0xe0) >> 5) | ((s1 & 0x03) << 3))
    out.push((s1 & 0x7c) >> 2)
    out.push(((s1 & 0x80) >> 7) | ((s2 & 0x0f) << 1))
    out.push(((s2 & 0xf0) >> 4) | ((s3 & 0x01) << 4))
    out.push((s3 & 0x3e) >> 1)
    out.push(((s3 & 0xc0) >> 6) | ((s4 & 0x07) << 2))
    out.push((s4 & 0xf8) >> 3)
  }
  const rest = packed.length - p
  const s0 = packed[p]
  if (rest === 4) {
    const s1 = packed[p + 1]
    const s2 = packed[p + 2]
    const s3 = packed[p + 3]
    out.push(s0 & 0x1f)
    out.push(((s0 & 0xe0) >> 5) | ((s1 & 0x03) << 3))
    out.push((s1 & 0x7c) >> 2)
    out.push(((s1 & 0x80) >> 7) | ((s2 & 0x0f) << 1))
    out.push(((s2 & 0xf0) >> 4) | ((s3 & 0x01) << 4))
    out.push((s3 & 0x3e) >> 1)
  } else if (rest === 3) {
    const s1 = packed[p + 1]
    const s2 = packed[p + 2]
    out.push(s0 & 0x1f)
    out.push(((s0 & 0xe0) >> 5) | ((s1 & 0x03) << 3))
    out.push((s1 & 0x7c) >> 2)
    out.push(((s1 & 0x80) >> 7) | ((s2 & 0x0f) << 1))
  } else if (rest === 2) {
    const s1 = packed[p + 1]
    out.push(s0 & 0x1f)
    out.push(((s0 & 0xe0) >> 5) | ((s1 & 0x03) << 3))
    out.push((s1 & 0x7c) >> 2)
  } else if (rest === 1) {
    out.push(s0 & 0x1f)
  }
  return out
}

/** 把压缩指纹解码为 32 位条目；格式非法时返回 null。 */
export function decodeChromaprint(fingerprint: string): number[] | null {
  if (!fingerprint) return null
  const data = Buffer.from(fingerprint, 'base64')
  if (data.length < 4) return null
  const numValues = (data[1] << 16) | (data[2] << 8) | data[3]
  if (numValues <= 0) return []

  const bitsAll = unpackInt3(data.subarray(4))
  let found = 0
  let exceptional = 0
  let cut = bitsAll.length
  for (let i = 0; i < bitsAll.length; i++) {
    const bit = bitsAll[i]
    if (bit === 0) {
      found += 1
      if (found === numValues) {
        cut = i + 1
        break
      }
    } else if (bit === 7) {
      exceptional += 1
    }
  }
  if (found !== numValues) return null

  const bits = bitsAll.slice(0, cut)
  if (exceptional > 0) {
    const offset = 4 + Math.ceil((cut * 3) / 8)
    const packedSize = Math.ceil((exceptional * 5) / 8)
    if (data.length < offset + packedSize) return null
    const extra = unpackInt5(data.subarray(offset, offset + packedSize))
    let j = 0
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] === 7 && j < extra.length) bits[i] += extra[j++]
    }
  }

  const out: number[] = new Array(numValues)
  let i = 0
  let lastBit = 0
  let value = 0
  for (let j = 0; j < bits.length; j++) {
    const bit = bits[j]
    if (bit === 0) {
      if (i < numValues) out[i] = i > 0 ? (value ^ out[i - 1]) >>> 0 : value >>> 0
      value = 0
      lastBit = 0
      i += 1
      continue
    }
    const position = bit + lastBit
    lastBit = position
    value = (value | (1 << (position - 1))) >>> 0
  }
  return out
}

function popCount(value: number): number {
  let v = value >>> 0
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function sample(items: number[]): number[] {
  return items.slice(SOUND_SKIP, SOUND_SKIP + SOUND_ITEMS)
}

function sameRecording(a: number[], b: number[]): boolean {
  for (let shift = -SHIFT_RANGE; shift <= SHIFT_RANGE; shift++) {
    let pairs = 0
    let bitDiff = 0
    for (let i = 0; i < a.length; i++) {
      const j = i + shift
      if (j < 0 || j >= b.length) continue
      pairs += 1
      bitDiff += popCount((a[i] ^ b[j]) >>> 0)
    }
    if (pairs >= MIN_COMPARED_ITEMS && bitDiff / pairs < MAX_AVG_HAMMING_BITS) return true
  }
  return false
}

export type FingerprintedTrack = {
  id: string
  fingerprint: string
}

export type GroupSameRecordingsOptions = {
  /** 用户标记过“不是重复”的指纹对；键为 sortFingerprintPair() 生成值。 */
  mutedPairs?: ReadonlySet<string>
}

export function sortFingerprintPair(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/** 把指纹两两足够接近的曲目并成组，只返回至少有两条记录的组。 */
export function groupSameRecordings(
  tracks: FingerprintedTrack[],
  options: GroupSameRecordingsOptions = {}
): FingerprintedTrack[][] {
  const muted = options.mutedPairs
  const isMuted = (a: string, b: string) => muted?.has(sortFingerprintPair(a, b)) === true
  const decoded = new Map<string, number[]>()
  const samples = new Map<string, number[]>()
  for (const track of tracks) {
    const items = decodeChromaprint(track.fingerprint)
    if (!items || items.length === 0) continue
    decoded.set(track.id, items)
    samples.set(track.id, sample(items))
  }
  if (decoded.size < 2) return []

  const byItem = new Map<number, string[]>()
  for (const [id, items] of samples) {
    for (const item of new Set(items)) {
      const owners = byItem.get(item)
      if (owners) owners.push(id)
      else byItem.set(item, [id])
    }
  }

  const shared = new Map<string, number>()
  for (const owners of byItem.values()) {
    if (owners.length < 2 || owners.length > SOUND_COMMON) continue
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        const a = owners[i]
        const b = owners[j]
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
        shared.set(key, (shared.get(key) || 0) + 1)
      }
    }
  }

  const neighbors = new Map<string, Set<string>>()
  const ordered = [...decoded.keys()]
  const addEdge = (a: string, b: string) => {
    const from = neighbors.get(a) || new Set<string>()
    from.add(b)
    neighbors.set(a, from)
    const back = neighbors.get(b) || new Set<string>()
    back.add(a)
    neighbors.set(b, back)
  }
  const byFingerprint = new Map<string, string[]>()
  const fingerprintById = new Map<string, string>()
  for (const track of tracks) {
    if (!decoded.has(track.id)) continue
    fingerprintById.set(track.id, track.fingerprint)
    const ids = byFingerprint.get(track.fingerprint)
    if (ids) ids.push(track.id)
    else byFingerprint.set(track.fingerprint, [track.id])
  }
  for (const [fingerprint, ids] of byFingerprint) {
    if (isMuted(fingerprint, fingerprint)) continue
    for (let i = 1; i < ids.length; i++) addEdge(ids[0], ids[i])
  }
  for (const [key, common] of shared) {
    const [a, b] = key.split('\u0000')
    const sa = samples.get(a)
    const sb = samples.get(b)
    if (!sa || !sb) continue
    const fpA = fingerprintById.get(a)
    const fpB = fingerprintById.get(b)
    if (!fpA || !fpB || isMuted(fpA, fpB)) continue
    const fewer = Math.min(sa.length, sb.length)
    if (fewer < MIN_COMPARED_ITEMS || common < MIN_SHARED_ITEMS) continue
    if (!sameRecording(sa, sb)) continue
    addEdge(a, b)
  }

  const byId = new Map(tracks.map((track) => [track.id, track]))
  const seen = new Set<string>()
  const groups: FingerprintedTrack[][] = []
  for (const start of ordered) {
    if (seen.has(start)) continue
    const stack = [start]
    const component: string[] = []
    seen.add(start)
    while (stack.length > 0) {
      const id = stack.pop() as string
      component.push(id)
      for (const next of neighbors.get(id) || []) {
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    if (component.length < 2) continue
    const group = component
      .map((id) => byId.get(id))
      .filter((track): track is FingerprintedTrack => Boolean(track))
    if (group.length >= 2) groups.push(group)
  }
  return groups
}
