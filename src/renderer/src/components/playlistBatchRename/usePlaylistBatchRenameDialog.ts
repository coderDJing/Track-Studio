import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import choiceDialog from '@renderer/components/choiceDialog'
import confirm from '@renderer/components/confirmDialog'
import inputDialog from '@renderer/components/inputDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import type { BatchRenameSongListTarget } from './index'
import {
  BUILTIN_PRESET_ID,
  createTextSegment,
  createTokenSegment,
  normalizeTemplateSegments,
  readBatchRenamePresetState,
  writeBatchRenamePresetState
} from './storage'
import type {
  IBatchRenamePreviewResult,
  IBatchRenamePreviewItem,
  IBatchRenamePreviewStatus,
  IBatchRenameTemplatePreset,
  IBatchRenameTemplateSegment,
  IBatchRenameTemplateToken,
  IBatchRenameTrackInput
} from 'src/types/globals'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'

export function usePlaylistBatchRenameDialog(props: {
  songLists: BatchRenameSongListTarget[]
  tracks?: IBatchRenameTrackInput[]
  selectedPresetId?: string
}) {
  const runtime = useRuntimeStore()
  const TOKEN_ORDER: IBatchRenameTemplateToken[] = [
    'title',
    'artist',
    'bpm',
    'key',
    'album',
    'genre',
    'label',
    'year',
    'trackNo',
    'fileName',
    'albumArtist',
    'discNo',
    'comment',
    'duration'
  ]

  const presetState = ref(readBatchRenamePresetState())
  const selectedPresetId = ref(
    props.selectedPresetId ||
      presetState.value.lastUsedPresetId ||
      presetState.value.defaultPresetId
  )
  const templateSegments = ref<IBatchRenameTemplateSegment[]>([createTextSegment('')])
  const draftChanged = ref(false)
  const scanning = ref(true)
  const scanNow = ref(0)
  const scanTotal = ref(props.songLists.length + (props.tracks?.length ? 1 : 0))
  const sampleLoading = ref(false)
  const previewLoading = ref(false)
  const sampleItems = ref<IBatchRenamePreviewItem[]>([])
  const sourceTracks = ref<IBatchRenameTrackInput[]>([])
  const activeTextSelection = ref<{ segmentId: string; start: number; end: number } | null>(null)
  const textSegmentRefs = new Map<string, HTMLInputElement>()
  const pendingTextFocus = ref<{ segmentId: string; pos: number } | null>(null)
  const scrollbarOptions = {
    scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
    overflow: { x: 'hidden', y: 'scroll' } as const
  }

  let sampleTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let sampleToken = 0

  const tokenLabelMap: Record<IBatchRenameTemplateToken, string> = {
    title: t('batchRename.tokenTitle'),
    artist: t('batchRename.tokenArtist'),
    bpm: t('batchRename.tokenBpm'),
    key: t('batchRename.tokenKey'),
    album: t('batchRename.tokenAlbum'),
    genre: t('batchRename.tokenGenre'),
    label: t('batchRename.tokenLabel'),
    year: t('batchRename.tokenYear'),
    trackNo: t('batchRename.tokenTrackNo'),
    fileName: t('batchRename.tokenFileName'),
    albumArtist: t('batchRename.tokenAlbumArtist'),
    discNo: t('batchRename.tokenDiscNo'),
    comment: t('batchRename.tokenComment'),
    duration: t('batchRename.tokenDuration')
  }
  const presets = computed(() => presetState.value.presets)
  const selectedPreset = computed(
    () => presets.value.find((item) => item.id === selectedPresetId.value) || null
  )
  const isTemplateBlank = computed(() =>
    templateSegments.value.every((segment) => segment.type === 'text' && !segment.value.trim())
  )
  const platformInvalidCharsLabel = computed(() =>
    runtime.setting.platform === 'darwin' ? ':/ ' : '< > : " / \\ | ? *'
  )
  const templateLiteralInvalidCharsMessage = computed(() => {
    const textValues = templateSegments.value
      .filter(
        (segment): segment is Extract<IBatchRenameTemplateSegment, { type: 'text' }> =>
          segment.type === 'text'
      )
      .map((segment) => segment.value)
    const hasInvalid =
      runtime.setting.platform === 'darwin'
        ? textValues.some((value) => /[:/\u0000]/.test(value))
        : textValues.some((value) => /[<>:"/\\|?*\u0000-\u001F]/.test(value))
    if (!hasInvalid) return ''
    return t('batchRename.templateLiteralInvalid', {
      chars: platformInvalidCharsLabel.value
    })
  })
  const formulaSummary = computed(() =>
    templateSegments.value
      .map((segment) =>
        segment.type === 'text' ? segment.value : tokenLabelMap[segment.token] || segment.token
      )
      .join('')
      .trim()
  )

  const buildTemplateSegmentsPayload = () =>
    templateSegments.value.map((segment) =>
      segment.type === 'text'
        ? {
            id: String(segment.id || ''),
            type: 'text' as const,
            value: String(segment.value || '')
          }
        : {
            id: String(segment.id || ''),
            type: 'token' as const,
            token: segment.token
          }
    )

  const buildTracksPayload = (tracks: IBatchRenameTrackInput[]) =>
    tracks.map((track) => ({
      order: Number(track.order || 0),
      songListUUID: track.songListUUID ? String(track.songListUUID) : undefined,
      songListPath: track.songListPath ? String(track.songListPath) : undefined,
      filePath: String(track.filePath || ''),
      fileName: String(track.fileName || ''),
      title: track.title ? String(track.title) : undefined,
      artist: track.artist ? String(track.artist) : undefined,
      album: track.album ? String(track.album) : undefined,
      genre: track.genre ? String(track.genre) : undefined,
      label: track.label ? String(track.label) : undefined,
      duration: track.duration ? String(track.duration) : undefined,
      key: track.key ? String(track.key) : undefined,
      bpm: typeof track.bpm === 'number' ? track.bpm : undefined
    }))

  const normalizeTrackKey = (filePath: string) =>
    normalizeFilePathForComparison(
      filePath,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )

  const pushTrackInput = (
    tracks: IBatchRenameTrackInput[],
    seen: Set<string>,
    track: Partial<IBatchRenameTrackInput>,
    order: number
  ) => {
    const filePath = String(track.filePath || '').trim()
    if (!filePath) return false
    const key = normalizeTrackKey(filePath)
    if (seen.has(key)) return false
    seen.add(key)
    tracks.push({
      order,
      songListUUID: track.songListUUID ? String(track.songListUUID) : undefined,
      songListPath: track.songListPath ? String(track.songListPath) : undefined,
      filePath,
      fileName: String(track.fileName || ''),
      title: typeof track.title === 'string' ? track.title : undefined,
      artist: typeof track.artist === 'string' ? track.artist : undefined,
      album: typeof track.album === 'string' ? track.album : undefined,
      genre: typeof track.genre === 'string' ? track.genre : undefined,
      label: typeof track.label === 'string' ? track.label : undefined,
      duration: typeof track.duration === 'string' ? track.duration : undefined,
      key: typeof track.key === 'string' ? track.key : undefined,
      bpm: typeof track.bpm === 'number' ? track.bpm : undefined
    })
    return true
  }

  const replaceTemplateSegments = (segments: IBatchRenameTemplateSegment[]) => {
    templateSegments.value = normalizeTemplateSegments(segments)
    syncDraftChanged()
    requestSamplePreview()
  }

  const cloneSegments = (segments: IBatchRenameTemplateSegment[]) =>
    normalizeTemplateSegments(
      segments.map((segment) =>
        segment.type === 'text'
          ? { id: segment.id, type: 'text', value: segment.value }
          : { id: segment.id, type: 'token', token: segment.token }
      )
    )

  const syncDraftChanged = () => {
    const preset = presets.value.find((item) => item.id === selectedPresetId.value)
    if (!preset) {
      draftChanged.value = false
      return
    }
    const current = JSON.stringify(
      templateSegments.value.map((segment) =>
        segment.type === 'text'
          ? { type: 'text', value: segment.value }
          : { type: 'token', token: segment.token }
      )
    )
    const presetSnapshot = JSON.stringify(
      normalizeTemplateSegments(preset.segments).map((segment) =>
        segment.type === 'text'
          ? { type: 'text', value: segment.value }
          : { type: 'token', token: segment.token }
      )
    )
    draftChanged.value = current !== presetSnapshot
  }

  const restoreDraftFromPreset = (presetId: string) => {
    const preset = presets.value.find((item) => item.id === presetId)
    if (!preset) return
    selectedPresetId.value = preset.id
    templateSegments.value = cloneSegments(preset.segments)
    activeTextSelection.value = null
    presetState.value = writeBatchRenamePresetState({
      ...presetState.value,
      lastUsedPresetId: preset.id
    })
    syncDraftChanged()
    requestSamplePreview()
  }

  const setTextSegmentRef = (segmentId: string, el: Element | { $el?: Element | null } | null) => {
    const target =
      el instanceof HTMLInputElement
        ? el
        : el && typeof el === 'object' && '$el' in el && el.$el instanceof HTMLInputElement
          ? el.$el
          : null
    if (target) {
      textSegmentRefs.set(segmentId, target)
    } else {
      textSegmentRefs.delete(segmentId)
    }
  }

  const focusTextSegment = (segmentId: string, pos: number) => {
    pendingTextFocus.value = { segmentId, pos }
    void nextTick(() => {
      const target = textSegmentRefs.get(segmentId)
      const pending = pendingTextFocus.value
      if (!target || !pending || pending.segmentId !== segmentId) return
      const nextPos = Math.max(0, Math.min(pos, target.value.length))
      target.focus()
      target.setSelectionRange(nextPos, nextPos)
      activeTextSelection.value = { segmentId, start: nextPos, end: nextPos }
      pendingTextFocus.value = null
    })
  }

  const handleTextSelectionChange = (segmentId: string, event: Event) => {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    activeTextSelection.value = {
      segmentId,
      start: target.selectionStart ?? target.value.length,
      end: target.selectionEnd ?? target.value.length
    }
  }

  const updateTextSegmentValue = (segmentId: string, value: string) => {
    templateSegments.value = templateSegments.value.map((segment) =>
      segment.id === segmentId && segment.type === 'text' ? { ...segment, value } : segment
    )
    syncDraftChanged()
    requestSamplePreview()
  }

  const handleTokenInsert = (token: IBatchRenameTemplateToken) => {
    const nextSegments = cloneSegments(templateSegments.value)
    let selection = activeTextSelection.value
    if (!selection) {
      const tail = [...nextSegments].reverse().find((segment) => segment.type === 'text')
      if (!tail || tail.type !== 'text') return
      selection = {
        segmentId: tail.id,
        start: tail.value.length,
        end: tail.value.length
      }
    }
    const index = nextSegments.findIndex(
      (segment) => segment.id === selection?.segmentId && segment.type === 'text'
    )
    if (index === -1) {
      nextSegments.push(createTokenSegment(token), createTextSegment(''))
      templateSegments.value = normalizeTemplateSegments(nextSegments)
      const tail = templateSegments.value[templateSegments.value.length - 1]
      if (tail?.type === 'text') {
        focusTextSegment(tail.id, 0)
      }
      syncDraftChanged()
      requestSamplePreview()
      return
    }
    const current = nextSegments[index]
    if (!current || current.type !== 'text') return
    const start = Math.max(0, Math.min(selection.start, current.value.length))
    const end = Math.max(start, Math.min(selection.end, current.value.length))
    const before = current.value.slice(0, start)
    const after = current.value.slice(end)
    const trailingText = createTextSegment(after)
    nextSegments.splice(
      index,
      1,
      { ...current, value: before },
      createTokenSegment(token),
      trailingText
    )
    templateSegments.value = normalizeTemplateSegments(nextSegments)
    focusTextSegment(trailingText.id, 0)
    syncDraftChanged()
    requestSamplePreview()
  }

  const removeTokenSegment = (segmentId: string) => {
    templateSegments.value = normalizeTemplateSegments(
      cloneSegments(templateSegments.value).filter((segment) => segment.id !== segmentId)
    )
    syncDraftChanged()
    requestSamplePreview()
  }

  const measureTextSegmentWidth = (value: string) => {
    const safeLength = Math.max(6, value.length + 1)
    return `${Math.min(360, Math.max(72, safeLength * 8 + 18))}px`
  }

  const resolvePreviewStatusLabel = (status: IBatchRenamePreviewStatus) => {
    switch (status) {
      case 'unchanged':
        return t('batchRename.status.unchanged')
      case 'invalid_chars':
        return t('batchRename.status.invalidChars')
      case 'too_long':
        return t('batchRename.status.tooLong')
      case 'source_missing':
        return t('batchRename.status.sourceMissing')
      case 'invalid_name':
        return t('batchRename.status.invalidName')
      default:
        return t('batchRename.status.executable')
    }
  }

  const requestSamplePreview = () => {
    if (sampleTimer) {
      clearTimeout(sampleTimer)
    }
    sampleTimer = setTimeout(() => {
      void refreshSamplePreview()
    }, 160)
  }

  const getRepresentativeTracks = () => {
    const output: IBatchRenameTrackInput[] = []
    const seen = new Set<string>()
    const pushTrack = (track?: IBatchRenameTrackInput) => {
      if (!track) return
      if (seen.has(track.filePath)) return
      seen.add(track.filePath)
      output.push(track)
    }
    pushTrack(sourceTracks.value[0])
    pushTrack(
      sourceTracks.value.find(
        (track) =>
          !track.title ||
          !track.artist ||
          !track.album ||
          !track.genre ||
          !track.label ||
          !track.key ||
          !track.bpm
      )
    )
    pushTrack(sourceTracks.value[sourceTracks.value.length - 1])
    return output.slice(0, 3)
  }

  const refreshSamplePreview = async () => {
    if (disposed || scanning.value || sourceTracks.value.length === 0) return
    if (isTemplateBlank.value) {
      sampleItems.value = []
      return
    }
    const currentToken = sampleToken + 1
    sampleToken = currentToken
    sampleLoading.value = true
    try {
      const result = (await window.electron.ipcRenderer.invoke('playlist:batchRename:preview', {
        tracks: buildTracksPayload(getRepresentativeTracks()),
        templateSegments: buildTemplateSegmentsPayload()
      })) as IBatchRenamePreviewResult
      if (disposed || currentToken !== sampleToken) return
      sampleItems.value = Array.isArray(result.items) ? result.items : []
    } catch {
      if (disposed || currentToken !== sampleToken) return
      sampleItems.value = []
    } finally {
      if (!disposed && currentToken === sampleToken) {
        sampleLoading.value = false
      }
    }
  }

  const promptDirtyDecision = async () => {
    if (!draftChanged.value) return 'discard'
    return await choiceDialog({
      title: t('batchRename.unsavedTitle'),
      content: [t('batchRename.unsavedDescription')],
      options: [
        { key: 'enter', label: t('common.save') },
        { key: 'reset', label: t('batchRename.discardChanges') },
        { key: 'cancel', label: t('common.cancel') }
      ],
      innerHeight: 220,
      innerWidth: 520
    })
  }

  const savePresetWithMode = async (mode: 'overwrite' | 'new') => {
    if (templateLiteralInvalidCharsMessage.value) {
      await confirm({
        title: t('dialog.hint'),
        content: [templateLiteralInvalidCharsMessage.value],
        confirmShow: false
      })
      return false
    }
    const currentPreset = presets.value.find((item) => item.id === selectedPresetId.value)
    let name = currentPreset?.name || ''
    if (mode === 'new') {
      const input = await inputDialog({
        title: t('batchRename.savePresetAsNew'),
        value: name,
        placeholder: t('batchRename.presetNameLabel'),
        confirmText: t('common.save')
      })
      if (input === 'cancel') return false
      name = String(input || '').trim()
    }
    if (!name) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('batchRename.presetNameRequired')],
        confirmShow: false
      })
      return false
    }
    const duplicate = presets.value.find(
      (item) => item.name.trim() === name && (mode === 'new' || item.id !== selectedPresetId.value)
    )
    if (duplicate) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('batchRename.presetNameDuplicate')],
        confirmShow: false
      })
      return false
    }
    if (mode === 'overwrite') {
      presetState.value = writeBatchRenamePresetState({
        ...presetState.value,
        presets: presets.value.map((item) =>
          item.id === selectedPresetId.value
            ? {
                ...item,
                name,
                segments: cloneSegments(templateSegments.value),
                updatedAt: Date.now()
              }
            : item
        ),
        lastUsedPresetId: selectedPresetId.value
      })
      restoreDraftFromPreset(selectedPresetId.value)
      return true
    }
    const presetId = uuidV4()
    const nextPreset: IBatchRenameTemplatePreset = {
      id: presetId,
      name,
      segments: cloneSegments(templateSegments.value),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    presetState.value = writeBatchRenamePresetState({
      ...presetState.value,
      presets: [...presets.value, nextPreset],
      lastUsedPresetId: presetId
    })
    restoreDraftFromPreset(presetId)
    return true
  }

  const handleCreatePreset = async () => {
    return await savePresetWithMode('new')
  }

  const handleSavePreset = async (): Promise<boolean> => {
    const choice = await choiceDialog({
      title: t('batchRename.savePresetTitle'),
      content: [t('batchRename.savePresetDescription')],
      options: [
        { key: 'enter', label: t('batchRename.savePresetOverwrite') },
        { key: 'reset', label: t('batchRename.savePresetAsNew') },
        { key: 'cancel', label: t('common.cancel') }
      ],
      innerHeight: 220,
      innerWidth: 520
    })
    if (choice === 'enter') {
      return await savePresetWithMode('overwrite')
    } else if (choice === 'reset') {
      return await savePresetWithMode('new')
    }
    return false
  }

  const switchPreset = async (presetId: string) => {
    if (presetId === selectedPresetId.value) return
    const dirtyChoice = await promptDirtyDecision()
    if (dirtyChoice === 'cancel') return
    if (dirtyChoice === 'enter') {
      const saved = await savePresetWithMode('overwrite')
      if (!saved) return
    }
    restoreDraftFromPreset(presetId)
  }

  const beginRenamePreset = () => {
    void (async () => {
      const currentPreset = presets.value.find((item) => item.id === selectedPresetId.value)
      if (!currentPreset) return
      const input = await inputDialog({
        title: t('batchRename.renamePreset'),
        value: currentPreset.name,
        placeholder: t('batchRename.presetNameLabel'),
        confirmText: t('common.confirm')
      })
      if (input === 'cancel') return
      const name = String(input || '').trim()
      if (!name) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('batchRename.presetNameRequired')],
          confirmShow: false
        })
        return
      }
      const duplicate = presets.value.find(
        (item) => item.name.trim() === name && item.id !== selectedPresetId.value
      )
      if (duplicate) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('batchRename.presetNameDuplicate')],
          confirmShow: false
        })
        return
      }
      presetState.value = writeBatchRenamePresetState({
        ...presetState.value,
        presets: presets.value.map((item) =>
          item.id === selectedPresetId.value ? { ...item, name, updatedAt: Date.now() } : item
        ),
        lastUsedPresetId: selectedPresetId.value
      })
      restoreDraftFromPreset(selectedPresetId.value)
    })()
  }

  const deletePreset = async () => {
    const result = await confirm({
      title: t('batchRename.deletePresetTitle'),
      content: [t('batchRename.deletePresetDescription')],
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel')
    })
    if (result !== 'confirm') return
    const remaining = presets.value.filter((item) => item.id !== selectedPresetId.value)
    presetState.value = writeBatchRenamePresetState({
      presets: remaining,
      defaultPresetId:
        presetState.value.defaultPresetId === selectedPresetId.value
          ? BUILTIN_PRESET_ID
          : presetState.value.defaultPresetId,
      lastUsedPresetId:
        presetState.value.lastUsedPresetId === selectedPresetId.value
          ? BUILTIN_PRESET_ID
          : presetState.value.lastUsedPresetId
    })
    restoreDraftFromPreset(presetState.value.lastUsedPresetId || presetState.value.defaultPresetId)
  }

  const reloadPresetState = (preferredPresetId?: string) => {
    presetState.value = readBatchRenamePresetState()
    const targetId =
      preferredPresetId && presetState.value.presets.some((item) => item.id === preferredPresetId)
        ? preferredPresetId
        : presetState.value.lastUsedPresetId || presetState.value.defaultPresetId
    restoreDraftFromPreset(targetId)
  }

  const scanTracks = async () => {
    scanNow.value = 0
    scanTotal.value = props.songLists.length + (props.tracks?.length ? 1 : 0)
    const nextTracks: IBatchRenameTrackInput[] = []
    const seen = new Set<string>()
    let order = 0

    if (props.tracks?.length) {
      for (const track of props.tracks) {
        if (pushTrackInput(nextTracks, seen, track, order)) {
          order += 1
        }
      }
      scanNow.value = 1
    }

    for (let index = 0; index < props.songLists.length; index += 1) {
      const songList = props.songLists[index]
      scanNow.value = index + 1 + (props.tracks?.length ? 1 : 0)
      try {
        const scan = (await window.electron.ipcRenderer.invoke(
          'scanSongList',
          songList.path,
          songList.uuid
        )) as { scanData?: Array<Record<string, unknown>> } | null
        const rows = Array.isArray(scan?.scanData) ? scan.scanData : []
        for (const row of rows) {
          const added = pushTrackInput(
            nextTracks,
            seen,
            {
              order,
              songListUUID: songList.uuid,
              songListPath: songList.path,
              filePath: String(row.filePath || ''),
              fileName: String(row.fileName || ''),
              title: typeof row.title === 'string' ? row.title : undefined,
              artist: typeof row.artist === 'string' ? row.artist : undefined,
              album: typeof row.album === 'string' ? row.album : undefined,
              genre: typeof row.genre === 'string' ? row.genre : undefined,
              label: typeof row.label === 'string' ? row.label : undefined,
              duration: typeof row.duration === 'string' ? row.duration : undefined,
              key: typeof row.key === 'string' ? row.key : undefined,
              bpm: typeof row.bpm === 'number' ? row.bpm : undefined
            },
            order
          )
          if (added) {
            order += 1
          }
        }
      } catch (error) {
        console.error('[batchRename] scanSongList failed', songList.path, error)
      }
    }
    sourceTracks.value = nextTracks
    scanning.value = false
    if (sourceTracks.value.length === 0 && !disposed) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('batchRename.noEligibleTracks')],
        confirmShow: false
      })
    }
    requestSamplePreview()
  }

  const generatePreview = async () => {
    if (isTemplateBlank.value) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('batchRename.templateEmptyError')],
        confirmShow: false
      })
      return null
    }
    previewLoading.value = true
    try {
      return (await window.electron.ipcRenderer.invoke('playlist:batchRename:preview', {
        tracks: buildTracksPayload(sourceTracks.value),
        templateSegments: buildTemplateSegmentsPayload()
      })) as IBatchRenamePreviewResult
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [error instanceof Error ? error.message : t('common.unknownError')],
        confirmShow: false
      })
      return null
    } finally {
      previewLoading.value = false
    }
  }

  onMounted(() => {
    restoreDraftFromPreset(selectedPresetId.value)
    void scanTracks()
  })

  onUnmounted(() => {
    disposed = true
    if (sampleTimer) {
      clearTimeout(sampleTimer)
      sampleTimer = null
    }
  })

  return {
    TOKEN_ORDER,
    beginRenamePreset,
    formulaSummary,
    handleCreatePreset,
    deletePreset,
    draftChanged,
    generatePreview,
    handleSavePreset,
    handleTextSelectionChange,
    handleTokenInsert,
    isTemplateBlank,
    measureTextSegmentWidth,
    presets,
    replaceTemplateSegments,
    reloadPresetState,
    sampleItems,
    sampleLoading,
    scanNow,
    scanTotal,
    scanning,
    selectedPreset,
    scrollbarOptions,
    removeTokenSegment,
    selectedPresetId,
    setTextSegmentRef,
    switchPreset,
    templateSegments,
    templateLiteralInvalidCharsMessage,
    tokenLabelMap,
    resolvePreviewStatusLabel,
    updateTextSegmentValue
  }
}
