<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import chromeMinimizeAsset from '@renderer/assets/chrome-minimize.svg?asset'
import logoAsset from '@renderer/assets/logo.png?asset'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { formatWindowTitle } from '@renderer/utils/windowTitle'
import { renderMarkdownToHtml } from '@renderer/utils/releaseNotesMarkdown'
const chromeMinimize = chromeMinimizeAsset
const logo = logoAsset

type ReleasePayload = {
  title: string
  tagName: string
  body: string
  publishedAt: string
  htmlUrl: string
  currentVersion: string
}

const runtime = useRuntimeStore()
const loading = ref(true)
const release = ref<ReleasePayload | null>(null)
const bodyHtml = ref('')
const whatsNewWindowTitle = computed(() => formatWindowTitle(t('whatsNew.title')))
const overlayOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  } as const,
  overflow: {
    x: 'hidden' as const,
    y: 'scroll' as const
  } as const
}

const toggleMinimize = () => {
  window.electron.ipcRenderer.send('whatsNew-toggle-minimize')
}

const toggleClose = () => {
  window.electron.ipcRenderer.send('whatsNew-toggle-close')
}

const acknowledge = () => {
  window.electron.ipcRenderer.send('whatsNew-acknowledge')
}

window.electron.ipcRenderer.on('whatsNew-data', async (_event, payload: ReleasePayload) => {
  release.value = payload
  const rawBody = typeof payload?.body === 'string' ? payload.body : ''
  try {
    bodyHtml.value = rawBody ? await renderMarkdownToHtml(rawBody) : ''
  } catch {
    bodyHtml.value = ''
  }
  loading.value = false
})

const releaseTitle = computed(() => {
  const title = release.value?.title?.trim()
  if (title) return title
  const tag = release.value?.tagName?.trim()
  return tag || ''
})

