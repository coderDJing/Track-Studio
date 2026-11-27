<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { setIcloudLibraryIconVisible } from '@renderer/utils/icloudLibraryPreferences'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import { t } from '@renderer/utils/translate'
const runtime = useRuntimeStore()
const saving = ref(false)
const failed = ref(false)
const revision = ref(0)
const visible = computed({
  get: () => runtime.setting.showIcloudLibraryIcon !== false,
  set: (value: boolean) => {
    void change(value)
  }
})
async function change(value: boolean) {
  if (saving.value) return
  saving.value = true
  failed.value = false
  try {
    await setIcloudLibraryIconVisible(value)
  } catch {
    failed.value = true
  } finally {
    revision.value += 1
    saving.value = false
  }
}
</script>
<template>
  <div class="settings-section">
    <div class="section-title">{{ t('icloud.title') }}</div>
    <label class="setting-block" for="setting-checkbox-showIcloudLibraryIcon">{{
      t('icloud.showIcon')
    }}</label>
    <div class="setting-control">
      <singleCheckbox
        id="setting-checkbox-showIcloudLibraryIcon"
        :key="revision"
        v-model="visible"
        :disabled="saving"
      />
      <div v-if="failed" class="setting-hint" role="alert">{{ t('icloud.preferenceFailed') }}</div>
    </div>
  </div>
</template>
<style scoped>
.settings-section {
  margin-top: 30px;
  padding-top: 2px;
}
.section-title {
  position: relative;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  padding-left: 12px;
  margin-bottom: 4px;
}
.section-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 4px;
  height: 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 52%, transparent);
  transform: translateY(-50%);
}
.setting-block {
  display: block;
  margin-top: 20px;
  user-select: none;
}
.setting-control {
  margin-top: 10px;
  max-width: 100%;
}
.setting-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 8px;
  line-height: 1.5;
}
</style>
