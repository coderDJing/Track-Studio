<script setup lang="ts">
import { computed, watch, ref, PropType, onMounted, onUnmounted, nextTick } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidV4 } from 'uuid'
import tickIconAsset from '@renderer/assets/tickIcon.svg?asset'
import { t } from '@renderer/utils/translate'
import { ISongsAreaColumn } from '../../../types/globals'
import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'
const uuid = uuidV4()
const runtime = useRuntimeStore()
const tickIcon = tickIconAsset
const menuRef = ref<HTMLDivElement | null>(null)

const ENERGY_COLUMN_KEYS = new Set([
  'energyScore',
  'dancefloorScore',
  'danceabilityScore',
  'rhythmicScore',
  'drivingScore',
  'mainSectionScore',
  'highEnergyCoverageScore',
  'dropScore',
  'breakdownScore',
  'peakScore',
  'rangeScore',
  'confidence'
])
const COMMON_COLUMN_KEYS = new Set([
  'index',
  'cover',
  'waveformPreview',
  'title',
  'artist',
  'duration',
  'bpm',
  'key'
])

const emits = defineEmits(['update:modelValue', 'colMenuHandleClick'])
watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      emits('update:modelValue', false)
    }
  }
)
const props = defineProps({
  columnData: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  modelValue: {
    type: Boolean,
    required: true
  },
  clickEvent: {
    type: Object as PropType<MouseEvent | null>,
    default: null
  }
})

const groupedColumns = computed(() => {
  const groups = [
    { id: 'common', label: 'columns.columnMenuCommon', keys: COMMON_COLUMN_KEYS },
    { id: 'energy', label: 'columns.columnMenuEnergy', keys: ENERGY_COLUMN_KEYS },
    { id: 'details', label: 'columns.columnMenuDetails', keys: null }
  ]
  return groups
    .map((group) => ({
      ...group,
      columns: props.columnData.filter((column) =>
        group.keys
          ? group.keys.has(column.key)
          : !COMMON_COLUMN_KEYS.has(column.key) && !ENERGY_COLUMN_KEYS.has(column.key)
      )
    }))
    .filter((group) => group.columns.length > 0)
})

const visibleColumnCount = computed(() => props.columnData.filter((column) => column.show).length)

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      runtime.activeMenuUUID = uuid
      positionLeft.value = -9999
      positionTop.value = -9999
      void updateMenuPosition()
    }
  }
)
const menuButtonClick = (item: ISongsAreaColumn) => {
  if (props.columnData.filter((col) => col.show).length == 1 && item.show) {
    return
  }
  emits('colMenuHandleClick', item)
}

const closeMenu = () => {
  if (!props.modelValue) return
  if (runtime.activeMenuUUID === uuid) {
    runtime.activeMenuUUID = ''
  }
  emits('update:modelValue', false)
}

let positionTop = ref(-9999)
let positionLeft = ref(-9999)

const updateMenuPosition = async () => {
  if (!props.modelValue || !props.clickEvent) return

  await nextTick()
  if (!menuRef.value) return

  const { x, y } = resolveContextMenuPoint(
    {
      clickX: props.clickEvent.clientX,
      clickY: props.clickEvent.clientY,
      menuWidth: menuRef.value.offsetWidth,
      menuHeight: menuRef.value.offsetHeight
    },
    {
      padding: 8
    }
  )

  positionLeft.value = x
  positionTop.value = y
}

watch(
  () => props.clickEvent,
  () => {
    if (props.modelValue) {
      void updateMenuPosition()
    }
  }
)

const handleGlobalPointerDown = (event: PointerEvent) => {
  if (!props.modelValue) return
  const target = event.target as Node | null
  if (menuRef.value && target && menuRef.value.contains(target)) return
  closeMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown, true)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
})
</script>
<template>
  <Teleport to="body">
    <div
      v-if="props.modelValue"
      ref="menuRef"
      data-frkb-context-menu="true"
      class="menu unselectable"
      :style="{ top: positionTop + 'px', left: positionLeft + 'px' }"
      @click.stop="() => {}"
    >
      <div class="menuHeader">
        <span class="menuTitle">{{ t('columns.columnMenuTitle') }}</span>
        <span class="menuCount">{{ visibleColumnCount }}/{{ props.columnData.length }}</span>
      </div>
      <div class="menuContent">
        <section v-for="group of groupedColumns" :key="group.id" class="menuSection">
          <div class="menuSectionTitle">{{ t(group.label) }}</div>
          <div class="columnGrid">
            <div v-for="item of group.columns" :key="item.key" class="menuGroup">
              <div
                class="menuButton"
                @click="menuButtonClick(item)"
                @contextmenu="menuButtonClick(item)"
              >
                <div class="menuButtonIcon">
                  <img v-if="item.show" :src="tickIcon" style="width: 16px" class="theme-icon" />
                </div>
                <div class="menuButtonLabel">
                  <span>{{ t(item.columnName) }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </Teleport>
</template>
<style lang="scss" scoped>
.menu {
  position: fixed;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  font-size: 14px;
  min-width: min(520px, calc(100vw - 12px));
  width: min(620px, calc(100vw - 12px));
  max-width: calc(100vw - 12px);
  max-height: min(72vh, 620px);
  overflow: hidden;
  border-radius: 5px;
  z-index: var(--z-context-menu);

  .menuHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 13px 7px;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);

    .menuTitle {
      color: var(--text);
      font-weight: 600;
    }

    .menuCount {
      font-size: 12px;
      opacity: 0.75;
    }
  }

  .menuContent {
    overflow-y: auto;
    padding: 6px;
  }

  .menuSection {
    & + .menuSection {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }

    .menuSectionTitle {
      padding: 3px 8px 5px;
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
    }

    .columnGrid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2px 4px;
    }

    .menuGroup {
      min-width: 0;

      .menuButton {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 6px 8px;
        border-radius: 5px;
        white-space: nowrap;
        color: var(--text);

        &:hover {
          background-color: var(--accent);
          color: #ffffff;
        }
      }

      .menuButtonIcon {
        width: 19px;
        height: 19px;
        flex: 0 0 19px;
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .menuButtonLabel {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .menuButtonLabel span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }

  @media (max-width: 620px) {
    min-width: min(420px, calc(100vw - 12px));

    .menuSection .columnGrid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 420px) {
    min-width: min(300px, calc(100vw - 12px));

    .menuSection .columnGrid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
}
</style>
