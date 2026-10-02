import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { buildExternalLibraryBrowserTracks, getPlaylistNumericId } from './browserAdapter'
import { parseTraktorCollectionXml, traktorNodeId } from './traktor'
import type { ExternalLibraryPlaylist, TraktorTrackMetadata } from '../../../shared/externalLibrary'

const execFileAsync = promisify(execFile)

export type TraktorMutationRequest = {
  operation:
    | 'create-playlist'
    | 'create-folder'
    | 'rename'
    | 'move'
    | 'delete'
    | 'remove-tracks'
    | 'reorder-tracks'
    | 'write-tracks'
  sourcePath: string
  externalId?: string
  parentExternalId?: string
  name?: string
  rowKeys?: string[]
  targetIndex?: number
  seq?: number
  trackPaths?: string[]
  trackMetadata?: TraktorTrackMetadata[]
}

type MutationSummary = {
  externalId?: string
  parentExternalId?: string
  removedCount?: number
  addedCount?: number
  skippedDuplicateCount?: number
}

type XmlElement = Element & { getAttribute(name: string): string | null }

const element = (node: Node | null): XmlElement | null =>
  node?.nodeType === 1 ? (node as XmlElement) : null

const children = (node: Node | null | undefined, tagName: string): XmlElement[] => {
  const result: XmlElement[] = []
  for (let child = node?.firstChild || null; child; child = child.nextSibling) {
    const value = element(child)
    if (value?.tagName === tagName) result.push(value)
  }
  return result
}

const child = (node: Node | null | undefined, tagName: string) => children(node, tagName)[0] || null
const attribute = (node: XmlElement | null, name: string) => node?.getAttribute(name) || ''

const assertName = (value: string | undefined) => {
  const name = String(value || '').trim()
  if (!name || /[\u0000-\u001f]/.test(name)) throw new Error('Traktor 歌单名称无效。')
  return name
}

const indexedNodes = (rootNode: XmlElement) => {
  const result: Array<{ node: XmlElement; id: string }> = []
  const walk = (node: XmlElement) => {
    result.push({ node, id: traktorNodeId(node, result.length) })
    for (const nested of children(child(node, 'SUBNODES'), 'NODE')) walk(nested)
  }
  for (const node of children(child(rootNode, 'SUBNODES'), 'NODE')) walk(node)
  return result
}

const ensureSubnodes = (document: Document, node: XmlElement) => {
  const existing = child(node, 'SUBNODES')
  if (existing) return existing
  const created = document.createElement('SUBNODES')
  created.setAttribute('COUNT', '0')
  node.appendChild(created)
  return created
}

const updateCounts = (document: Document, rootNode: XmlElement) => {
  for (const { node } of indexedNodes(rootNode)) {
    const subnodes = child(node, 'SUBNODES')
    if (subnodes) subnodes.setAttribute('COUNT', String(children(subnodes, 'NODE').length))
    const playlist = child(node, 'PLAYLIST')
    if (playlist) playlist.setAttribute('ENTRIES', String(children(playlist, 'ENTRY').length))
  }
  const rootSubnodes = ensureSubnodes(document, rootNode)
  rootSubnodes.setAttribute('COUNT', String(children(rootSubnodes, 'NODE').length))
}

const makeNode = (document: Document, type: 'FOLDER' | 'PLAYLIST', name: string) => {
  const node = document.createElement('NODE')
  node.setAttribute('TYPE', type)
  node.setAttribute('NAME', name)
  if (type === 'FOLDER') {
    ensureSubnodes(document, node)
  } else {
    const playlist = document.createElement('PLAYLIST')
    playlist.setAttribute('ENTRIES', '0')
    playlist.setAttribute('TYPE', 'LIST')
    playlist.setAttribute('UUID', crypto.randomUUID().replaceAll('-', '').toUpperCase())
    node.appendChild(playlist)
  }
  return node
}

