<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import confirm from '@renderer/components/confirmDialog'
import {
  buildMusicSearchQuery,
  getMusicSearchOpenFailedMessageKey,
  openMusicSearch,
  type MusicSearchProvider
} from '@renderer/utils/musicSearch'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { seedKeyOfSimilarSong } from '@renderer/utils/similarTracksBatch'
import type {
  ISimilarTrackItem,
  ISimilarTrackSource,
  ISimilarTracksBatchResult,
  ISimilarTracksProviderStatus,
  ISimilarTracksPoolItem,
  ISimilarTrackBlockTarget,
  ISimilarTrackBlockResult,
  ISongInfo
} from 'src/types/globals'

type FilterKey = 'all' | 'listenbrainz' | 'lastfm' | 'both'

const props = defineProps<{
  seeds: ISongInfo[]
  initialResult?: ISimilarTracksBatchResult | null
  initialErrorText?: string
}>()
const emits = defineEmits(['close', 'retry'])

const scope = `similar_batch_dialog_${Math.random().toString(36).slice(2)}`
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const errorText = ref(props.initialErrorText || '')
const activeFilter = ref<FilterKey>('all')
const failedCoverKeys = ref(new Set<string>())
const blockedRecommendationKeys = ref(new Set<string>())
const blockingTrackKeys = ref(new Set<string>())
const batchResult = ref<ISimilarTracksBatchResult | null>(props.initialResult || null)

// 汇总统计
const pool = ref<ISimilarTracksPoolItem[]>([])
const seedTotal = ref(props.seeds.length)
const seedProcessed = ref(0)
const seedEmptyCount = ref(0)
const wasCanceled = ref(false)

// ---- 文本归一化（与后端 normalizeKey 对齐：NFKC + 去空白 + 小写）----
const normalizeText = (value?: string | null): string =>
  String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
const normalizeKey = (value?: string | null): string => normalizeText(value).toLocaleLowerCase()

// 推荐项去重键：优先 MBID，否则 artist|title 文本
const textKeyOfTrack = (track: Pick<ISimilarTrackItem, 'artist' | 'title'>): string =>
  `text:${normalizeKey(track.artist)}:${normalizeKey(track.title)}`

const blockKeysOfTrack = (
  track: Pick<ISimilarTrackItem, 'artist' | 'title' | 'recordingMbid'>
): string[] => {
  const keys: string[] = []
  const recordingMbid = normalizeKey(track.recordingMbid)
  if (recordingMbid) keys.push(`mbid:${recordingMbid}`)
  const artist = normalizeKey(track.artist)
  const title = normalizeKey(track.title)
  if (artist && title) keys.push(`text:${artist}:${title}`)
  return Array.from(new Set(keys))
}

const isTrackBlocked = (track: ISimilarTrackItem): boolean =>
  blockKeysOfTrack(track).some((key) => blockedRecommendationKeys.value.has(key))

const blockActionKey = (track: ISimilarTrackItem): string =>
  blockKeysOfTrack(track).join('|') || track.id

const sourceLabel = (source: ISimilarTrackSource) =>
  source === 'listenbrainz'
    ? t('similarTracks.sourceListenBrainz')
    : t('similarTracks.sourceLastFm')

const sourceClass = (source: ISimilarTrackSource) =>
  source === 'listenbrainz' ? 'source-listenbrainz' : 'source-lastfm'

/**
 * 把后端按种子返回的结果，合并去重成一个推荐池：
 *  - 同一首被多个种子推荐则合并，记录 recommendedBy 计数与来源
 *  - 排序：被推荐次数↓ → 综合分↓ → 标题序
 */
