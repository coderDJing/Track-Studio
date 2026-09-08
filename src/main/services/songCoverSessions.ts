export type SongCoverSessionContext = {
  clientKey?: unknown
  generation?: unknown
  priority?: unknown
}

export type SongCoverSession = {
  key: string
  generation: number
}

export class SongCoverSessionRegistry {
  private readonly latestGeneration = new Map<string, number>()

  activate(senderId: number, context?: SongCoverSessionContext): SongCoverSession | null {
    const session = this.resolve(senderId, context)
    if (!session) return null
    this.advance(session.key, session.generation)
    return session
  }

  cancel(senderId: number, context?: SongCoverSessionContext): SongCoverSession | null {
    const session = this.resolve(senderId, context)
    if (!session) return null
    this.advance(session.key, session.generation + 1)
    return session
  }

  isStale(session: SongCoverSession): boolean {
    return (this.latestGeneration.get(session.key) || 0) > session.generation
  }

  clearSender(senderId: number) {
    const prefix = `${senderId}:`
    for (const key of this.latestGeneration.keys()) {
      if (key.startsWith(prefix)) this.latestGeneration.delete(key)
    }
  }

  private resolve(senderId: number, context?: SongCoverSessionContext): SongCoverSession | null {
    const clientKey = typeof context?.clientKey === 'string' ? context.clientKey.trim() : ''
    const generation = Number(context?.generation)
    if (!clientKey || !Number.isSafeInteger(generation) || generation <= 0) return null
    return { key: `${senderId}:${clientKey}`, generation }
  }

  private advance(key: string, generation: number) {
    const current = this.latestGeneration.get(key) || 0
    if (generation > current) this.latestGeneration.set(key, generation)
  }
}
