import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { createVNode, render, reactive, shallowRef, ref } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import confirm from '@renderer/components/confirmDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { useAnalysisRuntimeDownload } from '@renderer/composables/useAnalysisRuntimeDownload'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import type { BpmFixOptions, BpmFixSnapshot, BpmFixStart, BpmFixTrackOptions } from '@shared/bpmFix'
import pkg from '../../../../package.json'

export const bpmFixSnapshot = shallowRef<BpmFixSnapshot | null>(null)
export const bpmFixDialogOpen = ref(false)
export const bpmFixFocusedId = ref('')
export const bpmFixDraft = reactive<{
  saveMode: BpmFixOptions['saveMode']
  format: BpmFixOptions['format']
  tracks: Record<string, BpmFixTrackOptions>
}>({ saveMode: 'copy', format: 'wav', tracks: {} })
let runtimeGate: ReturnType<typeof useAnalysisRuntimeDownload> | undefined
let initialized = false
let opening = false
const applySnapshot = (snapshot: BpmFixSnapshot | null) => {
  if (snapshot && snapshot.id !== bpmFixSnapshot.value?.id) {
    bpmFixDraft.saveMode = 'copy'
    bpmFixDraft.format = 'wav'
    bpmFixDraft.tracks = {}
    bpmFixFocusedId.value = ''
  }
  bpmFixSnapshot.value = snapshot
  for (const track of snapshot?.tracks || []) {
    if (!track.analysis || bpmFixDraft.tracks[track.id]) continue
    bpmFixDraft.tracks[track.id] = {
      id: track.id,
      enabled:
        track.status === 'ready' &&
        track.analysis.confidence >= 0.5 &&
        !track.analysis.tempoAmbiguous,
      tempoFactor: 1,
      targetBpm: null,
      allowLowConfidence: false
    }
  }
}
export const initializeBpmFix = () => {
  if (initialized) return
  initialized = true
  window.electron.ipcRenderer.on('audio:bpm-fix:updated', (_event, value: BpmFixSnapshot) =>
    applySnapshot(value)
  )
  window.electron.ipcRenderer.on(
    'audio:bpm-fix:files-changed',
    (
      _event,
      value: {
        playlistUuids: string[]
        sourcePath: string
        outputPath: string
        overwritten: boolean
      }
    ) => {
      emitter.emit('playlistContentChanged', { uuids: value.playlistUuids })
      if (value.overwritten) {
        const runtime = useRuntimeStore()
        if (sameRendererFilePath(runtime.playingData.playingSong?.filePath, value.sourcePath)) {
          emitter.emit('waveform-preview:stop', { reason: 'switch' })
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          runtime.playingData.playingSongListData = []
        }
      }
    }
  )
  void window.electron.ipcRenderer.invoke('audio:bpm-fix:snapshot').then(applySnapshot)
}
export const bpmFixErrorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const known = [
    ['BPM_FIX_RECOVERY_REQUIRED', 'recoveryRequired'],
    ['BPM_FIX_LIBROSA_UNAVAILABLE', 'librosaUnavailable'],
    ['BPM_FIX_LOW_CONFIDENCE', 'lowConfidence'],
    ['BPM_FIX_NOT_ENOUGH_BEATS', 'lowConfidence'],
    ['BPM_FIX_UNRELIABLE_BEATS', 'lowConfidence'],
    ['BPM_FIX_VERIFICATION_FAILED', 'verificationFailed'],
    ['BPM_FIX_SOURCE_CHANGED', 'sourceChanged'],
    ['BPM_FIX_EXTREME_STRETCH', 'extremeStretch'],
    ['BPM_FIX_UNSUPPORTED_FORMAT', 'unsupportedFormat'],
    ['BPM_FIX_INVALID_PLAYLIST', 'invalidPlaylist'],
    ['BPM_FIX_RUNTIME_UNAVAILABLE', 'runtimeHint'],
    ['BPM_FIX_CHECKPOINT_UNAVAILABLE', 'runtimeHint'],
    ['BPM_FIX_R3_UNAVAILABLE', 'rendererUnavailable'],
    ['BPM_FIX_BUSY', 'busy'],
    ['EEXIST', 'outputExists'],
    ['BPM_FIX_NO_SELECTION', 'noSelection'],
    ['BPM_FIX_INVALID_OPTIONS', 'invalidOptions'],
    ['LIBRARY_MERGE_IN_PROGRESS', 'libraryBusy']
  ].find(([code]) => message.includes(code))
  return t(`bpmFix.${known?.[1] || 'failedHint'}`)
}
export const restoreBpmFix = async () => {
  if (bpmFixDialogOpen.value || opening) return
  opening = true
  try {
    const snapshot = (await window.electron.ipcRenderer.invoke(
      'audio:bpm-fix:snapshot'
    )) as BpmFixSnapshot | null
    applySnapshot(snapshot)
    if (!snapshot) return
    const { default: BpmFixDialog } = await import('@renderer/components/BpmFixDialog.vue')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const unmount = () => {
      render(null, container)
      container.remove()
      bpmFixDialogOpen.value = false
    }
    const close = async () => {
      await window.electron.ipcRenderer.invoke('audio:bpm-fix:close', snapshot.id)
      applySnapshot(null)
      unmount()
    }
    const vnode = createVNode(BpmFixDialog, { onClose: close, onMinimize: unmount })
    attachAppContext(vnode)
    bpmFixDialogOpen.value = true
    render(vnode, container)
  } finally {
    opening = false
  }
}
export const repairBpmFix = async () => {
  const snapshot = bpmFixSnapshot.value
  if (!snapshot) return
  const options: BpmFixOptions = {
    saveMode: bpmFixDraft.saveMode,
    format: bpmFixDraft.format,
    tracks: snapshot.tracks.map((track) => ({
      ...(bpmFixDraft.tracks[track.id] || {
        id: track.id,
        enabled: false,
        tempoFactor: 1,
        targetBpm: null,
        allowLowConfidence: false
      })
    }))
  }
  applySnapshot(
    await window.electron.ipcRenderer.invoke('audio:bpm-fix:repair', snapshot.id, options)
  )
}
export const analyzeBpmFix = async () => {
  const snapshot = bpmFixSnapshot.value
  if (!snapshot || snapshot.status !== 'pending') return
  runtimeGate ??= useAnalysisRuntimeDownload({
    runtime: useRuntimeStore(),
    t,
    confirmDialog: confirm,
    appVersion: String(pkg.version)
  })
  if (!(await runtimeGate.ensureAnalysisRuntimeForBpmFix())) return
  if (bpmFixSnapshot.value?.id !== snapshot.id) return
  applySnapshot(await window.electron.ipcRenderer.invoke('audio:bpm-fix:analyze', snapshot.id))
}
export const startBpmFix = async (input: BpmFixStart) => {
  initializeBpmFix()
  if (bpmFixSnapshot.value) {
    await restoreBpmFix()
    return
  }
  try {
    applySnapshot(await window.electron.ipcRenderer.invoke('audio:bpm-fix:prepare', input))
    await restoreBpmFix()
  } catch (error) {
    await confirm({
      title: t('bpmFix.failed'),
      content: [bpmFixErrorText(error)],
      confirmShow: false,
      innerHeight: 0,
      textAlign: 'left'
    })
  }
}