const trackLocation = (filePath: string) => {
  if (path.posix.isAbsolute(filePath)) {
    const normalized = path.posix.normalize(filePath)
    const parsed = path.posix.parse(normalized)
    const segments = parsed.dir.split('/').filter(Boolean)
    const dir = segments.length ? `/:${segments.join('/:')}/:` : '/:'
    return { volume: '/', dir, file: parsed.base, key: `/${dir}${parsed.base}` }
  }
  const normalized = path.win32.normalize(filePath)
  if (!path.win32.isAbsolute(normalized) || !/^[A-Za-z]:\\/.test(normalized)) {
    throw new Error('Traktor 音频文件路径必须是绝对路径。')
  }
  const parsed = path.win32.parse(normalized)
  const segments = parsed.dir.slice(parsed.root.length).split('\\').filter(Boolean)
  const volume = parsed.root.slice(0, 2).toUpperCase()
  const dir = segments.length ? `/:${segments.join('/:')}/:` : '/:'
  return { volume, dir, file: parsed.base, key: `${volume}${dir}${parsed.base}` }
}

const normalizeTrackKey = (value: string) =>
  value.replaceAll('\\', '/').replaceAll('/:', '/').replace(/^\/+/, '').toLowerCase()

const addCollectionTrack = (
  document: Document,
  collection: XmlElement,
  filePath: string,
  metadata?: TraktorTrackMetadata
) => {
  const location = trackLocation(filePath)
  const entry = document.createElement('ENTRY')
  entry.setAttribute('TITLE', metadata?.title || path.parse(filePath).name)
  if (metadata?.artist) entry.setAttribute('ARTIST', metadata.artist)
  const locationNode = document.createElement('LOCATION')
  locationNode.setAttribute('VOLUME', location.volume)
  locationNode.setAttribute('DIR', location.dir)
  locationNode.setAttribute('FILE', location.file)
  entry.appendChild(locationNode)
  if (metadata?.album) {
    const album = document.createElement('ALBUM')
    album.setAttribute('TITLE', metadata.album)
    entry.appendChild(album)
  }
  const info = document.createElement('INFO')
  if (metadata?.genre) info.setAttribute('GENRE', metadata.genre)
  if (metadata?.key) info.setAttribute('KEY', metadata.key)
  if (Number.isFinite(metadata?.durationSec) && Number(metadata?.durationSec) > 0) {
    info.setAttribute('PLAYTIME', String(Math.round(Number(metadata?.durationSec))))
    info.setAttribute('PLAYTIME_FLOAT', String(metadata?.durationSec))
  }
  if (Number.isFinite(metadata?.bitrate) && Number(metadata?.bitrate) > 0) {
    info.setAttribute('BITRATE', String(Math.round(Number(metadata?.bitrate))))
  }
  entry.appendChild(info)
  if (Number.isFinite(metadata?.bpm) && Number(metadata?.bpm) > 0) {
    const tempo = document.createElement('TEMPO')
    tempo.setAttribute('BPM', String(metadata?.bpm))
    entry.appendChild(tempo)
  }
  const cues = [
    ...(metadata?.hotCues || []).map((cue) => ({ ...cue, hotcue: cue.slot, name: cue.label })),
    ...(metadata?.memoryCues || []).map((cue) => ({
      ...cue,
      hotcue: -1,
      name: cue.comment
    }))
  ]
  for (const [index, cue] of cues.entries()) {
    if (!Number.isFinite(cue.sec) || cue.sec < 0) continue
    const cueNode = document.createElement('CUE_V2')
    cueNode.setAttribute('NAME', cue.name || 'n.n.')
    cueNode.setAttribute('DISPL_ORDER', String(index))
    cueNode.setAttribute('TYPE', cue.isLoop ? '5' : '0')
    cueNode.setAttribute('START', String(cue.sec * 1000))
    cueNode.setAttribute(
      'LEN',
      String(cue.isLoop ? Math.max(0, (Number(cue.loopEndSec) - cue.sec) * 1000) || 0 : 0)
    )
    cueNode.setAttribute('REPEATS', '-1')
    cueNode.setAttribute('HOTCUE', String(cue.hotcue))
    entry.appendChild(cueNode)
  }
  collection.appendChild(entry)
  collection.setAttribute('ENTRIES', String(children(collection, 'ENTRY').length))
  return location.key
}

const playlistFor = (parsed: ReturnType<typeof parseTraktorCollectionXml>, externalId: string) =>
  parsed.playlists.find((item) => item.id === externalId)

const selectedEntryIndexes = (
  parsed: ReturnType<typeof parseTraktorCollectionXml>,
  playlist: ExternalLibraryPlaylist,
  rowKeys: string[]
) => {
  const tracks = buildExternalLibraryBrowserTracks(
    { ...parsed, kind: 'traktor', rootPath: '', libraryPath: '' },
    getPlaylistNumericId(playlist)
  ).tracks
  const indexByRowKey = new Map(tracks.map((track) => [track.rowKey, track.entryIndex]))
  return [...new Set(rowKeys)].map((rowKey) => {
    const index = indexByRowKey.get(rowKey)
    if (index === undefined) throw new Error('Traktor 歌单已变化，请刷新后重试。')
    return index
  })
}

