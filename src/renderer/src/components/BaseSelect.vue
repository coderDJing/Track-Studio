<template>
  <div
    ref="triggerRef"
    class="base-select"
    :class="{
      'base-select--open': isOpen && !disabled,
      'base-select--disabled': disabled
    }"
    :style="wrapperStyle"
    role="combobox"
    :aria-expanded="isOpen"
    :aria-disabled="disabled"
    :tabindex="disabled ? -1 : 0"
    @click="toggleDropdown"
    @keydown.stop="handleKeydown"
  >
    <div class="base-select__value">
      <span v-if="selectedLabel">{{ selectedLabel }}</span>
      <span v-else class="base-select__placeholder">{{ placeholder }}</span>
    </div>
    <div class="base-select__arrow" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </div>
    <transition name="base-select-fade">
      <OverlayScrollbarsComponent
        v-if="isOpen"
        class="base-select__dropdown"
        :options="scrollbarOptions"
        element="div"
        :style="{ maxHeight: `${maxHeight}px` }"
        @click.stop
      >
        <ul class="base-select__dropdown-list" role="listbox">
          <li
            v-for="(option, index) in normalizedOptions"
            :key="getOptionKey(option, index)"
            class="base-select__option"
            :class="{
              'is-selected': option.value === modelValue,
              'is-highlighted': index === highlightIndex,
              'is-disabled': option.disabled
            }"
            role="option"
            :aria-selected="option.value === modelValue"
            @click.stop="selectOption(option)"
          >
            <slot name="option" :option="option">
              {{ option.label }}
            </slot>
          </li>
          <li v-if="!normalizedOptions.length" class="base-select__empty">
            {{ emptyText }}
          </li>
        </ul>
      </OverlayScrollbarsComponent>
    </transition>
  </div>
  <bubbleBox
    v-if="showBubble"
    :dom="triggerRef || undefined"
    :title="selectedLabel || placeholder"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'

type SelectValue = string | number | boolean | null | undefined

export interface SelectOption {
  label: string
  value: SelectValue
  disabled?: boolean
}

const props = defineProps({
  modelValue: {
    type: [String, Number, Boolean, Object] as PropType<SelectValue>,
    default: undefined
  },
  options: {
    type: Array as PropType<SelectOption[]>,
    default: () => []
  },
  placeholder: {
    type: String,
    default: ''
  },
  disabled: {
    type: Boolean,
    default: false
  },
  emptyText: {
    type: String,
    default: '--'
  },
  maxHeight: {
    type: Number,
    default: 220
  },
  width: {
    type: [Number, String],
    default: '200px'
  },
  showBubble: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: SelectValue): void
  (event: 'change', value: SelectValue): void
}>()

const isOpen = ref(false)
const highlightIndex = ref(-1)
const triggerRef = ref<HTMLElement | null>(null)

const normalizedOptions = computed(() => props.options ?? [])

const selectedOption = computed(() =>
  normalizedOptions.value.find((option) => option.value === props.modelValue)
)

const selectedLabel = computed(() => selectedOption.value?.label ?? '')

const wrapperStyle = computed(() => {
  if (!props.width) {
    return undefined
  }

  const parsedWidth = typeof props.width === 'number' ? `${props.width}px` : props.width

  return { width: parsedWidth }
})

const scrollbarOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  },
  overflow: {
    x: 'hidden',
    y: 'scroll'
  } as const
}

const getOptionKey = (option: SelectOption, index: number) => {
  const { value, label } = option
  if (value !== null && value !== undefined) {
    return typeof value === 'boolean' ? `bool-${value}` : value
  }
  if (label) {
    return `label-${label}-${index}`
  }
  return index
}

const findSelectableIndex = (start: number, direction: 1 | -1) => {
  if (!normalizedOptions.value.length) {
    return -1
  }

  let newIndex = start
  do {
    newIndex += direction
  } while (
    newIndex >= 0 &&
    newIndex < normalizedOptions.value.length &&
    normalizedOptions.value[newIndex]?.disabled
  )

  if (newIndex < 0 || newIndex >= normalizedOptions.value.length) {
    return start
  }

  return newIndex
}

