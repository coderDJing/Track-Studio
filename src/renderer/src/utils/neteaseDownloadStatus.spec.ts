// Run: pnpm exec vitest run src/renderer/src/utils/neteaseDownloadStatus.spec.ts
import { describe, expect, it } from 'vitest'
import { getNeteaseDownloadStatus, getNeteaseDownloadStatusRank } from './neteaseDownloadStatus'

describe('getNeteaseDownloadStatus', () => {
  it('prefers failed over pending and downloaded', () => {
    expect(
      getNeteaseDownloadStatus({
        neteaseDownloaded: true,
        neteasePendingDownload: true,
        neteasePendingStatus: 'failed'
      })
    ).toBe('failed')
  })

  it('marks pending and downloaded, and leaves empty rows blank', () => {
    expect(
      getNeteaseDownloadStatus({
        neteaseDownloaded: false,
        neteasePendingDownload: true,
        neteasePendingStatus: undefined
      })
    ).toBe('pending')
    expect(
      getNeteaseDownloadStatus({
        neteaseDownloaded: true,
        neteasePendingDownload: false
      })
    ).toBe('downloaded')
    expect(getNeteaseDownloadStatus({})).toBe('')
    expect(getNeteaseDownloadStatusRank({})).toBeNull()
    expect(
      getNeteaseDownloadStatusRank({
        neteaseDownloaded: true
      })
    ).toBe(2)
  })
})
