import fs from 'node:fs/promises'
import { embeddedPicture } from './embeddedPicture'
import { constants } from 'node:fs'
// Reuse the tokenizer already shipped with the existing music-metadata parser.
import type { IRandomAccessTokenizer } from 'strtok3'
import {
  audioName,
  boundedPath,
  isLegacyPlaceholder,
  requireLocal,
  type ResidencyReader
} from './files'
import type { IcloudSongMetadata } from '../../../shared/icloudLibrary'

// Called only in the native policy-OFF worker. No analysis, tag writes,
// sidecar/database lookups or implicit downloads. Uses the existing list parser.
export async function readIcloudMetadata(
  root: string,
  relative: string,
  residency: ResidencyReader,
  expectedRoot?: string,
  cover = false
): Promise<IcloudSongMetadata> {
  const rootInfo = await fs.lstat(root)
  const identity = expectedRoot || `${root}:${rootInfo.dev}:${rootInfo.ino}`
  const verifyRoot = async () => {
    const current = await fs.lstat(root)
    if (!current.isDirectory() || `${root}:${current.dev}:${current.ino}` !== identity)
      throw new Error('boundary')
  }
  await verifyRoot()
  if (!audioName(relative) || isLegacyPlaceholder(relative)) throw new Error('invalid')
  const file = await boundedPath(root, relative, residency)
  await requireLocal(file, residency)
  const before = await fs.lstat(file)
  if (!before.isFile()) throw new Error('invalid')
  // Verify the opened descriptor before any audio read. A changed final path or
  // intermediate directory must not redirect the parser outside the checked file.
  const nodeTokenizer = await import('strtok3')
  // The shared bundler tsconfig resolves web typings; this Node-only worker
  // deliberately uses strtok3's documented `node` conditional export.
  if (!('FileTokenizer' in nodeTokenizer) || typeof nodeTokenizer.FileTokenizer !== 'function')
    throw new Error('unsupported')
  const FileTokenizer = nodeTokenizer.FileTokenizer as new (
    handle: fs.FileHandle,
    options: { fileInfo: { path: string; size: number }; maxBufferSize?: number }
  ) => IRandomAccessTokenizer
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  class VerifiedTokenizer extends FileTokenizer {
    constructor() {
      super(handle, {
        fileInfo: { path: file, size: before.size },
        ...(cover ? { maxBufferSize: 2 * 1024 * 1024 } : {})
      })
    }
  }
  const tokenizer = new VerifiedTokenizer()
  // Random-access parser may skip audio data; cap actual reads, not file length.
  let remaining = 32 * 1024 * 1024
  for (const method of ['readBuffer', 'peekBuffer'] as const) {
    const original = tokenizer[method].bind(tokenizer)
    tokenizer[method] = async (buffer, options) => {
      remaining -= options?.length ?? buffer.length
      if (remaining < 0) throw new Error('invalid')
      return original(buffer, options)
    }
  }
  let metadata: import('music-metadata').IAudioMetadata
  try {
    const opened = await handle.stat()
    await boundedPath(root, relative, residency)
    await verifyRoot()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    )
      throw new Error('boundary')
    const { parseFromTokenizer } = await import('music-metadata')
    metadata = await parseFromTokenizer(tokenizer, { skipCovers: !cover, duration: false })
  } finally {
    await tokenizer.close()
  }
  await boundedPath(root, relative, residency)
  await requireLocal(file, residency)
  await verifyRoot()
  const after = await fs.lstat(file)
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error('boundary')
  if (cover) {
    for (const picture of metadata.common.picture || []) {
      const result = embeddedPicture(picture.format, picture.data)
      if (result) return { picture: result }
    }
    return {}
  }
  const common = metadata.common,
    format = metadata.format
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 4096) : undefined
  // ID3 TBPM is commonly fractional in DJ files; the common parser maps it
  // through parseInt. Keep the actual tag value, without estimating tempo.
  const bpmTag = Object.values(metadata.native)
    .flat()
    .find(
      (tag) =>
        /^(TBPM|BPM|TXXX:BPM)$/i.test(tag.id) && /^(\d+)(\.\d+)?$/.test(String(tag.value).trim())
    )
  const taggedBpm = bpmTag ? Number(bpmTag.value) : common.bpm
  const seconds = format.duration === undefined ? undefined : Math.round(format.duration)
  return {
    title: text(common.title),
    artist: text(common.artist),
    album: text(common.album),
    genre: text(common.genre?.[0]),
    label: text(common.label?.[0]),
    key: text(common.key),
    bpm: Number.isFinite(taggedBpm) && taggedBpm! > 0 ? taggedBpm : undefined,
    duration:
      seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
        ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        : undefined,
    bitrate: Number.isFinite(format.bitrate) ? format.bitrate : undefined,
    container: text(format.container)
  }
}
