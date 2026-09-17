import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import {
  getUserGuideBeats,
  sanitizeUserGuideAudience,
  sanitizeUserGuideDismissedSteps,
  USER_GUIDE_DEFAULT_BEAT_ID,
  type UserGuideAudience,
  type UserGuideBeatId,
  type UserGuideStepId
} from '@shared/userGuide'
import type { MainWindowBrowseMode } from '@renderer/utils/mainWindowPlaybackHandoff'
import {
  bindUserGuideHandlers,
  unbindUserGuideHandlers,
  userGuideSpotlightBeat,
  userGuideSpotlightStep
} from '@renderer/composables/userGuideBridge'
import {
  measureUserGuideHole,
  USER_GUIDE_HOLE_WAIT_MS
} from '@renderer/composables/userGuideTargets'

const BROWSER_REKORDBOX_USB_BEATS: UserGuideBeatId[] = [
  'browserRekordboxUsb',
  'browserRekordboxUsbMenu'
]

const isBrowserRekordboxUsbBeat = (beat: UserGuideBeatId) =>
  BROWSER_REKORDBOX_USB_BEATS.includes(beat)

type StepWaiter = {
  step: UserGuideStepId
  resolve: () => void
}

const browseModeToStep = (mode: MainWindowBrowseMode): UserGuideStepId => {
  if (mode === 'horizontal') return 'horizontal'
  if (mode === 'edit') return 'edit'
  return 'browser'
}

const hasHorizontalDeckSong = (runtime: ReturnType<typeof useRuntimeStore>) =>
  Boolean(runtime.horizontalBrowseDecks.topSong || runtime.horizontalBrowseDecks.bottomSong)

const isFilterLibrarySongList = (songListUUID: string) => {
  const normalized = String(libraryUtils.findDirPathByUuid(songListUUID) || '').replace(/\\/g, '/')
  return normalized === 'library/FilterLibrary' || normalized.startsWith('library/FilterLibrary/')
}

