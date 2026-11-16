<script setup lang="ts">
import chromeMiniimizeAsset from '@renderer/assets/chrome-minimize.svg?asset'
import logoAsset from '@renderer/assets/logo.png?asset'
import { computed, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import 'overlayscrollbars/overlayscrollbars.css'
import { t } from '@renderer/utils/translate'
import type { UpdateInfo } from 'electron-updater'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { formatWindowTitle } from '@renderer/utils/windowTitle'
import type { ReleaseNotesRangePayload } from '@shared/releaseNotes'
import {
  buildReleaseNotesMarkdown,
  renderMarkdownToHtml
} from '@renderer/utils/releaseNotesMarkdown'
const chromeMiniimize = chromeMiniimizeAsset
const logo = logoAsset

type UpdateErrorPayload = {
  kind?: 'network' | 'signature' | 'install' | 'gone' | 'unknown'
  message?: string
  manualUrl?: string
}

type UpdateDownloadedPayload = {
  mode?: 'auto' | 'manual'
  kind?: 'dmg' | 'pkg' | 'zip' | 'other'
  fileName?: string
  filePath?: string
  downloadDir?: string
}

const toggleMinimize = () => {
  window.electron.ipcRenderer.send('updateWindow-toggle-minimize')
}

const toggleClose = () => {
  window.electron.ipcRenderer.send('updateWindow-toggle-close')
}

const launchedWithStartDownload =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('startDownload') === '1'
const state = ref(launchedWithStartDownload ? 'isUpdateProgress' : 'isRequesting')
const errorInfo = ref<Required<UpdateErrorPayload>>({
  kind: 'network',
  message: '',
  manualUrl: ''
})
const downloadedInfo = ref<Required<UpdateDownloadedPayload>>({
  mode: 'auto',
  kind: 'other',
  fileName: '',
  filePath: '',
  downloadDir: ''
})
const updateWindowTitle = computed(() => formatWindowTitle(t('menu.checkUpdate')))

watch(
  updateWindowTitle,
  (title) => {
    document.title = title
  },
  { immediate: true }
)

const latestVersion = ref('')
window.electron.ipcRenderer.on('isLatestVersion', (_event, version) => {
  latestVersion.value = version
  state.value = 'isLatest'
})

window.electron.ipcRenderer.on('isRequesting', () => {
  state.value = 'isRequesting'
})

const newVersionInfo = ref<UpdateInfo>({
  version: '',
  files: [],
  path: '',
  sha512: '',
  releaseDate: ''
})
const releaseNotesRange = ref<ReleaseNotesRangePayload | null>(null)
const releaseNotesLoading = ref(false)
const releaseNotesHtml = ref('')
let releaseNotesRenderSeq = 0
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

const updateReleaseNotesHtml = async (payload: ReleaseNotesRangePayload | null) => {
  const seq = ++releaseNotesRenderSeq
  if (!payload || payload.releases.length === 0) {
    releaseNotesHtml.value = ''
    return
  }
  const markdown = buildReleaseNotesMarkdown(payload, t('whatsNew.noChangelog'))
  const html = await renderMarkdownToHtml(markdown)
  if (seq === releaseNotesRenderSeq) {
    releaseNotesHtml.value = html
  }
}

window.electron.ipcRenderer.on('newVersion', (_event, versionInfo: UpdateInfo) => {
  newVersionInfo.value = versionInfo
  if (state.value === 'isUpdateProgress' || state.value === 'isUpdateDownloaded') {
    return
  }
  releaseNotesRange.value = null
  releaseNotesHtml.value = ''
  releaseNotesLoading.value = true
  state.value = 'isNewVersion'
})

window.electron.ipcRenderer.on(
  'releaseNotesRange',
  (_event, payload: ReleaseNotesRangePayload | null) => {
    releaseNotesLoading.value = false
    releaseNotesRange.value = payload || null
    void updateReleaseNotesHtml(releaseNotesRange.value)
  }
)

window.electron.ipcRenderer.on('isError', (_event, payload?: UpdateErrorPayload) => {
  errorInfo.value = {
    kind: payload?.kind || 'unknown',
    message: typeof payload?.message === 'string' ? payload.message : '',
    manualUrl: typeof payload?.manualUrl === 'string' ? payload.manualUrl : ''
  }
  state.value = 'isError'
})

function convertISOToCustomFormat(isoString: string) {
  const date = new Date(isoString)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

const startDownload = () => {
  window.electron.ipcRenderer.send('updateWindow-startDownload')
  state.value = 'isUpdateProgress'
}
const checkNewVersion = () => {
  window.electron.ipcRenderer.send('updateWindow-recheck')
  state.value = 'isRequesting'
}
const progress = ref({
  percent: 0,
  bytesPerSecond: 0,
  transferredBytes: 0,
  totalBytes: 0,
  fileName: ''
})
window.electron.ipcRenderer.on('updateProgress', (_event, progressObj) => {
  progress.value = {
    percent: Number(progressObj?.percent) || 0,
    bytesPerSecond: Number(progressObj?.bytesPerSecond) || 0,
    transferredBytes: Math.max(0, Number(progressObj?.transferredBytes) || 0),
    totalBytes: Math.max(0, Number(progressObj?.totalBytes) || 0),
    fileName: typeof progressObj?.fileName === 'string' ? progressObj.fileName : ''
  }
  state.value = 'isUpdateProgress'
})

function convertBytesToUnits(bytesPerSecond: number) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']
  let unitIndex = 0
  let convertedValue = bytesPerSecond

  while (convertedValue >= 1024 && unitIndex < units.length - 1) {
    convertedValue /= 1024
    unitIndex++
  }

  return `${convertedValue.toFixed(2)} ${units[unitIndex]}`
}

window.electron.ipcRenderer.on('updateDownloaded', (_event, payload?: UpdateDownloadedPayload) => {
  downloadedInfo.value = {
    mode: payload?.mode || 'auto',
    kind: payload?.kind || 'other',
    fileName: typeof payload?.fileName === 'string' ? payload.fileName : '',
    filePath: typeof payload?.filePath === 'string' ? payload.filePath : '',
    downloadDir: typeof payload?.downloadDir === 'string' ? payload.downloadDir : ''
  }
  state.value = 'isUpdateDownloaded'
})

const runtime = useRuntimeStore()
const errorHintText = computed(() => {
  switch (errorInfo.value.kind) {
    case 'signature':
      return t('update.signatureIssue')
    case 'install':
      return t('update.installIssue')
    case 'unknown':
      return t('update.unknownIssue')
    case 'gone':
      return t('update.goneIssue')
    default:
      return t('update.networkIssue')
  }
})

const hasManualDownload = computed(() => !!errorInfo.value.manualUrl)
const canRetryDownload = computed(
  () => errorInfo.value.kind === 'network' || errorInfo.value.kind === 'unknown'
)
const canCheckNewVersion = computed(() => errorInfo.value.kind === 'gone')
const isManualMacUpdate = computed(
  () => runtime.setting.platform === 'darwin' && downloadedInfo.value.mode === 'manual'
)
// Windows 与 macOS 都由 electron-updater 原地替换，重启即完成升级；
// 只有 macOS 走手动安装包时才是 manual 模式。
const canRestartFrkbForUpdate = computed(
  () =>
    (runtime.setting.platform === 'win32' || runtime.setting.platform === 'darwin') &&
    downloadedInfo.value.mode === 'auto'
)
const startUpdateText = computed(() =>
  runtime.setting.platform === 'darwin' ? t('update.downloadUpdate') : t('update.startUpdate')
)
const releaseNotesChannelText = computed(() => {
  if (releaseNotesRange.value?.channel === 'rc' || newVersionInfo.value.version.includes('-')) {
    return t('update.rcChannel')
  }
  return t('update.stableChannel')
})
const releaseNotesRangeText = computed(() => {
  const current = releaseNotesRange.value?.currentVersion
  const latest = releaseNotesRange.value?.latestVersion || newVersionInfo.value.version
  if (!current || !latest) return ''
  return t('update.versionRange', { current, latest })
})
const downloadedText = computed(() =>
  isManualMacUpdate.value ? t('update.manualReadyTitle') : t('update.updateDownloaded')
)
const savedLocationText = computed(
  () => downloadedInfo.value.filePath || downloadedInfo.value.downloadDir
)
const manualSteps = computed(() => [
  t('update.manualStepOpenFile'),
  t('update.manualStepCloseApp'),
  t('update.manualStepReplaceApp'),
  t('update.manualStepReplaceConfirm'),
  t('update.manualStepOpenFromApps'),
  t('update.manualStepRightClickOpen')
])

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let value = Math.max(0, Number(bytes) || 0)
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

const progressAmountText = computed(() => {
  if (progress.value.transferredBytes <= 0 && progress.value.totalBytes <= 0) return ''
  const downloaded = formatBytes(progress.value.transferredBytes)
  const total =
    progress.value.totalBytes > 0
      ? formatBytes(progress.value.totalBytes)
      : t('update.totalUnknown')
  return t('update.downloadProgressAmount', { downloaded, total })
})

const openManualDownload = () => {
  window.electron.ipcRenderer.send('updateWindow-open-manual-download')
}

const openDownloadedFile = () => {
  window.electron.ipcRenderer.send('updateWindow-open-downloaded-file')
}

const openDownloadFolder = () => {
  window.electron.ipcRenderer.send('updateWindow-open-download-folder')
}

const openApplicationsFolder = () => {
  window.electron.ipcRenderer.send('updateWindow-open-applications-folder')
}

const quitApp = () => {
  window.electron.ipcRenderer.send('updateWindow-quit-app')
}

const restartFrkbForUpdate = () => {
  window.electron.ipcRenderer.send('updateWindow-restart-app-for-update')
}

const restartFrkbLater = () => {
  toggleClose()
}
</script>
<template>
  <div
    style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column"
    class="unselectable"
  >
    <div>
      <div class="title unselectable">{{ updateWindowTitle }}</div>
      <div class="titleComponent unselectable">
        <div
          v-if="runtime.setting.platform !== 'darwin'"
          style="
            z-index: 1;
            padding-left: 10px;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <img :src="logo" style="width: 20px" :draggable="false" class="theme-icon" />
        </div>

        <div class="canDrag" style="flex-grow: 1; height: 35px; z-index: 1"></div>
        <div v-if="runtime.setting.platform !== 'darwin'" style="display: flex; z-index: 1">
          <div class="rightIcon" @click="toggleMinimize()">
            <img :src="chromeMiniimize" :draggable="false" />
          </div>
          <div class="rightIcon closeIcon" @click="toggleClose()">
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
    <div
      v-if="state === 'isRequesting'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div class="loading"></div>
    </div>
    <div
      v-else-if="state === 'isLatest'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div>{{ t('update.noUpdatesAvailable') }}</div>
      <div style="margin-top: 15px">{{ t('update.currentVersion') }} {{ latestVersion }}</div>
    </div>
    <div
      v-else-if="state === 'isError'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div>{{ t('update.updateFailed') }}</div>
      <div
        style="margin-top: 15px; max-width: 80%; word-wrap: break-word; overflow-wrap: break-word"
      >
        {{ errorHintText }}
      </div>
      <div
        v-if="errorInfo.message"
        style="
          margin-top: 12px;
          max-width: 88%;
          font-size: 12px;
          color: var(--text-weak);
          word-wrap: break-word;
          overflow-wrap: break-word;
          text-align: center;
        "
      >
        {{ errorInfo.message }}
      </div>
      <div
        v-if="canRetryDownload || canCheckNewVersion || hasManualDownload"
        style="margin-top: 20px; display: flex; justify-content: center; flex-wrap: wrap; gap: 12px"
      >
        <div v-if="canCheckNewVersion" class="button" @click="checkNewVersion()">
          {{ t('update.checkNewVersion') }}
        </div>
        <div v-if="canRetryDownload" class="button" @click="startDownload()">
          {{ t('update.retryDownload') }}
        </div>
        <div v-if="hasManualDownload" class="button" @click="openManualDownload()">
          {{ t('update.manualDownload') }}
        </div>
      </div>
    </div>
    <div v-else-if="state === 'isNewVersion'" class="update-state-content new-version-content">
      <section class="new-version-summary">
        <div class="channel-pill">{{ releaseNotesChannelText }}</div>
        <div class="new-version-line">
          {{ t('update.newVersion') }} {{ newVersionInfo.version }}
        </div>
        <div class="muted-line">
          {{ t('update.releaseDate') }} {{ convertISOToCustomFormat(newVersionInfo.releaseDate) }}
        </div>
        <div v-if="releaseNotesRangeText" class="muted-line">{{ releaseNotesRangeText }}</div>
      </section>
      <section class="release-notes-panel">
        <div class="release-notes-heading">{{ t('update.releaseNotesTitle') }}</div>
        <div v-if="releaseNotesLoading" class="release-notes-status">
          <div class="loading small-loading"></div>
          <span>{{ t('update.releaseNotesLoading') }}</span>
        </div>
        <OverlayScrollbarsComponent
          v-else-if="releaseNotesHtml"
          class="release-notes-scroll"
          :options="overlayOptions"
          element="div"
          defer
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="markdown-body" v-html="releaseNotesHtml"></div>
        </OverlayScrollbarsComponent>
        <div v-else class="release-notes-status">
          {{ t('update.releaseNotesEmpty') }}
        </div>
      </section>
      <div class="new-version-actions">
        <div class="button" @click="startDownload()">{{ startUpdateText }}</div>
      </div>
    </div>
    <div
      v-else-if="state === 'isUpdateProgress'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div>
        {{ t('update.downloadingUpdate') }} {{ convertBytesToUnits(progress.bytesPerSecond) }}
      </div>
      <div
        v-if="progressAmountText"
        style="margin-top: 10px; font-size: 12px; color: var(--text-weak)"
      >
        {{ progressAmountText }}
      </div>
      <div
        style="width: 90%; margin-top: 15px; border: 1px solid var(--border); position: relative"
      >
        <div
          :style="{ width: progress.percent.toFixed(2) + '%' }"
          style="
            text-align: center;
            height: 20px;
            line-height: 20px;
            background-color: var(--accent);
          "
        ></div>
        <div
          style="
            text-align: center;
            height: 20px;
            line-height: 20px;
            width: 100%;
            position: absolute;
            top: 0;
            left: 0;
          "
        >
          {{ progress.percent.toFixed(2) }}%
        </div>
      </div>
    </div>
    <div
      v-else-if="state === 'isUpdateDownloaded'"
      style="
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-direction: column;
      "
    >
      <div style="max-width: 80%; word-wrap: break-word; overflow-wrap: break-word">
        {{ downloadedText }}
      </div>
      <template v-if="canRestartFrkbForUpdate">
        <div
          style="
            margin-top: 20px;
            display: flex;
            justify-content: center;
            flex-wrap: wrap;
            gap: 12px;
          "
        >
          <div class="button primary" @click="restartFrkbForUpdate()">
            {{ t('update.restartFrkbNow') }}
          </div>
          <div class="button" @click="restartFrkbLater()">
            {{ t('update.restartFrkbLater') }}
          </div>
        </div>
      </template>
      <template v-if="isManualMacUpdate">
        <div
          v-if="savedLocationText"
          style="
            margin-top: 14px;
            max-width: 88%;
            font-size: 12px;
            color: var(--text-weak);
            word-wrap: break-word;
            overflow-wrap: break-word;
            text-align: center;
          "
        >
          {{ t('update.savedTo') }} {{ savedLocationText }}
        </div>
        <div
          style="
            margin-top: 16px;
            max-width: 86%;
            padding: 10px 12px;
            border-radius: 8px;
            background: color-mix(in srgb, var(--accent) 14%, var(--bg));
            border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
            text-align: center;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
          "
        >
          <div>{{ t('update.manualCloseWarning') }}</div>
          <div class="button primary" @click="quitApp()">{{ t('update.quitApp') }}</div>
        </div>
        <div
          style="
            margin-top: 18px;
            max-width: 86%;
            display: flex;
            flex-direction: column;
            gap: 8px;
            text-align: left;
          "
        >
          <div v-for="step in manualSteps" :key="step">{{ step }}</div>
        </div>
        <div
          style="
            margin-top: 20px;
            display: flex;
            justify-content: center;
            flex-wrap: wrap;
            gap: 12px;
          "
        >
          <div class="button" @click="openDownloadedFile()">
            {{ t('update.openDownloadedFile') }}
          </div>
          <div class="button" @click="openDownloadFolder()">
            {{ t('update.openDownloadFolder') }}
          </div>
          <div class="button" @click="openApplicationsFolder()">
            {{ t('update.openApplicationsFolder') }}
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss">
.button {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  font-size: 14px;

  &:hover {
    color: #ffffff;
    background-color: var(--accent);
  }

  &.primary {
    color: #ffffff;
    background-color: var(--accent);

    &:hover {
      color: #ffffff;
      background-color: color-mix(in srgb, var(--accent) 82%, #000000);
    }
  }
}

#app {
  --release-notes-code-bg: rgba(255, 255, 255, 0.08);
  --release-notes-pre-bg: rgba(255, 255, 255, 0.06);
  color: var(--text);
  background-color: var(--bg);
  width: 100vw;
  height: 100vh;
}

.theme-light #app {
  --release-notes-code-bg: rgba(15, 23, 42, 0.06);
  --release-notes-pre-bg: rgba(15, 23, 42, 0.045);
}