const buildPool = (result: ISimilarTracksBatchResult): void => {
  const map = new Map<string, ISimilarTracksPoolItem>()

  for (const seedResult of result.perSeed || []) {
    const seedKey = seedResult.seedKey
    for (const track of seedResult.tracks || []) {
      // 池内去重键：优先 MBID
      const textKey = textKeyOfTrack(track)
      const poolKey = track.recordingMbid ? `mbid:${normalizeKey(track.recordingMbid)}` : textKey
      const existing = map.get(poolKey)
      if (!existing) {
        map.set(poolKey, {
          ...track,
          sources: [...track.sources],
          recommendedBy: 1,
          recommendedBySeeds: [seedKey]
        })
      } else if (!existing.recommendedBySeeds.includes(seedKey)) {
        existing.recommendedBy += 1
        existing.recommendedBySeeds.push(seedKey)
        // 合并来源/封面/分数等信息，保留更高综合分
        for (const source of track.sources) {
          if (!existing.sources.includes(source)) existing.sources.push(source)
        }
        existing.coverUrl = existing.coverUrl || track.coverUrl
        existing.album = existing.album || track.album
        existing.recordingMbid = existing.recordingMbid || track.recordingMbid
        existing.sourceUrls = { ...(existing.sourceUrls || {}), ...(track.sourceUrls || {}) }
        if (track.score > existing.score) existing.score = track.score
      }
    }
  }

  const merged = [...map.values()].sort((a, b) => {
    if (b.recommendedBy !== a.recommendedBy) return b.recommendedBy - a.recommendedBy
    if (b.score !== a.score) return b.score - a.score
    return a.title.localeCompare(b.title)
  })

  pool.value = merged
  seedProcessed.value = result.processed
  seedTotal.value = result.total
  seedEmptyCount.value = result.emptyCount
  wasCanceled.value = result.canceled
}

if (props.initialResult) {
  buildPool(props.initialResult)
}

const visiblePool = computed(() => pool.value.filter((item) => !isTrackBlocked(item)))

const filteredTracks = computed(() => {
  const tracks = visiblePool.value
  if (activeFilter.value === 'listenbrainz') {
    return tracks.filter((item) => item.sources.includes('listenbrainz'))
  }
  if (activeFilter.value === 'lastfm') {
    return tracks.filter((item) => item.sources.includes('lastfm'))
  }
  if (activeFilter.value === 'both') {
    return tracks.filter(
      (item) => item.sources.includes('listenbrainz') && item.sources.includes('lastfm')
    )
  }
  return tracks
})

const counts = computed<Record<FilterKey, number>>(() => {
  const tracks = visiblePool.value
  return {
    all: tracks.length,
    listenbrainz: tracks.filter((item) => item.sources.includes('listenbrainz')).length,
    lastfm: tracks.filter((item) => item.sources.includes('lastfm')).length,
    both: tracks.filter(
      (item) => item.sources.includes('listenbrainz') && item.sources.includes('lastfm')
    ).length
  }
})

const filterTabs = computed<Array<{ key: FilterKey; label: string; count: number }>>(() => [
  { key: 'all', label: t('similarTracks.filterAll'), count: counts.value.all },
  {
    key: 'listenbrainz',
    label: t('similarTracks.filterListenBrainz'),
    count: counts.value.listenbrainz
  },
  { key: 'lastfm', label: t('similarTracks.filterLastFm'), count: counts.value.lastfm },
  { key: 'both', label: t('similarTracks.filterBoth'), count: counts.value.both }
])

const isSingleSeed = computed(() => props.seeds.length === 1)

const seedKeyToSong = computed(() => {
  const map = new Map<string, ISongInfo>()
  props.seeds.forEach((song, index) => {
    map.set(seedKeyOfSimilarSong(song, index), song)
  })
  return map
})

const songDisplayName = (song?: ISongInfo | null): string => {
  if (!song) return ''
  const title = normalizeText(song.title || song.fileName)
  const artist = normalizeText(song.artist)
  return [title, artist].filter(Boolean).join(' - ')
}

const singleSeedText = computed(() => {
  const inputSong = props.seeds[0]
  const resolvedSeed = batchResult.value?.perSeed?.[0]?.seed
  if (resolvedSeed) {
    return [resolvedSeed.title, resolvedSeed.artist].filter(Boolean).join(' - ')
  }
  return songDisplayName(inputSong)
})

