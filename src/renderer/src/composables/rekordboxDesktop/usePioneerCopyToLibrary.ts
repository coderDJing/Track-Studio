import confirm from '@renderer/components/confirmDialog'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { notifyFilterLibraryReceivedSongs } from '@renderer/composables/userGuideBridge'
import {
  copySongCueDefinitionsToTargets,
  type SongCueCopyEntry,
  type SongCueCopySummary
} from '@renderer/utils/songCueTransfer'
import { loadRekordboxPlaylistTracks } from '@renderer/composables/rekordboxDesktop/useRekordboxTrackLoader'
import { v4 as uuidV4 } from 'uuid'
import { getPlaylistNodeDisplayName } from '@renderer/composables/rekordboxDesktop/playlistNodeDisplayName'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type {
  IDir,
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode
} from '../../../../types/globals'

type PioneerCopyTargetLibrary = 'FilterLibrary' | 'CuratedLibrary'

type RuntimeStore = ReturnType<typeof useRuntimeStore>
type RunWithCopyBusy = <T>(task: () => Promise<T>) => Promise<T>

interface CopyPioneerNodeToLibraryOptions {
  node: IPioneerPlaylistTreeNode
  sourceKind: RekordboxSourceKind
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
  targetLibrary: PioneerCopyTargetLibrary
  runtime: RuntimeStore
  runWithCopyBusy: RunWithCopyBusy
  isBusy: () => boolean
}

type CopyPlanNode = {
  source: IPioneerPlaylistTreeNode
  type: 'dir' | 'songList'
  children?: CopyPlanNode[]
}

type StagedLibraryNode = IDir & {
  sourcePlaylistId?: number
  sourcePlaylistName?: string
  targetPath: string
  copied?: boolean
  children?: StagedLibraryNode[]
}

type StagedPlaylistCopyResult = {
  copied: boolean
  cueEntries: SongCueCopyEntry[]
}

const INVALID_LIBRARY_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

