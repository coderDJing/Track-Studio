import rekordboxDesktopStorageDirDialog from '@renderer/components/rekordboxDesktopStorageDirDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type {
  RekordboxDesktopCopyTracksToStorageResponse,
  RekordboxDesktopPlaylistTrackInput
} from '@shared/rekordboxDesktopPlaylist'

export const ensureRekordboxDesktopStorageDirConfigured = async () => {
  const runtime = useRuntimeStore()
  const current = String(runtime.setting.rekordboxDesktopTrackStorageDir || '').trim()
  if (current) return current

  const result = await rekordboxDesktopStorageDirDialog({ storageKind: 'rekordbox' })
  if (result === 'cancel') return ''
  const nextDir = String(result || '').trim()
  if (!nextDir) return ''

  runtime.setting.rekordboxDesktopTrackStorageDir = nextDir
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  return nextDir
}

export const copyTracksToStorage = async (params: {
  targetRootDir: string
  tracks: RekordboxDesktopPlaylistTrackInput[]
}) =>
  (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('desktop', 'copy-tracks-to-storage'),
    {
      targetRootDir: params.targetRootDir,
      tracks: params.tracks
    }
  )) as RekordboxDesktopCopyTracksToStorageResponse

export const ensureSeratoTrackStorageDirConfigured = async () => {
  const runtime = useRuntimeStore()
  const current = String(runtime.setting.seratoTrackStorageDir || '').trim()
  if (current) return current

  const result = await rekordboxDesktopStorageDirDialog({ storageKind: 'serato' })
  if (result === 'cancel') return ''
  const nextDir = String(result || '').trim()
  if (!nextDir) return ''

  runtime.setting.seratoTrackStorageDir = nextDir
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  return nextDir
}
