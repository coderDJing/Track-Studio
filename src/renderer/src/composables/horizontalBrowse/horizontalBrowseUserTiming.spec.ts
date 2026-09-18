import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHorizontalBrowseUserTiming } from './horizontalBrowseUserTiming'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startHorizontalBrowseUserTiming', () => {
  it('clears its measure after recording it so repeated render work cannot retain entries', () => {
    const mark = vi.spyOn(performance, 'mark')
    const measure = vi.spyOn(performance, 'measure')
    const clearMeasures = vi.spyOn(performance, 'clearMeasures')

    const finish = startHorizontalBrowseUserTiming('frkb:hb:test')
    finish()

    expect(mark).toHaveBeenCalledTimes(2)
    expect(measure).toHaveBeenCalledWith('frkb:hb:test', expect.any(String), expect.any(String))
    expect(clearMeasures).toHaveBeenCalledWith('frkb:hb:test')
  })
})