const normalizeLocalLibraryName = (value: string, fallback: string) => {
  const cleaned = String(value || '')
    .replace(INVALID_LIBRARY_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const resolved = cleaned || fallback
  return WINDOWS_RESERVED_NAMES.has(resolved.toUpperCase()) ? `${resolved}_` : resolved
}

const findUniqueChildName = (parent: { children?: IDir[] }, baseName: string) => {
  const existingNames = new Set(
    (parent.children || [])
      .map((child) =>
        String(child.dirName || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  )
  if (!existingNames.has(baseName.toLowerCase())) return baseName

  let counter = 1
  let uniqueName = `${baseName}(${counter})`
  while (existingNames.has(uniqueName.toLowerCase())) {
    counter++
    uniqueName = `${baseName}(${counter})`
  }
  return uniqueName
}

const buildCopyPlan = (node: IPioneerPlaylistTreeNode): CopyPlanNode | null => {
  if (node.isSmartPlaylist) return null
  if (!node.isFolder) {
    return {
      source: node,
      type: 'songList'
    }
  }

  const children = (Array.isArray(node.children) ? node.children : [])
    .map(buildCopyPlan)
    .filter((item): item is CopyPlanNode => item !== null)
  if (!children.length) return null
  return {
    source: node,
    type: 'dir',
    children
  }
}

const countPlaylists = (node: CopyPlanNode): number => {
  if (node.type === 'songList') return 1
  return (node.children || []).reduce((count, child) => count + countPlaylists(child), 0)
}

const stageCopyPlan = (
  plan: CopyPlanNode,
  parent: { children?: IDir[] },
  parentPath: string
): StagedLibraryNode => {
  const fallbackName = plan.type === 'dir' ? 'Folder' : 'Playlist'
  const baseName = normalizeLocalLibraryName(getPlaylistNodeDisplayName(plan.source), fallbackName)
  const uniqueName = findUniqueChildName(parent, baseName)
  const staged: StagedLibraryNode = {
    uuid: uuidV4(),
    type: plan.type,
    dirName: uniqueName,
    order: (parent.children || []).length + 1,
    children: [],
    targetPath: `${parentPath}/${uniqueName}`
  }

  parent.children = parent.children || []
  parent.children.push(staged)

  if (plan.type === 'songList') {
    staged.sourcePlaylistId = plan.source.id
    staged.sourcePlaylistName = plan.source.name
    return staged
  }

  for (const child of plan.children || []) {
    stageCopyPlan(child, staged, staged.targetPath)
  }
  return staged
}

const flattenStagedPlaylists = (nodes: StagedLibraryNode[]) => {
  const playlists: StagedLibraryNode[] = []
  const walk = (items: StagedLibraryNode[]) => {
    for (const item of items) {
      if (item.type === 'songList') {
        playlists.push(item)
        continue
      }
      walk(item.children || [])
    }
  }
  walk(nodes)
  return playlists
}

const pruneUncopiedNodes = (nodes: StagedLibraryNode[]): IDir[] =>
  nodes
    .map((node): IDir | null => {
      if (node.type === 'songList') {
        return node.copied
          ? {
              uuid: node.uuid,
              type: node.type,
              dirName: node.dirName,
              order: node.order,
              children: []
            }
          : null
      }

      const children = pruneUncopiedNodes(node.children || []).map((child, index) => ({
        ...child,
        order: index + 1
      }))
      if (!children.length) return null
      return {
        uuid: node.uuid,
        type: node.type,
        dirName: node.dirName,
        order: node.order,
        children
      }
    })
    .filter((node): node is IDir => node !== null)

const filterExistingTracks = async (tracks: IPioneerPlaylistTrack[]) => {
  const filePaths = tracks
    .map((track) => String(track.filePath || '').trim())
    .filter((filePath) => filePath.length > 0)
  if (!filePaths.length) return []

  const existsMap = (await window.electron.ipcRenderer.invoke(
    'check-paths-exist',
    filePaths
  )) as Record<string, boolean>
  return tracks.filter((track) => {
    const filePath = String(track.filePath || '').trim()
    return filePath.length > 0 && Boolean(existsMap[filePath])
  })
}

const loadPlaylistTracks = async ({
  sourceKind,
  playlistId,
  sourceRootPath,
  sourceLibraryType
}: {
  sourceKind: RekordboxSourceKind
  playlistId: number
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
}) => loadRekordboxPlaylistTracks({ sourceKind, playlistId, sourceRootPath, sourceLibraryType })

const copyStagedPlaylist = async ({
  playlist,
  sourceKind,
  sourceRootPath,
  sourceLibraryType,
  targetLibrary
}: {
  playlist: StagedLibraryNode
  sourceKind: RekordboxSourceKind
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
  targetLibrary: PioneerCopyTargetLibrary
}): Promise<StagedPlaylistCopyResult> => {
  const playlistId = Number(playlist.sourcePlaylistId) || 0
  if (playlistId <= 0) return { copied: false, cueEntries: [] }

  const loadResult = await loadPlaylistTracks({
    sourceKind,
    playlistId,
    sourceRootPath,
    sourceLibraryType
  })

  const tracks = await filterExistingTracks(
    Array.isArray(loadResult?.tracks) ? loadResult.tracks : []
  )
  if (!tracks.length) return { copied: false, cueEntries: [] }

  const copiedPaths = (await window.electron.ipcRenderer.invoke(
    'moveSongsToDir',
    tracks.map((track) => String(track.filePath || '').trim()),
    playlist.targetPath,
    {
      mode: 'copy',
      curatedArtistNames:
        targetLibrary === 'CuratedLibrary' ? tracks.map((track) => track.artist || '') : []
    }
  )) as string[]

  playlist.copied = true
  return {
    copied: true,
    cueEntries: copiedPaths.map((targetFilePath, index) => ({
      targetFilePath,
      sourceSong: tracks[index]
    }))
  }
}

const hasIncompleteCueCopy = (summary: SongCueCopySummary) =>
  summary.hotCueUpdated < summary.hotCueTargetCount ||
  summary.memoryCueUpdated < summary.memoryCueTargetCount

export const copyPioneerNodeToLibrary = async ({
  node,
  sourceKind,
  sourceRootPath,
  sourceLibraryType,
  targetLibrary,
  runtime,
  runWithCopyBusy,
  isBusy
}: CopyPioneerNodeToLibraryOptions) => {
  if (isBusy()) return

  const plan = buildCopyPlan(node)
  if (!plan) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('pioneer.noPlaylistsToCopy')],
      confirmShow: false
    })
    return
  }

  const playlistCount = countPlaylists(plan)
  const targetDisplayName =
    targetLibrary === 'FilterLibrary' ? t('library.filter') : t('library.curated')
  const sourceName = getPlaylistNodeDisplayName(node).trim()
  const confirmMessage =
    plan.type === 'songList'
      ? t('pioneer.copySinglePlaylistConfirm', {
          name: sourceName,
          target: targetDisplayName
        })
      : t('pioneer.copyFolderToLibraryConfirm', {
          name: sourceName,
          target: targetDisplayName,
          count: playlistCount
        })
  const confirmResult = await confirm({
    title: t('pioneer.copyToLibraryTitle'),
    content: [confirmMessage]
  })
  if (confirmResult !== 'confirm') return

  await runWithCopyBusy(async () => {
    try {
      const targetLibraryNode = runtime.libraryTree.children?.find(
        (child) => child.dirName === targetLibrary
      )
      if (!targetLibraryNode) {
        throw new Error(`Target library ${targetLibrary} not found`)
      }

      const shadowTargetNode: IDir = {
        ...targetLibraryNode,
        children: [...(targetLibraryNode.children || [])]
      }
      const stagedRoot = stageCopyPlan(plan, shadowTargetNode, `library/${targetLibrary}`)
      const stagedRoots = [stagedRoot]
      const stagedPlaylists = flattenStagedPlaylists(stagedRoots)
      let totalCopied = 0
      let totalFailed = 0
      let cueCopyIncomplete = false
      const pendingCueEntries: SongCueCopyEntry[] = []

      for (const playlist of stagedPlaylists) {
        try {
          const result = await copyStagedPlaylist({
            playlist,
            sourceKind,
            sourceRootPath,
            sourceLibraryType,
            targetLibrary
          })
          if (result.copied) {
            totalCopied++
            pendingCueEntries.push(...result.cueEntries)
          } else {
            totalFailed++
          }
        } catch {
          totalFailed++
        }
      }

      const copiedNodes = pruneUncopiedNodes(stagedRoots)
      if (copiedNodes.length > 0) {
        targetLibraryNode.children = targetLibraryNode.children || []
        targetLibraryNode.children.push(...copiedNodes)
        const success = await libraryUtils.diffLibraryTreeExecuteFileOperation()
        if (!success) throw new Error('copy playlist tree failed')
        const cueCopySummary = await copySongCueDefinitionsToTargets(pendingCueEntries)
        emitter.emit('playlistContentChanged', {
          uuids: flattenStagedPlaylists(stagedRoots)
            .filter((playlist) => playlist.copied)
            .map((playlist) => playlist.uuid)
        })
        if (hasIncompleteCueCopy(cueCopySummary)) {
          cueCopyIncomplete = true
        }
      }

      await confirm({
        title: t('pioneer.copyToLibraryFinished'),
        content: [
          t('pioneer.copyToLibrarySuccessCount', { count: totalCopied }),
          ...(totalFailed > 0
            ? [t('pioneer.copyToLibraryFailedCount', { count: totalFailed })]
            : []),
          ...(cueCopyIncomplete ? [t('pioneer.copyCueDefinitionsIncomplete')] : [])
        ],
        confirmShow: false
      })
      if (targetLibrary === 'FilterLibrary' && totalCopied > 0) {
        notifyFilterLibraryReceivedSongs()
      }
    } catch (error: unknown) {
      await confirm({
        title: t('common.error'),
        content: [error instanceof Error ? error.message : String(error)],
        confirmShow: false
      })
    }
  })
}