body {
  margin: 0px;
  background-color: var(--bg-elev);
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: var(--bg);
  z-index: 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.titleComponent {
  width: 100vw;
  height: 35px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  box-sizing: border-box;

  .rightIcon {
    width: 47px;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 35px;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .rightIcon:hover {
    background-color: var(--hover);
  }

  .closeIcon {
    color: var(--text-weak);
  }

  .closeIcon:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}

.loading {
  width: 60px;
  height: 60px;
  border: 5px solid var(--text);
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

.small-loading {
  width: 20px;
  height: 20px;
  border-width: 3px;
}

.update-state-content {
  flex-grow: 1;
  min-height: 0;
}

.new-version-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 24px;
  box-sizing: border-box;
}

.new-version-summary {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.channel-pill {
  width: fit-content;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: #ffffff;
  background-color: var(--accent);
}

.new-version-line {
  font-size: 20px;
  font-weight: 600;
}

.muted-line {
  font-size: 13px;
  color: var(--text-weak);
}

.release-notes-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background-color: var(--bg-elev);
}

.release-notes-heading {
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

.release-notes-scroll {
  flex: 1;
  min-height: 0;
  padding: 12px 14px;
}

.release-notes-status {
  flex: 1;
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-weak);
  font-size: 13px;
}

.new-version-actions {
  display: flex;
  justify-content: flex-end;
}

.markdown-body {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  word-break: break-word;

  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    margin: 1em 0 0.5em;
    line-height: 1.25;
  }

  h2:first-child {
    margin-top: 0;
  }

  p {
    margin: 0.5em 0;
  }

  ul,
  ol {
    padding-left: 1.35em;
    margin: 0.5em 0;
  }

  code {
    background-color: var(--release-notes-code-bg);
    padding: 0.12em 0.3em;
    border-radius: 4px;
  }

  pre {
    padding: 10px;
    border-radius: 8px;
    background-color: var(--release-notes-pre-bg);
    overflow: auto;
  }
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