const summaryText = computed(() => {
  if (isSingleSeed.value) {
    return singleSeedText.value || t('similarTracks.singleSeedUnknown')
  }
  return t('similarTracks.batchSummary', {
    processed: seedProcessed.value,
    total: seedTotal.value,
    empty: seedEmptyCount.value
  })
})

const seedPanelLabel = computed(() =>
  isSingleSeed.value ? t('similarTracks.seedLabel') : t('similarTracks.batchSeedLabel')
)

const seedSourceText = computed(() => {
  if (!isSingleSeed.value) return ''
  const source = batchResult.value?.perSeed?.[0]?.seed?.source
  if (source === 'acoustid') return t('similarTracks.seedFromAcoustId')
  if (source === 'tags') return t('similarTracks.seedFromTags')
  return ''
})

const sourceSeedLabels = (track: ISimilarTracksPoolItem): string[] =>
  track.recommendedBySeeds
    .map((seedKey) => songDisplayName(seedKeyToSong.value.get(seedKey)))
    .filter((label) => label.length > 0)

const sourceSeedText = (track: ISimilarTracksPoolItem): string => {
  const labels = sourceSeedLabels(track)
  if (labels.length === 0) return ''
  if (labels.length === 1) return t('similarTracks.recommendedFromOne', { seed: labels[0] })
  return t('similarTracks.recommendedFromMany', { count: labels.length })
}

const sourceSeedTooltip = (track: ISimilarTracksPoolItem): string => {
  const labels = sourceSeedLabels(track)
  if (labels.length === 0) return ''
  return labels.join('\n')
}

const providerDiagnosticText = (source: ISimilarTrackSource, status: string, count: number) => {
  if (source === 'lastfm' && status === 'missing-key') {
    return t('similarTracks.batchDiagnosticLastFmMissingKey')
  }
  if (source === 'listenbrainz' && status === 'no-seed') {
    return t('similarTracks.batchDiagnosticListenBrainzNoSeed', { count })
  }
  if (status === 'error') {
    return t('similarTracks.batchDiagnosticProviderError', {
      source: sourceLabel(source),
      count
    })
  }
  return ''
}

const diagnosticItems = computed(() => {
  const result = batchResult.value
  if (!result) return []
  const items: Array<{ key: string; text: string; level: 'warn' | 'error' }> = []
  const noSeedCount = result.perSeed.filter(
    (item) => item.errorCode === 'SIMILAR_TRACKS_NO_SEED'
  ).length
  if (noSeedCount > 0) {
    items.push({
      key: 'no-seed',
      text: isSingleSeed.value
        ? t('similarTracks.errorNoSeed')
        : t('similarTracks.batchDiagnosticNoSeed', { count: noSeedCount }),
      level: 'warn'
    })
  }

  const statusCounts = new Map<string, { status: ISimilarTracksProviderStatus; count: number }>()
  for (const seedResult of result.perSeed) {
    for (const status of seedResult.providerStatus || []) {
      if (status.status === 'ok') continue
      const key = `${status.source}:${status.status}:${status.message || ''}`
      const existing = statusCounts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        statusCounts.set(key, { status, count: 1 })
      }
    }
  }

  for (const { status, count } of statusCounts.values()) {
    const text = providerDiagnosticText(status.source, status.status, count)
    if (!text) continue
    items.push({
      key: `${status.source}:${status.status}:${status.message || ''}`,
      text,
      level: status.status === 'error' ? 'error' : 'warn'
    })
  }
  return items
})

const openTrackSource = (track: ISimilarTrackItem) => {
  const url =
    track.sourceUrls?.lastfm ||
    track.sourceUrls?.listenbrainz ||
    (track.recordingMbid
      ? `https://musicbrainz.org/recording/${encodeURIComponent(track.recordingMbid)}`
      : '')
  if (!url) return
  window.electron.ipcRenderer.send('openLocalBrowser', url)
}

