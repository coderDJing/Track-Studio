import { describe, expect, it } from 'vitest'
import { setLocale } from '@renderer/i18n'
import { t } from '@renderer/utils/translate'
import { icloudDownloadStatusLabel, mergeIcloudDownloadProgress } from './icloudDownloadStatus'
import type { CloudPlaybackState } from './icloudPlayback'

const leaked = ['icloud.downloadingPercent', 'icloud.downloading', 'icloud.waiting', 'requestId']

describe('icloud on-demand download status copy', () => {
  it('shows a real percent in both languages and falls back when it is missing or illegal', () => {
    setLocale('zh-CN')
    expect(icloudDownloadStatusLabel(t, { state: 'waiting', requestId: 'r' })).toBe('等待下载…')
    expect(icloudDownloadStatusLabel(t, { state: 'downloading', requestId: 'r' })).toBe('下载中…')
    expect(
      icloudDownloadStatusLabel(t, { state: 'downloading', requestId: 'r', percent: 37 })
    ).toBe('下载中 37%')
    expect(
      icloudDownloadStatusLabel(t, { state: 'downloading', requestId: 'r', percent: Number.NaN })
    ).toBe('下载中…')
    expect(icloudDownloadStatusLabel(t, { state: 'waiting', requestId: 'r', percent: 37 })).toBe(
      '等待下载…'
    )
    setLocale('en-US')
    expect(icloudDownloadStatusLabel(t, { state: 'waiting', requestId: 'r' })).toBe(
      'Waiting to download…'
    )
    expect(
      icloudDownloadStatusLabel(t, { state: 'downloading', requestId: 'r', percent: 37 })
    ).toBe('Downloading 37%')
    expect(icloudDownloadStatusLabel(t, { state: 'downloading', requestId: 'r' })).toBe(
      'Downloading…'
    )
    const shown = [
      icloudDownloadStatusLabel(t, { state: 'downloading', requestId: 'r', percent: 37 }),
      icloudDownloadStatusLabel(t, { state: 'downloading', requestId: 'r', percent: 140 })
    ]
    for (const text of shown) {
      for (const key of leaked) expect(text).not.toContain(key)
    }
    setLocale('zh-CN')
  })
})

describe('icloud:download-progress updates the existing status row', () => {
  it('keeps request ownership, stores a real percent, and clears it when the system stops reporting one', () => {
    const waiting: CloudPlaybackState = { state: 'waiting', requestId: 'owned' }
    expect(
      mergeIcloudDownloadProgress(waiting, {
        requestId: 'other',
        relative: 'song.mp3',
        state: 'downloading',
        percent: 37
      })
    ).toEqual(waiting)
    const downloading = mergeIcloudDownloadProgress(waiting, {
      requestId: 'owned',
      relative: 'song.mp3',
      state: 'downloading',
      percent: 37
    })
    expect(downloading).toMatchObject({
      state: 'downloading',
      requestId: 'owned',
      percent: 37
    })
    expect(icloudDownloadStatusLabel(t, downloading)).toBe('下载中 37%')
    const withoutPercent = mergeIcloudDownloadProgress(downloading, {
      requestId: 'owned',
      relative: 'song.mp3',
      state: 'downloading'
    })
    expect(withoutPercent?.percent).toBeUndefined()
    expect(icloudDownloadStatusLabel(t, withoutPercent)).toBe('下载中…')
    const cancelled: CloudPlaybackState = {
      state: 'failed',
      requestId: 'owned',
      error: 'cancelled'
    }
    expect(
      mergeIcloudDownloadProgress(cancelled, {
        requestId: 'owned',
        relative: 'song.mp3',
        state: 'downloading',
        percent: 80
      })
    ).toEqual(cancelled)
  })
})
