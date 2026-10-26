<script setup lang="ts">
import { computed } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type {
  IBatchRenameExecutionResult,
  IBatchRenameExecutionResultItem,
  IBatchRenameExecutionStatus
} from 'src/types/globals'

const props = defineProps<{
  result: IBatchRenameExecutionResult
}>()
const emits = defineEmits(['close'])
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const close = () => closeWithAnimation(() => emits('close'))

const scrollbarOptions = {
  scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
  overflow: { x: 'hidden', y: 'scroll' } as const
}

type GroupItem = {
  title: string
  items: IBatchRenameExecutionResultItem[]
}

const isFailedStatus = (status: IBatchRenameExecutionStatus) =>
  ['source_missing', 'file_in_use', 'permission_denied', 'target_exists', 'failed'].includes(status)

const isSkippedStatus = (status: IBatchRenameExecutionStatus) =>
  ['hand_skipped', 'unchanged', 'invalid_chars', 'too_long', 'invalid_name'].includes(status)

const failedItems = computed(() =>
  (props.result?.items || []).filter((item) => isFailedStatus(item.status))
)

const skippedItems = computed(() =>
  (props.result?.items || []).filter((item) => isSkippedStatus(item.status))
)

const cancelledItems = computed(() =>
  (props.result?.items || []).filter((item) => item.status === 'cancelled')
)

const groups = computed<GroupItem[]>(() => {
  const output: GroupItem[] = []
  if (failedItems.value.length > 0) {
    output.push({
      title: t('batchRename.resultFailedTitle'),
      items: failedItems.value
    })
  }
  if (skippedItems.value.length > 0) {
    output.push({
      title: t('batchRename.resultSkippedTitle'),
      items: skippedItems.value
    })
  }
  if (cancelledItems.value.length > 0) {
    output.push({
      title: t('batchRename.resultCancelledTitle'),
      items: cancelledItems.value
    })
  }
  return output
})

const resolveStatusLabel = (status: IBatchRenameExecutionStatus) => {
  switch (status) {
    case 'hand_skipped':
      return t('batchRename.status.handSkipped')
    case 'unchanged':
      return t('batchRename.status.unchanged')
    case 'invalid_chars':
      return t('batchRename.status.invalidChars')
    case 'too_long':
      return t('batchRename.status.tooLong')
    case 'invalid_name':
      return t('batchRename.status.invalidName')
    case 'source_missing':
      return t('batchRename.status.sourceMissing')
    case 'file_in_use':
      return t('batchRename.status.fileInUse')
    case 'permission_denied':
      return t('batchRename.status.permissionDenied')
    case 'target_exists':
      return t('batchRename.status.targetExists')
    case 'cancelled':
      return t('batchRename.status.cancelled')
    case 'failed':
      return t('batchRename.status.failed')
    default:
      return t('batchRename.status.executable')
  }
}
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">
        {{ t('batchRename.resultTitle') }}
      </div>
      <div class="content">
        <div class="chips">
          <div class="chip">
            <div class="num">{{ result.summary.total }}</div>
            <div class="cap">{{ t('batchRename.summaryTotal') }}</div>
          </div>
          <div class="chip success">
            <div class="num">{{ result.summary.success }}</div>
            <div class="cap">{{ t('batchRename.summarySuccess') }}</div>
          </div>
          <div class="chip danger">
            <div class="num">{{ result.summary.failed }}</div>
            <div class="cap">{{ t('batchRename.summaryFailed') }}</div>
          </div>
          <div class="chip">
            <div class="num">{{ result.summary.skipped }}</div>
            <div class="cap">{{ t('batchRename.summarySkipped') }}</div>
          </div>
        </div>

        <div v-if="groups.length > 0" class="groups">
          <div v-for="group in groups" :key="group.title" class="group">
            <div class="group-title">{{ group.title }}</div>
            <OverlayScrollbarsComponent
              class="group-scroll"
              :options="scrollbarOptions"
              element="div"
            >
              <div class="rows">
                <div v-for="item in group.items" :key="item.id" class="row">
                  <bubbleBoxTrigger tag="div" class="name" :title="item.originalFileName">
                    {{ item.originalFileName }}
                  </bubbleBoxTrigger>
                  <bubbleBoxTrigger tag="div" class="target" :title="item.targetFileName">
                    {{ item.targetFileName }}
                  </bubbleBoxTrigger>
                  <div class="status">{{ resolveStatusLabel(item.status) }}</div>
                </div>
              </div>
            </OverlayScrollbarsComponent>
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
  width: 840px;
  max-height: 82vh;
  min-height: 480px;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.content {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  min-height: 0;
  flex: 1;
}

.chips {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.chip {
  min-width: 110px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}

.chip .num {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}

.chip .cap {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-weak);
}

.chip.danger .num {
  color: var(--danger-text);
}

.chip.success .num {
  color: var(--success-text);
}

.groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-height: 0;
  flex: 1;
}

.group {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.group:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.group-title {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}

.group-scroll {
  min-height: 0;
  flex: 1;
  width: 100%;
}

.rows {
  width: 100%;
  min-width: 100%;
}

.group-scroll :deep(.os-host),
.group-scroll :deep(.os-content) {
  width: 100% !important;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  align-items: center;
}

.row:last-child {
  border-bottom: none;
}

.name,
.target {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.target {
  color: var(--text-weak);
}

.status {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
}
</style>
