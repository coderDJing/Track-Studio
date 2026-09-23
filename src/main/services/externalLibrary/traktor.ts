import fs from 'node:fs/promises'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import type {
  ExternalLibraryCue,
  ExternalLibraryPlaylist,
  ExternalLibrarySnapshot,
  ExternalLibraryTrack
} from '../../../shared/externalLibrary'

type XmlElement = Element & { getAttribute(name: string): string | null }

const asElement = (node: Node | null): XmlElement | null =>
  node && node.nodeType === 1 ? (node as XmlElement) : null

const directChildren = (node: XmlElement | null | undefined, tagName?: string): XmlElement[] => {
  const result: XmlElement[] = []
  if (!node) return result
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const element = asElement(child)
    if (element && (!tagName || element.tagName === tagName)) result.push(element)
  }
  return result
}

const attr = (node: XmlElement | null, name: string) =>
  String(node?.getAttribute(name) || '').trim()

const numberAttr = (node: XmlElement | null, name: string) => {
  const number = Number(attr(node, name))
  return Number.isFinite(number) ? number : undefined
}

const yearAttr = (node: XmlElement | null) => {
  const value = attr(node, 'RELEASE_DATE')
  const match = value.match(/^(\d{4})/)
  return match ? Number(match[1]) : undefined
}

const normalizeKey = (value: string) =>
  value.replaceAll('\\', '/').replaceAll('/:', '/').replace(/^\/+/, '').toLowerCase()

const decodeLocation = (location: XmlElement, collectionDir: string) => {
  const volume = attr(location, 'VOLUME')
  const dir = attr(location, 'DIR')
    .replaceAll('/:', '/')
    .replace(/^\/+|\/+$/g, '')
  const file = attr(location, 'FILE')
  const relative = [dir, file].filter(Boolean).join('/')
  if (/^[A-Za-z]:$/.test(volume))
    return path.win32.normalize(`${volume}\\${relative.replaceAll('/', '\\')}`)
  if (volume.startsWith('/')) return path.normalize(path.join(volume, relative))
  if (process.platform === 'win32' && volume) {
    const candidate = path.join(`${volume}${path.sep}`, relative)
    if (path.isAbsolute(candidate)) return path.normalize(candidate)
  }
  return path.normalize(path.join(collectionDir, volume, relative))
}

const parseCue = (cue: XmlElement): ExternalLibraryCue | null => {
  const positionMs = numberAttr(cue, 'START')
  if (positionMs === undefined || positionMs < 0) return null
  const type = numberAttr(cue, 'TYPE')
  const hotcue = numberAttr(cue, 'HOTCUE')
  const name = attr(cue, 'NAME')
  if (type === 4) {
    return { kind: 'grid', positionMs, bpm: numberAttr(cue, 'BPM') }
  }
  if (type === 5) {
    const length = numberAttr(cue, 'LEN') || 0
    return {
      kind: 'loop',
      positionMs,
      endPositionMs: positionMs + Math.max(0, length),
      slot: hotcue !== undefined && hotcue >= 0 ? hotcue : undefined,
      name: name && name !== 'n.n.' ? name : undefined
    }
  }
  return {
    kind: hotcue !== undefined && hotcue >= 0 ? 'hotCue' : 'memory',
    positionMs,
    slot: hotcue !== undefined && hotcue >= 0 ? hotcue : undefined,
    name: name && name !== 'n.n.' ? name : undefined
  }
}

