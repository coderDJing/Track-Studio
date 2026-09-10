import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { TracedEventListenerRegistry, type EventListenerFn } from './tracedEventListeners'

describe('TracedEventListenerRegistry', () => {
  it('removes a once listener by its original callback before it fires', () => {
    const emitter = new EventEmitter()
    const registry = new TracedEventListenerRegistry()
    const listener = vi.fn()
    const wrapped = registry.createOnce(
      'cloudSync/cancel',
      listener,
      (callback) => callback,
      (callback) => emitter.removeListener('cloudSync/cancel', callback)
    )
    emitter.on('cloudSync/cancel', wrapped)

    emitter.removeListener('cloudSync/cancel', registry.take('cloudSync/cancel', listener))

    expect(emitter.listenerCount('cloudSync/cancel')).toBe(0)
  })

  it('self-removes a once listener and invokes it only once', () => {
    const emitter = new EventEmitter()
    const registry = new TracedEventListenerRegistry()
    const listener = vi.fn()
    const wrapped = registry.createOnce(
      'cloudSync/cancel',
      listener,
      (callback) => callback,
      (callback) => emitter.removeListener('cloudSync/cancel', callback)
    )
    emitter.on('cloudSync/cancel', wrapped)

    emitter.emit('cloudSync/cancel')
    emitter.emit('cloudSync/cancel')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(emitter.listenerCount('cloudSync/cancel')).toBe(0)
    expect(registry.take('cloudSync/cancel', listener)).toBe(listener)
  })

  it('removes duplicate registrations in EventEmitter order', () => {
    const registry = new TracedEventListenerRegistry()
    const listener: EventListenerFn = () => undefined
    const first: EventListenerFn = () => 'first'
    const second: EventListenerFn = () => 'second'
    registry.remember('channel', listener, first)
    registry.remember('channel', listener, second)

    expect(registry.take('channel', listener)).toBe(second)
    expect(registry.take('channel', listener)).toBe(first)
  })
})
