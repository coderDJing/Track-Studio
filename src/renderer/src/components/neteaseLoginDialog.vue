<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '@renderer/utils/translate'

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

const qrDataUrl = ref('')
const status = ref<'loading' | 'ready' | 'scanned' | 'expired' | 'failed'>('loading')
const message = ref('')
let unikey = ''
let timer: ReturnType<typeof setInterval> | null = null

const clearTimer = () => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
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
        props.onSuccess()
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
  void requestQr()
})

onBeforeUnmount(() => {
  clearTimer()
})
</script>

<template>
  <div class="dialog unselectable dialog-visible">
    <div class="inner" style="width: 360px; padding: 20px; display: flex; flex-direction: column">
      <div class="dialog-title dialog-header">
        <span>{{ t('netease.login') }}</span>
      </div>
      <div style="margin-top: 16px; font-size: 13px; line-height: 1.6; opacity: 0.85">
        {{ t('netease.loginTip') }}
      </div>
      <div style="margin-top: 14px; display: flex; justify-content: center; min-height: 260px">
        <img
          v-if="qrDataUrl && status !== 'expired'"
          :src="qrDataUrl"
          alt="NetEase login QR"
          style="width: 260px; height: 260px; image-rendering: pixelated"
        />
        <div v-else style="align-self: center; font-size: 13px; opacity: 0.7">
          {{
            status === 'expired'
              ? t('netease.loginExpired')
              : status === 'failed'
                ? t('netease.loginFailed')
                : t('netease.loginLoading')
          }}
        </div>
      </div>
      <div style="margin-top: 10px; min-height: 20px; font-size: 12px; opacity: 0.75">
        <span v-if="status === 'scanned'">{{ t('netease.loginScanned') }}</span>
        <span v-else-if="message">{{ message }}</span>
      </div>
      <div style="margin-top: 18px; display: flex; flex-direction: column; gap: 10px">
        <div class="button" @click="requestQr">{{ t('netease.loginRefresh') }}</div>
        <div class="button" @click="props.onCancel()">{{ t('netease.loginClose') }}</div>
      </div>
    </div>
  </div>
</template>