const parseEntry = (
  entry: XmlElement,
  collectionDir: string,
  index: number
): ExternalLibraryTrack | null => {
  const location = directChildren(entry, 'LOCATION')[0]
  if (!location) return null
  const filePath = decodeLocation(location, collectionDir)
  const album = directChildren(entry, 'ALBUM')[0]
  const info = directChildren(entry, 'INFO')[0]
  const tempo = directChildren(entry, 'TEMPO')[0]
  const musicalKey = directChildren(entry, 'MUSICAL_KEY')[0]
  const cues = directChildren(entry, 'CUE_V2').flatMap((cue) => {
    const parsed = parseCue(cue)
    return parsed ? [parsed] : []
  })
  return {
    id: `traktor-track:${normalizeKey(filePath) || index}`,
    filePath,
    title: attr(entry, 'TITLE') || undefined,
    artist: attr(entry, 'ARTIST') || undefined,
    album: attr(album, 'TITLE') || undefined,
    genre: attr(info, 'GENRE') || undefined,
    comment: attr(info, 'COMMENT') || undefined,
    key: attr(info, 'KEY') || attr(musicalKey, 'VALUE') || undefined,
    bpm: numberAttr(tempo, 'BPM'),
    durationSec: numberAttr(entry, 'PLAYTIME'),
    bitrate: numberAttr(info, 'BITRATE'),
    fileFormat: path.extname(filePath).replace(/^\./, '').toUpperCase(),
    year: yearAttr(info),
    dateAdded: attr(info, 'IMPORT_DATE') || undefined,
    missing: attr(entry, 'STATUS') === 'MISSING',
    cues
  }
}

const playlistTree = (
  node: XmlElement,
  parentId: string | null,
  tracksByKey: Map<string, ExternalLibraryTrack>,
  playlists: ExternalLibraryPlaylist[],
  warnings: string[]
) => {
  const type = attr(node, 'TYPE')
  const name = attr(node, 'NAME') || 'Untitled'
  const id = `traktor-playlist:${playlists.length}:${name}`
  const isSmartPlaylist = type === 'SMARTLIST'
  const playlist: ExternalLibraryPlaylist = {
    id,
    name,
    parentId,
    isFolder: type === 'FOLDER',
    isSmartPlaylist,
    trackIds: [],
    order: playlists.length
  }
  playlists.push(playlist)
  if (isSmartPlaylist) warnings.push(`Traktor Smartlist「${name}」只读取名称，未展开动态规则。`)

  const playlistElement = directChildren(node, 'PLAYLIST')[0]
  for (const entry of playlistElement ? directChildren(playlistElement, 'ENTRY') : []) {
    const primaryKey = directChildren(entry, 'PRIMARYKEY')[0]
    const key = normalizeKey(attr(primaryKey, 'KEY'))
    const track = tracksByKey.get(key)
    if (track) playlist.trackIds.push(track.id)
  }
  const subnodes = directChildren(directChildren(node, 'SUBNODES')[0], 'NODE')
  for (const child of subnodes) playlistTree(child, id, tracksByKey, playlists, warnings)
}

export const parseTraktorCollectionXml = (
  xml: string,
  collectionDir = ''
): Omit<ExternalLibrarySnapshot, 'kind' | 'rootPath' | 'libraryPath'> => {
  const document = new DOMParser().parseFromString(xml, 'text/xml')
  const root = asElement(document.documentElement)
  const warnings: string[] = []
  if (!root || root.tagName !== 'NML')
    return { tracks: [], playlists: [], warnings: ['不是有效的 Traktor NML 文件。'] }

  const tracks: ExternalLibraryTrack[] = []
  const tracksByKey = new Map<string, ExternalLibraryTrack>()
  const collection = directChildren(root, 'COLLECTION')[0]
  for (const [index, entry] of (collection ? directChildren(collection, 'ENTRY') : []).entries()) {
    const track = parseEntry(entry, collectionDir, index)
    if (!track) continue
    tracks.push(track)
    tracksByKey.set(normalizeKey(track.filePath), track)
  }

  const playlists: ExternalLibraryPlaylist[] = []
  const playlistRoot = directChildren(root, 'PLAYLISTS')[0]
  const rootNode = playlistRoot ? directChildren(playlistRoot, 'NODE')[0] : null
  if (rootNode) playlistTree(rootNode, null, tracksByKey, playlists, warnings)
  return { tracks, playlists, warnings }
}

export const readTraktorCollection = async (
  collectionPath: string
): Promise<ExternalLibrarySnapshot> => {
  const xml = await fs.readFile(collectionPath, 'utf8')
  const collectionDir = path.dirname(collectionPath)
  const parsed = parseTraktorCollectionXml(xml, collectionDir)
  return {
    kind: 'traktor',
    rootPath: collectionDir,
    libraryPath: collectionPath,
    ...parsed
  }
}

export const __traktorTestUtils = { decodeLocation, parseCue, parseTraktorCollectionXml }