export const mutateTraktorCollectionXml = (
  xml: string,
  request: TraktorMutationRequest
): { xml: string; summary: MutationSummary } => {
  const errors: string[] = []
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message)
    }
  }).parseFromString(xml, 'text/xml')
  if (errors.length || document.documentElement?.tagName !== 'NML') {
    throw new Error('Traktor collection.nml 不是有效的 NML 文件。')
  }
  const collection = child(document.documentElement, 'COLLECTION')
  const playlists = child(document.documentElement, 'PLAYLISTS')
  const rootNode = child(playlists, 'NODE')
  if (!collection || !playlists || !rootNode || attribute(rootNode, 'TYPE') !== 'FOLDER') {
    throw new Error('Traktor collection.nml 缺少可识别的歌单结构。')
  }
  const parsed = parseTraktorCollectionXml(xml, path.dirname(request.sourcePath))
  const current = indexedNodes(rootNode)
  const target = current.find((item) => item.id === request.externalId)
  const parentTarget = current.find((item) => item.id === request.parentExternalId)
  if (request.parentExternalId && !parentTarget) {
    throw new Error('Traktor 目标文件夹已变化，请刷新后重试。')
  }
  const parent = parentTarget?.node || rootNode
  const summary: MutationSummary = {}
  let resultNode: XmlElement | null = null

  if (request.operation === 'create-playlist' || request.operation === 'create-folder') {
    if (attribute(parent, 'TYPE') !== 'FOLDER') throw new Error('只能在 Traktor 文件夹中创建歌单。')
    resultNode = makeNode(
      document,
      request.operation === 'create-folder' ? 'FOLDER' : 'PLAYLIST',
      assertName(request.name)
    )
    ensureSubnodes(document, parent).appendChild(resultNode)
  } else {
    if (!target) throw new Error('Traktor 歌单已变化，请刷新后重试。')
    resultNode = target.node
    if (attribute(resultNode, 'TYPE') === 'SMARTLIST') {
      throw new Error('Traktor 智能歌单不可修改。')
    }
    if (request.operation === 'rename') {
      resultNode.setAttribute('NAME', assertName(request.name))
    } else if (request.operation === 'delete') {
      resultNode.parentNode?.removeChild(resultNode)
      resultNode = null
    } else if (request.operation === 'move') {
      if (attribute(parent, 'TYPE') !== 'FOLDER') throw new Error('只能移动到 Traktor 文件夹中。')
      for (let ancestor: Node | null = parent; ancestor; ancestor = ancestor.parentNode) {
        if (ancestor === resultNode) throw new Error('不能将文件夹移入自身。')
      }
      const destination = ensureSubnodes(document, parent)
      const siblings = children(destination, 'NODE').filter(
        (node) => node !== resultNode && attribute(node, 'TYPE') !== 'SMARTLIST'
      )
      const oneBasedSeq = Number(request.seq) || 1
      const index = Math.min(Math.max(0, oneBasedSeq - 1), siblings.length)
      destination.insertBefore(resultNode, siblings[index] || null)
    } else {
      const playlistNode = child(resultNode, 'PLAYLIST')
      const externalPlaylist = playlistFor(parsed, request.externalId || '')
      if (!playlistNode || !externalPlaylist) throw new Error('所选 Traktor 节点不是普通歌单。')
      const entries = children(playlistNode, 'ENTRY')
      if (request.operation === 'remove-tracks' || request.operation === 'reorder-tracks') {
        const indexes = selectedEntryIndexes(parsed, externalPlaylist, request.rowKeys || [])
        if (request.operation === 'remove-tracks') {
          for (const index of indexes) playlistNode.removeChild(entries[index])
          summary.removedCount = indexes.length
        } else {
          const selected = indexes.map((index) => entries[index])
          const selectedSet = new Set(selected)
          const remaining = entries.filter((entry) => !selectedSet.has(entry))
          const targetIndex = Math.min(
            Math.max(0, Number(request.targetIndex) || 0),
            entries.length
          )
          const position = targetIndex - indexes.filter((index) => index < targetIndex).length
          remaining.splice(position, 0, ...selected)
          for (const entry of remaining) playlistNode.appendChild(entry)
        }
      } else if (request.operation === 'write-tracks') {
        const metadataByPath = new Map(
          (request.trackMetadata || []).map((item) => [normalizeTrackKey(item.storedPath), item])
        )
        const collectionKeys = new Set(
          children(collection, 'ENTRY').map((entry) => {
            const location = child(entry, 'LOCATION')
            return normalizeTrackKey(
              `${attribute(location, 'VOLUME')}${attribute(location, 'DIR')}${attribute(location, 'FILE')}`
            )
          })
        )
        const playlistKeys = new Set(
          entries.map((entry) => normalizeTrackKey(attribute(child(entry, 'PRIMARYKEY'), 'KEY')))
        )
        let added = 0
        let skipped = 0
        for (const filePath of request.trackPaths || []) {
          const location = trackLocation(filePath)
          const key = normalizeTrackKey(location.key)
          if (playlistKeys.has(key)) {
            skipped++
            continue
          }
          if (!collectionKeys.has(key)) {
            addCollectionTrack(document, collection, filePath, metadataByPath.get(key))
            collectionKeys.add(key)
          }
          const entry = document.createElement('ENTRY')
          const primaryKey = document.createElement('PRIMARYKEY')
          primaryKey.setAttribute('TYPE', 'TRACK')
          primaryKey.setAttribute('KEY', location.key)
          entry.appendChild(primaryKey)
          playlistNode.appendChild(entry)
          playlistKeys.add(key)
          added++
        }
        summary.addedCount = added
        summary.skippedDuplicateCount = skipped
      }
    }
  }

  updateCounts(document, rootNode)
  if (resultNode) {
    summary.externalId = indexedNodes(rootNode).find((item) => item.node === resultNode)?.id
    const parentNode = element(resultNode.parentNode?.parentNode || null)
    summary.parentExternalId = indexedNodes(rootNode).find((item) => item.node === parentNode)?.id
  }
  return { xml: new XMLSerializer().serializeToString(document), summary }
}

