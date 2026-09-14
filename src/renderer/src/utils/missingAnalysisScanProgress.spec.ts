import { afterEach, describe, expect, it } from 'vitest'
import emitter from '@renderer/utils/mitt'
import { createMissingAnalysisScanProgress } from './missingAnalysisScanProgress'

type ProgressEvent = {
  id?: string
  titleKey?: string
  now?: number
  total?: number
  isInitial?: boolean
  dismiss?: boolean
}

const listeners: Array<(payload: unknown) => void> = []

afterEach(() => {
  for (const listener of listeners.splice(0)) {
    emitter.off('renderer-progressSet', listener)
  }
})

describe('missing analysis scan progress', () => {
  it('reports the initial state and each completed playlist before completion', () => {
    const events: ProgressEvent[] = []
    const listener = (payload: unknown) => events.push(payload as ProgressEvent)
    listeners.push(listener)
    emitter.on('renderer-progressSet', listener)

    const progress = createMissingAnalysisScanProgress(3)
    progress.markPlaylistScanned()
    progress.markPlaylistScanned()
    progress.complete()
    progress.markPlaylistScanned()

    expect(events).toHaveLength(4)
    expect(events[0]).toMatchObject({
      titleKey: 'tracks.scanningMissingAnalysisPlaylists',
      now: 0,
      total: 3,
      isInitial: true
    })
    expect(events[1]).toMatchObject({ id: events[0].id, now: 1, total: 3 })
    expect(events[2]).toMatchObject({ id: events[0].id, now: 2, total: 3 })
    expect(events[3]).toMatchObject({ id: events[0].id, now: 3, total: 3 })
  })

  it('removes an unfinished task when scanning fails', () => {
    const events: ProgressEvent[] = []
    const listener = (payload: unknown) => events.push(payload as ProgressEvent)
    listeners.push(listener)
    emitter.on('renderer-progressSet', listener)

    const progress = createMissingAnalysisScanProgress(1)
    progress.dismiss()
    progress.markPlaylistScanned()

    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ id: events[0].id, dismiss: true })
  })
})
