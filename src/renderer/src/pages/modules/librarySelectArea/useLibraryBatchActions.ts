import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '@renderer/components/rightClickMenu'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import { createMissingAnalysisScanProgress } from '@renderer/utils/missingAnalysisScanProgress'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import {
  fetchAcoustIdClientKeyStatus,
  hasConfiguredAcoustIdClientKey
} from '@renderer/utils/acoustid'
import {
  collectFilesForAudioConvert,
  startAudioConvertFromFiles
} from '@renderer/utils/audioConvertActions'
import {
  promptAndQueueManualKeyAnalysisBatch,
  scanSongListsForMissingAnalysisFiles
} from '@renderer/utils/manualKeyAnalysis'
import { emptyRecycleBinWithOptimisticUpdate } from '@renderer/utils/recycleBinActions'
import { collectSongsForSimilarBatch } from '@renderer/components/libraryItem/libraryContextMenuHelpers'
import { openBatchSimilarTracksDialogForSeeds } from '@renderer/utils/similarTracksActions'
import type { Icon, IDir, IMetadataAutoFillSummary } from '../../../../../types/globals'

type RuntimeStore = ReturnType<typeof import('@renderer/stores/runtime').useRuntimeStore>

type ScanSongListResult = {
  scanData?: Array<{ filePath?: string }>
}

type SongListScanRequest = {
  songListPath: string | string[]
  songListUUID: string
}

/**
 * 库级批量操作与右键菜单逻辑（自动填充元数据、补析缺失分析、批量转 MP3、相似曲目、清空回收站）。
 * 从 librarySelectArea.vue 抽出，依赖通过参数注入，保持原有职责与行为不变。
 */
