import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  findSongListRootByPath: vi.fn(),
  collectFilesWithExtensions: vi.fn(),
  loadSongCache: vi.fn(),
  replaceSongCache: vi.fn()
}))

vi.mock('../libraryTreeDb', () => ({
  findSongListRootByPath: mocks.findSongListRootByPath
}))

vi.mock('../nodeTaskUtils', () => ({
  collectFilesWithExtensions: mocks.collectFilesWithExtensions
}))

vi.mock('../libraryCacheDb', () => ({
  loadSongCache: mocks.loadSongCache,
  replaceSongCache: mocks.replaceSongCache
}))

vi.mock('../coreLibraries', () => ({
  getCoreFsDirName: () => 'CuratedLibrary'
}))

// databaseDir 要在每个用例里指向当次临时库，所以这里留一个可变的普通对象。
vi.mock('../store', () => ({
  default: {
    databaseDir: '',
    settingConfig: { audioExt: ['.mp3'] }
  }
}))

const store = (await import('../store')).default
const { compactSongListTrackNumbers, compactSongListTrackNumbersByFilePaths } =
  await import('./playlistTrackNumbers')

const temporaryRoots: string[] = []

const createPlaylistDir = async (fileNames: string[]): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-track-numbers-'))
  temporaryRoots.push(root)
  const playlistDir = path.join(root, 'library', 'CuratedLibrary')
  await fs.mkdir(playlistDir, { recursive: true })
  await Promise.all(fileNames.map((name) => fs.writeFile(path.join(playlistDir, name), '')))
  store.databaseDir = root
  return playlistDir
}

const capturedOrder = (): string[] =>
  [...((mocks.replaceSongCache.mock.calls.at(-1)?.[1] as Map<string, unknown>)?.keys() ?? [])].map(
    (filePath) => path.basename(String(filePath))
  )

beforeEach(() => {
  mocks.findSongListRootByPath.mockReset()
  mocks.collectFilesWithExtensions.mockReset()
  mocks.loadSongCache.mockReset()
  mocks.replaceSongCache.mockReset()
  mocks.loadSongCache.mockResolvedValue(new Map())
  mocks.replaceSongCache.mockResolvedValue(true)
})

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('compactSongListTrackNumbersByFilePaths', () => {
  it('解析歌单根时按目录去重，不对每个文件重复走库树', async () => {
    const playlistDir = await createPlaylistDir([])
    mocks.findSongListRootByPath.mockResolvedValue(playlistDir)
    mocks.collectFilesWithExtensions.mockResolvedValue([])

    const result = await compactSongListTrackNumbersByFilePaths([
      path.join(playlistDir, 'set-a', '01.mp3'),
      path.join(playlistDir, 'set-a', '02.mp3'),
      path.join(playlistDir, 'set-a', '03.mp3')
    ])

    expect(mocks.findSongListRootByPath).toHaveBeenCalledTimes(1)
    expect(mocks.replaceSongCache).toHaveBeenCalledTimes(1)
    expect(result.roots).toBe(1)
  })

  it('不同目录各自解析一次，但结果仍按歌单根去重', async () => {
    const playlistDir = await createPlaylistDir([])
    mocks.findSongListRootByPath.mockImplementation(async (dir: string) =>
      dir.endsWith('set-a') || dir.endsWith('set-b') ? playlistDir : null
    )
    mocks.collectFilesWithExtensions.mockResolvedValue([])

    const result = await compactSongListTrackNumbersByFilePaths([
      path.join(playlistDir, 'set-a', '01.mp3'),
      path.join(playlistDir, 'set-a', '02.mp3'),
      path.join(playlistDir, 'set-b', '01.mp3')
    ])

    expect(mocks.findSongListRootByPath).toHaveBeenCalledTimes(2)
    expect(mocks.replaceSongCache).toHaveBeenCalledTimes(1)
    expect(result.roots).toBe(1)
  })

  it('忽略不在歌单树里的路径，也忽略空白项', async () => {
    await createPlaylistDir([])
    mocks.findSongListRootByPath.mockResolvedValue(null)

    const result = await compactSongListTrackNumbersByFilePaths(['   ', 'C:\\elsewhere\\01.mp3'])

    expect(result.roots).toBe(0)
    expect(result.updated).toBe(false)
    expect(mocks.replaceSongCache).not.toHaveBeenCalled()
  })
})

describe('compactSongListTrackNumbers 的落库顺序', () => {
  it('已有的真实序号优先并按数值升序，无序号的文件排在后面', async () => {
    const fileNames = ['1.mp3', '2.mp3', '10.mp3']
    const playlistDir = await createPlaylistDir(fileNames)
    mocks.collectFilesWithExtensions.mockResolvedValue(
      fileNames.map((name) => path.join(playlistDir, name))
    )
    mocks.loadSongCache.mockResolvedValue(
      new Map([
        [
          path.join(playlistDir, '10.mp3'),
          { size: 0, mtimeMs: 0, info: { filePath: '', playlistTrackNumber: 1 } }
        ],
        [
          path.join(playlistDir, '1.mp3'),
          { size: 0, mtimeMs: 0, info: { filePath: '', playlistTrackNumber: 2 } }
        ]
      ])
    )

    await compactSongListTrackNumbers(playlistDir)

    expect(capturedOrder()).toEqual(['10.mp3', '1.mp3', '2.mp3'])
  })

  it('没有序号时按相对路径做数字感知排序，而不是字典序', async () => {
    const fileNames = ['track10.mp3', 'track2.mp3']
    const playlistDir = await createPlaylistDir(fileNames)
    mocks.collectFilesWithExtensions.mockResolvedValue(
      fileNames.map((name) => path.join(playlistDir, name))
    )

    await compactSongListTrackNumbers(playlistDir)

    // 字典序会把 track10 排到 track2 前面。
    expect(capturedOrder()).toEqual(['track2.mp3', 'track10.mp3'])
  })

  it('不丢文件且重复整理得到同样的顺序', async () => {
    const fileNames = ['b.mp3', 'a.mp3', 'c.mp3']
    const playlistDir = await createPlaylistDir(fileNames)
    mocks.collectFilesWithExtensions.mockResolvedValue(
      fileNames.map((name) => path.join(playlistDir, name))
    )

    await compactSongListTrackNumbers(playlistDir)
    const first = capturedOrder()
    await compactSongListTrackNumbers(playlistDir)
    const second = capturedOrder()

    expect([...first].sort()).toEqual([...fileNames].sort())
    expect(second).toEqual(first)
  })
})
