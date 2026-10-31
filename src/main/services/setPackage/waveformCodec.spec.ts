// Run: pnpm exec vitest run src/main/services/setPackage/waveformCodec.spec.ts
import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { buildWaveformSurfaceCacheDataFromUnifiedDisplay } from '../../../shared/waveformSurfaceCache'
import { createPackageWaveformFixture } from './waveformTestFixtures'
import { encodeSetPackageWaveforms, decodeSetPackageWaveforms } from './waveformCodec'

const AUDIO_SHA = 'a'.repeat(64)
describe('SET waveform codec', () => {
  it('完整保留详细、列表和总览波形中的字节与版本', async () => {
    const detail = createPackageWaveformFixture()
    const surfaces = buildWaveformSurfaceCacheDataFromUnifiedDisplay(detail)
    if (!surfaces) throw new Error('surface fixture failed')
    const source = { detail, surfaces }
    const encoded = await encodeSetPackageWaveforms(source, AUDIO_SHA)
    expect(await decodeSetPackageWaveforms(encoded, AUDIO_SHA)).toEqual(source)
    await expect(decodeSetPackageWaveforms(encoded, 'b'.repeat(64))).rejects.toMatchObject({
      code: 'PACKAGE_FILE_CORRUPTED'
    })
  })

  it('拒绝截断的数据、非法压缩内容和缺少波形的空对象', async () => {
    const encoded = await encodeSetPackageWaveforms(
      { detail: createPackageWaveformFixture() },
      AUDIO_SHA
    )
    for (const payload of [encoded.subarray(0, 20), Buffer.from('bad gzip'), gzipSync('{}')]) {
      await expect(decodeSetPackageWaveforms(payload, AUDIO_SHA)).rejects.toMatchObject({
        code: 'PACKAGE_FILE_CORRUPTED'
      })
    }
  })

  it('拒绝版本不符或数组长度不一致的源波形', async () => {
    for (const patch of [
      { parameterVersion: 999 },
      { height: new Uint8Array(1) },
      { duration: NaN }
    ]) {
      await expect(
        encodeSetPackageWaveforms(
          { detail: { ...createPackageWaveformFixture(), ...patch } },
          AUDIO_SHA
        )
      ).rejects.toMatchObject({ code: 'PACKAGE_FILE_CORRUPTED' })
    }
  })
})
