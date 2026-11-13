import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractTarGzArchive,
  inspectTarGzEntries,
  validateArchiveEntriesForPlatform,
  type RekordboxRuntimeArchiveEntry
} from './rekordboxRuntimeArchive'
import { normalizeRekordboxRuntimeRelativePath } from '../../shared/rekordboxRuntimeDownload'

type TarEntrySpec = {
  name: string
  type?: 'file' | 'directory' | 'symlink' | 'hardlink' | 'device'
  content?: string
  linkPath?: string
  mode?: number
}

const TYPE_FLAGS: Record<NonNullable<TarEntrySpec['type']>, string> = {
  file: '0',
  directory: '5',
  symlink: '2',
  hardlink: '1',
  device: '3'
}

const buildHeader = (spec: TarEntrySpec, size: number): Buffer => {
  const header = Buffer.alloc(512, 0)
  header.write(spec.name, 0, 100, 'utf8')
  header.write(`${(spec.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write(TYPE_FLAGS[spec.type ?? 'file'], 156, 1, 'ascii')
  if (spec.linkPath) header.write(spec.linkPath, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  if (spec.type === 'device') {
    header.write('0000000\0', 329, 8, 'ascii')
    header.write('0000000\0', 337, 8, 'ascii')
  }
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

const buildTarGz = (specs: TarEntrySpec[]): Uint8Array => {
  const blocks: Buffer[] = []
  for (const spec of specs) {
    const content =
      spec.type === undefined || spec.type === 'file'
        ? Buffer.from(spec.content ?? '')
        : Buffer.alloc(0)
    blocks.push(buildHeader(spec, content.length))
    if (content.length > 0) {
      blocks.push(content)
      const padding = (512 - (content.length % 512)) % 512
      if (padding > 0) blocks.push(Buffer.alloc(padding))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const tempDirs: string[] = []
const writeArchive = (content: Uint8Array): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-rbx-archive-'))
  tempDirs.push(dir)
  const archivePath = path.join(dir, 'runtime.tar.gz')
  fs.writeFileSync(archivePath, content)
  return archivePath
}

const validate = (
  entries: Parameters<typeof validateArchiveEntriesForPlatform>[0],
  platform = 'win32-x64'
) => validateArchiveEntriesForPlatform(entries, platform, normalizeRekordboxRuntimeRelativePath)

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('rekordbox runtime tar.gz inspection', () => {
  it('parses platform root, directories, files and relative symlinks', async () => {
    const archivePath = writeArchive(
      buildTarGz([
        { name: 'win32-x64', type: 'directory', mode: 0o755 },
        { name: 'win32-x64/python', type: 'directory', mode: 0o755 },
        { name: 'win32-x64/python/python.exe', content: 'binary', mode: 0o755 },
        {
          name: 'win32-x64/python/bin/python3',
          type: 'symlink',
          linkPath: 'python3.11'
        }
      ])
    )

    const entries = await inspectTarGzEntries(archivePath)
    expect(entries.map((entry) => entry.path.replace(/\/+$/, ''))).toEqual([
      'win32-x64',
      'win32-x64/python',
      'win32-x64/python/python.exe',
      'win32-x64/python/bin/python3'
    ])
    expect(entries[3]).toMatchObject({ type: 'symlink', linkPath: 'python3.11' })
    expect(validate(entries).ok).toBe(true)
  })

  it('accepts the platform root directory with a trailing slash', () => {
    const entries = [
      { path: 'win32-x64/', type: 'directory' as const, size: 0 },
      { path: 'win32-x64/python/', type: 'directory' as const, size: 0 },
      { path: 'win32-x64/python/python.exe', type: 'file' as const, size: 3 }
    ]
    expect(validate(entries).ok).toBe(true)
  })

  it('rejects escaping paths, foreign platforms and escaping links', async () => {
    // 解析层或策略层任意一层拒绝都可接受，但绝不能被放行。
    const expectRejected = async (specs: TarEntrySpec[]) => {
      let entries: RekordboxRuntimeArchiveEntry[] | null = null
      try {
        entries = await inspectTarGzEntries(writeArchive(buildTarGz(specs)))
      } catch {
        return
      }
      if (!entries) return
      expect(validate(entries).ok).toBe(false)
    }

    await expectRejected([
      { name: 'win32-x64', type: 'directory' },
      { name: '../evil.py', content: 'x' }
    ])
    await expectRejected([{ name: 'darwin-arm64/python', type: 'directory' }])
    await expectRejected([
      { name: 'win32-x64/python', type: 'directory' },
      { name: 'win32-x64/python/link', type: 'symlink', linkPath: '../../../../etc/passwd' }
    ])
    await expectRejected([
      { name: 'win32-x64/python', type: 'directory' },
      { name: 'win32-x64/python/hard', type: 'hardlink', linkPath: '../outside' }
    ])
    await expectRejected([{ name: 'win32-x64/dev', type: 'device' }])
  })

  it('extracts a real archive and preserves normal symlinks and exec bits', async () => {
    const specs: TarEntrySpec[] = [
      { name: 'win32-x64', type: 'directory', mode: 0o755 },
      { name: 'win32-x64/python', type: 'directory', mode: 0o755 },
      { name: 'win32-x64/python/python.exe', content: 'binary', mode: 0o755 }
    ]
    if (process.platform !== 'win32') {
      specs.push({
        name: 'win32-x64/python/bin/python3',
        type: 'symlink',
        linkPath: '../python.exe'
      })
    }
    const archivePath = writeArchive(buildTarGz(specs))
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-rbx-extract-'))
    tempDirs.push(outputDir)

    await extractTarGzArchive(archivePath, outputDir)

    const pythonPath = path.join(outputDir, 'win32-x64', 'python', 'python.exe')
    expect(fs.readFileSync(pythonPath, 'utf8')).toBe('binary')
    if (process.platform !== 'win32') {
      // Windows 不保留 POSIX 执行位，也未必允许创建 symlink；只在类 Unix 上断言。
      expect(fs.statSync(pythonPath).mode & 0o111).not.toBe(0)
      const linkPath = path.join(outputDir, 'win32-x64', 'python', 'bin', 'python3')
      const stat = fs.lstatSync(linkPath)
      expect(stat.isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(linkPath)).toBe('../python.exe')
    }
  })
})