const openDropdown = () => {
  if (props.disabled || !normalizedOptions.value.length) {
    return
  }
  const currentIndex = normalizedOptions.value.findIndex(
    (option) => option.value === props.modelValue
  )
  highlightIndex.value = currentIndex
  isOpen.value = true
}

const closeDropdown = () => {
  isOpen.value = false
  highlightIndex.value = -1
}

const toggleDropdown = () => {
  if (props.disabled) {
    return
  }
  if (isOpen.value) {
    closeDropdown()
  } else {
    openDropdown()
  }
}

const selectOption = (option: SelectOption) => {
  if (option.disabled) {
    return
  }
  const changed = option.value !== props.modelValue
  emit('update:modelValue', option.value)
  if (changed) {
    emit('change', option.value)
  }
  closeDropdown()
}

const selectByIndex = (index: number) => {
  const option = normalizedOptions.value[index]
  if (!option || option.disabled) {
    return
  }
  selectOption(option)
}

const handleKeydown = (event: KeyboardEvent) => {
  if (props.disabled) {
    return
  }

  if (!normalizedOptions.value.length) {
    if (event.key === 'Escape') {
      closeDropdown()
    }
    return
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      if (highlightIndex.value === -1) {
        highlightIndex.value = 0
      }
      return
    }
    highlightIndex.value = findSelectableIndex(highlightIndex.value, 1)
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      if (highlightIndex.value === -1) {
        highlightIndex.value = normalizedOptions.value.length - 1
      }
      return
    }
    if (highlightIndex.value <= 0) {
      return
    }
    highlightIndex.value = findSelectableIndex(highlightIndex.value, -1)
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      return
    }
    selectByIndex(
      highlightIndex.value > -1
        ? highlightIndex.value
        : normalizedOptions.value.findIndex((option) => option.value === props.modelValue)
    )
    return
  }

  if (event.key === 'Escape') {
    closeDropdown()
  }
}

const handleClickOutside = (event: MouseEvent) => {
  if (!isOpen.value || !triggerRef.value) {
    return
  }
  const target = event.target as Node | null
  if (target && triggerRef.value.contains(target)) {
    return
  }
  closeDropdown()
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped lang="scss">
.base-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 30px 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
  user-select: none;
  width: 200px;

  &:hover {
    border-color: var(--accent);
  }

  &:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.base-select--disabled {
  cursor: not-allowed;
  color: var(--text-secondary, #8c8c8c);
  border-color: var(--border);
  background-color: var(--bg, #1b1b1b);
}

.base-select--open {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.base-select__value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.base-select__placeholder {
  color: var(--text-secondary, #8c8c8c);
}

.base-select__arrow {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--text-secondary, #8c8c8c);
  transition: transform 0.2s ease;
  pointer-events: none;

  svg {
    width: 100%;
    height: 100%;
  }
}

.base-select--open .base-select__arrow {
  transform: translateY(-50%) rotate(180deg);
}

.base-select__dropdown {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  border-radius: 6px;
  border: 1px solid var(--border);
  background-color: var(--bg-elev);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.base-select__dropdown-list {
  list-style: none;
  padding: 5px 0;
  margin: 0;
}

.base-select__option {
  padding: 6px 12px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--text);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;

  &.is-selected {
    color: var(--accent);
    font-weight: 600;
  }

  &.is-highlighted {
    background-color: var(--hover);
  }

  &.is-disabled {
    color: var(--text-secondary, #8c8c8c);
    cursor: not-allowed;
  }

  &:not(.is-disabled):hover {
    background-color: var(--hover);
  }
}

.base-select__empty {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary, #8c8c8c);
  text-align: center;
}

.base-select-fade-enter-active,
.base-select-fade-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.base-select-fade-enter-from,
.base-select-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
