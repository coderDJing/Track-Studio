<script setup lang="ts">
import CloudSyncSettingsDialog from './cloudSyncSettingsDialog.vue'
import CloudSyncSyncDialog from './cloudSyncSyncDialog.vue'
import CuratedLibrarySyncDialog from './curatedLibrarySyncDialog.vue'
import SetLibrarySyncDialog from './setLibrarySyncDialog.vue'

const activeDialog = defineModel<string>({ required: true })
const close = () => {
  activeDialog.value = ''
}
</script>

<template>
  <CloudSyncSettingsDialog v-if="activeDialog === 'cloudSync.settings'" @cancel="close" />
  <CloudSyncSyncDialog v-if="activeDialog === 'cloudSync.syncFingerprints'" @cancel="close" />
  <CuratedLibrarySyncDialog
    v-if="activeDialog === 'cloudSync.syncCuratedLibrary'"
    @cancel="close"
  />
  <SetLibrarySyncDialog v-if="activeDialog === 'cloudSync.syncSetLibrary'" @cancel="close" />
</template>
