import { requestUserGuideStep } from '@renderer/composables/userGuideBridge'

export const resolveLibraryUserGuideTarget = (name: string) => {
  if (name === 'FilterLibrary' || name === 'CuratedLibrary') return 'filter-curated'
  if (name === 'SetLibrary') return 'set-library'
  if (name === 'MixtapeLibrary') return 'mixtape-library'
  if (name === 'RecordingLibrary') return 'recording-library'
  return undefined
}

export const requestLibraryUserGuide = (name: string) => {
  if (name === 'SetLibrary') {
    void requestUserGuideStep('setLibrary')
    return
  }
  if (name === 'MixtapeLibrary') {
    void requestUserGuideStep('mixtapeLibrary')
    return
  }
  if (name === 'RecordingLibrary') {
    void requestUserGuideStep('recordingLibrary')
  }
}
