<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

/**
 * 网易云扫码登录。
 *
 * 二维码由主进程生成（自实现的 QR 编码器 → PNG → data URL），这里只负责显示与轮询。
 * 关键约束：unikey 一码一 key 且几分钟过期，所以整个过程不许重新申请；
 * 过期就提示用户点「重新获取」，而不是自动刷新（自动刷新会让正在扫的码失效）。
 */

const props = defineProps<{
  onSuccess: () => void
  onCancel: () => void
}>()

const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const qrDataUrl = ref('')
const status = ref<'loading' | 'ready' | 'scanned' | 'expired' | 'failed'>('loading')
const message = ref('')
let unikey = ''
let timer: ReturnType<typeof setInterval> | null = null

/** 扫码必须用手机上的网易云音乐 App，没装的用户从这里去官网取。 */
const OFFICIAL_SITE_URL = 'https://music.163.com'
const openOfficialSite = () => {
  window.electron.ipcRenderer.send('openLocalBrowser', OFFICIAL_SITE_URL)
}

const clearTimer = () => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

const close = (ok: boolean) => {
  closeWithAnimation(() => {
    if (ok) props.onSuccess()
    else props.onCancel()
  })
}

const cancel = () => {
  close(false)
}

const succeed = () => {
  close(true)
}

const startPolling = () => {
  clearTimer()
  timer = setInterval(async () => {
    if (!unikey) return
    try {
      const result = (await window.electron.ipcRenderer.invoke('netease:login-poll', {
        unikey
      })) as { code: number }
      if (result?.code === 802) status.value = 'scanned'
      if (result?.code === 800) {
        status.value = 'expired'
        message.value = t('netease.loginExpiredHint')
        clearTimer()
      }
      if (result?.code === 803) {
        status.value = 'ready'
        clearTimer()
        succeed()
      }
    } catch (error) {
      status.value = 'failed'
      message.value = error instanceof Error ? error.message : t('netease.loginFailed')
      clearTimer()
    }
  }, 2000)
}

const requestQr = async () => {
  clearTimer()
  status.value = 'loading'
  message.value = ''
  try {
    const result = (await window.electron.ipcRenderer.invoke('netease:login-start')) as {
      unikey: string
      qrDataUrl: string
    }
    unikey = String(result?.unikey || '')
    qrDataUrl.value = String(result?.qrDataUrl || '')
    status.value = unikey ? 'ready' : 'failed'
    if (unikey) startPolling()
  } catch (error) {
    status.value = 'failed'
    message.value = error instanceof Error ? error.message : t('netease.loginFailed')
  }
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
  void requestQr()
})

onUnmounted(() => {
  clearTimer()
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner login-inner">
      <div class="dialog-title dialog-header">
        <span>{{ t('netease.login') }}</span>
      </div>
      <div class="login-body">
        <div class="login-tip">{{ t('netease.loginTip') }}</div>
        <div class="login-qr">
          <div class="login-qr-frame">
            <img
              v-if="qrDataUrl && status !== 'expired'"
              :src="qrDataUrl"
              alt=""
              class="login-qr-image"
            />
            <div v-else class="login-qr-placeholder">
              {{
                status === 'expired'
                  ? t('netease.loginExpired')
                  : status === 'failed'
                    ? t('netease.loginFailed')
                    : t('netease.loginLoading')
              }}
            </div>
          </div>
        </div>
        <div class="login-status">
          <span v-if="status === 'scanned'">{{ t('netease.loginScanned') }}</span>
          <span v-else-if="message">{{ message }}</span>
        </div>
        <div class="login-official">
          <span class="login-official-hint">{{ t('netease.loginOfficialHint') }}</span>
          <button type="button" class="login-official-link" @click="openOfficialSite">
            <span>{{ t('netease.loginOfficialLink') }}</span>
            <svg class="login-official-icon" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4.9 2.4h4.7v4.7" />
              <path d="M9.6 2.4 2.9 9.1" />
            </svg>
          </button>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button login-footer-button" @click="requestQr">
          {{ t('netease.loginRefresh') }}
        </div>
        <div class="button login-footer-button" @click="cancel">
          {{ t('netease.loginClose') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.login-inner {
  width: 400px;
  display: flex;
  flex-direction: column;
}

.login-body {
  padding: 16px 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-tip {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-weak);
}

.login-qr {
  display: flex;
  justify-content: center;
}

.login-qr-frame {
  width: 240px;
  height: 240px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
}

.login-qr-image {
  width: 240px;
  height: 240px;
  image-rendering: pixelated;
  display: block;
}

.login-qr-placeholder {
  font-size: 14px;
  color: var(--text-weak);
  text-align: center;
  padding: 0 16px;
}

.login-status {
  min-height: 20px;
  font-size: 13px;
  color: var(--text-weak);
  text-align: center;
}

/* 「没有 App」的兜底入口：一行弱提示 + 一枚外链小药丸，不抢二维码的注意力。 */
.login-official {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: -4px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-weak);
}

.login-official-hint {
  opacity: 0.85;
}

.login-official-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    opacity 0.15s ease;
}

.login-official-link:hover {
  background: var(--hover);
  border-color: var(--text-weak);
}

.login-official-link:active {
  opacity: 0.75;
}

.login-official-link:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.login-official-icon {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.75;
}

.login-footer-button {
  min-width: 90px;
  text-align: center;
  box-sizing: border-box;
}
</style>