export const useUserGuide = (options?: { surface?: 'main' | 'mixtape' }) => {
  const runtime = useRuntimeStore()
  const surface = options?.surface === 'mixtape' ? 'mixtape' : 'main'
  const activeStep = ref<UserGuideStepId | null>(null)
  const tourBeats = ref<UserGuideBeatId[]>([USER_GUIDE_DEFAULT_BEAT_ID])
  const beatIndex = ref(0)
  const pendingSteps: Array<{ step: UserGuideStepId; force: boolean }> = []
  const stepWaiters: StepWaiter[] = []
  const identityWaiters: Array<() => void> = []
  const idleWaiters: Array<() => void> = []
  let importFinishedBound = false
  let tourRefreshToken = 0

  const persistSetting = async () => {
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
  }

  const currentAudience = () => sanitizeUserGuideAudience(runtime.setting.userGuideAudience)

  const hasChosenIdentity = () => currentAudience() !== undefined
  const shouldSkipGuides = () => currentAudience() === 'veteran'

  const identityVisible = computed(() => currentAudience() === undefined)
  const isRekordboxUser = computed(() => currentAudience() === 'rekordbox')

  const dismissedSteps = () => {
    const steps = sanitizeUserGuideDismissedSteps(runtime.setting.userGuideDismissedSteps)
    runtime.setting.userGuideDismissedSteps = steps
    return steps
  }

  const isDismissed = (step: UserGuideStepId) => dismissedSteps().includes(step)

  const activeBeat = computed(() => tourBeats.value[beatIndex.value] || USER_GUIDE_DEFAULT_BEAT_ID)
  const beatCount = computed(() => Math.max(1, tourBeats.value.length))
  const beatNumber = computed(() => Math.min(beatIndex.value + 1, beatCount.value))
  const hasNextBeat = computed(() => beatIndex.value < tourBeats.value.length - 1)

  const refreshTourBeats = (step: UserGuideStepId) => {
    const defined = getUserGuideBeats(step)
    if (defined.length === 1 && defined[0] === USER_GUIDE_DEFAULT_BEAT_ID) {
      tourBeats.value = [USER_GUIDE_DEFAULT_BEAT_ID]
      beatIndex.value = 0
      return
    }
    const available = defined.filter((beat) =>
      Boolean(measureUserGuideHole(step, beat, isRekordboxUser.value))
    )
    const nextBeats = available.length > 0 ? available : defined.slice(0, 1)
    const currentBeat = tourBeats.value[beatIndex.value]
    tourBeats.value = nextBeats
    const nextIndex = currentBeat ? nextBeats.indexOf(currentBeat) : 0
    beatIndex.value = nextIndex >= 0 ? nextIndex : 0
  }

  const insertBrowserRekordboxUsbAfterCurrent = () => {
    const currentBeat = tourBeats.value[beatIndex.value]
    if (!currentBeat || isBrowserRekordboxUsbBeat(currentBeat)) return
    const natural = getUserGuideBeats('browser')
    const usbNaturalIndexes = BROWSER_REKORDBOX_USB_BEATS.map((beat) =>
      natural.indexOf(beat)
    ).filter((index) => index >= 0)
    const firstUsbNatural = usbNaturalIndexes.length > 0 ? Math.min(...usbNaturalIndexes) : -1
    const currentNatural = natural.indexOf(currentBeat)
    if (currentNatural >= 0 && firstUsbNatural >= 0 && currentNatural < firstUsbNatural) return
    const usbPresent = BROWSER_REKORDBOX_USB_BEATS.filter((beat) => tourBeats.value.includes(beat))
    if (usbPresent.length === 0) return
    const without = tourBeats.value.filter((beat) => !isBrowserRekordboxUsbBeat(beat))
    const currentIndex = without.indexOf(currentBeat)
    if (currentIndex < 0) return
    tourBeats.value = [
      ...without.slice(0, currentIndex + 1),
      ...usbPresent,
      ...without.slice(currentIndex + 1)
    ]
    beatIndex.value = currentIndex
  }

  const absorbRekordboxUsbIntoActiveBrowserTour = (): boolean => {
    if (activeStep.value !== 'browser') return false
    const hadBeat = tourBeats.value.some((beat) => isBrowserRekordboxUsbBeat(beat))
    refreshTourBeats('browser')
    if (!hadBeat && tourBeats.value.some((beat) => isBrowserRekordboxUsbBeat(beat))) {
      insertBrowserRekordboxUsbAfterCurrent()
    }
    return true
  }

  const stopTourRefreshRetry = () => {
    tourRefreshToken += 1
  }

  const scheduleTourRefreshRetry = (step: UserGuideStepId) => {
    const token = ++tourRefreshToken
    const started = performance.now()
    const tick = () => {
      if (token !== tourRefreshToken || activeStep.value !== step) return
      refreshTourBeats(step)
      const beat = tourBeats.value[beatIndex.value] || USER_GUIDE_DEFAULT_BEAT_ID
      if (measureUserGuideHole(step, beat, isRekordboxUser.value)) return
      if (performance.now() - started >= USER_GUIDE_HOLE_WAIT_MS) return
      requestAnimationFrame(tick)
    }
    void nextTick(tick)
  }

  const activateStep = (step: UserGuideStepId) => {
    refreshTourBeats(step)
    activeStep.value = step
    scheduleTourRefreshRetry(step)
  }

  const flushIdentityWaiters = () => {
    const waiters = identityWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  const flushIdleWaitersIfIdle = () => {
    if (activeStep.value || identityVisible.value) return
    const waiters = idleWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  const resolveStepWaiters = (step: UserGuideStepId) => {
    const remaining: StepWaiter[] = []
    for (const waiter of stepWaiters.splice(0)) {
      if (waiter.step === step) waiter.resolve()
      else remaining.push(waiter)
    }
    stepWaiters.push(...remaining)
  }

  const enqueuePending = (step: UserGuideStepId, force: boolean) => {
    if (activeStep.value === step) return
    if (pendingSteps.some((item) => item.step === step)) {
      if (force) {
        const queued = pendingSteps.find((item) => item.step === step)
        if (queued) queued.force = true
      }
      return
    }
    pendingSteps.push({ step, force })
  }

  const showNextPending = () => {
    while (pendingSteps.length > 0) {
      const next = pendingSteps.shift()
      if (!next) continue
      if (!next.force && isDismissed(next.step)) continue
      activateStep(next.step)
      return
    }
    flushIdleWaitersIfIdle()
  }

  const requestStep = (step: UserGuideStepId, options?: { force?: boolean }): Promise<void> => {
    if (!hasChosenIdentity()) return Promise.resolve()
    const force = options?.force === true
    if (!force && shouldSkipGuides()) return Promise.resolve()
    if (step === 'rekordboxUsb' && !force && absorbRekordboxUsbIntoActiveBrowserTour()) {
      return Promise.resolve()
    }
    if (step === 'rekordboxUsb' && !force && !isDismissed('browser') && !activeStep.value) {
      return Promise.resolve()
    }
    if (!force && isDismissed(step)) return Promise.resolve()
    if (activeStep.value === step) {
      if (force) {
        activateStep(step)
      }
      return new Promise((resolve) => {
        stepWaiters.push({ step, resolve })
      })
    }
    if (activeStep.value) {
      enqueuePending(step, force)
      return new Promise((resolve) => {
        stepWaiters.push({ step, resolve })
      })
    }
    activateStep(step)
    return new Promise((resolve) => {
      stepWaiters.push({ step, resolve })
    })
  }

  const dismissActiveStep = () => {
    stopTourRefreshRetry()
    const step = activeStep.value
    if (!step) return
    const beatsAtDismiss = [...tourBeats.value]
    activeStep.value = null
    tourBeats.value = [USER_GUIDE_DEFAULT_BEAT_ID]
    beatIndex.value = 0
    if (!isDismissed(step)) {
      const dismissed = [...dismissedSteps(), step]
      if (step === 'browser' && !dismissed.includes('songsSource')) {
        dismissed.push('songsSource')
      }
      if (
        step === 'browser' &&
        beatsAtDismiss.some((beat) => isBrowserRekordboxUsbBeat(beat)) &&
        !dismissed.includes('rekordboxUsb')
      ) {
        dismissed.push('rekordboxUsb')
      }
      runtime.setting.userGuideDismissedSteps = dismissed
      void persistSetting()
    }
    resolveStepWaiters(step)
    showNextPending()
  }

  const goNextBeat = () => {
    if (!activeStep.value) return
    if (!hasNextBeat.value) {
      dismissActiveStep()
      return
    }
    beatIndex.value += 1
  }

  const suppressActiveGuide = () => {
    stopTourRefreshRetry()
    pendingSteps.length = 0
    const step = activeStep.value
    if (!step) {
      flushIdleWaitersIfIdle()
      return
    }
    activeStep.value = null
    tourBeats.value = [USER_GUIDE_DEFAULT_BEAT_ID]
    beatIndex.value = 0
    resolveStepWaiters(step)
    flushIdleWaitersIfIdle()
  }

  const chooseIdentity = (audience: UserGuideAudience) => {
    runtime.setting.userGuideAudience = audience
    flushIdentityWaiters()
    if (audience === 'veteran') suppressActiveGuide()
    void persistSetting()
  }

  const waitForIdentity = () => {
    if (hasChosenIdentity()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      identityWaiters.push(resolve)
    })
  }

  const waitForIdleGuide = () => {
    if (!identityVisible.value && !activeStep.value) return Promise.resolve()
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve)
    })
  }

  const requestCurrentModeGuide = (mode: MainWindowBrowseMode, options?: { force?: boolean }) => {
    if (
      (mode === 'horizontal' || mode === 'edit') &&
      !options?.force &&
      !hasHorizontalDeckSong(runtime)
    ) {
      return
    }
    void requestStep(browseModeToStep(mode), options)
  }

  const showCurrentModeGuide = () => {
    requestCurrentModeGuide(runtime.mainWindowBrowseMode)
  }

  const handleImportFinished = (_event: unknown, songListUUID: unknown) => {
    const uuid = typeof songListUUID === 'string' ? songListUUID : ''
    if (!uuid || !isFilterLibrarySongList(uuid)) return
    void requestStep('filterCurated')
  }

  const notifyFilterLibraryReceivedSongs = () => {
    void requestStep('filterCurated')
  }

  const stopAudienceWatch = watch(
    () => runtime.setting.userGuideAudience,
    (audience) => {
      if (audience === 'veteran') suppressActiveGuide()
    }
  )

  const stopBrowseModeWatch =
    surface === 'main'
      ? watch(
          () => runtime.mainWindowBrowseMode,
          (mode, previousMode) => {
            if (!hasChosenIdentity()) return
            if (mode === previousMode) return
            requestCurrentModeGuide(mode)
          }
        )
      : undefined

  const stopHorizontalDeckWatch =
    surface === 'main'
      ? watch(
          () => [
            runtime.mainWindowBrowseMode,
            Boolean(runtime.horizontalBrowseDecks.topSong),
            Boolean(runtime.horizontalBrowseDecks.bottomSong)
          ],
          () => {
            if (!hasChosenIdentity()) return
            const mode = runtime.mainWindowBrowseMode
            if (mode !== 'horizontal' && mode !== 'edit') return
            if (!hasHorizontalDeckSong(runtime)) return
            void requestStep(browseModeToStep(mode))
          }
        )
      : undefined

  const stopSpotlightWatch = watch(
    [activeStep, activeBeat],
    ([step, beat]) => {
      userGuideSpotlightStep.value = step
      userGuideSpotlightBeat.value = step ? beat : null
    },
    { immediate: true }
  )

  const beginUserGuide = () => {
    bindUserGuideHandlers({
      requestStep,
      notifyFilterLibraryReceivedSongs
    })
    if (surface === 'mixtape') {
      void requestStep('mixtapeWindow')
      return
    }
    if (!importFinishedBound) {
      window.electron.ipcRenderer.on('importFinished', handleImportFinished)
      importFinishedBound = true
    }
    showCurrentModeGuide()
    if (runtime.libraryAreaSelected === 'SetLibrary') {
      void requestStep('setLibrary')
    } else if (runtime.libraryAreaSelected === 'MixtapeLibrary') {
      void requestStep('mixtapeLibrary')
    } else if (runtime.libraryAreaSelected === 'RecordingLibrary') {
      void requestStep('recordingLibrary')
    }
  }

  onBeforeUnmount(() => {
    stopTourRefreshRetry()
    stopAudienceWatch()
    stopBrowseModeWatch?.()
    stopHorizontalDeckWatch?.()
    stopSpotlightWatch()
    userGuideSpotlightStep.value = null
    userGuideSpotlightBeat.value = null
    unbindUserGuideHandlers()
    if (importFinishedBound) {
      window.electron.ipcRenderer.removeListener('importFinished', handleImportFinished)
      importFinishedBound = false
    }
  })

  return {
    identityVisible,
    activeStep,
    activeBeat,
    beatNumber,
    beatCount,
    hasNextBeat,
    isRekordboxUser,
    chooseIdentity,
    dismissActiveStep,
    goNextBeat,
    beginUserGuide,
    waitForIdentity,
    waitForIdleGuide
  }
}
