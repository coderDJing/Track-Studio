type KeyDisplayStyle = 'Classic' | 'Camelot'

const KEY_TO_CAMELOT: Record<string, string> = {
  C: '8B',
  Db: '3B',
  D: '10B',
  Eb: '5B',
  E: '12B',
  F: '7B',
  'F#': '2B',
  G: '9B',
  Ab: '4B',
  A: '11B',
  Bb: '6B',
  B: '1B',
  Cm: '5A',
  'C#m': '12A',
  Dm: '7A',
  Ebm: '2A',
  Em: '9A',
  Fm: '4A',
  'F#m': '11A',
  Gm: '6A',
  'G#m': '1A',
  Am: '8A',
  Bbm: '3A',
  Bm: '10A'
}

const CAMELOT_KEY_PATTERN = /^0?([1-9]|1[0-2])\s*([AB])$/i
const ENHARMONIC_KEYS: Record<string, string> = {
  'C#': 'Db',
  'D#': 'Eb',
  Gb: 'F#',
  'G#': 'Ab',
  'A#': 'Bb',
  Dbm: 'C#m',
  'D#m': 'Ebm',
  Gbm: 'F#m',
  Abm: 'G#m',
  'A#m': 'Bbm'
}

const normalizeKeyText = (keyText: string): string => {
  const raw = typeof keyText === 'string' ? keyText.trim() : ''
  if (!raw) return ''

  const symbolic = raw.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/\s+/g, '')
  const camelotMatch = symbolic.match(CAMELOT_KEY_PATTERN)
  if (camelotMatch) {
    return `${Number(camelotMatch[1])}${camelotMatch[2].toUpperCase()}`
  }

  const tonalMatch = symbolic.match(/^([A-Ga-g])([#b]?)(m?)$/)
  if (!tonalMatch) return symbolic

  const root = tonalMatch[1].toUpperCase()
  const accidental = tonalMatch[2] === '#' ? '#' : tonalMatch[2] === 'b' ? 'b' : ''
  const minor = tonalMatch[3] ? 'm' : ''
  return `${root}${accidental}${minor}`
}

const mapKeyToCamelot = (keyText: string): string => {
  const normalized = normalizeKeyText(keyText)
  return KEY_TO_CAMELOT[ENHARMONIC_KEYS[normalized] || normalized] || normalized
}

export const normalizeCamelotKey = (keyText: string): string => {
  const camelot = mapKeyToCamelot(keyText)
  const match = camelot.match(CAMELOT_KEY_PATTERN)
  if (!match) return ''
  return `${Number(match[1])}${match[2].toUpperCase()}`
}

export const isHarmonicMixCompatible = (referenceKeyText: string, candidateKeyText: string) => {
  const reference = normalizeCamelotKey(referenceKeyText)
  const candidate = normalizeCamelotKey(candidateKeyText)
  if (!reference || !candidate) return false
  if (reference === candidate) return true

  const referenceMatch = reference.match(CAMELOT_KEY_PATTERN)
  const candidateMatch = candidate.match(CAMELOT_KEY_PATTERN)
  if (!referenceMatch || !candidateMatch) return false

  const referenceNumber = Number(referenceMatch[1])
  const referenceLetter = referenceMatch[2].toUpperCase()
  const candidateNumber = Number(candidateMatch[1])
  const candidateLetter = candidateMatch[2].toUpperCase()
  const previousNumber = referenceNumber === 1 ? 12 : referenceNumber - 1
  const nextNumber = referenceNumber === 12 ? 1 : referenceNumber + 1
  const isRelativeMajorMinor =
    candidateNumber === referenceNumber && candidateLetter !== referenceLetter
  const isAdjacentSameMode =
    candidateLetter === referenceLetter &&
    (candidateNumber === previousNumber || candidateNumber === nextNumber)

  return isRelativeMajorMinor || isAdjacentSameMode
}

export const getKeyDisplayText = (keyText: string, style: KeyDisplayStyle): string => {
  const normalized = typeof keyText === 'string' ? keyText.trim() : ''
  if (!normalized) return ''
  if (style === 'Camelot') {
    return mapKeyToCamelot(normalized)
  }
  return normalized
}

export const getKeySortText = (keyText: string, style: KeyDisplayStyle): string => {
  const display = getKeyDisplayText(keyText, style)
  if (!display) return ''
  if (display.toLowerCase() === 'o') return ''
  if (style === 'Camelot') {
    if (/^\d{1,2}[AB]$/.test(display)) return display
    return `99Z-${display}`
  }
  return display
}

export const KEY_FILTER_PREFIX = 'keys:'
export const KEY_FILTER_OPTIONS = Object.entries(KEY_TO_CAMELOT)
  .map(([classic, camelot]) => ({ classic, camelot }))
  .sort(
    (a, b) =>
      Number.parseInt(a.camelot) - Number.parseInt(b.camelot) || a.camelot.localeCompare(b.camelot)
  )
export const parseSelectedKeyFilter = (value: string): string[] | null => {
  if (!value.startsWith(KEY_FILTER_PREFIX)) return null
  return value.slice(KEY_FILTER_PREFIX.length).split(',').map(normalizeCamelotKey).filter(Boolean)
}
