<script setup lang="ts">
// 应用歌曲区的真实欢迎页包含当前模式的完整快捷键表。
import WelcomePage from '@renderer/components/welcomePage.vue'
</script>

<template>
  <div class="frkb-app theme-dark demo-keyboard">
    <WelcomePage />
  </div>
</template>

<style scoped>
.demo-keyboard {
  display: flex;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}
</style>
