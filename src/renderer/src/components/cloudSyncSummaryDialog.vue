<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '@renderer/composables/useI18n'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { CloudSyncSummary } from 'src/types/cloudSync'

const props = defineProps<{
  summary: CloudSyncSummary | null
}>()
const emits = defineEmits(['close'])

const { t } = useI18n()
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const close = () => {
  closeWithAnimation(() => emits('close'))
}

const summaryView = computed(() => ({
  addedToServerCount: Number(props.summary?.addedToServerCount || 0),
  pulledToClientCount: Number(props.summary?.pulledToClientCount || 0),
  curatedArtistClientInitialCount: Number(props.summary?.curatedArtistClientInitialCount || 0),
  curatedArtistClientCountAfter: Number(props.summary?.curatedArtistClientCountAfter || 0),
  curatedArtistServerInitialCount: Number(props.summary?.curatedArtistServerInitialCount || 0),
  curatedArtistServerCountAfter: Number(props.summary?.curatedArtistServerCountAfter || 0),
  clientInitialCount: Number(props.summary?.clientInitialCount || 0),
  totalClientCountAfter: Number(props.summary?.totalClientCountAfter || 0),
  serverInitialCount: Number(props.summary?.serverInitialCount || 0),
  totalServerCountAfter: Number(props.summary?.totalServerCountAfter || 0)
}))

const curatedArtistSummaryView = computed(() => {
  const view = summaryView.value
  const uploadedCount = Math.max(
    view.curatedArtistServerCountAfter - view.curatedArtistServerInitialCount,
    0
  )
  const pulledCount = Math.max(
    view.curatedArtistClientCountAfter - view.curatedArtistClientInitialCount,
    0
  )
  return {
    uploadedCount,
    pulledCount
  }
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="title dialog-title dialog-header">{{ t('cloudSync.syncCompleted') }}</div>
      <div class="body summary-body">
        <div class="stats">
          <div class="section">
            <div class="section-title">{{ t('cloudSync.audioFingerprintCount') }}</div>
            <div class="chips">
              <div class="chip" :class="{ success: summaryView.addedToServerCount > 0 }">
                <div class="num">{{ summaryView.addedToServerCount }}</div>
                <div class="cap">{{ t('cloudSync.uploadedNew') }}</div>
              </div>
              <div class="chip" :class="{ success: summaryView.pulledToClientCount > 0 }">
                <div class="num">{{ summaryView.pulledToClientCount }}</div>
                <div class="cap">{{ t('cloudSync.pulledNew') }}</div>
              </div>
            </div>
            <div class="section-body">
              <span class="count-pair">
                <span class="count-text"
                  >{{ t('cloudSync.clientCount') }}: {{ summaryView.clientInitialCount }}</span
                >
                <span class="arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M5 12h12M13 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    ></path>
                  </svg>
                </span>
                <span class="count-text">{{ summaryView.totalClientCountAfter }}</span>
              </span>
              <span class="count-pair" style="margin-left: 16px">
                <span class="count-text"
                  >{{ t('cloudSync.serverCount') }}: {{ summaryView.serverInitialCount }}</span
                >
                <span class="arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M5 12h12M13 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    ></path>
                  </svg>
                </span>
                <span class="count-text">{{ summaryView.totalServerCountAfter }}</span>
              </span>
            </div>
          </div>
          <div class="section">
            <div class="section-title">{{ t('cloudSync.curatedArtistCount') }}</div>
            <div class="chips">
              <div class="chip" :class="{ success: curatedArtistSummaryView.uploadedCount > 0 }">
                <div class="num">{{ curatedArtistSummaryView.uploadedCount }}</div>
                <div class="cap">{{ t('cloudSync.curatedArtistUploadedNew') }}</div>
              </div>
              <div class="chip" :class="{ success: curatedArtistSummaryView.pulledCount > 0 }">
                <div class="num">{{ curatedArtistSummaryView.pulledCount }}</div>
                <div class="cap">{{ t('cloudSync.curatedArtistPulledNew') }}</div>
              </div>
            </div>
            <div class="section-body">
              <span class="count-pair">
                <span class="count-text"
                  >{{ t('cloudSync.clientCount') }}:
                  {{ summaryView.curatedArtistClientInitialCount }}</span
                >
                <span class="arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M5 12h12M13 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    ></path>
                  </svg>
                </span>
                <span class="count-text">{{ summaryView.curatedArtistClientCountAfter }}</span>
              </span>
              <span class="count-pair" style="margin-left: 16px">
                <span class="count-text"
                  >{{ t('cloudSync.serverCount') }}:
                  {{ summaryView.curatedArtistServerInitialCount }}</span
                >
                <span class="arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M5 12h12M13 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    ></path>
                  </svg>
                </span>
                <span class="count-text">{{ summaryView.curatedArtistServerCountAfter }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="close">
          {{ t('common.close') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.title {
  color: var(--text);
}
.body {
  min-height: 0;
  overflow-y: auto;
  overflow-wrap: anywhere;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
}
.summary-body {
  gap: 12px;
}
.stats {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
  color: var(--text);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-title {
  font-size: 13px;
  color: #d0d0d0;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.section-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.chips {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.chip {
  min-width: 96px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}
.chip .num {
  font-size: 18px;
  color: var(--text);
  font-weight: 700;
  line-height: 1;
}
.chip .cap {
  font-size: 11px;
  color: var(--text-weak);
  margin-top: 4px;
}
.chip.success .num {
  color: #9fe870;
}
.count-pair {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
}
.count-pair > .count-text {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
}
.arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin: 0 6px;
  line-height: 14px;
  vertical-align: middle;
}
.arrow svg {
  width: 14px;
  height: 14px;
  display: block;
}
</style>
