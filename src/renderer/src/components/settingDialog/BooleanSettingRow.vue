<script setup lang="ts">
import { computed, inject } from 'vue'
import { t } from '@renderer/utils/translate'
import { SETTINGS_BY_ID, type SettingId } from './settingsCatalog'
import { settingDialogContextKey, type SettingDialogContext } from './context'

const props = defineProps<{
  id: SettingId
  controlId?: string
  stacked?: boolean
}>()

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const meta = computed(() => SETTINGS_BY_ID[props.id])
const labelText = computed(() => (meta.value ? t(meta.value.labelKey) : props.id))
const isHighlighted = computed(() => ctx.highlightedSettingId.value === props.id)
</script>

<template>
  <div
    class="settings-row settings-row--toggle flashing-border"
    :class="{
      'settings-row--stacked': stacked,
      'is-flashing': isHighlighted
    }"
    :data-setting-id="id"
  >
    <div class="settings-toggle__main">
      <label class="settings-toggle__label" :for="controlId">{{ labelText }}</label>
      <div class="settings-toggle__control">
        <slot />
      </div>
    </div>
    <div v-if="$slots.details" class="settings-toggle__details">
      <slot name="details" />
    </div>
  </div>
</template>
