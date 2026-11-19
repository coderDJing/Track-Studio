<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { onMounted, onUnmounted, computed, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'

const uuid = uuidV4()
const runtime = useRuntimeStore()
const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  count: {
    type: Number,
    default: 0
  },
  downloadedCount: {
    type: Number,
    default: 0
  },
  headingKey: {
    type: String,
    default: 'netease.removeFromPlaylist'
  },
  messageKey: {
    type: String,
    default: 'netease.removeFromPlaylistConfirmOnly'
  },
  downloadedCountKey: {
    type: String,
    default: 'netease.removeFromPlaylistDownloadedCount'
  },
  confirmCallback: {
    type: Function
  },
  cancelCallback: {
    type: Function
  }
})

const alsoDeleteLocal = ref(false)
const rememberChoice = ref(false)
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const confirm = () => {
  closeWithAnimation(() => {
    props.confirmCallback?.({
      alsoDeleteLocal: alsoDeleteLocal.value,
      remember: rememberChoice.value
    })
  })
}

const cancel = () => {
  closeWithAnimation(() => {
    props.cancelCallback?.()
  })
}

const innerStyle = computed(() => 'max-height:70vh;width:440px;')

const confirmDialogScrollOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  },
  overflow: {
    x: 'hidden' as const,
    y: 'scroll' as const
  }
}

onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    confirm()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})
runtime.confirmShow = true
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.confirmShow = false
})
</script>
<template>
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    style="font-size: 14px"
  >
    <div
      v-dialog-drag="'.dialog-title'"
      style="display: flex; flex-direction: column"
      class="inner"
      :style="innerStyle"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t(props.headingKey) }}</span>
      </div>
      <OverlayScrollbarsComponent
        class="confirm-dialog__scroll-shell"
        element="div"
        :options="confirmDialogScrollOptions"
        defer
      >
        <div class="confirm-dialog__scroll-content">
          <div class="confirm-dialog__scroll-line">
            <span>{{ t(props.messageKey, { title: props.title, count: props.count }) }}</span>
          </div>
          <div class="confirm-dialog__scroll-line">
            <span>{{ t(props.downloadedCountKey, { count: props.downloadedCount }) }}</span>
          </div>
          <div class="confirm-dialog__options">
            <singleCheckbox v-model="alsoDeleteLocal">
              {{ t('netease.removeFromPlaylistAlsoDeleteLocal') }}
            </singleCheckbox>
            <singleCheckbox v-model="rememberChoice">
              {{ t('netease.removeFromPlaylistRememberChoice') }}
            </singleCheckbox>
          </div>
        </div>
      </OverlayScrollbarsComponent>
      <div class="dialog-footer">
        <div class="button confirm-dialog__button" @click="confirm()">
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button confirm-dialog__button" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.dialog-footer {
  justify-content: center;
  flex-wrap: wrap;
}

.confirm-dialog__scroll-shell {
  flex: 1 1 auto;
  min-height: 0;
}

.confirm-dialog__scroll-content {
  padding: 10px 20px 20px;
  box-sizing: border-box;
}

.confirm-dialog__scroll-line {
  text-align: left;
  line-height: 1.5;
  margin-bottom: 8px;
}

.confirm-dialog__options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
}

.confirm-dialog__button {
  margin: 0 8px;
}
</style>
