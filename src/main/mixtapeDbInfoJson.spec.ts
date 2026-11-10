import { beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the transaction boundary without loading the Electron-only SQLite ABI.
const mocks = vi.hoisted(() => {
  const state = { rows: new Map<string, string>(), available: true, failWrite: false }
  const db = {
    prepare: () => ({
      all: (...ids: string[]) =>
        ids.filter((id) => state.rows.has(id)).map((id) => ({ id, info_json: state.rows.get(id) })),
      run: (info: string, id: string) => {
        if (state.failWrite) throw new Error('write failed')
        state.rows.set(id, info)
      }
    }),
    transaction: (fn: () => void) => () => {
      const before = new Map(state.rows)
      try {
        fn()
      } catch (error) {
        state.rows = before
        throw error
      }
    }
  }
  return { state, db }
})

vi.mock('./libraryDb', () => ({
  getLibraryDb: () => (mocks.state.available ? mocks.db : null),
  isSqliteRow: (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value)
}))
vi.mock('./log', () => ({ log: { error: vi.fn() } }))

import { upsertMixtapeItemGainEnvelopeById } from './mixtapeDbInfoJson'

const entry = (itemId: string, gain = 0.5) => ({
  itemId,
  gainEnvelope: [
    { sec: 0, gain },
    { sec: 10, gain }
  ]
})

beforeEach(() => {
  mocks.state.rows = new Map(['a', 'b'].map((id) => [id, JSON.stringify({ title: id })]))
  mocks.state.available = true
  mocks.state.failWrite = false
})

describe('strict project gain batch persistence', () => {
  it('saves every envelope, preserves metadata, and accepts an idempotent retry', () => {
    const entries = [entry('a'), entry('b')]
    expect(upsertMixtapeItemGainEnvelopeById(entries, { requireAll: true })).toEqual({ updated: 2 })
    expect(JSON.parse(mocks.state.rows.get('a')!)).toMatchObject({
      title: 'a',
      gainEnvelope: entry('a').gainEnvelope
    })
    expect(upsertMixtapeItemGainEnvelopeById(entries, { requireAll: true })).toEqual({ updated: 0 })
  })

  it('rolls back all earlier chunks when one track is missing', () => {
    const before = new Map(mocks.state.rows)
    const entries = [
      entry('a'),
      entry('b'),
      ...Array.from({ length: 300 }, (_, i) => entry(`missing-${i}`))
    ]
    expect(() => upsertMixtapeItemGainEnvelopeById(entries, { requireAll: true })).toThrow(
      'ITEMS_CHANGED'
    )
    expect(mocks.state.rows).toEqual(before)
  })

  it('rejects invalid entries before making any writes', () => {
    const before = new Map(mocks.state.rows)
    expect(() =>
      upsertMixtapeItemGainEnvelopeById([entry('a'), entry('')], { requireAll: true })
    ).toThrow('INVALID_ENTRIES')
    expect(mocks.state.rows).toEqual(before)
  })

  it('surfaces unavailable databases and failed writes in strict mode', () => {
    mocks.state.available = false
    expect(() => upsertMixtapeItemGainEnvelopeById([entry('a')], { requireAll: true })).toThrow(
      'DATABASE_UNAVAILABLE'
    )
    mocks.state.available = true
    mocks.state.failWrite = true
    expect(() => upsertMixtapeItemGainEnvelopeById([entry('a')], { requireAll: true })).toThrow(
      'write failed'
    )
  })

  it('retains the existing non-strict behavior for other callers', () => {
    expect(upsertMixtapeItemGainEnvelopeById([entry('a'), entry('missing')])).toEqual({
      updated: 1
    })
    mocks.state.available = false
    expect(upsertMixtapeItemGainEnvelopeById([entry('b')])).toEqual({ updated: 0 })
  })
})
