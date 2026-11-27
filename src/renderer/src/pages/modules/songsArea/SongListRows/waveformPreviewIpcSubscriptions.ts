import type { IPioneerPreviewWaveformData } from '../../../../../../types/globals'
import {
  getRekordboxPreviewWaveformDoneEventChannel,
  getRekordboxPreviewWaveformItemEventChannel
} from '@renderer/utils/rekordboxExternalSource'

export type WaveformUpdatedPayload = { filePath?: string }
type PioneerPreviewWaveformItemPayload = {
  requestId?: string
  analyzePath?: string
  data?: IPioneerPreviewWaveformData | null
  error?: string
}
type PioneerPreviewWaveformDonePayload = {
  requestId?: string
  error?: string
}

export type WaveformUpdatedHandler = (_event: unknown, payload: WaveformUpdatedPayload) => void
export type PioneerPreviewWaveformItemHandler = (
  _event: unknown,
  payload: PioneerPreviewWaveformItemPayload
) => void
export type PioneerPreviewWaveformDoneHandler = (
  _event: unknown,
  payload: PioneerPreviewWaveformDonePayload
) => void

const waveformUpdatedSubscribers = new Set<WaveformUpdatedHandler>()
const pioneerPreviewWaveformItemSubscribers = new Set<PioneerPreviewWaveformItemHandler>()
const pioneerPreviewWaveformDoneSubscribers = new Set<PioneerPreviewWaveformDoneHandler>()
let waveformIpcListenersBound = false

const globalHandleWaveformUpdated = (_event: unknown, payload: WaveformUpdatedPayload) => {
  for (const handler of waveformUpdatedSubscribers) {
    handler(_event, payload)
  }
}

const globalHandlePioneerPreviewWaveformItem = (
  _event: unknown,
  payload: PioneerPreviewWaveformItemPayload
) => {
  for (const handler of pioneerPreviewWaveformItemSubscribers) {
    handler(_event, payload)
  }
}

const globalHandlePioneerPreviewWaveformDone = (
  _event: unknown,
  payload: PioneerPreviewWaveformDonePayload
) => {
  for (const handler of pioneerPreviewWaveformDoneSubscribers) {
    handler(_event, payload)
  }
}

const bindWaveformIpcListeners = () => {
  if (waveformIpcListenersBound) return
  if (typeof window === 'undefined' || !window.electron?.ipcRenderer) return
  window.electron.ipcRenderer.on('song-waveform-updated', globalHandleWaveformUpdated)
  for (const sourceKind of ['usb', 'desktop'] as const) {
    window.electron.ipcRenderer.on(
      getRekordboxPreviewWaveformItemEventChannel(sourceKind),
      globalHandlePioneerPreviewWaveformItem
    )
    window.electron.ipcRenderer.on(
      getRekordboxPreviewWaveformDoneEventChannel(sourceKind),
      globalHandlePioneerPreviewWaveformDone
    )
  }
  waveformIpcListenersBound = true
}

const unbindWaveformIpcListenersIfIdle = () => {
  if (!waveformIpcListenersBound) return
  if (
    waveformUpdatedSubscribers.size > 0 ||
    pioneerPreviewWaveformItemSubscribers.size > 0 ||
    pioneerPreviewWaveformDoneSubscribers.size > 0
  ) {
    return
  }
  if (typeof window === 'undefined' || !window.electron?.ipcRenderer) return
  window.electron.ipcRenderer.removeListener('song-waveform-updated', globalHandleWaveformUpdated)
  for (const sourceKind of ['usb', 'desktop'] as const) {
    window.electron.ipcRenderer.removeListener(
      getRekordboxPreviewWaveformItemEventChannel(sourceKind),
      globalHandlePioneerPreviewWaveformItem
    )
    window.electron.ipcRenderer.removeListener(
      getRekordboxPreviewWaveformDoneEventChannel(sourceKind),
      globalHandlePioneerPreviewWaveformDone
    )
  }
  waveformIpcListenersBound = false
}

export const subscribeWaveformUpdated = (handler: WaveformUpdatedHandler) => {
  waveformUpdatedSubscribers.add(handler)
  bindWaveformIpcListeners()
  return () => {
    waveformUpdatedSubscribers.delete(handler)
    unbindWaveformIpcListenersIfIdle()
  }
}

export const subscribePioneerPreviewWaveformItem = (handler: PioneerPreviewWaveformItemHandler) => {
  pioneerPreviewWaveformItemSubscribers.add(handler)
  bindWaveformIpcListeners()
  return () => {
    pioneerPreviewWaveformItemSubscribers.delete(handler)
    unbindWaveformIpcListenersIfIdle()
  }
}

export const subscribePioneerPreviewWaveformDone = (handler: PioneerPreviewWaveformDoneHandler) => {
  pioneerPreviewWaveformDoneSubscribers.add(handler)
  bindWaveformIpcListeners()
  return () => {
    pioneerPreviewWaveformDoneSubscribers.delete(handler)
    unbindWaveformIpcListenersIfIdle()
  }
}

export const notifyWaveformUpdated = (filePath: string) => {
  const path = String(filePath || '').trim()
  if (!path) return
  globalHandleWaveformUpdated(null, { filePath: path })
}
