import { computed, onMounted, onUnmounted } from 'vue'
import { icloudState, icloudOpen, refreshIcloudState } from '@renderer/utils/icloudLibrary'
import { isIcloudEntryVisible } from '@shared/icloudLibrary'
import type { useRuntimeStore } from '@renderer/stores/runtime'

export function useIcloudLibraryRail(runtime: ReturnType<typeof useRuntimeStore>) {
  const refresh = () => {
    void refreshIcloudState().catch(() => {})
  }
  onMounted(() => {
    refresh()
    window.addEventListener('focus', refresh)
  })
  onUnmounted(() => window.removeEventListener('focus', refresh))
  return computed(() =>
    isIcloudEntryVisible(icloudState.value, runtime.setting.showIcloudLibraryIcon)
  )
}

// Explicit sibling navigation also works when the stored local library is unchanged.
export function leaveIcloudLibrary() {
  icloudOpen.value = false
}
export function selectIcloudSiblingLibrary(
  runtime: Pick<ReturnType<typeof useRuntimeStore>, 'libraryAreaSelected'>,
  name: ReturnType<typeof useRuntimeStore>['libraryAreaSelected']
) {
  runtime.libraryAreaSelected = name
  leaveIcloudLibrary()
}
