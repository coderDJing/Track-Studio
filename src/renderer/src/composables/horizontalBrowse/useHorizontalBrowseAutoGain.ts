import { computed, onMounted, onUnmounted } from 'vue'
import {
  createHorizontalBrowseNativeTransport,
  type HorizontalBrowseDeckKey
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseTransportDeckSnapshot } from '@shared/horizontalBrowseTransport'
import { t } from '@renderer/utils/translate'

const autoGainTransport = createHorizontalBrowseNativeTransport()
let subscriberCount = 0
let unsubscribeSnapshot: (() => void) | null = null

const startAutoGainSnapshotSync = () => {
  subscriberCount += 1
  if (unsubscribeSnapshot) return
  unsubscribeSnapshot = autoGainTransport.subscribeSnapshot(() => {})
}

const stopAutoGainSnapshotSync = () => {
  subscriberCount = Math.max(0, subscriberCount - 1)
  if (subscriberCount > 0 || !unsubscribeSnapshot) return
  unsubscribeSnapshot()
  unsubscribeSnapshot = null
}

const resolveDeckSnapshot = (
  deck: HorizontalBrowseDeckKey
): HorizontalBrowseTransportDeckSnapshot =>
  deck === 'top' ? autoGainTransport.state.top : autoGainTransport.state.bottom

const resolveAutoGainTitle = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
  if (!snapshot.autoGainEnabled || snapshot.autoGainStatus === 'off') {
    return t('horizontalBrowse.autoGainOff')
  }
  if (snapshot.autoGainStatus === 'master') return t('horizontalBrowse.autoGainMaster')
  if (snapshot.autoGainStatus === 'pending') {
    return snapshot.loaded
      ? t('horizontalBrowse.autoGainPendingLoaded')
      : t('horizontalBrowse.autoGainPendingUnloaded')
  }
  if (snapshot.autoGainStatus === 'unavailable') return t('horizontalBrowse.autoGainUnavailable')
  return t('horizontalBrowse.autoGainAligned')
}

export const useHorizontalBrowseAutoGain = (deck: HorizontalBrowseDeckKey) => {
  onMounted(startAutoGainSnapshotSync)
  onUnmounted(stopAutoGainSnapshotSync)

  const autoGainSnapshot = computed(() => resolveDeckSnapshot(deck))
  const autoGainEnabled = computed(() => autoGainSnapshot.value.autoGainEnabled)
  const autoGainStatus = computed(() => autoGainSnapshot.value.autoGainStatus)
  const autoGainTitle = computed(() => resolveAutoGainTitle(autoGainSnapshot.value))

  const toggleAutoGain = () => {
    void autoGainTransport.setAutoGainEnabled(deck, !autoGainEnabled.value)
  }

  return {
    autoGainEnabled,
    autoGainStatus,
    autoGainTitle,
    toggleAutoGain
  }
}
