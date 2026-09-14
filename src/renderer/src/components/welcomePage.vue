<script setup lang="ts">
import welcomeLogoAsset from '@renderer/assets/welcomeLogo.png?asset'
import WelcomeCreatePlaylistActions from '@renderer/components/WelcomeCreatePlaylistActions.vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { computed, onMounted, onUnmounted, ref } from 'vue'

type ShortcutRow = {
  title: string
  keys?: string[]
  keyGroups?: Array<{
    label: string
    key: string
  }>
  hint?: string
  minWidth?: number
  keySeparator?: string
  useGlobalShortcut?: boolean
}

type HorizontalShortcutLayoutItem =
  | {
      kind: 'section'
      leftRows: ShortcutRow[]
      rightRows: ShortcutRow[]
    }
  | {
      kind: 'wide'
      row: ShortcutRow
    }

const runtime = useRuntimeStore()
const welcomeLogo = welcomeLogoAsset
const isHorizontalMode = computed(() => runtime.mainWindowBrowseMode !== 'browser')
const welcomeContainerRef = ref<HTMLElement | null>(null)
const horizontalContainerHeight = ref(272)
const horizontalContainerWidth = ref(820)
const deckLabels = {
  deck1: t('shortcuts.horizontalDeck1'),
  deck2: t('shortcuts.horizontalDeck2')
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const roundPx = (value: number) => `${Math.round(value)}px`

const horizontalLayoutStyle = computed<Record<string, string>>(() => {
  if (!isHorizontalMode.value) {
    return {} as Record<string, string>
  }

  const minHeight = 272
  const maxHeight = 420
  const heightProgress = clampNumber(
    (horizontalContainerHeight.value - minHeight) / (maxHeight - minHeight),
    0,
    1
  )
  const minWidth = 760
  const maxWidth = 1100
  const widthProgress = clampNumber(
    (horizontalContainerWidth.value - minWidth) / (maxWidth - minWidth),
    0,
    1
  )
  const progress = Math.min(heightProgress, widthProgress)

  return {
    '--horizontal-content-gap': roundPx(4 + progress * 6),
    '--horizontal-grid-column-gap': roundPx(14 + widthProgress * 12),
    '--horizontal-grid-row-gap': roundPx(4 + progress * 4),
    '--horizontal-row-gap': roundPx(2 + progress * 3),
    '--horizontal-row-min-height': roundPx(20 + progress * 5),
    '--horizontal-keybinding-min-height': roundPx(18 + progress * 4),
    '--horizontal-title-width': roundPx(104 + widthProgress * 28),
    '--horizontal-title-font-size': roundPx(11 + progress),
    '--horizontal-key-font-size': roundPx(9 + progress),
    '--horizontal-label-font-size': roundPx(9 + progress),
    '--horizontal-key-padding-y': roundPx(3),
    '--horizontal-key-padding-x': roundPx(6 + progress * 2),
    '--horizontal-logo-size': roundPx(54 + progress * 14)
  }
})

const globalShortcut = computed(() => {
  const raw = String(runtime.setting.globalCallShortcut || '').trim()
  if (!raw) {
    return []
  }
  return raw.split('+').map((key) => ({
    key,
    needSeparator: true
  }))
})

const browserShortcutRows = computed<ShortcutRow[]>(() => [
  {
    title: t('player.playPause'),
    keys: ['Space']
  },
  {
    title: t('player.previousNext'),
    keys: ['W / S'],
    hint: '( ↑ / ↓ )'
  },
  {
    title: t('player.fastBackwardForward'),
    keys: ['A / D'],
    hint: '( ← / → )'
  },
  {
    title: t('player.seekPercent'),
    keys: [t('player.seekPercentKeys')],
    hint: t('player.seekPercentHint')
  },
  {
    title: t('shortcuts.globalPlayPause'),
    keys: ['Shift', 'Alt', 'Space']
  },
  {
    title: t('shortcuts.globalPreviousNext'),
    keys: ['Shift', 'Alt', 'Up / Down']
  },
  {
    title: t('shortcuts.globalFastBackwardForward'),
    keys: ['Shift', 'Alt', 'Left / Right']
  },
  {
    title: t('player.moveToLibraries'),
    keys: ['Q / E']
  },
  {
    title: t('common.delete'),
    keys: ['F'],
    hint: '( Delete )'
  },
  {
    title: t('player.playbackRange'),
    keys: ['R']
  },
  {
    title: t('player.volumeControl'),
    keys: ['+ / -']
  },
  {
    title: t('player.showHide'),
    minWidth: 250,
    useGlobalShortcut: true
  }
])

const horizontalShortcutLayoutItems = computed<HorizontalShortcutLayoutItem[]>(() => [
  {
    kind: 'section',
    leftRows: [
      {
        title: t('shortcuts.horizontalLoadDeck'),
        keyGroups: [
          { label: deckLabels.deck1, key: t('shortcuts.horizontalLoadDeck1Key') },
          { label: deckLabels.deck2, key: t('shortcuts.horizontalLoadDeck2Key') }
        ],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalPlayPause'),
        keyGroups: [
          { label: deckLabels.deck1, key: 'Space' },
          { label: deckLabels.deck2, key: 'Shift+Space' }
        ],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalCue'),
        keyGroups: [
          { label: deckLabels.deck1, key: 'C' },
          { label: deckLabels.deck2, key: 'Shift+C' }
        ],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalBarJump'),
        keyGroups: [
          { label: deckLabels.deck1, key: 'A / D' },
          { label: deckLabels.deck2, key: 'Shift+A / Shift+D' }
        ],
        hint: '( ← / → ) / ( Shift+← / Shift+→ )',
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalPhraseJump'),
        keyGroups: [
          { label: deckLabels.deck1, key: 'Alt+A / Alt+D' },
          { label: deckLabels.deck2, key: 'Shift+Alt+A / Shift+Alt+D' }
        ],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalDeleteTracks'),
        keyGroups: [
          { label: deckLabels.deck1, key: 'F' },
          { label: deckLabels.deck2, key: 'Shift+F' }
        ],
        keySeparator: ' / '
      }
    ],
    rightRows: [
      {
        title: t('shortcuts.horizontalCrossfaderMove'),
        keys: ['W / S', '↑ / ↓'],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalCrossfaderReset'),
        keys: ['Shift+W / Shift+S', 'Shift+↑ / Shift+↓'],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalMoveToFilter'),
        keyGroups: [
          { label: deckLabels.deck1, key: 'Q' },
          { label: deckLabels.deck2, key: 'Shift+Q' }
        ],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalMoveToCurated'),
        keyGroups: [
          { label: deckLabels.deck1, key: 'E' },
          { label: deckLabels.deck2, key: 'Shift+E' }
        ],
        keySeparator: ' / '
      },
      {
        title: t('shortcuts.horizontalSeekPercent'),
        keyGroups: [
          {
            label: deckLabels.deck1,
            key: t('shortcuts.horizontalSeekPercentPrimaryKeys')
          },
          {
            label: deckLabels.deck2,
            key: t('shortcuts.horizontalSeekPercentSecondaryKeys')
          }
        ],
        hint: t('player.seekPercentHint'),
        keySeparator: ' / '
      },
      {
        title: t('player.showHide'),
        minWidth: 250,
        useGlobalShortcut: true
      }
    ]
  }
])

const shortcutRows = browserShortcutRows

let resizeObserver: ResizeObserver | null = null

const syncHorizontalContainerMetrics = () => {
  horizontalContainerHeight.value = welcomeContainerRef.value?.clientHeight || 272
  horizontalContainerWidth.value = welcomeContainerRef.value?.clientWidth || 820
}

onMounted(() => {
  syncHorizontalContainerMetrics()
  if (typeof ResizeObserver === 'undefined' || !welcomeContainerRef.value) return
  resizeObserver = new ResizeObserver(() => {
    syncHorizontalContainerMetrics()
  })
  resizeObserver.observe(welcomeContainerRef.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div
    ref="welcomeContainerRef"
    class="welcome-container"
    :class="{ 'welcome-container--horizontal': isHorizontalMode }"
    :style="horizontalLayoutStyle"
  >
    <div class="welcome-content" :class="{ 'welcome-content--horizontal': isHorizontalMode }">
      <img
        :src="welcomeLogo"
        width="150"
        height="150"
        alt=""
        class="unselectable welcome-logo theme-icon"
        :class="{ 'welcome-logo--horizontal': isHorizontalMode }"
        draggable="false"
      />
      <WelcomeCreatePlaylistActions :horizontal="isHorizontalMode" />
      <div v-if="isHorizontalMode" class="shortcuts shortcuts--horizontal">
        <template v-for="(item, itemIndex) in horizontalShortcutLayoutItems" :key="itemIndex">
          <div v-if="item.kind === 'section'" class="shortcuts--horizontal-section">
            <div class="shortcut-column">
              <dl
                v-for="row in item.leftRows"
                :key="`${row.title}-left`"
                class="shortcut-row--horizontal"
              >
                <dt>{{ row.title }}</dt>
                <dd>
                  <div class="monaco-keybinding">
                    <template v-if="row.useGlobalShortcut">
                      <template
                        v-for="(itemKey, index) in globalShortcut"
                        :key="`${row.title}-${index}`"
                      >
                        <span class="monaco-keybinding-key">{{ itemKey.key }}</span>
                        <span
                          v-if="index !== globalShortcut.length - 1"
                          class="monaco-keybinding-key-separator"
                          >+</span
                        >
                      </template>
                    </template>
                    <template v-else-if="row.keyGroups">
                      <template
                        v-for="(group, index) in row.keyGroups"
                        :key="`${row.title}-${group.label}-${group.key}-${index}`"
                      >
                        <span class="shortcut-key-group">
                          <span class="shortcut-key-group-label">{{ group.label }}</span>
                          <span class="monaco-keybinding-key">{{ group.key }}</span>
                        </span>
                        <span
                          v-if="index !== row.keyGroups.length - 1"
                          class="monaco-keybinding-key-separator"
                          >{{ row.keySeparator || '+' }}</span
                        >
                      </template>
                    </template>
                    <template v-else>
                      <template
                        v-for="(key, index) in row.keys"
                        :key="`${row.title}-${key}-${index}`"
                      >
                        <span class="monaco-keybinding-key">{{ key }}</span>
                        <span
                          v-if="index !== (row.keys?.length || 0) - 1"
                          class="monaco-keybinding-key-separator"
                          >{{ row.keySeparator || '+' }}</span
                        >
                      </template>
                    </template>
                    <span v-if="row.hint" class="easter-egg">{{ row.hint }}</span>
                  </div>
                </dd>
              </dl>
            </div>
            <div class="shortcut-column">
              <dl
                v-for="row in item.rightRows"
                :key="`${row.title}-right`"
                class="shortcut-row--horizontal"
              >
                <dt>{{ row.title }}</dt>
                <dd>
                  <div class="monaco-keybinding">
                    <template v-if="row.useGlobalShortcut">
                      <template
                        v-for="(itemKey, index) in globalShortcut"
                        :key="`${row.title}-${index}`"
                      >
                        <span class="monaco-keybinding-key">{{ itemKey.key }}</span>
                        <span
                          v-if="index !== globalShortcut.length - 1"
                          class="monaco-keybinding-key-separator"
                          >+</span
                        >
                      </template>
                    </template>
                    <template v-else-if="row.keyGroups">
                      <template
                        v-for="(group, index) in row.keyGroups"
                        :key="`${row.title}-${group.label}-${group.key}-${index}`"
                      >
                        <span class="shortcut-key-group">
                          <span class="shortcut-key-group-label">{{ group.label }}</span>
                          <span class="monaco-keybinding-key">{{ group.key }}</span>
                        </span>
                        <span
                          v-if="index !== row.keyGroups.length - 1"
                          class="monaco-keybinding-key-separator"
                          >{{ row.keySeparator || '+' }}</span
                        >
                      </template>
                    </template>
                    <template v-else>
                      <template
                        v-for="(key, index) in row.keys"
                        :key="`${row.title}-${key}-${index}`"
                      >
                        <span class="monaco-keybinding-key">{{ key }}</span>
                        <span
                          v-if="index !== (row.keys?.length || 0) - 1"
                          class="monaco-keybinding-key-separator"
                          >{{ row.keySeparator || '+' }}</span
                        >
                      </template>
                    </template>
                    <span v-if="row.hint" class="easter-egg">{{ row.hint }}</span>
                  </div>
                </dd>
              </dl>
            </div>
          </div>
          <dl v-else class="shortcut-row--horizontal shortcut-row--horizontal-wide">
            <dt>{{ item.row.title }}</dt>
            <dd>
              <div class="monaco-keybinding">
                <template v-if="item.row.useGlobalShortcut">
                  <template
                    v-for="(shortcutItem, index) in globalShortcut"
                    :key="`${item.row.title}-${index}`"
                  >
                    <span class="monaco-keybinding-key">{{ shortcutItem.key }}</span>
                    <span
                      v-if="index !== globalShortcut.length - 1"
                      class="monaco-keybinding-key-separator"
                      >+</span
                    >
                  </template>
                </template>
                <template v-else-if="item.row.keyGroups">
                  <template
                    v-for="(group, index) in item.row.keyGroups"
                    :key="`${item.row.title}-${group.label}-${group.key}-${index}`"
                  >
                    <span class="shortcut-key-group">
                      <span class="shortcut-key-group-label">{{ group.label }}</span>
                      <span class="monaco-keybinding-key">{{ group.key }}</span>
                    </span>
                    <span
                      v-if="index !== item.row.keyGroups.length - 1"
                      class="monaco-keybinding-key-separator"
                      >{{ item.row.keySeparator || '+' }}</span
                    >
                  </template>
                </template>
                <template v-else>
                  <template
                    v-for="(key, index) in item.row.keys"
                    :key="`${item.row.title}-${key}-${index}`"
                  >
                    <span class="monaco-keybinding-key">{{ key }}</span>
                    <span
                      v-if="index !== (item.row.keys?.length || 0) - 1"
                      class="monaco-keybinding-key-separator"
                      >{{ item.row.keySeparator || '+' }}</span
                    >
                  </template>
                </template>
                <span v-if="item.row.hint" class="easter-egg">{{ item.row.hint }}</span>
              </div>
            </dd>
          </dl>
        </template>
      </div>
      <div v-else class="shortcuts">
        <dl v-for="row in shortcutRows" :key="row.title">
          <dt>{{ row.title }}</dt>
          <dd>
            <div
              class="monaco-keybinding"
              :style="row.minWidth ? { minWidth: `${row.minWidth}px` } : {}"
            >
              <template v-if="row.useGlobalShortcut">
                <template v-for="(item, index) in globalShortcut" :key="`${row.title}-${index}`">
                  <span class="monaco-keybinding-key">{{ item.key }}</span>
                  <span
                    v-if="index !== globalShortcut.length - 1"
                    class="monaco-keybinding-key-separator"
                    >+</span
                  >
                </template>
              </template>
              <template v-else>
                <template v-for="(key, index) in row.keys" :key="`${row.title}-${key}-${index}`">
                  <span class="monaco-keybinding-key">{{ key }}</span>
                  <span
                    v-if="index !== (row.keys?.length || 0) - 1"
                    class="monaco-keybinding-key-separator"
                    >{{ row.keySeparator || '+' }}</span
                  >
                </template>
              </template>
              <span v-if="row.hint" class="easter-egg">{{ row.hint }}</span>
            </div>
          </dd>
        </dl>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.welcome-container {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 16px 20px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.welcome-container--horizontal {
  padding: 10px 14px;
  align-items: center;
  justify-content: center;
  --horizontal-content-gap: 4px;
  --horizontal-grid-column-gap: 14px;
  --horizontal-grid-row-gap: 4px;
  --horizontal-row-gap: 2px;
  --horizontal-row-min-height: 20px;
  --horizontal-keybinding-min-height: 18px;
  --horizontal-title-width: 104px;
  --horizontal-title-font-size: 11px;
  --horizontal-key-font-size: 9px;
  --horizontal-label-font-size: 9px;
  --horizontal-key-padding-y: 3px;
  --horizontal-key-padding-x: 6px;
  --horizontal-logo-size: 54px;
}

.welcome-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--text-weak);
  width: min(100%, 430px);
  max-width: 430px;
  flex-shrink: 0;
  min-width: 0;
  gap: 10px;
}

.welcome-content--horizontal {
  width: min(100%, 980px);
  max-width: 980px;
  min-height: 0;
  align-items: stretch;
  justify-content: center;
  gap: var(--horizontal-content-gap);
}

.welcome-logo {
  width: 140px;
  height: 140px;
  flex-shrink: 0;
}

.welcome-logo--horizontal {
  width: var(--horizontal-logo-size);
  height: var(--horizontal-logo-size);
  align-self: center;
}

.shortcuts {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
}

.shortcuts--horizontal {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  gap: var(--horizontal-grid-row-gap);
}

.shortcuts--horizontal-section {
  display: flex;
  align-items: flex-start;
  width: 100%;
  min-width: 0;
  column-gap: var(--horizontal-grid-column-gap);
}

.shortcut-column {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: var(--horizontal-grid-row-gap);
  min-width: 0;
}

dl {
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  align-items: center;
  min-width: 0;

  &:last-child {
    margin-bottom: 0;
  }
}

.shortcut-row--horizontal {
  margin: 0;
  width: 100%;
  min-height: var(--horizontal-row-min-height);
  display: grid;
  grid-template-columns: minmax(0, var(--horizontal-title-width)) minmax(0, 1fr);
  column-gap: 8px;
  align-items: center;
}

.shortcut-row--horizontal-wide {
  width: 100%;
  justify-content: center;
  grid-template-columns: minmax(0, var(--horizontal-title-width)) max-content;
}

dt {
  font-size: 14px;
  text-align: right;
  width: 220px;
  padding-right: 10px;
  flex-shrink: 0;
  box-sizing: border-box;
  white-space: normal;
  line-height: 1.4;
}

.shortcut-row--horizontal dt {
  width: auto;
  min-width: 0;
  padding-right: 0;
  text-align: right;
  font-size: var(--horizontal-title-font-size);
  line-height: 1.25;
  white-space: normal;
  overflow-wrap: anywhere;
}

dd {
  margin: 0;
  text-align: left;
  width: auto;
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
}

.shortcut-row--horizontal dd {
  width: 100%;
}

.shortcut-row--horizontal-wide dd {
  width: auto;
}

.monaco-keybinding {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  position: relative;
  min-width: 0;

  .easter-egg {
    margin-left: 8px;
    color: var(--text);
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.3s ease;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  &:hover {
    .easter-egg {
      opacity: 1;
    }
  }
}

.monaco-keybinding-key {
  padding: 4px 8px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-bottom-color: var(--border);
  box-shadow: inset 0 -1px 0 var(--border);
  border-radius: 3px;
  font-size: 11px;
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  justify-content: center;
  text-align: center;
  color: var(--text-weak);
  white-space: normal;
  overflow-wrap: anywhere;
}

.monaco-keybinding-key-separator {
  padding: 0 4px;
  color: var(--text-weak);
}

.shortcut-key-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.shortcut-key-group-label {
  color: var(--text-weak);
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}

.shortcuts--horizontal .monaco-keybinding {
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-start;
  row-gap: 4px;
  min-height: var(--horizontal-keybinding-min-height);
}

.shortcuts--horizontal .monaco-keybinding-key {
  flex: 0 0 auto;
  max-width: 100%;
  padding: var(--horizontal-key-padding-y) var(--horizontal-key-padding-x);
  font-size: var(--horizontal-key-font-size);
  line-height: 1.25;
  min-width: 0;
  white-space: nowrap;
  overflow-wrap: normal;
}

.shortcuts--horizontal .monaco-keybinding-key-separator {
  padding: 0 3px;
}

.shortcuts--horizontal .shortcut-key-group {
  gap: 4px;
  flex: 0 1 auto;
  max-width: 100%;
}

.shortcuts--horizontal .shortcut-key-group-label {
  font-size: var(--horizontal-label-font-size);
}

.shortcuts--horizontal .easter-egg {
  display: none;
}

.global-shortcut-divider {
  color: var(--text-weak);
  font-size: 13px;
}

.unselectable {
  user-select: none;
  -webkit-user-drag: none;
}
</style>