const hasTrackSourceUrl = (track: ISimilarTrackItem) =>
  !!(track.sourceUrls?.lastfm || track.sourceUrls?.listenbrainz || track.recordingMbid)

const resolveMusicSearchQuery = (track: ISimilarTrackItem) =>
  buildMusicSearchQuery(track.title, track.artist)

const hasMusicSearchQuery = (track: ISimilarTrackItem) => !!resolveMusicSearchQuery(track)

const openTrackMusicSearch = async (provider: MusicSearchProvider, track: ISimilarTrackItem) => {
  if (await openMusicSearch(provider, resolveMusicSearchQuery(track))) return
  await confirm({
    title: t('dialog.hint'),
    content: [t(getMusicSearchOpenFailedMessageKey(provider))],
    confirmShow: false
  })
}

const loadBlockedRecommendationKeys = async () => {
  try {
    const keys = (await window.electron.ipcRenderer.invoke(
      'similarTracks:getBlockedRecommendationKeys'
    )) as string[]
    blockedRecommendationKeys.value = new Set(
      Array.isArray(keys) ? keys.filter((key) => typeof key === 'string' && key.length > 0) : []
    )
  } catch (error) {
    console.error('[similar-tracks] load blocked recommendation keys failed', error)
  }
}

const isBlockingTrack = (track: ISimilarTrackItem): boolean =>
  blockingTrackKeys.value.has(blockActionKey(track))

const blockTrackRecommendation = async (track: ISimilarTrackItem) => {
  const localKeys = blockKeysOfTrack(track)
  if (!localKeys.length) return
  const actionKey = blockActionKey(track)
  if (blockingTrackKeys.value.has(actionKey)) return

  blockingTrackKeys.value = new Set(blockingTrackKeys.value).add(actionKey)
  try {
    const payload: ISimilarTrackBlockTarget = {
      title: normalizeText(track.title) || undefined,
      artist: normalizeText(track.artist) || undefined,
      album: normalizeText(track.album) || undefined,
      recordingMbid: normalizeText(track.recordingMbid) || undefined,
      sources: track.sources.filter((source) => source === 'listenbrainz' || source === 'lastfm')
    }
    const result = (await window.electron.ipcRenderer.invoke(
      'similarTracks:blockRecommendation',
      payload
    )) as ISimilarTrackBlockResult
    const nextKeys = new Set(blockedRecommendationKeys.value)
    for (const key of [...localKeys, ...(Array.isArray(result.keys) ? result.keys : [])]) {
      if (typeof key === 'string' && key.length > 0) nextKeys.add(key)
    }
    blockedRecommendationKeys.value = nextKeys
  } catch (error) {
    console.error('[similar-tracks] block recommendation failed', error)
  } finally {
    const nextBlockingKeys = new Set(blockingTrackKeys.value)
    nextBlockingKeys.delete(actionKey)
    blockingTrackKeys.value = nextBlockingKeys
  }
}

const coverKey = (track: ISimilarTrackItem) => `${track.id}:${track.coverUrl || ''}`
const hasCover = (track: ISimilarTrackItem) =>
  !!track.coverUrl && !failedCoverKeys.value.has(coverKey(track))
const markCoverFailed = (track: ISimilarTrackItem) => {
  failedCoverKeys.value = new Set(failedCoverKeys.value).add(coverKey(track))
}
const coverFallbackText = (track: ISimilarTrackItem) => {
  const text = (track.title || track.artist || '').trim()
  const [firstChar] = Array.from(text)
  return firstChar ? firstChar.toLocaleUpperCase() : '#'
}

const closeDialog = () => {
  closeWithAnimation(() => emits('close'))
}

const retrySearch = () => {
  closeWithAnimation(() => emits('retry'))
}

onMounted(() => {
  utils.setHotkeysScpoe(scope)
  void loadBlockedRecommendationKeys()
  hotkeys('esc', scope, () => {
    closeDialog()
    return false
  })
})

