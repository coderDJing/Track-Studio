<script setup lang="ts">
import { watch, ref, shallowRef, onUnmounted, onMounted, PropType, nextTick, computed } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { t } from '@renderer/utils/translate'
import { IMenu } from '../../../types/globals'
import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'
import bubbleBox from './bubbleBox.vue'

const uuid = uuidV4()
const runtime = useRuntimeStore()
runtime.activeMenuUUID = uuid

const props = defineProps({
  menuArr: {
    type: Array as PropType<IMenu[][]>,
    required: true
  },
  clickEvent: {
    type: Object,
    required: true
  },
  confirmCallback: {
    type: Function,
    required: true
  },
  cancelCallback: {
    type: Function,
    required: true
  }
})

const menuRef = ref<HTMLDivElement | null>(null)
const isVisible = ref(true)
const isClosing = ref(false)
const closeResult = ref<IMenu | 'cancel'>('cancel')
const menuButtonRefs = ref<Record<string, HTMLElement | null>>({})

const requestClose = (result: IMenu | 'cancel') => {
  if (isClosing.value) return
  isClosing.value = true
  closeResult.value = result
  if (runtime.activeMenuUUID === uuid) {
    runtime.activeMenuUUID = ''
  }
  isVisible.value = false
}

watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      requestClose('cancel')
    }
  }
)

const handleAfterLeave = () => {
  if (closeResult.value === 'cancel') {
    props.cancelCallback()
    return
  }
  props.confirmCallback(closeResult.value)
}

let positionTop = ref(0)
let positionLeft = ref(0)
const maxMenuHeight = ref(0)
const submenuRef = ref<HTMLDivElement | null>(null)
const submenuTop = ref(-9999)
const submenuLeft = ref(-9999)
let leaveTimer: ReturnType<typeof setTimeout> | undefined

positionTop.value = -9999
positionLeft.value = -9999

