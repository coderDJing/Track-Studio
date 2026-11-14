<script setup lang="ts">
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import {
  useDownloadTasks,
  type DownloadTaskAction,
  type DownloadTaskView
} from '@renderer/composables/useDownloadTasks'

const { tasks, hasTasks, activeCount, collapsed, minimize, expand, isRetrying, runAction } =
  useDownloadTasks()

const barStyle = (task: DownloadTaskView) => ({
  width: `${Math.max(0, Math.min(100, task.percent ?? 0))}%`
})

const isIndeterminate = (task: DownloadTaskView) =>
  task.percent === null && task.status === 'installing'

// 只有真实百分比或安装中的不确定态才画进度条，避免“待下载/已最新”下面挂一条空条。
const hasBar = (task: DownloadTaskView) =>
  task.status !== 'failed' && (task.percent !== null || isIndeterminate(task))

const actionDisabled = (task: DownloadTaskView, action: DownloadTaskAction) =>
  action.disabled === true || isRetrying(task.id)
</script>

<template>
  <div v-if="hasTasks" class="download-tasks">
    <button
      v-if="collapsed"
      class="download-tasks__pill"
      type="button"
      :aria-label="t('downloadTasks.expand')"
      @click="expand"
    >
      <span v-if="activeCount > 0" class="download-tasks__spinner" aria-hidden="true"></span>
      <span class="download-tasks__pill-text">{{ t('downloadTasks.panelTitle') }}</span>
      <span v-if="activeCount > 0" class="download-tasks__badge">{{ activeCount }}</span>
    </button>
    <div v-else class="download-tasks__card">
      <div class="download-tasks__header">
        <span class="download-tasks__title">{{ t('downloadTasks.panelTitle') }}</span>
        <bubbleBoxTrigger
          tag="button"
          class="download-tasks__minimize"
          type="button"
          :title="t('downloadTasks.minimize')"
          :aria-label="t('downloadTasks.minimize')"
          @click="minimize"
        >
          <span class="download-tasks__minimize-glyph" aria-hidden="true"></span>
        </bubbleBoxTrigger>
      </div>
      <div v-for="task of tasks" :key="task.id" class="download-tasks__row">
        <div class="download-tasks__row-main">
          <span class="download-tasks__label">{{ task.label }}</span>
          <bubbleBoxTrigger
            v-if="task.error"
            tag="span"
            class="download-tasks__status download-tasks__status--failed"
            :title="task.error"
            :aria-label="task.error"
          >
            {{ task.statusText }}
          </bubbleBoxTrigger>
          <span
            v-else
            class="download-tasks__status"
            :class="`download-tasks__status--${task.status}`"
          >
            {{ task.statusText }}
          </span>
        </div>
        <div v-if="hasBar(task)" class="download-tasks__bar">
          <div
            class="download-tasks__bar-fill"
            :class="{ 'download-tasks__bar-fill--indeterminate': isIndeterminate(task) }"
            :style="isIndeterminate(task) ? undefined : barStyle(task)"
          ></div>
        </div>
        <div v-if="task.detail" class="download-tasks__detail">{{ task.detail }}</div>
        <div v-if="task.actions.length" class="download-tasks__actions">
          <button
            v-for="action of task.actions"
            :key="action.id"
            class="download-tasks__action"
            :class="{ 'download-tasks__action--primary': action.primary }"
            type="button"
            :disabled="actionDisabled(task, action)"
            @click="runAction(task, action.id)"
          >
            {{ action.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.download-tasks {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: min(320px, calc(100vw - 32px));
  pointer-events: none;
}

.download-tasks__card,
.download-tasks__pill {
  pointer-events: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}

.download-tasks__card {
  width: 300px;
  max-width: 100%;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.download-tasks__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.download-tasks__title {
  font-size: 13px;
  color: var(--text);
}

.download-tasks__minimize {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 18px;
  border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg) 76%, transparent);
  color: var(--text-weak);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.download-tasks__minimize:hover {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  color: var(--text);
}

.download-tasks__minimize-glyph {
  width: 8px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
}

.download-tasks__row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.download-tasks__row-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.download-tasks__label {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-tasks__status {
  flex: 0 0 auto;
  color: var(--text-weak);
  font-variant-numeric: tabular-nums;
}

.download-tasks__status--failed {
  color: var(--danger, #d9534f);
}

.download-tasks__status--ready {
  color: var(--accent);
}

.download-tasks__status--available,
.download-tasks__status--downloaded {
  color: var(--accent);
}

.download-tasks__bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(127, 127, 127, 0.18);
}

.download-tasks__bar-fill {
  height: 100%;
  width: 0;
  background: var(--accent);
  transition: width 0.2s ease;
}

.download-tasks__bar-fill--indeterminate {
  width: 40%;
  animation: download-tasks-indeterminate 1.2s ease-in-out infinite;
}

.download-tasks__detail {
  font-size: 11px;
  color: var(--text-weak);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-tasks__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.download-tasks__action {
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  border-radius: 6px;
  padding: 2px 10px;
  background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  color: var(--text);
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
}

.download-tasks__action:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
  background: color-mix(in srgb, var(--accent) 16%, var(--bg));
}

.download-tasks__action--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}

.download-tasks__action--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 86%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 86%, #ffffff);
}

.download-tasks__action:disabled {
  opacity: 0.5;
  cursor: default;
}

.download-tasks__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  color: var(--text-weak);
  font-size: 12px;
  cursor: pointer;
}

.download-tasks__pill:hover {
  color: var(--text);
}

.download-tasks__badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.download-tasks__spinner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--accent) 34%, transparent);
  border-top-color: var(--accent);
  animation: download-tasks-spin 0.9s linear infinite;
}

@keyframes download-tasks-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

@keyframes download-tasks-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
