<script setup lang="ts">
// 应用歌曲区的真实欢迎页包含当前模式的完整快捷键表。
import WelcomePage from '@renderer/components/welcomePage.vue'
</script>

<template>
  <!-- 欢迎页只展示快捷键；在捕获阶段阻止新建歌单和导入按钮启动应用弹窗。
       键盘 Enter / Space 产生的 click 也会经过这里。 -->
  <div class="frkb-app theme-dark demo-keyboard" @click.capture.stop.prevent>
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
