<script setup lang="ts">
import { computed, inject } from 'vue'
import { t } from '@renderer/utils/translate'
import { SETTINGS_BY_ID, type SettingId } from './settingsCatalog'
import { settingDialogContextKey, type SettingDialogContext } from './context'

const props = defineProps<{
  id: SettingId
  label?: string
  description?: string
  controlId?: string
  stacked?: boolean
  inline?: boolean
  danger?: boolean
}>()

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const meta = computed(() => SETTINGS_BY_ID[props.id])
const labelText = computed(() => props.label || (meta.value ? t(meta.value.labelKey) : props.id))
const isHighlighted = computed(() => ctx.highlightedSettingId.value === props.id)
</script>

<template>
  <div
    class="settings-row flashing-border"
    :class="{
      'settings-row--stacked': stacked,
      'settings-row--inline': inline,
      'settings-row--danger': danger,
      'is-flashing': isHighlighted
    }"
    :data-setting-id="id"
  >
    <div class="settings-row__text">
      <label v-if="labelText" class="settings-row__label" :for="controlId">{{ labelText }}</label>
      <div v-if="description || $slots.description" class="settings-row__description">
        <slot name="description">{{ description }}</slot>
      </div>
    </div>
    <div class="settings-row__control">
      <slot />
    </div>
    <div v-if="$slots.details" class="settings-row__details">
      <slot name="details" />
    </div>
  </div>
</template>
