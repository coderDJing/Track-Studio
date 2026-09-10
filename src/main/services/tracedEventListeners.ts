export type EventListenerFn = (...args: unknown[]) => unknown

export class TracedEventListenerRegistry {
  private readonly wrappedListeners = new Map<string, WeakMap<EventListenerFn, EventListenerFn[]>>()

  remember(channel: string, listener: EventListenerFn, wrapped: EventListenerFn): EventListenerFn {
    let byListener = this.wrappedListeners.get(channel)
    if (!byListener) {
      byListener = new WeakMap<EventListenerFn, EventListenerFn[]>()
      this.wrappedListeners.set(channel, byListener)
    }
    const registrations = byListener.get(listener)
    if (registrations) registrations.push(wrapped)
    else byListener.set(listener, [wrapped])
    return wrapped
  }

  createAndRemember(
    channel: string,
    listener: EventListenerFn,
    wrap: (listener: EventListenerFn) => EventListenerFn
  ): EventListenerFn {
    return this.remember(channel, listener, wrap(listener))
  }

  createOnce(
    channel: string,
    listener: EventListenerFn,
    wrap: (listener: EventListenerFn) => EventListenerFn,
    remove: (wrapped: EventListenerFn) => void
  ): EventListenerFn {
    const traced = wrap(listener)
    const onceWrapped: EventListenerFn = (...args) => {
      this.forget(channel, listener, onceWrapped)
      remove(onceWrapped)
      return traced(...args)
    }
    return this.remember(channel, listener, onceWrapped)
  }

  take(channel: string, listener: EventListenerFn): EventListenerFn {
    const byListener = this.wrappedListeners.get(channel)
    const registrations = byListener?.get(listener)
    const wrapped = registrations?.pop()
    if (registrations?.length === 0) byListener?.delete(listener)
    return wrapped || listener
  }

  private forget(channel: string, listener: EventListenerFn, wrapped: EventListenerFn): void {
    const byListener = this.wrappedListeners.get(channel)
    const registrations = byListener?.get(listener)
    if (!registrations) return
    const index = registrations.lastIndexOf(wrapped)
    if (index >= 0) registrations.splice(index, 1)
    if (registrations.length === 0) byListener?.delete(listener)
  }
}
