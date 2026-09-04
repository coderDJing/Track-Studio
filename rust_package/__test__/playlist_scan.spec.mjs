import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'ava'
import rustPackage from '../index.js'

const { listAudioFilesWithStat } = rustPackage

const AUDIO_EXTS = ['.mp3', '.flac', '.wav']

/**
 * src/main/nodeTaskUtils.ts 里 collectFilesWithExtensions 的同步参照实现。
 *
 * 原生实现的输出顺序必须和它逐字一致：歌单序号初始化、封面扫描都依赖这个顺序，
 * 所以两边都不许排序，子目录内容出现在"该子目录这条目录项"的位置上。
 */
const referenceWalk = (dir, extensions) => {
  const allowed = new Set(extensions.map((ext) => String(ext || '').toLowerCase()).filter(Boolean))
  if (allowed.size === 0) return []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return []
    }
    const files = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        for (const file of walk(path.join(current, entry.name))) files.push(file)
        continue
      }
      if (!entry.isFile()) continue
      if (!allowed.has(path.extname(entry.name).toLowerCase())) continue
      files.push(path.join(current, entry.name))
    }
    return files
  }
  return walk(dir)
}

const createFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'frkb-playlist-scan-'))
  const write = (relative, content) => {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  write('b.mp3', 'b')
  write('a.MP3', 'aa')
  write('10.flac', '10')
  write('2.flac', '2')
  write('note.txt', 'not audio')
  // extname('.hidden.mp3') === '.mp3'，要算进去；extname('.mp3') === ''，不算。
  write('.hidden.mp3', 'hidden')
  write('.mp3', 'dot only')
  write('A B.mp3', 'space')
  write('ä.mp3', 'umlaut')
  write('中文.mp3', 'cjk')
  write('sub/inner.wav', 'inner')
  write('sub/skip.txt', 'skip')
  write('sub/deeper/x.flac', 'deep')
  write('sub/deeper/y.mp3', 'deeper')
  // 目录名带音频后缀：必须当目录递归进去，不能当文件。
  write('album.mp3/track.flac', 'in dir named like a file')
  mkdirSync(path.join(root, 'empty-dir'))
  return root
}

const withFixture = async (run) => {
  const root = createFixture()
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('native exports the playlist scan entrypoint', (t) => {
  t.is(typeof listAudioFilesWithStat, 'function')
})

test('原生枚举与 JS 参照实现逐字一致（顺序 / size / mtimeMs）', async (t) => {
  await withFixture(async (root) => {
    const expected = referenceWalk(root, AUDIO_EXTS)
    t.true(expected.length >= 10)
    const scanned = await listAudioFilesWithStat(root, AUDIO_EXTS)
    t.is(scanned.skipped, 0)
    t.deepEqual(
      scanned.files.map((item) => item.file),
      expected
    )
    for (const item of scanned.files) {
      const stats = statSync(item.file)
      t.is(item.size, stats.size)
      // 必须是同一个 double：下游 song_cache / 身份摘要都拿它和 fs.stat 的值直接比。
      t.is(item.mtimeMs, stats.mtimeMs)
    }
  })
})

test('后缀列表大小写不敏感', async (t) => {
  await withFixture(async (root) => {
    const scanned = await listAudioFilesWithStat(root, ['.MP3'])
    t.deepEqual(
      scanned.files.map((item) => item.file),
      referenceWalk(root, ['.MP3'])
    )
    t.true(scanned.files.length >= 4)
  })
})

test('空后缀列表返回空结果', async (t) => {
  await withFixture(async (root) => {
    const scanned = await listAudioFilesWithStat(root, [])
    t.deepEqual(scanned.files, [])
    t.is(scanned.skipped, 0)
  })
})

test('目录不存在时返回空结果而不是抛错', async (t) => {
  const missing = path.join(tmpdir(), 'frkb-playlist-scan-missing-0f3a9c')
  const scanned = await listAudioFilesWithStat(missing, AUDIO_EXTS)
  t.deepEqual(scanned.files, [])
  t.is(scanned.skipped, 0)
})
