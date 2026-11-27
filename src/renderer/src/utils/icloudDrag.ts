import { ICLOUD_DRAG_MIME, parseIcloudDragPayload } from '@shared/icloudLibrary'
import { openIcloudExport, copyIcloudDropToLocal } from './icloudLibrary'

export { ICLOUD_DRAG_MIME, parseIcloudDragPayload }
export function dropLocalSongsOnIcloud(
  event: DragEvent,
  fallbackPaths: string[],
  directory?: string,
  rootToken?: string
) {
  const raw = event.dataTransfer?.getData('application/x-song-drag')
  if (!raw || raw.length > 1024 * 1024) return false
  try {
    const value = JSON.parse(raw) as { sourceSongListUUID?: unknown; paths?: unknown }
    if (typeof value.sourceSongListUUID !== 'string' || !value.sourceSongListUUID) return false
    const paths = Array.isArray(value.paths) ? value.paths : fallbackPaths
    if (
      !paths.length ||
      paths.length > 100000 ||
      paths.some((file) => typeof file !== 'string' || !file)
    )
      return false
    event.preventDefault()
    event.stopPropagation()
    if (directory === undefined) openIcloudExport(value.sourceSongListUUID, paths as string[])
    else openIcloudExport(value.sourceSongListUUID, paths as string[], directory, rootToken)
    return true
  } catch {
    return false
  }
}
export async function dropIcloudOnPlaylist(
  event: DragEvent,
  targetUuid: string,
  targetType: string,
  libraryName: string
) {
  if (!event.dataTransfer?.types.includes(ICLOUD_DRAG_MIME)) return false
  event.preventDefault()
  event.stopPropagation()
  if (targetType !== 'songList' || !['FilterLibrary', 'CuratedLibrary'].includes(libraryName))
    return true
  const payload = parseIcloudDragPayload(event.dataTransfer.getData(ICLOUD_DRAG_MIME))
  if (payload) await copyIcloudDropToLocal(targetUuid, payload)
  return true
}
