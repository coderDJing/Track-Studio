<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import type { OverlayScrollbarsComponentRef } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import utils from '@renderer/utils/utils'
import {
  getTextareaCaretY,
  resolveScrollTopToShowRange
} from '@renderer/components/mixtapeChapterDialogCaret'

const scope = uuidV4()
const CHAPTER_SCROLL_HEIGHT = 280

const props = defineProps({
  text: {
    type: String,
    default: ''
  }
})

const emit = defineEmits<{
  (event: 'update:text', value: string): void
  (event: 'close'): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const copied = ref(false)
const copyFailed = ref(false)
const textAreaRef = ref<HTMLTextAreaElement | null>(null)
const scrollRef = ref<OverlayScrollbarsComponentRef | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
const dialogInnerStyle = computed(() => 'width: 560px; display: flex; flex-direction: column')
const scrollbarOptions = {
  scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
  overflow: { x: 'hidden' as const, y: 'scroll' as const }
}
const scrollbarEvents = {
  initialized: () => {
    void nextTick(() => {
      resizeChapterText()
    })
  }
}

const draftText = computed({
  get: () => props.text,
  set: (value: string) => emit('update:text', value)
})

const copyLabel = computed(() => (copied.value ? t('mixtape.chaptersCopied') : t('common.copy')))

const getScrollViewport = (): HTMLElement | undefined => {
  const instance = scrollRef.value?.osInstance?.()
  return instance?.elements?.().viewport as HTMLElement | undefined
}

const resizeChapterText = () => {
  const el = textAreaRef.value
  if (!el) return
  const viewport = getScrollViewport()
  const prevScrollTop = viewport?.scrollTop ?? 0
  const minHeight = Math.max(viewport?.clientHeight || CHAPTER_SCROLL_HEIGHT - 2, 1)
  el.style.height = '0px'
  el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`
  if (viewport) viewport.scrollTop = prevScrollTop
}

const scrollCaretIntoView = () => {
  const el = textAreaRef.value
  const viewport = getScrollViewport()
  if (!el || !viewport) return
  const caret = getTextareaCaretY(el)
  viewport.scrollTop = resolveScrollTopToShowRange(
    viewport.scrollTop,
    viewport.clientHeight,
    caret.top,
    caret.bottom
  )
}

const syncChapterTextLayout = () => {
  resizeChapterText()
  if (textAreaRef.value && textAreaRef.value === document.activeElement) {
    scrollCaretIntoView()
  }
}

const clearCopiedTimer = () => {
  if (!copiedTimer) return
  clearTimeout(copiedTimer)
  copiedTimer = null
}

const writeClipboardText = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

const copyText = async () => {
  copyFailed.value = false
  try {
    await writeClipboardText(draftText.value)
    copied.value = true
    clearCopiedTimer()
    copiedTimer = setTimeout(() => {
      copied.value = false
      copiedTimer = null
    }, 1600)
  } catch {
    copied.value = false
    copyFailed.value = true
  }
}

const close = () => {
  closeWithAnimation(() => {
    emit('close')
  })
}

watch(
  () => draftText.value,
  () => {
    void nextTick(syncChapterTextLayout)
  }
)

onMounted(() => {
  void nextTick(() => {
    resizeChapterText()
  })
  hotkeys('Esc', scope, () => {
    close()
    return false
  })
  utils.setHotkeysScpoe(scope)
})

onUnmounted(() => {
  clearCopiedTimer()
  utils.delHotkeysScope(scope)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner" :style="dialogInnerStyle">
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.chaptersDialogTitle') }}</span>
      </div>
      <div class="dialog-content">
        <div class="hint">{{ t('mixtape.chaptersHint') }}</div>
        <OverlayScrollbarsComponent
          ref="scrollRef"
          class="chapter-scroll"
          element="div"
          :options="scrollbarOptions"
          :events="scrollbarEvents"
          defer
        >
          <textarea
            ref="textAreaRef"
            v-model="draftText"
            class="chapter-text selectable"
            spellcheck="false"
            @keyup="scrollCaretIntoView"
          />
        </OverlayScrollbarsComponent>
        <div v-if="copyFailed" class="copy-error">{{ t('mixtape.chaptersCopyFailed') }}</div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="copyText">{{ copyLabel }}</div>
        <div class="button" @click="close">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.dialog-content {
  padding: 16px 18px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 auto;
}

.hint {
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.chapter-scroll {
  height: 280px;
  min-height: 280px;
  overflow: hidden;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg-elev);

  &:focus-within {
    border-color: var(--accent);
  }
}

.chapter-text {
  display: block;
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  resize: none;
  overflow: hidden;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
  font-family: inherit;
  white-space: pre-wrap;
  outline: none;
  user-select: text;
  -webkit-user-select: text;
}

.copy-error {
  font-size: 13px;
  color: var(--danger, #d35a5a);
}
</style>
