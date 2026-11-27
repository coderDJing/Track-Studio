<script setup lang="ts">
import { t } from '@renderer/utils/translate'

defineProps<{
  titleKey: string
  descKey?: string
}>()
</script>

<template>
  <section class="settings-group">
    <header class="settings-group__header">
      <h3 class="settings-group__title">{{ t(titleKey) }}</h3>
      <p v-if="descKey" class="settings-group__description">{{ t(descKey) }}</p>
    </header>
    <div class="settings-group__body">
      <slot />
    </div>
  </section>
</template>
