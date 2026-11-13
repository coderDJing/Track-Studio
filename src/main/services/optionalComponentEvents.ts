import { EventEmitter } from 'node:events'
import type {
  OptionalComponentDownloadState,
  OptionalComponentId
} from '../../shared/optionalComponentDownloads'

export const optionalComponentEvents = new EventEmitter()

const states = new Map<OptionalComponentId, OptionalComponentDownloadState>()

export const publishOptionalComponentState = (
  state: Omit<OptionalComponentDownloadState, 'updatedAt'>
) => {
  const next: OptionalComponentDownloadState = {
    ...state,
    percent: Math.max(0, Math.min(100, state.percent)),
    updatedAt: Date.now()
  }
  states.set(state.id, next)
  optionalComponentEvents.emit('state', { ...next })
}

export const getOptionalComponentStates = (): OptionalComponentDownloadState[] =>
  [...states.values()].map((state) => ({ ...state }))
