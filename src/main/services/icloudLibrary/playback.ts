import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  audioName,
  boundedPath,
  readMacResidency,
  requireLocal,
  type ResidencyReader
} from './files'

// Every Range request rechecks boundaries and residency: prepare-play alone is
// insufficient when macOS evicts a file or the folder changes during playback.
export class IcloudPlayback {
  private tickets = new Map<string, { root: string; relative: string; expires: number }>()
  constructor(private residency: ResidencyReader) {}
  clear() {
    this.tickets.clear()
  }
  holds(root: string, relative: string) {
    const now = Date.now()
    for (const ticket of this.tickets.values()) {
      if (ticket.expires >= now && ticket.root === root && ticket.relative === relative) return true
    }
    return false
  }
  revoke(root: string, relative: string) {
    for (const [id, ticket] of this.tickets) {
      if (ticket.root === root && ticket.relative === relative) this.tickets.delete(id)
    }
  }
  async issue(root: string, relative: string) {
    const file = await boundedPath(root, relative, this.residency)
    if (!audioName(path.basename(file)) || !(await fs.lstat(file)).isFile())
      throw new Error('invalid')
    await requireLocal(file, this.residency)
    const ticket = randomUUID()
    this.tickets.set(ticket, { root, relative, expires: Date.now() + 12 * 3600 * 1000 })
    while (this.tickets.size > 32) this.tickets.delete(this.tickets.keys().next().value!)
    return `frkb-preview://icloud/?path=${encodeURIComponent(file)}&ticket=${ticket}`
  }
  async validate(url: string, decodedPath: string) {
    const parsed = new URL(url)
    const ticket = this.tickets.get(parsed.searchParams.get('ticket') || '')
    if (!ticket || ticket.expires < Date.now()) throw new Error('unavailable')
    const file = await boundedPath(ticket.root, ticket.relative, this.residency)
    if (file !== decodedPath || parsed.hostname !== 'icloud') throw new Error('boundary')
    await requireLocal(file, this.residency)
  }
}
export const icloudPlayback = new IcloudPlayback(readMacResidency)