export function useLibraryBatchActions(options: {
  runtime: RuntimeStore
  findLibraryNode: (libraryName: string) => IDir | undefined
}) {
  const { runtime, findLibraryNode } = options
  const hasWarnedAcoustId = ref(false)

  const hasAcoustIdKey = async () => {
    if (hasConfiguredAcoustIdClientKey(runtime.setting)) return true
    const status = await fetchAcoustIdClientKeyStatus()
    return status.hasEffectiveKey
  }

  const warnAcoustIdMissing = () => {
    if (hasWarnedAcoustId.value) return
    void (async () => {
      if (await hasAcoustIdKey()) return
      hasWarnedAcoustId.value = true
      void confirm({
        title: t('metadata.autoFillFingerprintHintTitle'),
        content: [
          t('metadata.autoFillFingerprintHintMissing'),
          t('metadata.autoFillFingerprintHintGuide')
        ],
        confirmShow: false
      })
    })()
  }

  const collectSongLists = (root?: IDir | null): IDir[] => {
    const result: IDir[] = []
    const traverse = (node?: IDir | null) => {
      if (!node) return
      if (node.type === 'songList') {
        result.push(node)
      }
      if (Array.isArray(node.children)) {
        node.children.forEach((child) => traverse(child as IDir))
      }
    }
    traverse(root)
    return result
  }

  const scanSongListsFiles = async (songLists: IDir[]) => {
    const files: string[] = []
    for (const list of songLists) {
      try {
        const dirPath = libraryUtils.findDirPathByUuid(list.uuid)
        const scan = (await window.electron.ipcRenderer.invoke(
          'scanSongList',
          dirPath,
          list.uuid
        )) as ScanSongListResult | null
        const songFiles = Array.isArray(scan?.scanData)
          ? scan.scanData.map((s) => s.filePath).filter((item): item is string => !!item)
          : []
        files.push(...songFiles)
      } catch (error) {
        console.error('[librarySelectArea] scanSongList failed', error)
      }
    }
    return Array.from(new Set(files))
  }

  const buildSongListScanRequests = (songLists: IDir[]): SongListScanRequest[] =>
    songLists.map((list) => ({
      songListPath: libraryUtils.findDirPathByUuid(list.uuid),
      songListUUID: list.uuid
    }))

  const handleAutoFillForLibrary = async (libraryName: string) => {
    const libraryNode = findLibraryNode(libraryName)
    const songLists = collectSongLists(libraryNode)
    if (!songLists.length) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('metadata.autoFillNoEligible')],
        confirmShow: false
      })
      return
    }
    const files = await scanSongListsFiles(songLists)
    if (!files.length) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('metadata.autoFillNoEligible')],
        confirmShow: false
      })
      return
    }
    warnAcoustIdMissing()
    runtime.isProgressing = true
    let summary: IMetadataAutoFillSummary | null = null
    let hadError = false
    try {
      summary = await invokeMetadataAutoFill(files)
    } catch (error: unknown) {
      hadError = true
      const message =
        error instanceof Error && error.message.trim() ? error.message : t('common.unknownError')
      await confirm({
        title: t('common.error'),
        content: [message],
        confirmShow: false
      })
    } finally {
      runtime.isProgressing = false
    }
    if (!summary) {
      if (!hadError) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('metadata.autoFillNoEligible')],
          confirmShow: false
        })
      }
      return
    }
    const { default: openAutoSummary } =
      await import('@renderer/components/autoMetadataSummaryDialog')
    await openAutoSummary(summary)
    const updates =
      summary.items
        ?.filter((item) => item.status === 'applied' && item.updatedSongInfo)
        .map((item) => ({
          song: item.updatedSongInfo,
          oldFilePath: item.oldFilePath
        })) || []
    if (updates.length) {
      try {
        emitter.emit('metadataBatchUpdated', { updates })
      } catch {}
    }
  }

  const emptyRecycleBinHandleClick = async () => {
    await emptyRecycleBinWithOptimisticUpdate(runtime)
  }

  const buildMenuArr = (item: Icon) => {
    const similarMenu =
      item.name === 'FilterLibrary' ||
      item.name === 'CuratedLibrary' ||
      item.name === 'SetLibrary' ||
      item.name === 'MixtapeLibrary'
        ? [[{ menuName: 'similarTracks.menu' }]]
        : []
    const commonMenus = [
      ...(item.name === 'FilterLibrary' || item.name === 'CuratedLibrary'
        ? [[{ menuName: 'tracks.analyzeMissingTracks' }]]
        : []),
      [{ menuName: 'metadata.autoFillMenu' }],
      ...similarMenu,
      [{ menuName: 'tracks.convertNonMp3ToMp3' }]
    ]
    if (item.name === 'RecycleBin') {
      return [[{ menuName: 'recycleBin.emptyRecycleBin' }], ...commonMenus]
    }
    if (item.name === 'SetLibrary' || item.name === 'MixtapeLibrary') {
      return similarMenu
    }
    return commonMenus
  }

  const handleAnalyzeMissingForLibrary = async (libraryName: string) => {
    const uuids = collectSongLists(findLibraryNode(libraryName)).map((item) => item.uuid)
    const requiresRuntimeAnalysis = runtime.analysisRuntime.available === true
    if (!uuids.length) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('tracks.noMissingAnalysisTracks')],
        confirmShow: false
      })
      return
    }
    const scanProgress = createMissingAnalysisScanProgress(uuids.length)
    runtime.isProgressing = true
    let files: string[] = []
    try {
      files = await scanSongListsForMissingAnalysisFiles(uuids, requiresRuntimeAnalysis, {
        includeSongStructure: true,
        onPlaylistScanned: scanProgress.markPlaylistScanned
      })
      scanProgress.complete()
    } catch (error: unknown) {
      scanProgress.dismiss()
      const message =
        error instanceof Error && error.message.trim() ? error.message : t('common.unknownError')
      await confirm({
        title: t('common.error'),
        content: [message],
        confirmShow: false
      })
      return
    } finally {
      runtime.isProgressing = false
    }
    if (files.length) {
      await promptAndQueueManualKeyAnalysisBatch(files, 'tracks.analyzingMissingTracks')
      return
    }
    await confirm({
      title: t('dialog.hint'),
      content: [t('tracks.noMissingAnalysisTracks')],
      confirmShow: false
    })
  }

  const handleConvertLibraryToMp3 = async (libraryName: string) => {
    const libraryNode = findLibraryNode(libraryName)
    const songLists = collectSongLists(libraryNode)
    if (!songLists.length) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('convert.noNonMp3Files')],
        confirmShow: false
      })
      return
    }
    const files = await collectFilesForAudioConvert(buildSongListScanRequests(songLists))
    const result = await startAudioConvertFromFiles({
      files,
      allowedSourceExts: runtime.setting.audioExt,
      presetTargetFormat: 'mp3',
      lockTargetFormat: true,
      excludeSameFormatAsTarget: true,
      skipExistingTargetCopies: true
    })
    if (result.status === 'no-files') {
      await confirm({
        title: t('dialog.hint'),
        content: [t('convert.noNonMp3Files')],
        confirmShow: false
      })
    }
  }

  const handleSimilarTracksForLibrary = async (libraryName: string) => {
    const libraryNode = findLibraryNode(libraryName)
    if (!libraryNode) {
      await openBatchSimilarTracksDialogForSeeds([])
      return
    }
    const seeds = await collectSongsForSimilarBatch([libraryNode.uuid])
    await openBatchSimilarTracksDialogForSeeds(seeds)
  }

  const handleIconContextmenu = async (event: MouseEvent, item: Icon) => {
    if (
      !['FilterLibrary', 'CuratedLibrary', 'SetLibrary', 'MixtapeLibrary', 'RecycleBin'].includes(
        item.name as string
      )
    ) {
      return
    }
    event.preventDefault()
    const menuArr = buildMenuArr(item)
    const result = await rightClickMenu({ menuArr, clickEvent: event })
    if (result === 'cancel') return
    switch (result.menuName) {
      case 'tracks.analyzeMissingTracks':
        await handleAnalyzeMissingForLibrary(item.name)
        break
      case 'metadata.autoFillMenu':
        await handleAutoFillForLibrary(item.name)
        break
      case 'tracks.convertNonMp3ToMp3':
        await handleConvertLibraryToMp3(item.name)
        break
      case 'similarTracks.menu':
        await handleSimilarTracksForLibrary(item.name)
        break
      case 'recycleBin.emptyRecycleBin':
        await emptyRecycleBinHandleClick()
        break
    }
  }

  return {
    handleIconContextmenu
  }
}