// Preserve the identity used by submenu lookup and keyboard traversal for raw and reactive menus.
const hoverItem = shallowRef<IMenu | null>(null)
const submenuParent = computed(() => {
  const hovered = hoverItem.value
  return props.menuArr
    .flat()
    .find(
      (item) =>
        !item.disabled &&
        item.children?.length &&
        hovered &&
        (item === hovered || item.children.includes(hovered))
    )
})
const getMenuItemRefKey = (item: IMenu) => item.menuName
const setMenuItemRef = (item: IMenu, element: Element | ComponentPublicInstance | null) => {
  const key = getMenuItemRefKey(item)
  if (element instanceof HTMLElement) {
    menuButtonRefs.value[key] = element
    return
  }
  menuButtonRefs.value[key] = null
}
const resolveDisabledReason = (item: IMenu) => {
  if (item.disabledReasonKey) return t(item.disabledReasonKey)
  return item.disabledReason || ''
}
const resolveTrailingText = (item: IMenu) => {
  if (item.disabled) return t(item.disabledStatusKey || 'common.loading')
  return item.children?.length ? '>' : item.shortcutKey
}
const isMenuItemOver = (item: IMenu) => {
  if (hoverItem.value === null) return false
  return (
    hoverItem.value.menuName === item.menuName ||
    !!item.children?.some((child) => child.menuName === hoverItem.value?.menuName)
  )
}
const isMenuItemEnabled = (item: IMenu) => !item.disabled
const menuButtonClick = (item: IMenu) => {
  if (item.disabled) return
  if (item.children?.length) {
    hoverItem.value = item
    return
  }
  requestClose(item)
}
const cancelMenuLeave = () => {
  clearTimeout(leaveTimer)
}
const mouseover = (item: IMenu) => {
  cancelMenuLeave()
  hoverItem.value = item
}
const mouseleave = (event: MouseEvent) => {
  const target = event.relatedTarget
  if (
    target instanceof Node &&
    (menuRef.value?.contains(target) || submenuRef.value?.contains(target))
  )
    return
  cancelMenuLeave()
  leaveTimer = setTimeout(() => {
    hoverItem.value = null
  }, 120)
}
const updateSubmenuPosition = async () => {
  await nextTick()
  const parent = submenuParent.value
  const submenu = submenuRef.value
  const anchor = parent && menuButtonRefs.value[getMenuItemRefKey(parent)]
  if (!anchor || !submenu || !menuRef.value) return
  const rect = anchor.getBoundingClientRect()
  const menuRect = menuRef.value.getBoundingClientRect()
  const openLeft = menuRect.right + submenu.offsetWidth > window.innerWidth - 8
  const point = resolveContextMenuPoint({
    clickX: openLeft ? menuRect.left - submenu.offsetWidth : menuRect.right,
    clickY: rect.top - 5,
    menuWidth: submenu.offsetWidth,
    menuHeight: submenu.offsetHeight
  })
  submenuTop.value = point.y
  submenuLeft.value = point.x
}
watch(submenuParent, () => {
  submenuTop.value = -9999
  submenuLeft.value = -9999
  void updateSubmenuPosition()
})
const updateMenuPosition = async () => {
  const bounds = resolveContextMenuPoint({
    clickX: 0,
    clickY: 0,
    menuWidth: 0,
    menuHeight: 0
  })
  maxMenuHeight.value = bounds.maxHeight
  await nextTick()
  if (!menuRef.value) return
  const point = resolveContextMenuPoint({
    clickX: props.clickEvent.clientX,
    clickY: props.clickEvent.clientY,
    menuWidth: menuRef.value.offsetWidth,
    menuHeight: menuRef.value.offsetHeight
  })
  positionTop.value = point.y
  positionLeft.value = point.x
  void updateSubmenuPosition()
}
const revealKeyboardItem = async () => {
  const item = hoverItem.value
  if (!item) return
  const parent = submenuParent.value
  if (parent) menuButtonRefs.value[getMenuItemRefKey(parent)]?.scrollIntoView({ block: 'nearest' })
  await updateSubmenuPosition()
  menuButtonRefs.value[getMenuItemRefKey(item)]?.scrollIntoView({ block: 'nearest' })
}
const handleGlobalPointerDown = (event: MouseEvent) => {
  if (!isVisible.value) return
  const target = event.target as Node | null
  if (target && (menuRef.value?.contains(target) || submenuRef.value?.contains(target))) return
  requestClose('cancel')
}
onMounted(() => {
  void updateMenuPosition()
  window.addEventListener('resize', updateMenuPosition)

  const getNavigableItems = () =>
    props.menuArr
      .flat(1)
      .flatMap((item) => [item, ...(item.children || [])])
      .filter(isMenuItemEnabled)

  hotkeys('w', uuid, () => {
    let menuArr = getNavigableItems()
    if (menuArr.length === 0) return false
    const currentIndex = hoverItem.value === null ? -1 : menuArr.indexOf(hoverItem.value)
    if (currentIndex <= 0) {
      hoverItem.value = menuArr[menuArr.length - 1]
    } else {
      hoverItem.value = menuArr[currentIndex - 1]
    }
    void revealKeyboardItem()
    return false
  })
  hotkeys('s', uuid, () => {
    let menuArr = getNavigableItems()
    if (menuArr.length === 0) return false
    const currentIndex = hoverItem.value === null ? -1 : menuArr.indexOf(hoverItem.value)
    if (currentIndex < 0 || currentIndex >= menuArr.length - 1) {
      hoverItem.value = menuArr[0]
    } else {
      hoverItem.value = menuArr[currentIndex + 1]
    }
    void revealKeyboardItem()
    return false
  })
  hotkeys('E,Enter', uuid, () => {
    if (hoverItem.value === null) {
      const flattened = getNavigableItems()
      if (flattened.length === 0) return false
      hoverItem.value = flattened[0]
    }
    if (hoverItem.value && !hoverItem.value.disabled && !hoverItem.value.children?.length) {
      requestClose(hoverItem.value)
    }
  })
  utils.setHotkeysScpoe(uuid)
  window.addEventListener('pointerdown', handleGlobalPointerDown, true)
})

