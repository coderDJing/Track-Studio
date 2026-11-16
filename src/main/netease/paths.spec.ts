// Run: pnpm exec vitest run src/main/netease/paths.spec.ts
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import store from '../store'
import {
  assertAbsPathInsideStore,
  assertSongId,
  fromRelativeStorePath,
  getNeteaseRootDir,
  getNeteaseStoreDir,
  getStoreFilePath,
  isAbsPathInsideStore,
  isSafeSongId,
  toRelativeStorePath
} from './paths'

/**
 * 这一组用例守的是同一件事：**任何外部来的 id / 路径都不能带我们走出库根**。
 * songId 会被直接拼进 `.store/<songId>.<ext>`，IPC 又是信任边界。
 */
describe('netease paths', () => {
  const originalDir = store.databaseDir

  beforeEach(() => {
    store.databaseDir = path.join(os.tmpdir(), 'frkb-netease-paths-spec')
  })

  afterEach(() => {
    store.databaseDir = originalDir
  })

  it('只接受纯数字曲目 id', () => {
    expect(isSafeSongId('1901371647')).toBe(true)
    expect(isSafeSongId(1901371647)).toBe(true)
    expect(isSafeSongId(' 1901371647 ')).toBe(true)

    expect(isSafeSongId('')).toBe(false)
    expect(isSafeSongId('0')).toBe(false)
    expect(isSafeSongId('007')).toBe(false)
    expect(isSafeSongId('../evil')).toBe(false)
    expect(isSafeSongId('123/456')).toBe(false)
    expect(isSafeSongId('123.456')).toBe(false)
    expect(isSafeSongId('/etc/passwd')).toBe(false)
    expect(isSafeSongId(null)).toBe(false)
    expect(isSafeSongId(undefined)).toBe(false)
  })

  it('拼落盘路径时先校验 id', () => {
    const filePath = getStoreFilePath('1234567', 'flac')
    expect(filePath).toBe(path.join(getNeteaseRootDir(), '.store', '1234567.flac'))

    expect(() => getStoreFilePath('../../evil', 'flac')).toThrow(/非法的网易云曲目 id/)
    expect(() => getStoreFilePath('12345/6', 'flac')).toThrow()
  })

  it('扩展名不合法时退回 flac，不会拼出任意后缀', () => {
    expect(getStoreFilePath('1', '../sh')).toBe(path.join(getNeteaseRootDir(), '.store', '1.flac'))
  })

  it('assertSongId 原样返回合法 id', () => {
    expect(assertSongId(' 42 ')).toBe('42')
  })

  it('库内相对路径解析后必须落在库根之下', () => {
    const root = getNeteaseRootDir()
    expect(fromRelativeStorePath('.store/123.flac')).toBe(path.join(root, '.store', '123.flac'))

    expect(() => fromRelativeStorePath('../../evil.flac')).toThrow(/越界/)
    expect(() => fromRelativeStorePath('/etc/passwd')).toThrow(/越界/)
    expect(() => fromRelativeStorePath('')).toThrow()
    // 恰好等于库根也不算合法：那条路径不能当文件用
    expect(() => fromRelativeStorePath('.')).toThrow()
  })

  it('相对/绝对路径可以来回换算', () => {
    const abs = getStoreFilePath('999', 'mp3')
    expect(fromRelativeStorePath(toRelativeStorePath(abs))).toBe(abs)
  })

  it('只允许临时文件落在 .store 目录内', () => {
    const inside = path.join(getNeteaseStoreDir(), '.123.lossless.part')
    expect(isAbsPathInsideStore(inside)).toBe(true)
    expect(assertAbsPathInsideStore(inside)).toBe(path.resolve(inside))

    expect(isAbsPathInsideStore(path.join(getNeteaseRootDir(), 'evil.flac'))).toBe(false)
    expect(() => assertAbsPathInsideStore(path.join(os.tmpdir(), 'evil.part'))).toThrow(/\.store/)
  })
})