onUnmounted(() => {
  utils.delHotkeysScope(scope)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ t('similarTracks.title') }}</div>

      <div class="similar-body">
        <div class="seed-panel">
          <div class="seed-main">
            <span class="seed-label">{{ seedPanelLabel }}</span>
            <span class="seed-title">{{ summaryText }}</span>
          </div>
          <div class="seed-badges">
            <span v-if="seedSourceText" class="source-chip seed-source">{{ seedSourceText }}</span>
            <span v-if="wasCanceled" class="source-chip seed-source">{{
              t('similarTracks.batchCanceled')
            }}</span>
          </div>
        </div>

        <div v-if="diagnosticItems.length" class="source-status">
          <span
            v-for="item in diagnosticItems"
            :key="item.key"
            class="status-pill"
            :class="item.level"
          >
            {{ item.text }}
          </span>
        </div>

        <div class="filter-tabs">
          <button
            v-for="tab in filterTabs"
            :key="tab.key"
            class="filter-tab"
            :class="{ active: activeFilter === tab.key }"
            type="button"
            @click="activeFilter = tab.key"
          >
            <span>{{ tab.label }}</span>
            <span class="count">{{ tab.count }}</span>
          </button>
        </div>

        <div class="result-panel">
          <div v-if="errorText" class="placeholder error-text">{{ errorText }}</div>
          <div v-else-if="!pool.length" class="placeholder">
            {{ t('similarTracks.batchNoResults') }}
          </div>
          <div v-else-if="!filteredTracks.length" class="placeholder">
            {{ t('similarTracks.noFilteredResults') }}
          </div>
          <OverlayScrollbarsComponent
            v-else
            class="result-scroll"
            element="div"
            :options="{
              scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
              overflow: { x: 'hidden', y: 'scroll' } as const
            }"
          >
            <div class="result-list">
              <div v-for="track in filteredTracks" :key="track.id" class="track-row">
                <div class="cover-box">
                  <img
                    v-if="hasCover(track)"
                    :src="track.coverUrl"
                    alt=""
                    draggable="false"
                    decoding="async"
                    @error="markCoverFailed(track)"
                  />
                  <span v-else class="cover-fallback">{{ coverFallbackText(track) }}</span>
                </div>
                <div class="track-main">
                  <div class="track-title">{{ track.title }}</div>
                  <div class="track-meta">
                    <span>{{ track.artist }}</span>
                    <span>{{ track.album || t('similarTracks.albumUnknown') }}</span>
                  </div>
                  <div class="track-sources">
                    <bubbleBoxTrigger
                      v-if="sourceSeedText(track)"
                      tag="span"
                      class="source-chip rec-chip"
                      :title="sourceSeedTooltip(track)"
                      :max-width="360"
                    >
                      {{ sourceSeedText(track) }}
                    </bubbleBoxTrigger>
                    <span
                      v-for="source in track.sources"
                      :key="source"
                      class="source-chip"
                      :class="sourceClass(source)"
                    >
                      {{ sourceLabel(source) }}
                    </span>
                  </div>
                </div>
                <div class="track-side">
                  <div class="track-side-top">
                    <div class="score">{{ t('similarTracks.score', { score: track.score }) }}</div>
                    <bubbleBoxTrigger
                      tag="button"
                      class="block-recommendation-button"
                      type="button"
                      :disabled="isBlockingTrack(track)"
                      :aria-label="t('similarTracks.blockRecommendation')"
                      :title="t('similarTracks.blockRecommendation')"
                      :show-delay="250"
                      :max-width="180"
                      @click="blockTrackRecommendation(track)"
                    >
                      <span class="block-recommendation-mark">×</span>
                    </bubbleBoxTrigger>
                  </div>
                  <div class="track-actions">
                    <button
                      class="open-button"
                      type="button"
                      :disabled="!hasTrackSourceUrl(track)"
                      @click="openTrackSource(track)"
                    >
                      {{ t('similarTracks.openSource') }}
                    </button>
                    <button
                      class="open-button"
                      type="button"
                      :disabled="!hasMusicSearchQuery(track)"
                      @click="openTrackMusicSearch('netease', track)"
                    >
                      {{ t('similarTracks.searchNetease') }}
                    </button>
                    <button
                      class="open-button"
                      type="button"
                      :disabled="!hasMusicSearchQuery(track)"
                      @click="openTrackMusicSearch('spotify', track)"
                    >
                      {{ t('similarTracks.searchSpotify') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
      </div>

      <div class="dialog-footer">
        <div class="button" @click="retrySearch">{{ t('similarTracks.retry') }}</div>
        <div class="button" @click="closeDialog">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 820px;
  height: 620px;
  max-height: 86vh;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.similar-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 0;
}

.seed-panel {
  min-height: 42px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg-elev);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
}

