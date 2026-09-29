import { reactive, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@shared/horizontalBrowseTransport'

type DeckKey = HorizontalBrowseDeckKey

type Params = {
  editMode: () => boolean
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveLeaderDeck: () => string | null | undefined
  touchDeckInteraction: (deck: DeckKey) => void
  activateMaster: (deck: DeckKey) => Promise<unknown>
  activateBeatSync: (deck: DeckKey) => Promise<unknown>
}

const otherDeck = (deck: DeckKey): DeckKey => (deck === 'top' ? 'bottom' : 'top')

export const useHorizontalBrowseDeckPreselection = (params: Params) => {
  const pendingMasterDeck = ref<DeckKey | null>(null)
  const failedMasterDeck = ref<DeckKey | null>(null)
  const pendingBeatSync = reactive<Record<DeckKey, boolean>>({ top: false, bottom: false })
  const applyingBeatSync = reactive<Record<DeckKey, boolean>>({ top: false, bottom: false })
  const cancelBeatSyncAfterApply = reactive<Record<DeckKey, boolean>>({ top: false, bottom: false })
  let masterRevision = 0
  let masterOperation: Promise<void> = Promise.resolve()
  let masterOperationRunning = false
  let priorMasterDeck: DeckKey | null = null
  let queuedMasterRevision: number | null = null
  let pendingMasterSongPath = ''
  let masterDecodeSeen = false

  const queueMasterActivation = (deck: DeckKey, revision: number) => {
    masterOperation = masterOperation
      .catch(() => {})
      .then(async () => {
        if (revision !== masterRevision) return
        masterOperationRunning = true
        try {
          await params.activateMaster(deck)
          if (params.resolveLeaderDeck() !== deck) {
            throw new Error(`Master selection did not activate for ${deck}`)
          }
          if (revision === masterRevision && pendingMasterDeck.value === deck) {
            pendingMasterDeck.value = null
          }
        } catch (error) {
          if (revision === masterRevision) failedMasterDeck.value = deck
          console.error('[horizontal-browse] select Master failed', error)
        } finally {
          masterOperationRunning = false
        }
      })
    return masterOperation
  }

  const toggleDeckMaster = async (deck: DeckKey): Promise<void> => {
    params.touchDeckInteraction(deck)
    const song = params.resolveDeckSong(deck)
    const loaded = params.resolveDeckSnapshot(deck).loaded
    if (pendingMasterDeck.value === deck && (!song || !loaded)) {
      pendingMasterDeck.value = null
      failedMasterDeck.value = null
      const revision = ++masterRevision
      if (masterOperationRunning && priorMasterDeck) {
        void queueMasterActivation(priorMasterDeck, revision)
      }
      priorMasterDeck = null
      return
    }
    const revision = ++masterRevision
    failedMasterDeck.value = null
    if (!song || !loaded) {
      const current = params.resolveLeaderDeck()
      priorMasterDeck = current === 'top' || current === 'bottom' ? current : null
      pendingMasterDeck.value = deck
      pendingMasterSongPath = String(song?.filePath || '')
      masterDecodeSeen = false
      return
    }
    pendingMasterDeck.value = null
    priorMasterDeck = null
    await queueMasterActivation(deck, revision)
  }

  const triggerDeckBeatSync = async (deck: DeckKey): Promise<void> => {
    if (pendingBeatSync[deck]) {
      pendingBeatSync[deck] = false
      cancelBeatSyncAfterApply[deck] = applyingBeatSync[deck]
      if (params.resolveDeckSnapshot(deck).syncEnabled) {
        await params.activateBeatSync(deck)
      }
      return
    }
    if (params.resolveDeckSong(deck)) {
      await params.activateBeatSync(deck)
      return
    }
    params.touchDeckInteraction(deck)
    pendingBeatSync[deck] = true
  }

  const tryActivatePendingBeatSync = (deck: DeckKey) => {
    if (!pendingBeatSync[deck] || applyingBeatSync[deck]) return
    const song = params.resolveDeckSong(deck)
    const snapshot = params.resolveDeckSnapshot(deck)
    const reference = params.resolveDeckSnapshot(otherDeck(deck))
    if (!song || !snapshot.loaded || !reference.loaded) return
    if (snapshot.syncEnabled) {
      pendingBeatSync[deck] = false
      return
    }
    if (!(snapshot.bpm > 0) || !(reference.bpm > 0)) return
    applyingBeatSync[deck] = true
    void params
      .activateBeatSync(deck)
      .then(async () => {
        if (cancelBeatSyncAfterApply[deck]) {
          if (params.resolveDeckSnapshot(deck).syncEnabled) await params.activateBeatSync(deck)
          return
        }
        if (params.resolveDeckSnapshot(deck).syncEnabled) pendingBeatSync[deck] = false
      })
      .catch((error) => console.error('[horizontal-browse] preselected Beat Sync failed', error))
      .finally(() => {
        applyingBeatSync[deck] = false
        cancelBeatSyncAfterApply[deck] = false
      })
  }

  watch(
    () => [
      pendingMasterDeck.value,
      params.resolveDeckSong('top')?.filePath,
      params.resolveDeckSong('bottom')?.filePath,
      params.resolveDeckSnapshot('top').loaded,
      params.resolveDeckSnapshot('bottom').loaded,
      params.resolveDeckSnapshot('top').decoding,
      params.resolveDeckSnapshot('bottom').decoding,
      params.resolveDeckSnapshot('top').bpm,
      params.resolveDeckSnapshot('bottom').bpm,
      pendingBeatSync.top,
      pendingBeatSync.bottom
    ],
    () => {
      const master = pendingMasterDeck.value
      if (master) {
        const songPath = String(params.resolveDeckSong(master)?.filePath || '')
        const snapshot = params.resolveDeckSnapshot(master)
        if (songPath !== pendingMasterSongPath) {
          pendingMasterSongPath = songPath
          masterDecodeSeen = false
          failedMasterDeck.value = null
        }
        if (songPath && snapshot.decoding) {
          masterDecodeSeen = true
          failedMasterDeck.value = null
        } else if (songPath && masterDecodeSeen && !snapshot.loaded) {
          masterDecodeSeen = false
          failedMasterDeck.value = master
        }
      }
      if (
        master &&
        failedMasterDeck.value !== master &&
        params.resolveDeckSong(master) &&
        params.resolveDeckSnapshot(master).loaded &&
        queuedMasterRevision !== masterRevision
      ) {
        const revision = masterRevision
        queuedMasterRevision = revision
        void queueMasterActivation(master, revision).finally(() => {
          if (queuedMasterRevision === revision) queuedMasterRevision = null
        })
      }
      tryActivatePendingBeatSync('top')
      tryActivatePendingBeatSync('bottom')
    }
  )

  const clearPending = () => {
    ++masterRevision
    pendingMasterDeck.value = null
    failedMasterDeck.value = null
    pendingBeatSync.top = false
    pendingBeatSync.bottom = false
    cancelBeatSyncAfterApply.top = applyingBeatSync.top
    cancelBeatSyncAfterApply.bottom = applyingBeatSync.bottom
  }
  watch(params.editMode, (editMode) => {
    if (editMode) clearPending()
  })

  return {
    pendingMasterDeck,
    failedMasterDeck,
    pendingBeatSync,
    toggleDeckMaster,
    triggerDeckBeatSync
  }
}
