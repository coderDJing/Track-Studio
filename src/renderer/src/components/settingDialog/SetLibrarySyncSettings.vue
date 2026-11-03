<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import singleCheckbox from '../singleCheckbox.vue'
import confirm from '../confirmDialog'
import { t } from '@renderer/utils/translate'
import type { SetSyncResolution, SetSyncStatus } from '@shared/setLibrarySync'

const enabled = ref(false)
const busy = ref(false)
const status = ref<SetSyncStatus | null>(null)
const error = ref('')
const errorMessage = computed(() => {
  const code = error.value || status.value?.error || ''
  if (!code) return ''
  const names = [
    'USER_KEY_REQUIRED',
    'MISSING_AUDIO',
    'QUOTA_EXCEEDED',
    'HASH_MISMATCH',
    'LOCAL_CHANGED',
    'BUSY_TRACK',
    'BUSY_LIBRARY',
    'CLOUD_HISTORY_CHANGED'
  ]
  const name =
    names.find((name) => code.includes(name)) ||
    (code.includes('404') || code.includes('PROTOCOL') ? 'SERVER_UPGRADE' : 'FAILED')
  return t(`cloudSync.setLibrary.errors.${name}`)
})
let timer: ReturnType<typeof setInterval> | null = null
let refreshing = false
async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    const result: { enabled: boolean; status: SetSyncStatus } =
      await window.electron.ipcRenderer.invoke('setLibrarySync/getState')
    enabled.value = result.enabled
    status.value = result.status
  } catch (e) {
    error.value = String(e)
  } finally {
    refreshing = false
  }
}
async function changeEnabled(value: boolean) {
  enabled.value = value
  busy.value = true
  error.value = ''
  try {
    await window.electron.ipcRenderer.invoke('setLibrarySync/setEnabled', enabled.value)
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
    await refresh()
  }
}
async function sync(resolution?: SetSyncResolution) {
  if (resolution) {
    try {
      const choice = await confirm({
        title: t('cloudSync.setLibrary.conflicts'),
        content: [t(`cloudSync.setLibrary.confirm${resolution === 'local' ? 'Local' : 'Cloud'}`)],
        confirmShow: true
      })
      if (choice !== 'confirm') return
    } catch {
      return
    }
  }
  busy.value = true
  error.value = ''
  try {
    await window.electron.ipcRenderer.invoke('setLibrarySync/start', resolution)
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
    await refresh()
  }
}
onMounted(() => {
  void refresh()
  timer = setInterval(() => {
    void refresh()
  }, 1500)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
const cancel = () => window.electron.ipcRenderer.invoke('setLibrarySync/cancel')
</script>

<template>
  <div class="set-sync">
    <label class="setting-block" for="set-library-cloud-sync">{{
      t('cloudSync.setLibrary.enabled')
    }}</label>
    <div class="setting-control">
      <singleCheckbox
        id="set-library-cloud-sync"
        v-model="enabled"
        :disabled="busy"
        @change="changeEnabled"
      />
      <p>{{ t('cloudSync.setLibrary.scopeHint') }}</p>
      <p>{{ t('cloudSync.setLibrary.custodyHint') }}</p>
      <p v-if="status?.running" role="status">
        {{ t(`cloudSync.setLibrary.phases.${status.phase}`) }}
        <span v-if="status.total"> · {{ status.done }} / {{ status.total }}</span>
      </p>
      <p v-else-if="status && status.result !== 'idle'" role="status">
        {{ t(`cloudSync.setLibrary.results.${status.result}`) }}
      </p>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <div class="actions">
        <button :disabled="!enabled || busy || status?.running" @click="sync()">
          {{ t('cloudSync.startSync') }}
        </button>
        <button v-if="status?.running" @click="cancel">
          {{ t('common.cancel') }}
        </button>
      </div>
      <template v-if="status?.result === 'conflicts'">
        <p>{{ t('cloudSync.setLibrary.conflictHint') }}</p>
        <div class="conflict-list">
          <div
            v-for="(conflict, index) in status.conflicts"
            :key="`${conflict.id}-${conflict.field}-${index}`"
            class="conflict"
          >
            <span>{{ conflict.name }}</span>
            <span>{{ t(`cloudSync.setLibrary.fields.${conflict.field}`) }}</span>
          </div>
        </div>
        <div class="actions">
          <button :disabled="busy || !enabled" @click="sync('local')">
            {{ t('cloudSync.setLibrary.keepLocal') }}
          </button>
          <button :disabled="busy || !enabled" @click="sync('cloud')">
            {{ t('cloudSync.setLibrary.keepCloud') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.set-sync {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(0, 3fr);
  gap: 12px;
  color: var(--text);
}
.setting-block {
  font-size: 13px;
}
p {
  margin: 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
button {
  padding: 6px 12px;
  color: var(--text);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 5px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:hover:enabled {
  border-color: var(--accent);
}
.error {
  color: var(--danger, #d83b3b);
}
.conflict-list {
  max-height: 180px;
  overflow: auto;
}
.conflict {
  padding: 5px 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  overflow-wrap: anywhere;
}
@media (max-width: 520px) {
  .set-sync {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