export const assertTraktorClosed = async () => {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'])
    if (/"[^"\r\n]*traktor[^"\r\n]*\.exe"/i.test(stdout)) {
      throw new Error('请先退出 Traktor，再修改 Traktor 歌单。')
    }
  } else if (process.platform === 'darwin') {
    try {
      await execFileAsync('pgrep', ['-ifl', 'Traktor.app/Contents/MacOS'])
      throw new Error('请先退出 Traktor，再修改 Traktor 歌单。')
    } catch (error) {
      if (error instanceof Error && error.message.includes('请先退出 Traktor')) throw error
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
        return
      }
      throw error
    }
  }
}

export const mutateTraktorCollection = async (request: TraktorMutationRequest) => {
  if (path.basename(request.sourcePath).toLowerCase() !== 'collection.nml') {
    throw new Error('Traktor 库路径必须是 collection.nml。')
  }
  await assertTraktorClosed()
  if (request.operation === 'write-tracks') {
    for (const filePath of request.trackPaths || []) {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) throw new Error(`音频文件不存在：${filePath}`)
    }
  }
  const original = await fs.readFile(request.sourcePath)
  const { xml, summary } = mutateTraktorCollectionXml(original.toString('utf8'), request)
  const next = Buffer.from(xml, 'utf8')
  if (next.equals(original)) return summary
  const latest = await fs.readFile(request.sourcePath)
  if (!latest.equals(original)) throw new Error('Traktor 库已被其他程序修改，请刷新后重试。')
  const backupDir = path.join(path.dirname(request.sourcePath), 'FRKB Backups')
  await fs.mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `collection.${stamp}.${crypto.randomUUID()}.nml`)
  await fs.writeFile(backupPath, original, { flag: 'wx' })
  const tempPath = `${request.sourcePath}.frkb-${crypto.randomUUID()}.tmp`
  try {
    const handle = await fs.open(tempPath, 'wx')
    try {
      await handle.writeFile(next)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertTraktorClosed()
    const beforeReplace = await fs.readFile(request.sourcePath)
    if (!beforeReplace.equals(original))
      throw new Error('Traktor 库已被其他程序修改，请刷新后重试。')
    await fs.rename(tempPath, request.sourcePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true })
    throw error
  }
  return summary
}
