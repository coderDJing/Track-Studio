import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import { useAnalysisRuntimeDownload } from '@renderer/composables/useAnalysisRuntimeDownload'
import LibraryStemSeparationDialog from './libraryStemSeparationDialog.vue'

type OpenLibraryStemSeparationDialogArgs = {
  filePath: string
  songTitle?: string
  initialSnapshot?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isInProgressSnapshot = (value: unknown) => {
  if (!isRecord(value)) return false
  return value.status === 'pending' || value.status === 'running'
}

let stemWorkbenchRuntimeGate: ReturnType<typeof useAnalysisRuntimeDownload> | null = null

const ensureStemWorkbenchAnalysisRuntime = async () => {
  if (!stemWorkbenchRuntimeGate) {
    stemWorkbenchRuntimeGate = useAnalysisRuntimeDownload({
      runtime: useRuntimeStore(),
      t,
      confirmDialog: confirm
    })
  }
  return await stemWorkbenchRuntimeGate.ensureAnalysisRuntimeForStemWorkbench()
}

export default async (args: OpenLibraryStemSeparationDialogArgs) => {
  if (!isInProgressSnapshot(args.initialSnapshot)) {
    const canOpen = await ensureStemWorkbenchAnalysisRuntime()
    if (!canOpen) return
  }
  return await new Promise<void>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const close = () => {
      render(null, container)
      container.remove()
      resolve()
    }
    const minimize = (snapshot: unknown) => {
      window.dispatchEvent(
        new CustomEvent('library-stem:minimized', {
          detail: { filePath: args.filePath, songTitle: args.songTitle || '', snapshot }
        })
      )
      close()
    }
    const vnode = createVNode(LibraryStemSeparationDialog, {
      filePath: args.filePath,
      songTitle: args.songTitle || '',
      initialSnapshot: args.initialSnapshot,
      onClose: close,
      onMinimize: minimize
    })
    attachAppContext(vnode)
    render(vnode, container)
  })
}