const publishedText = computed(() => {
  const publishedAt = release.value?.publishedAt
  if (!publishedAt) return ''
  try {
    const dt = new Date(publishedAt)
    if (Number.isNaN(dt.getTime())) return publishedAt
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
      dt.getDate()
    ).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(
      dt.getMinutes()
    ).padStart(2, '0')}`
  } catch {
    return publishedAt
  }
})

watch(
  whatsNewWindowTitle,
  (title) => {
    document.title = title
  },
  { immediate: true }
)
</script>

<template>
  <div class="window-root unselectable">
    <div class="title-bar">
      <div class="title">{{ whatsNewWindowTitle }}</div>
      <div class="toolbar">
        <div v-if="runtime.setting.platform !== 'darwin'" class="logo-area">
          <img :src="logo" style="width: 20px" :draggable="false" class="theme-icon" />
        </div>
        <div class="drag-zone canDrag"></div>
        <div v-if="runtime.setting.platform !== 'darwin'" class="toolbar-actions">
          <div class="toolbar-button" @click="toggleMinimize">
            <img :src="chromeMinimize" :draggable="false" />
          </div>
          <div class="toolbar-button close-button" @click="toggleClose">
            <svg
              width="15"
              height="15"
              viewBox="0 0 15 15"
              xmlns="http://www.w3.org/2000/svg"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
    <div class="content-wrapper">
      <template v-if="loading">
        <div class="content-empty">
          <div class="loading"></div>
        </div>
      </template>
      <template v-else-if="!release">
        <div class="content-empty">
          <div class="empty-text">{{ t('whatsNew.empty') }}</div>
        </div>
      </template>
      <template v-else>
        <div class="info-block">
          <div class="version">{{ releaseTitle }}</div>
          <div v-if="publishedText" class="published">
            {{ t('whatsNew.subtitle', { date: publishedText }) }}
          </div>
        </div>
        <OverlayScrollbarsComponent
          class="body-scroll"
          :options="overlayOptions"
          element="div"
          style="height: 100%; width: 100%"
          defer
        >
          <div class="body-text">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="bodyHtml" class="markdown-body" v-html="bodyHtml"></div>
            <div v-else class="empty-text">{{ t('whatsNew.noChangelog') }}</div>
          </div>
        </OverlayScrollbarsComponent>
      </template>
    </div>
    <div v-if="!loading && release" class="footer">
      <div class="button action-button" @click="acknowledge">{{ t('whatsNew.ok') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
:global(html, body) {
  height: 100%;
  margin: 0;
  overflow: hidden;
}

:global(#app) {
  height: 100%;
}

.window-root {
  --whats-new-code-bg: rgba(255, 255, 255, 0.08);
  --whats-new-pre-bg: rgba(255, 255, 255, 0.06);
  --whats-new-link: color-mix(in srgb, var(--accent) 65%, #ffffff);
  height: 100%;
  max-height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  color: var(--text);
  background-color: var(--bg);
}

:global(.theme-light) .window-root {
  --whats-new-code-bg: rgba(15, 23, 42, 0.06);
  --whats-new-pre-bg: rgba(15, 23, 42, 0.045);
  --whats-new-link: var(--accent);
}

.title-bar {
  position: relative;
  display: flex;
  flex-direction: column;
  background-color: var(--bg);
  border-bottom: 1px solid var(--border);
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 13px;
  z-index: 0;
}

.toolbar {
  width: 100%;
  height: 35px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}

.logo-area {
  z-index: 1;
  padding-left: 10px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.drag-zone {
  flex-grow: 1;
  height: 35px;
  z-index: 1;
}

.toolbar-actions {
  display: flex;
  z-index: 1;
}

.toolbar-button {
  width: 47px;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 35px;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.toolbar-button:hover {
  background-color: var(--hover);
}

.close-button {
  color: var(--text-weak);
}

.close-button:hover {
  color: #ffffff;
  background-color: #e81123;
}

.content-wrapper {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  min-height: 0;
  box-sizing: border-box;
}

.content-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.info-block {
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.body-scroll {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.body-text {
  padding: 16px;
  font-size: 14px;
  line-height: 1.6;
  min-height: 100%;
  box-sizing: border-box;
}

.version {
  font-size: 20px;
  font-weight: 600;
}

.tag {
  font-size: 14px;
  color: var(--text-secondary, var(--border));
}

.published {
  font-size: 13px;
  color: var(--text-weak);
  opacity: 0.85;
}

.loading {
  width: 60px;
  height: 60px;
  border: 5px solid var(--text);
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
  margin: auto;
}

.empty-text {
  margin: auto;
  font-size: 14px;
  color: var(--text-secondary, var(--border));
}

.body-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 16px;
  font-size: 14px;
  line-height: 1.6;

  .empty-text {
    margin: auto;
    font-size: 14px;
    color: var(--text-secondary, var(--border));
    text-align: center;
  }

  :deep(.markdown-body) {
    font-size: 14px;
    line-height: 1.6;
    color: var(--text);
    word-break: break-word;

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      margin: 1.2em 0 0.6em;
      line-height: 1.25;
    }

    p {
      margin: 0.6em 0;
    }

    ul,
    ol {
      padding-left: 1.4em;
      margin: 0.6em 0;
    }

    code {
      font-family:
        ui-monospace, SFMono-Regular, SFMono, Menlo, Monaco, Consolas, 'Liberation Mono',
        'Courier New', monospace;
      background-color: var(--whats-new-code-bg);
      padding: 0.15em 0.35em;
      border-radius: 4px;
    }

    pre {
      padding: 12px;
      border-radius: 8px;
      background-color: var(--whats-new-pre-bg);
      overflow: auto;
    }

    a {
      color: var(--whats-new-link);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }
  }
}

.footer {
  display: flex;
  justify-content: flex-end;
  padding: 12px 20px 20px;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background-color: var(--bg);
}

.action-button {
  width: 110px;
  text-align: center;
}

@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}
</style>
