<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import 'overlayscrollbars/overlayscrollbars.css'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { AppUpdateChannel } from '@shared/appUpdate'
import type { ReleaseNotesRangePayload } from '@shared/releaseNotes'
import {
  buildReleaseNotesMarkdown,
  renderMarkdownToHtml
} from '@renderer/utils/releaseNotesMarkdown'

const props = defineProps<{
  version: string
  releaseDate: string
  channel: AppUpdateChannel
  releaseNotes: ReleaseNotesRangePayload | null
  loading?: boolean
}>()

const emit = defineEmits<{ close: [] }>()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const html = ref('')
const renderSeq = ref(0)

const overlayOptions = {
  scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
  overflow: { x: 'hidden' as const, y: 'scroll' as const }
}

const channelText = computed(() =>
  props.channel === 'rc' ? t('update.rcChannel') : t('update.stableChannel')
)

const rangeText = computed(() => {
  const current = props.releaseNotes?.currentVersion
  const latest = props.releaseNotes?.latestVersion || props.version
  if (!current || !latest) return ''
  return t('update.versionRange', { current, latest })
})

const formatReleasedAt = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

const releasedAtText = computed(() => {
  const formatted = formatReleasedAt(props.releaseDate)
  return formatted ? `${t('update.releaseDate')} ${formatted}` : ''
})

onMounted(async () => {
  const payload = props.releaseNotes
  if (!payload || payload.releases.length === 0) return
  const seq = ++renderSeq.value
  const markdown = buildReleaseNotesMarkdown(payload, t('whatsNew.noChangelog'))
  const rendered = await renderMarkdownToHtml(markdown)
  if (seq === renderSeq.value) html.value = rendered
})

const close = () => closeWithAnimation(() => emit('close'))
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner release-notes-dialog__inner">
      <div class="dialog-title dialog-header">{{ t('update.releaseNotesTitle') }}</div>
      <div class="release-notes-dialog__summary">
        <span class="release-notes-dialog__channel">{{ channelText }}</span>
        <span class="release-notes-dialog__version">{{ version || t('update.newVersion') }}</span>
        <span v-if="releasedAtText" class="release-notes-dialog__muted">{{ releasedAtText }}</span>
        <span v-if="rangeText" class="release-notes-dialog__muted">{{ rangeText }}</span>
      </div>
      <OverlayScrollbarsComponent
        v-if="html"
        class="release-notes-dialog__scroll"
        :options="overlayOptions"
        element="div"
        defer
      >
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="markdown-body" v-html="html"></div>
      </OverlayScrollbarsComponent>
      <div v-else class="release-notes-dialog__empty">
        {{ props.loading ? t('update.releaseNotesLoading') : t('update.releaseNotesEmpty') }}
      </div>
      <div class="dialog-footer">
        <div class="button" @click="close">{{ t('common.close') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.release-notes-dialog__inner {
  width: 620px;
  max-width: 92vw;
  height: 560px;
  max-height: 86vh;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.release-notes-dialog__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  font-size: 12px;
  color: var(--text);
  border-bottom: 1px solid var(--border);
}

.release-notes-dialog__channel {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--bg);
  font-size: 11px;
}

.release-notes-dialog__version {
  font-size: 14px;
  font-weight: 500;
}

.release-notes-dialog__muted {
  color: var(--text-weak);
}

.release-notes-dialog__scroll {
  flex: 1;
  min-height: 0;
  padding: 14px 20px;
}

.release-notes-dialog__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 13px;
}

.markdown-body {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    margin: 1em 0 0.5em;
    line-height: 1.3;
  }

  :deep(h2:first-child) {
    margin-top: 0;
  }

  :deep(p) {
    margin: 0.5em 0;
  }

  :deep(ul),
  :deep(ol) {
    padding-left: 1.35em;
    margin: 0.5em 0;
  }

  :deep(code) {
    padding: 0.12em 0.3em;
    border-radius: 4px;
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }

  :deep(pre) {
    padding: 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--text) 5%, transparent);
    overflow: auto;
  }

  :deep(a) {
    color: var(--accent);
  }
}
</style>
