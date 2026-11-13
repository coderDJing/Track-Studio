import { describe, expect, it } from 'vitest'
import {
  buildArchiveName,
  buildRuntimeAsset,
  isSafeRelativePath,
  parseArgs,
  resolveDefaultPlatformKey,
  resolvePlatformKey,
  resolvePythonRelativePathCandidates
} from './package-rekordbox-runtime-assets.mjs'

const SHA = 'a'.repeat(64)

describe('rekordbox runtime packaging script', () => {
  it('parses defaults and overrides', () => {
    const defaults = parseArgs([])
    expect(
      defaults.runtimeRoot.endsWith('vendor\\rekordbox-desktop-runtime') ||
        defaults.runtimeRoot.endsWith('vendor/rekordbox-desktop-runtime')
    ).toBe(true)
    expect(defaults.releaseTag).toBe('rekordbox-runtime-assets')
    expect(defaults.version).toMatch(/^\d{8}/)

    const overridden = parseArgs([
      '--platform-key=darwin-arm64',
      '--runtime-root',
      'D:/runtime',
      '--output-root=D:/out',
      '--version',
      '3.11.9-pyrekordbox-1',
      '--release-tag',
      'rekordbox-runtime-assets-rc'
    ])
    expect(overridden.platformKey).toBe('darwin-arm64')
    expect(overridden.version).toBe('3.11.9-pyrekordbox-1')
    expect(overridden.releaseTag).toBe('rekordbox-runtime-assets-rc')
    expect(overridden.outputRoot.endsWith('out')).toBe(true)
  })

  it('supports exactly the three shipped platform keys', () => {
    expect(resolvePlatformKey('win32-x64')).toBe('win32-x64')
    expect(resolvePlatformKey('darwin-arm64')).toBe('darwin-arm64')
    expect(resolvePlatformKey('darwin-x64')).toBe('darwin-x64')
    expect(resolvePlatformKey('linux-x64')).toBe('')
    expect(['win32-x64', 'darwin-arm64', 'darwin-x64', '']).toContain(resolveDefaultPlatformKey())
  })

  it('names archives with platform and version so old assets are never overwritten', () => {
    expect(buildArchiveName({ platformKey: 'win32-x64', version: '202611131200' })).toBe(
      'frkb-rekordbox-runtime-win32-x64-202611131200.tar.gz'
    )
    expect(buildArchiveName({ platformKey: 'darwin-x64', version: 'v1 beta' })).toBe(
      'frkb-rekordbox-runtime-darwin-x64-v1-beta.tar.gz'
    )
    expect(() => buildArchiveName({ platformKey: 'linux-x64', version: '1' })).toThrow()
    expect(() => buildArchiveName({ platformKey: 'win32-x64', version: '' })).toThrow()
  })

  it('resolves the python entry relative to the platform directory', () => {
    expect(resolvePythonRelativePathCandidates('win32-x64')[0]).toBe('python/python.exe')
    expect(resolvePythonRelativePathCandidates('darwin-arm64')[0]).toBe('python/bin/python3')
  })

  it('rejects unsafe relative paths', () => {
    expect(isSafeRelativePath('python/python.exe')).toBe(true)
    expect(isSafeRelativePath('../python.exe')).toBe(false)
    expect(isSafeRelativePath('/usr/bin/python3')).toBe(false)
    expect(isSafeRelativePath('C:/python.exe')).toBe(false)
    expect(isSafeRelativePath('python\\python.exe')).toBe(false)
    expect(isSafeRelativePath('')).toBe(false)
  })

  it('builds a manifest asset pointing at the project release', () => {
    const asset = buildRuntimeAsset({
      platformKey: 'win32-x64',
      version: '202611131200',
      archiveName: 'frkb-rekordbox-runtime-win32-x64-202611131200.tar.gz',
      archiveSha256: SHA,
      archiveSize: 1024,
      pythonRelativePath: 'python/python.exe',
      releaseTag: 'rekordbox-runtime-assets',
      files: [{ path: 'python/python.exe', sha256: SHA, size: 1024 }]
    })
    expect(asset.platform).toBe('win32-x64')
    expect(asset.archiveUrl).toBe(
      'https://github.com/coderDJing/Track-Studio/releases/download/rekordbox-runtime-assets/frkb-rekordbox-runtime-win32-x64-202611131200.tar.gz'
    )
    expect(asset.files).toHaveLength(1)
  })

  it('refuses manifests that omit the python sentinel or carry bad hashes', () => {
    const base = {
      platformKey: 'darwin-arm64',
      version: '1',
      archiveName: 'frkb-rekordbox-runtime-darwin-arm64-1.tar.gz',
      archiveSha256: SHA,
      archiveSize: 10,
      pythonRelativePath: 'python/bin/python3',
      releaseTag: 'rekordbox-runtime-assets'
    }
    expect(() => buildRuntimeAsset({ ...base, files: [] })).toThrow()
    expect(() =>
      buildRuntimeAsset({
        ...base,
        files: [{ path: 'python/bin/python3', sha256: 'not-a-hash', size: 10 }]
      })
    ).toThrow()
    expect(() =>
      buildRuntimeAsset({
        ...base,
        files: [{ path: '../python3', sha256: SHA, size: 10 }]
      })
    ).toThrow()
    expect(() =>
      buildRuntimeAsset({ ...base, files: [{ path: 'python/bin/python3', sha256: SHA, size: 0 }] })
    ).toThrow()
  })
})
