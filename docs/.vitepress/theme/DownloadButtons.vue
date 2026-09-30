<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLatestRelease } from './useLatestRelease'

const props = defineProps<{
  windowsLabel: string
  macLabel: string
  otherPrefix: string
}>()

const release = ref<ReturnType<typeof useLatestRelease> | null>(null)

onMounted(() => {
  release.value = useLatestRelease()
})

const loading = computed(() => !release.value || release.value.loading.value)
const version = computed(() => release.value?.version.value ?? '')
const platform = computed(() => release.value?.platform.value ?? 'unknown')
const winUrl = computed(() => release.value?.winUrl.value ?? '')
const macUrl = computed(() => release.value?.macUrl.value ?? '')

// 主按钮给当前系统，另一个平台降级成文字链接；识别不出来时两个都给主按钮
const primary = computed(() => {
  if (platform.value === 'mac') return ['mac'] as const
  if (platform.value === 'win') return ['win'] as const
  return ['win', 'mac'] as const
})
const secondary = computed(() => {
  if (platform.value === 'mac') return 'win' as const
  if (platform.value === 'win') return 'mac' as const
  return null
})

const labelOf = (os: 'win' | 'mac') => (os === 'win' ? props.windowsLabel : props.macLabel)
const urlOf = (os: 'win' | 'mac') => (os === 'win' ? winUrl.value : macUrl.value)
</script>

<template>
  <div class="dl">
    <div v-if="loading" class="dl-skeleton" aria-hidden="true"></div>
    <template v-else>
      <div class="dl-row">
        <a
          v-for="os in primary"
          :key="os"
          class="dl-btn"
          :href="urlOf(os)"
          target="_blank"
          rel="nofollow noopener"
        >
          <span class="dl-icon-frame" aria-hidden="true">
            <svg
              v-if="os === 'win'"
              class="dl-icon dl-icon--win"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path
                d="M0 3.449L9.75 2.1V11.7H0V3.449zm0 17.1L9.75 21.9V12.3H0v8.249zM10.5 1.8L24 0v11.7H10.5V1.8zm0 20.4L24 24V12.3H10.5v9.9z"
              />
            </svg>
            <svg v-else class="dl-icon dl-icon--mac" viewBox="4 2 16 20" fill="currentColor">
              <path
                d="M17.057 12.781c.032 2.588 2.254 3.462 2.287 3.477-.025.065-.338 1.15-1.118 2.273-.679.973-1.381 1.94-2.486 1.96-1.087.02-1.391-.651-2.629-.651-1.241 0-1.609.63-2.67.67-1.1.04-1.766-.02-2.527-1.12-1.554-2.245-2.657-6.333-1.055-9.09.795-1.373 2.215-2.248 3.76-2.268 1.171-.025 2.212.748 2.927.748.717 0 1.98-.923 3.342-.782.572.022 2.181.23 3.213 1.731-.082.051-1.922 1.112-1.902 3.33zm-2.404-7.334c.615-.747 1.026-1.783.912-2.821-.892.036-1.972.593-2.612 1.341-.571.659-1.072 1.716-.938 2.731.996.078 2.016-.491 2.638-1.251z"
              />
            </svg>
          </span>
          <span>{{ labelOf(os) }}</span>
          <span v-if="version" class="dl-version">{{ version }}</span>
        </a>
      </div>
      <a
        v-if="secondary"
        class="dl-other"
        :href="urlOf(secondary)"
        target="_blank"
        rel="nofollow noopener"
      >
        {{ otherPrefix }} {{ labelOf(secondary) }}
      </a>
    </template>
  </div>
</template>
