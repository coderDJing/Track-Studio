import { onUnmounted, type Ref } from 'vue'
import type { ISongInfo, IRekordboxBeatGridEntry } from 'src/types/globals'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import { createSongBeatGridMapV2FromRekordboxEntries } from '@shared/songBeatGridMapV2'
import { editPioneerUsbSong, isEditablePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'
import type { HorizontalBrowseGridShiftOptions } from './useHorizontalBrowseGridToolbar'

type Session = {
  song: ISongInfo
  entries: IRekordboxBeatGridEntry[]
  pending: number
  sent: number
  timer?: ReturnType<typeof setTimeout>
  saving?: Promise<void>
}

/** Preview immediately, merge repeated button presses, and retain the original source on deck changes. */
export const usePioneerUsbGridEditing = (params: {
  song: () => ISongInfo | null
  previewBpm: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewDownbeatBeatOffset: Ref<number>
  previewBeatGridMap: Ref<SongBeatGridMapV2 | null>
  draw: () => void
}) => {
  const sessions = new Map<string, Session>()
  let mounted = true
  const key = (song: ISongInfo) =>
    `${song.pioneerUsbSource?.rootPath}:${song.pioneerUsbSource?.libraryType}:${song.pioneerUsbSource?.trackId}:${song.filePath}`
  const currentSession = () => {
    const song = params.song()
    return song ? sessions.get(key(song)) : undefined
  }
  const entriesFor = (session: Session) =>
    session.entries
      .map((entry) => ({
        ...entry,
        timeMs: entry.timeMs + Math.round(session.pending + session.sent)
      }))
      .filter((entry) => entry.timeMs >= 0)
  const showPreview = (session: Session) => {
    if (!mounted || currentSession() !== session) return
    const entries = entriesFor(session)
    params.previewBeatGridMap.value = createSongBeatGridMapV2FromRekordboxEntries(entries)
    if (entries.length) {
      params.previewFirstBeatMs.value = entries[0].timeMs
      params.previewBpm.value = entries[0].bpm
      params.previewDownbeatBeatOffset.value = (5 - entries[0].beatNumber) % 4
    }
    params.draw()
  }
  const flush = async (session = currentSession()): Promise<void> => {
    if (!session) return
    if (session.timer) clearTimeout(session.timer)
    session.timer = undefined
    if (session.saving) {
      await session.saving
      return flush(session)
    }
    const offsetMs = Math.round(session.pending)
    if (!offsetMs) {
      session.pending = 0
      return
    }
    session.pending = 0
    session.sent = offsetMs
    session.saving = (async () => {
      try {
        const result = await editPioneerUsbSong(session.song, { kind: 'shift-grid', offsetMs })
        if (result?.rekordboxGridEntries) session.entries = result.rekordboxGridEntries
        else session.pending = 0
      } finally {
        session.sent = 0
        session.saving = undefined
        showPreview(session)
      }
    })()
    await session.saving
    if (Math.round(session.pending)) await flush(session)
  }
  const shift = (deltaMs: number) => {
    const song = params.song()
    if (!isEditablePioneerUsbSong(song) || !song || !Number.isFinite(deltaMs)) return false
    let session = sessions.get(key(song))
    if (!session) {
      if (!song.rekordboxGridEntries?.length) return false
      session = {
        song: { ...song, pioneerUsbSource: { ...song.pioneerUsbSource! } },
        entries: song.rekordboxGridEntries.map((entry) => ({ ...entry })),
        pending: 0,
        sent: 0
      }
      sessions.set(key(song), session)
    }
    if (!session.saving && !session.pending && song.rekordboxGridEntries?.length)
      session.entries = song.rekordboxGridEntries.map((entry) => ({ ...entry }))
    session.pending += deltaMs
    showPreview(session)
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      void flush(session)
    }, 350)
    return true
  }
  onUnmounted(() => {
    mounted = false
    for (const session of sessions.values()) void flush(session)
  })
  return {
    shift,
    flush,
    flushFile: (filePath?: string): Promise<void> | null => {
      const matches = filePath
        ? [...sessions.values()].filter((session) => session.song.filePath === filePath)
        : currentSession()
          ? [currentSession()!]
          : []
      return matches.length
        ? Promise.all(matches.map((session) => flush(session))).then(() => undefined)
        : null
    },
    hasPending: () => {
      const session = currentSession()
      return Boolean(session && (session.pending || session.sent || session.saving))
    },
    bindToolbar: (local: {
      persistGridDefinition: () => Promise<void>
      schedulePersistGridDefinition: () => void
      handleGridShift: (delta: number, options?: HorizontalBrowseGridShiftOptions) => void
    }) => ({
      persistGridDefinition: () =>
        isEditablePioneerUsbSong(params.song()) ? flush() : local.persistGridDefinition(),
      schedulePersistGridDefinition: () => {
        if (!isEditablePioneerUsbSong(params.song())) local.schedulePersistGridDefinition()
      },
      handleGridShift: (delta: number, options?: HorizontalBrowseGridShiftOptions) => {
        if (isEditablePioneerUsbSong(params.song())) shift(delta)
        else local.handleGridShift(delta, options)
      }
    }),
    previewEntries: () => {
      const session = currentSession()
      return session && (session.pending || session.sent) ? entriesFor(session) : undefined
    }
  }
}
