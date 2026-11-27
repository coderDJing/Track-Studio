<script setup lang="ts">
defineProps<{ visible: boolean }>()
</script>
<template>
  <div v-show="visible" class="playerArea"><slot /></div>
</template>