.seed-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.seed-label {
  font-size: 11px;
  color: var(--text-weak);
}

.seed-title {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seed-badges {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.source-chip {
  height: 22px;
  line-height: 20px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-weak);
  background-color: var(--bg);
  box-sizing: border-box;
}

.seed-source {
  flex: 0 0 auto;
}

.rec-chip {
  max-width: 260px;
  border-color: rgba(56, 189, 248, 0.5);
  color: #0284c7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-listenbrainz {
  border-color: rgba(34, 197, 94, 0.45);
  color: #15803d;
}

.source-lastfm {
  border-color: rgba(239, 68, 68, 0.42);
  color: #dc2626;
}

.source-status {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.status-pill {
  min-height: 24px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg-elev);
  color: var(--text-weak);
  padding: 4px 8px;
  font-size: 12px;
  line-height: 16px;
  box-sizing: border-box;

  &.warn {
    border-color: rgba(245, 158, 11, 0.45);
    color: #d97706;
  }

  &.error {
    border-color: rgba(239, 68, 68, 0.42);
    color: #dc2626;
  }
}

.filter-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-tab {
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg-elev);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  cursor: pointer;

  &:hover,
  &.active {
    border-color: var(--accent);
    background-color: var(--hover);
  }
}

.count {
  min-width: 18px;
  height: 18px;
  border-radius: 999px;
  background-color: var(--bg);
  color: var(--text-weak);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.result-panel {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg);
  overflow: hidden;
}

.placeholder {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

.error-text {
  color: #dc2626;
}

.result-scroll {
  height: 100%;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.track-row {
  min-height: 86px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background-color: var(--bg-elev);
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 184px;
  gap: 12px;
  align-items: center;
  padding: 10px 12px 10px 10px;
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease;
}

.cover-box {
  width: 58px;
  height: 58px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0)), var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(34, 197, 94, 0.12)), var(--bg);
}

.track-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.track-title {
  font-size: 14px;
  color: var(--text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-meta {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr);
  gap: 12px;
  color: var(--text-weak);
  font-size: 12px;

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.track-sources {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.track-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.track-side-top {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.track-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.score {
  min-width: 52px;
  height: 24px;
  border: 1px solid rgba(34, 197, 94, 0.32);
  border-radius: 999px;
  background-color: rgba(34, 197, 94, 0.08);
  font-size: 12px;
  color: var(--text);
  font-weight: 700;
  line-height: 22px;
  text-align: center;
}

.block-recommendation-button {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg);
  color: var(--text-weak);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: rgba(239, 68, 68, 0.52);
    background-color: rgba(239, 68, 68, 0.08);
    color: #dc2626;
  }

  &:disabled {
    cursor: default;
    opacity: 0.48;
  }
}

.block-recommendation-mark {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 24px;
}

.open-button {
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg);
  color: var(--text);
  padding: 0 10px;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background-color: var(--accent);
    color: #ffffff;
  }

  &:disabled {
    cursor: default;
    opacity: 0.45;
    background-color: var(--bg);
    color: var(--text-weak);
  }
}

.dialog-footer {
  flex-shrink: 0;
}
</style>
