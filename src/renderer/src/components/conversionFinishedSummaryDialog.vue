<script setup lang="ts">
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = defineProps<{
  summary: {
    total: number
    success: number
    failed: number
    skipped: number
    overwritten: number
    renamed: number
    backupCount: number
    fingerprintAddedCount: number
    durationMs?: number
    cancelled?: boolean
    cancelledCount?: number
  } | null
  errors?: Array<{
    filePath: string
    message: string
    stderr?: string
  }>
}>()
const emits = defineEmits(['close'])
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const close = () => closeWithAnimation(() => emits('close'))

const formatDurationSec = (ms?: number) => {
  const s = (ms || 0) / 1000
  if (s >= 10) return String(Math.round(s))
  return String(Math.round(s * 10) / 10)
}
const getFileName = (filePath?: string) => {
  const raw = String(filePath || '')
  if (!raw) return ''
  const parts = raw.split(/[/\\\\]/)
  return parts[parts.length - 1] || raw
}
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="title dialog-title dialog-header">{{ t('convert.completed') }}</div>
      <div class="stats-body">
        <div class="stats">
          <div class="section">
            <div class="section-title">{{ t('import.overview') }}</div>
            <div class="chips">
              <div class="chip">
                <div class="num">{{ summary?.success || 0 }}</div>
                <div class="cap">{{ t('convert.converted') }}</div>
              </div>
              <div class="chip">
                <div class="num">{{ summary?.skipped || 0 }}</div>
                <div class="cap">{{ t('convert.skippedSameFormat') }}</div>
              </div>
              <div class="chip" :class="{ danger: (summary?.failed || 0) > 0 }">
                <div class="num">{{ summary?.failed || 0 }}</div>
                <div class="cap">{{ t('convert.failed') }}</div>
              </div>
              <div v-if="summary?.cancelled" class="chip warn">
                <div class="num">{{ summary?.cancelledCount || 0 }}</div>
                <div class="cap">{{ t('convert.userCancelled') }}</div>
              </div>
              <div class="chip">
                <div class="num">{{ formatDurationSec(summary?.durationMs) }}</div>
                <div class="cap">{{ t('cloudSync.duration') }} ({{ t('player.seconds') }})</div>
              </div>
            </div>
          </div>
          <div class="section">
            <div class="section-title">{{ t('convert.outputDetails') }}</div>
            <div class="chips">
              <div class="chip">
                <div class="num">{{ summary?.renamed || 0 }}</div>
                <div class="cap">{{ t('convert.createdNew') }}</div>
              </div>
              <div class="chip">
                <div class="num">{{ summary?.overwritten || 0 }}</div>
                <div class="cap">{{ t('convert.replaced') }}</div>
              </div>
              <div class="chip" :class="{ success: (summary?.fingerprintAddedCount || 0) > 0 }">
                <div class="num">{{ summary?.fingerprintAddedCount || 0 }}</div>
                <div class="cap">{{ t('import.newFingerprints') }}</div>
              </div>
            </div>
          </div>
          <div v-if="(props.errors || []).length > 0" class="section">
            <div class="section-title">{{ t('convert.errorDetails') }}</div>
            <div class="error-list">
              <div v-for="item in props.errors" :key="item.filePath" class="error-item">
                <div class="error-file">{{ getFileName(item.filePath) }}</div>
                <div class="error-msg">{{ item.message }}</div>
                <div v-if="item.stderr" class="error-stderr">{{ item.stderr }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="close">{{ t('common.close') }}</div>
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
.stats-body {
  overflow-y: auto;
  overflow-wrap: anywhere;
  padding: 20px;
  flex: 1;
  min-height: 0;
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
  color: var(--text);
  font-weight: 700;
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
  border-radius: 6px;
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
.chip.danger .num {
  color: var(--danger-text);
}
.chip.success .num {
  color: var(--success-text);
}
.chip.warn .num {
  color: var(--warning-text);
}
.chip.warn .cap {
  color: var(--warning-text);
}
.error-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  background: var(--bg-elev);
  max-height: 180px;
  overflow-y: auto;
}
.error-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}
.error-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.error-file {
  font-size: 12px;
  color: var(--text);
  font-weight: 600;
}
.error-msg {
  font-size: 11px;
  color: var(--danger-text);
}
.error-stderr {
  font-size: 10px;
  color: var(--text-weak);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
