// Run: pnpm exec vitest run src/main/netease/cache.spec.ts
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { teeStreamToFile } from './cache'

/**
 * 试听缓存的落盘时序。
 *
 * 回归点：`end` 之后 Node 会紧接着发 `close`。如果 `close` 也走"清理"，
 * 它会在 rename 之前把临时文件删掉 —— 缓存永远是空的，而且没有任何报错。
 */
describe('netease preview cache tee', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-netease-cache-'))
  })

  afterEach(async () => {
    await fs.remove(dir)
  })

  const consume = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
    return Buffer.concat(chunks)
  }

  /** 等到落盘回调，而不是固定睡一会儿（Windows 上 close/unlink 时序不稳定） */
  const waitForSettled = async (settled: boolean[]): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      if (settled.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('teeStreamToFile did not settle in time')
  }

  it('字节数到齐时落盘，并清掉 .part', async () => {
    const finalPath = path.join(dir, '42.lossless.flac')
    const payload = Buffer.from('fLaC-'.repeat(64))
    const source = Readable.from([payload])

    const settled: boolean[] = []
    const out = teeStreamToFile({
      finalPath,
      source,
      expectedBytes: payload.length,
      onSettled: (ok) => settled.push(ok)
    })

    // 播放器拿到的字节必须与上游完全一致
    expect(await consume(out)).toEqual(payload)
    await waitForSettled(settled)

    expect(await fs.pathExists(finalPath)).toBe(true)
    expect(await fs.readFile(finalPath)).toEqual(payload)
    expect(await fs.pathExists(`${finalPath}.part`)).toBe(false)
    expect(settled).toEqual([true])
  })

  it('字节数对不上时删掉临时文件，不留下半个缓存', async () => {
    const finalPath = path.join(dir, '43.lossless.flac')
    const source = Readable.from([Buffer.from('short')])

    const settled: boolean[] = []
    const out = teeStreamToFile({
      finalPath,
      source,
      expectedBytes: 1024,
      onSettled: (ok) => settled.push(ok)
    })

    expect((await consume(out)).toString()).toBe('short')
    await waitForSettled(settled)

    expect(await fs.pathExists(finalPath)).toBe(false)
    expect(await fs.pathExists(`${finalPath}.part`)).toBe(false)
    expect(settled).toEqual([false])
  })

  it('上游中途出错时清掉临时文件', async () => {
    const finalPath = path.join(dir, '44.exhigh.mp3')
    const source = new Readable({
      read() {
        this.push(Buffer.from('abc'))
        this.destroy(new Error('upstream broke'))
      }
    })

    const settled: boolean[] = []
    const out = teeStreamToFile({
      finalPath,
      source,
      expectedBytes: 9,
      onSettled: (ok) => settled.push(ok)
    })
    out.on('data', () => {})
    out.on('error', () => {})
    // 上游错误不会 end 掉 transform（pipe 不转发 error），等它跑完再收尾
    await waitForSettled(settled)
    if (!out.destroyed) out.destroy()

    expect(await fs.pathExists(finalPath)).toBe(false)
    expect(await fs.pathExists(`${finalPath}.part`)).toBe(false)
  })
})