onUnmounted(() => {
  cancelMenuLeave()
  window.removeEventListener('resize', updateMenuPosition)
  utils.delHotkeysScope(uuid)
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
})
</script>
<template>
  <Transition name="context-menu" appear @after-leave="handleAfterLeave">
    <div
      v-if="isVisible"
      ref="menuRef"
      data-frkb-context-menu="true"
      class="menu unselectable"
      :style="{
        top: positionTop + 'px',
        left: positionLeft + 'px',
        maxHeight: maxMenuHeight + 'px'
      }"
      @click.stop="() => {}"
      @mouseenter="cancelMenuLeave"
      @mouseleave.stop="mouseleave"
      @wheel.passive="hoverItem = null"
    >
      <div v-for="item of props.menuArr" class="menuGroup">
        <div
          v-for="button of item"
          :ref="(el) => setMenuItemRef(button, el)"
          class="menuButton"
          :class="{
            menuButtonOver: isMenuItemOver(button),
            menuButtonDisabled: button.disabled
          }"
          :aria-disabled="button.disabled ? 'true' : 'false'"
          @click="menuButtonClick(button)"
          @mouseover.stop="mouseover(button)"
          @contextmenu.stop.prevent="menuButtonClick(button)"
        >
          <span>{{ t(button.menuName) }}</span>
          <span :class="{ menuButtonStatus: button.disabled }">{{
            resolveTrailingText(button)
          }}</span>
          <bubbleBox
            v-if="button.disabled && resolveDisabledReason(button)"
            :dom="menuButtonRefs[getMenuItemRefKey(button)] || undefined"
            :title="resolveDisabledReason(button)"
            :show-delay="250"
            :z-index="'calc(var(--z-context-menu) + 1)'"
          />
        </div>
      </div>
    </div>
  </Transition>
  <Teleport to="body">
    <div
      v-if="isVisible && submenuParent"
      ref="submenuRef"
      data-frkb-context-menu="true"
      class="submenu unselectable"
      :style="{ top: submenuTop + 'px', left: submenuLeft + 'px', maxHeight: maxMenuHeight + 'px' }"
      @mouseenter="cancelMenuLeave"
      @mouseleave="mouseleave"
      @click.stop
      @contextmenu.stop.prevent
    >
      <div
        v-for="child of submenuParent.children"
        :ref="(el) => setMenuItemRef(child, el)"
        class="submenuButton"
        :class="{
          menuButtonOver: hoverItem?.menuName === child.menuName,
          submenuButtonDisabled: child.disabled
        }"
        :aria-disabled="child.disabled ? 'true' : 'false'"
        @click.stop="menuButtonClick(child)"
        @mouseover.stop="mouseover(child)"
        @contextmenu.stop.prevent="menuButtonClick(child)"
      >
        <span>{{ t(child.menuName) }}</span>
        <span :class="{ menuButtonStatus: child.disabled }">{{ resolveTrailingText(child) }}</span>
        <bubbleBox
          v-if="child.disabled && resolveDisabledReason(child)"
          :dom="menuButtonRefs[getMenuItemRefKey(child)] || undefined"
          :title="resolveDisabledReason(child)"
          :show-delay="250"
          :z-index="'calc(var(--z-context-menu) + 1)'"
        />
      </div>
    </div>
  </Teleport>
</template>
<style lang="scss" scoped>
.context-menu-enter-active,
.context-menu-leave-active {
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.context-menu-enter-from,
.context-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.menu {
  position: fixed;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar) transparent;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  font-size: 14px;
  min-width: 250px;
  width: max-content;
  max-width: calc(100vw - 12px);
  border-radius: 5px;
  z-index: var(--z-context-menu);

  .menuGroup {
    border-bottom: 1px solid var(--border);
    padding: 5px 5px;

    .menuButton {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 24px;
      padding: 5px 20px;
      border-radius: 5px;
      color: var(--text);

      &:hover {
        background-color: var(--accent);
        color: #ffffff;
      }
    }

    .menuButton > span {
      white-space: nowrap;
    }

    .menuButton > span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .menuButtonOver {
      background-color: var(--accent);
      color: #ffffff;
    }

    .menuButtonDisabled {
      color: var(--text-weak);
      cursor: default;
      opacity: 0.68;

      &:hover {
        background-color: transparent;
        color: var(--text-weak);
      }
    }

    .menuButtonStatus {
      font-size: 12px;
      color: inherit;
    }
  }

  .menuGroup:last-child {
    border-bottom: 0;
  }
}

.submenu {
  position: fixed;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar) transparent;
  min-width: 220px;
  width: max-content;
  max-width: calc(100vw - 16px);
  padding: 5px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 5px;
  font-size: 14px;
  color: var(--text);
  z-index: var(--z-context-menu);

  .submenuButton {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 24px;
    padding: 5px 20px;
    border-radius: 5px;
    color: var(--text);

    &:hover {
      background-color: var(--accent);
      color: #ffffff;
    }
  }

  .submenuButton > span {
    white-space: nowrap;
  }

  .submenuButton > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .submenuButton.menuButtonOver {
    background-color: var(--accent);
    color: #ffffff;
  }

  .menuButtonStatus {
    font-size: 12px;
    color: inherit;
  }

  .submenuButtonDisabled {
    color: var(--text-weak);
    cursor: default;
    opacity: 0.68;

    &:hover {
      background-color: transparent;
      color: var(--text-weak);
    }
  }
}
</style>
