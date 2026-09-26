<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'

const { localeIndex } = useData()
const isEn = ref(localeIndex.value === 'en')

// 监听语言切换
onMounted(() => {
  isEn.value = window.location.pathname.includes('/en/')
})

// 主题切换逻辑
const theme = ref('dark')

const toggleTheme = () => {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem('theme', theme.value)
  applyTheme(theme.value)
}

const applyTheme = (t) => {
  const root = document.documentElement
  if (t === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    root.removeAttribute('data-theme')
  }
}

// 鼠标光效逻辑
const glowRef = ref(null)
const handleMouseMove = (e) => {
  if (glowRef.value) {
    glowRef.value.style.left = e.clientX + 'px'
    glowRef.value.style.top = e.clientY + 'px'
    glowRef.value.style.opacity = '1'
  }
}

// 滚动侦测逻辑
const observer = ref(null)

onMounted(() => {
  // 初始化主题
  const savedTheme = localStorage.getItem('theme') || 'dark'
  theme.value = savedTheme
  applyTheme(savedTheme)

  // 初始化下载按钮
  initDownloadButtons()

  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('keydown', handleKeydown)

  // 设置 IntersectionObserver
  observer.value = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          // 可选：如果希望动画只触发一次，可以取消观察
          // observer.value.unobserve(entry.target)
        }
      })
    },
    {
      root: null,
      threshold: 0.15,
      rootMargin: '0px 0px -50px 0px'
    }
  )

  // 观察所有需要动画的元素
  setTimeout(() => {
    document.querySelectorAll('.reveal').forEach((el) => {
      observer.value.observe(el)
    })
  }, 100)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('keydown', handleKeydown)
  if (observer.value) {
    observer.value.disconnect()
  }
})

// 下载相关状态
const showWin = ref(false)
const showMac = ref(false)
const latestReleasePage = 'https://github.com/coderDJing/Track-Studio/releases/latest'
const winUrl = ref(latestReleasePage)
const macUrl = ref(latestReleasePage)
const version = ref('')
const isLoadingDownloads = ref(true)

const findAssetUrl = (assets, matchers) => {
  for (const matcher of matchers) {
    const match = assets.find((asset) => matcher.test(asset.name))
    if (match?.browser_download_url) return match.browser_download_url
  }
  return ''
}

// 初始化下载按钮
const initDownloadButtons = async () => {
  try {
    const api = 'https://api.github.com/repos/coderDJing/Track-Studio/releases/latest'
    const res = await fetch(api)
    if (!res.ok) throw new Error('Failed to fetch')

    const data = await res.json()
    const assets = data.assets || []
    const releaseUrl =
      typeof data.html_url === 'string' && data.html_url ? data.html_url : latestReleasePage

    winUrl.value = findAssetUrl(assets, [/setup.*\.exe$/i, /\.exe$/i, /\.msi$/i]) || releaseUrl
    macUrl.value = findAssetUrl(assets, [/\.dmg$/i, /\.pkg$/i, /\.zip$/i]) || releaseUrl

    if (data.tag_name) {
      version.value = data.tag_name.startsWith('v') ? data.tag_name : `v${data.tag_name}`
    }

    // 检测操作系统
    const ua = navigator.userAgent
    const isWin = /Windows/i.test(ua)
    const isMac = /Macintosh|Mac OS X/i.test(ua)

    if (isWin) {
      showWin.value = true
      showMac.value = false
    } else if (isMac) {
      showWin.value = false
      showMac.value = true
    } else {
      showWin.value = true
      showMac.value = true
    }
  } catch (err) {
    console.error('Failed to load download links:', err)
    showWin.value = true
    showMac.value = true
  } finally {
    isLoadingDownloads.value = false
  }
}

// 切换平台显示
const togglePlatform = (e) => {
  e.preventDefault()
  const winHidden = !showWin.value
  showWin.value = winHidden
  showMac.value = !winHidden
}

const zhContent = {
  nav: [{ label: '特性', href: '#features' }],
  hero: {
    titleTop: '终结混乱的',
    titleBottom: 'DJ 音频工作站',
    subtitle:
      '不再需要在多个软件间疲于奔命。从真实文件整理、SET 歌单、指纹去重、波形试听、Rekordbox 与 Serato 曲库集成、段落与能量分析、本地库合并，到双轨横推、录音库、单曲 Stem 分离与 Mixtape 工作流，Track Studio 用键盘优先的操作方式，为你打造一站式、所见即所得的桌面音频整理引擎。'
  },
  impacts: [
    {
      id: 'dual-deck',
      title: '双轨横推模式',
      subtitle: '类 DJ 混音台的并排浏览与试听',
      details:
        '支持独立音量推子、交叉渐变、Hot Cue、Memory Cue、Loop、Quantize、Beat Sync、自动增益、CUE 监听和双轨录音。快速判断两首歌是否适合衔接。',
      image: '/assets/softwareScreenshot_cn.webp',
      imageLight: '/assets/softwareScreenshot_cn_light.webp'
    },
    {
      id: 'mixtape-stem',
      title: 'Mixtape 自动录制与 Stem 分轨',
      subtitle: '为演出准备完美的素材',
      details:
        '独立时间线工作台用于排录制、听效果、调参数并直接导出结果。支持跨窗口拖入与跨轨道拖拽定位。内置受管 Stem 运行时，把分轨准备接入主流程。',
      image: '/assets/mixtapeScreenshot_cn.webp',
      imageLight: '/assets/mixtapeScreenshot_cn_light.webp'
    }
  ],
  coreFeaturesIntro: {
    title: '围绕真实整理流程',
    description: '从入库、试听、外部库到编排，常用能力都贴着 DJ 的实际工作路径展开。'
  },
  coreFeatures: [
    {
      title: '单轨编辑与波形可视化',
      details:
        '播放器、列表预览和单轨编辑统一使用 RGB 三频能量波形，可切换半波形/全波形，配合区间播放快速筛歌。精准定位高潮段落与鼓点能量。'
    },
    {
      title: '内容感知去重与真实映射',
      details:
        '基于音频指纹技术，精准识别内容重复的文件。界面上的分组与目录即是真实的磁盘结构，同步生效，告别重复与混乱。'
    },
    {
      title: 'SET 托管歌单',
      details:
        '按演出或场景准备映射型歌单，支持重复曲目、稳定序号、拖拽重排、删除保护和按顺序估算 SET 时长（起止可用 Hot Cue）。整理 SET 不必破坏源曲目。'
    },
    {
      title: 'Rekordbox 与 Serato 曲库集成',
      details:
        '直接读取 Rekordbox 本机库与 U 盘曲库，支持 Cue/Loop 保留、键盘多选、精选表演者导入和 XML 导出；同时可浏览和编辑 Serato 曲库。'
    },
    {
      title: '可控的分析流程',
      details:
        '歌单分析可以确认、暂不分析或手动启动，列表内直接显示进度。后台队列按闲时调度，尽量不抢前台播放。'
    },
    {
      title: '键盘优先的人机工学',
      details:
        '大幅减少鼠标移动与点击，所有高频操作均可通过快捷键完成，保护肩颈，让整理操作更加流畅和高效。'
    }
  ],
  bentoFeaturesIntro: {
    title: '极客特性',
    description: '为高级用户准备的强大工具集。'
  },
  bentoFeatures: [
    {
      title: '智能节拍网格与分析',
      details:
        '分析曲目速度、调性与节拍网格，支持 Tap Tempo 手动修正、未分析队列和列表内分析进度展示。'
    },
    {
      title: '全能格式转换与元数据',
      details: '支持标签整理、封面替换与 MusicBrainz 自动补齐。非 MP3 格式一键转换。'
    },
    {
      title: '跨设备云同步',
      details:
        '可同步精选库目录树、歌单和音频，首次连接时选择两端的对齐方式；也支持 SHA256 指纹与精选表演者跨设备同步。'
    },
    {
      title: '录音库与双轨录音',
      details: '双轨输出可录制为高质量 WAV，录音进入独立录音库，录制时显示毫秒级时长。'
    },
    {
      title: '筛选库与精选库双层架构',
      details: '专为 DJ 打造的双库分流体系，配合快捷键快速筛选，贴合真实的选曲与沉淀习惯。'
    },
    {
      title: '安全的回收站机制',
      details:
        '所有的删除与去重操作均进入专属回收站，支持一键恢复到原歌单，让大批量整理毫无后顾之忧。'
    },
    {
      title: '智能批量重命名',
      details: '支持按预设规则或自定义格式统一修改歌单内文件名，保持音乐库命名绝对一致性。'
    },
    {
      title: '全局搜歌与多源发现',
      details: '支持跨界面搜歌、网易云网页搜索、Spotify 客户端或网页搜索，以及相似歌曲推荐和不再推荐屏蔽。'
    },
    {
      title: '指纹库与相似歌曲',
      details:
        '可从库入口扫描全库加入指纹库，为后续查重、跨来源分析缓存和相似歌曲推荐提供稳定基础。'
    },
    {
      title: 'SET 与演出准备',
      details:
        'SET 歌单保留源曲目映射，允许重复编排和序号排序，并可按顺序估算 SET 时长，适合为不同演出、场景或能量段准备曲目。'
    },
    {
      title: '外部库分析缓存',
      details: 'Rekordbox 本机库与 U 盘曲库、Serato 和普通外部文件可复用分析结果，减少重复分析等待。'
    },
    {
      title: 'Serato 曲库编辑',
      details: '浏览 Serato 文件夹与歌单，创建、重命名、排序和移动歌单，也可把 Track Studio 曲目写入 Serato。'
    },
    {
      title: '闲时分析调度',
      details: '后台分析统一走闲时调度与限流，保障前台操作绝对流畅。'
    },
    {
      title: '合并音乐库',
      details:
        '把另一份音乐库合并进当前库，覆盖歌单、曲目、分析、SET 和 Mixtape；来源库本身不会被修改。'
    },
    {
      title: '移动音乐库',
      details:
        '将当前音乐库整体搬到新位置，支持同盘/跨盘和中断续传，也可在资源管理器或 Finder 中打开音乐库。'
    },
    {
      title: '能量与段落分析',
      details: '提供综合能量、舞池能量、舞蹈性等可查看和筛选的指标，并可按分析出的段落区间试听。'
    },
    {
      title: '自定义主题色',
      details: '在设置中选择预设颜色，或用取色器设定自己的主题强调色。'
    },
    {
      title: '单曲 Stem 工作台',
      details: '对单曲做高质量 4 轨分离，可试听、导出 WAV，并按需下载超高质量模型。'
    },
    {
      title: '代码开源与透明',
      details: '源码公开，采用非商业许可。架构清晰，欢迎在许可范围内参与贡献。'
    }
  ],
  specs: {
    title: '系统要求',
    systems: ['Windows 10 或更高版本 (x64)', 'macOS 12 或更高版本', '暂无 Linux 正式版'],
    formatsTitle: '支持格式',
    formats:
      'MP3, WAV, FLAC, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
  }
}

const enContent = {
  nav: [{ label: 'Features', href: '#features' }],
  hero: {
    titleTop: 'End the Chaos.',
    titleBottom: 'The Ultimate DJ Audio Workspace.',
    subtitle:
      'Stop bouncing between apps. From real file organization, SET playlists, fingerprint dedup, waveform preview, Rekordbox and Serato integration, section and energy analysis, and library merge, to dual-deck browsing, the Recording Library, single-track stem separation, and Mixtape workflows. Track Studio is a keyboard-first, WYSIWYG desktop engine for DJs.'
  },
  impacts: [
    {
      id: 'dual-deck',
      title: 'Dual-Deck Browse Mode',
      subtitle: 'DJ mixer-style side-by-side browsing',
      details:
        'Supports volume faders, crossfader, Hot Cue, Memory Cue, Loop, Quantize, Beat Sync, Auto Gain, Cue monitoring, and dual-deck recording. Quickly judge how two tracks work together.',
      image: '/assets/softwareScreenshot.webp',
      imageLight: '/assets/softwareScreenshot_light.webp'
    },
    {
      id: 'mixtape-stem',
      title: 'Mixtape Auto-Recording & Stems',
      subtitle: 'Prepare perfect materials for your set',
      details:
        'A dedicated timeline workspace for arranging, previewing, tweaking, and exporting mixes. Supports cross-window drag-in. Managed Stem runtime keeps track separation inside the app.',
      image: '/assets/mixtapeScreenshot.webp',
      imageLight: '/assets/mixtapeScreenshot_light.webp'
    }
  ],
  coreFeaturesIntro: {
    title: 'Built Around Real Workflows',
    description:
      'From importing and auditioning to external libraries and mix preparation, common tools stay close to the way DJs actually work.'
  },
  coreFeatures: [
    {
      title: 'Waveform Edit & Visualization',
      details:
        'RGB three-band energy waveforms in the player, list previews, and single-track editing, with half/full height and range playback. Precisely locate drops and drum energy.'
    },
    {
      title: 'Content-Aware Dedup & Mapping',
      details:
        'Identify duplicates based on audio characteristics. UI groups and directories reflect the true disk structure. Say goodbye to duplicates and mess.'
    },
    {
      title: 'Managed SET Playlists',
      details:
        'Prepare performance sets as mapping-based playlists with duplicate entries, stable indices, drag reordering, source-track deletion protection, and SET duration estimates using Hot Cues as start and end points when available.'
    },
    {
      title: 'Rekordbox & Serato Library Integration',
      details:
        'Read the Rekordbox desktop library and USB libraries with Cue/Loop preservation, keyboard multi-selection, curated artist import, and XML export; browse and edit Serato libraries alongside them.'
    },
    {
      title: 'Analysis Under Your Control',
      details:
        'Confirm, skip, or manually start playlist analysis. Per-track progress stays visible, while background queues are scheduled around foreground playback.'
    },
    {
      title: 'Keyboard-First Ergonomics',
      details:
        'Minimize mouse movement. All frequent operations are accessible via shortcuts, protecting your neck and making organization fluid.'
    }
  ],
  bentoFeaturesIntro: {
    title: 'Geek Features',
    description: 'Powerful toolset for advanced users.'
  },
  bentoFeatures: [
    {
      title: 'Smart Beatgrid & Analysis',
      details:
        'BPM, key, and beat-grid analysis with Tap Tempo, manual unanalysed-track queues, and visible per-track analysis progress.'
    },
    {
      title: 'Format Conversion & Metadata',
      details:
        'Tag cleanup, cover replacement, and MusicBrainz assisted filling. One-click non-MP3 conversion.'
    },
    {
      title: 'Cross-Device Cloud Sync',
      details:
        'Sync the Curated library folder tree, playlists, and audio, with a choice of how to align both sides on first connection. Fingerprints and curated artists also sync across devices.'
    },
    {
      title: 'Recording Library',
      details:
        'Record dual-deck output as high-quality WAV, keep recordings in a dedicated library, and see millisecond-level duration while recording.'
    },
    {
      title: 'Dual-Library Architecture',
      details:
        'Dedicated Screening and Curated libraries designed for DJs. Quickly route tracks with shortcuts.'
    },
    {
      title: 'Safe Recycle Bin',
      details:
        'All deletions and dedups go to a dedicated recycle bin with one-click restore. Organize with peace of mind.'
    },
    {
      title: 'Smart Batch Rename',
      details:
        'Unify filenames across playlists using preset rules or custom formats for absolute consistency.'
    },
    {
      title: 'Global Search & Discovery',
      details:
        'Global search, NetEase Cloud search, Spotify desktop or web search, similar track discovery, and controls for hiding unwanted recommendations.'
    },
    {
      title: 'Fingerprint Library',
      details:
        'Scan whole libraries into a reusable fingerprint store for more consistent deduplication, analysis reuse, and similar-track workflows.'
    },
    {
      title: 'SET Preparation',
      details:
        'SET playlists keep source-track mappings intact while allowing duplicate programming, stable ordering, duration estimates, and scene-specific performance crates.'
    },
    {
      title: 'External Analysis Cache',
      details:
        'Reuse analysis results for Rekordbox desktop and USB libraries, Serato, and ordinary external files to avoid repeated waiting.'
    },
    {
      title: 'Serato Library Editing',
      details:
        'Browse Serato folders and playlists, create, rename, reorder, and move playlists, and write Track Studio tracks into Serato.'
    },
    {
      title: 'Idle Analysis Scheduling',
      details:
        'Background analysis runs through unified idle scheduling to guarantee absolute UI fluidity.'
    },
    {
      title: 'Merge Music Libraries',
      details:
        'Merge another music library into the current one, including playlists, tracks, analysis, SET, and Mixtape data, without modifying the source library.'
    },
    {
      title: 'Move Music Library',
      details:
        'Relocate the current music library to a new location, including same-disk and cross-disk transfers with resume. You can also open the library folder in Explorer or Finder.'
    },
    {
      title: 'Energy & Section Analysis',
      details:
        'View and filter tracks by overall energy, dancefloor energy, danceability, and other measures, then audition by analyzed sections.'
    },
    {
      title: 'Custom Accent Color',
      details: 'Choose a preset in Settings or use the color picker to set your own theme accent.'
    },
    {
      title: 'Single-track Stem Workspace',
      details:
        'Separate a single track into high-quality 4 stems, preview and export WAV files, and download the ultra-quality model when needed.'
    },
    {
      title: 'Open Source & Transparent',
      details:
        'Source is public under a noncommercial license. Clear architecture welcomes contributions within that license.'
    }
  ],
  specs: {
    title: 'System Requirements',
    systems: ['Windows 10 or later (x64)', 'macOS 12 or later', 'No official Linux build yet'],
    formatsTitle: 'Supported Formats',
    formats:
      'MP3, WAV, FLAC, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
  }
}

const pageContent = computed(() => (isEn.value ? enContent : zhContent))

// 图片放大查看
const lightboxSrc = ref('')
const lightboxAlt = ref('')

const openLightbox = (src, alt) => {
  lightboxSrc.value = src
  lightboxAlt.value = alt || ''
  document.body.style.overflow = 'hidden'
}

const closeLightbox = () => {
  lightboxSrc.value = ''
  lightboxAlt.value = ''
  document.body.style.overflow = ''
}

const handleKeydown = (e) => {
  if (e.key === 'Escape' && lightboxSrc.value) {
    closeLightbox()
  }
}
</script>

<template>
  <div class="custom-home-wrapper">
    <!-- 鼠标光效 -->
    <div ref="glowRef" class="mouse-glow"></div>

    <!-- 导航栏 (找回之前的设计) -->
    <nav class="nav">
      <div class="container nav-inner">
        <a class="brand" :href="withBase('/')">
          <img
            :src="withBase('/assets/icon.webp')"
            alt="Track Studio"
            style="width: 32px; height: 32px"
          />
          Track Studio
        </a>
        <div class="nav-left">
          <a v-for="item in pageContent.nav" :key="item.href" :href="item.href">{{ item.label }}</a>
          <a href="https://github.com/coderDJing/Track-Studio" target="_blank">GitHub</a>
        </div>
        <div class="nav-right">
          <button
            class="theme-toggle"
            :aria-label="isEn ? 'Toggle theme' : '切换主题'"
            @click="toggleTheme"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="5" />
              <path
                d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
              />
            </svg>
          </button>
          <a :href="withBase(isEn ? '/' : '/en/')" class="lang-toggle">{{
            isEn ? '中文' : 'EN'
          }}</a>
        </div>
      </div>
    </nav>

    <!-- Hero Section -->
    <header class="hero">
      <div class="container hero-inner">
        <h1 class="reveal">
          {{ pageContent.hero.titleTop }}<br /><span>{{ pageContent.hero.titleBottom }}</span>
        </h1>
        <p class="subtitle reveal">
          {{ pageContent.hero.subtitle }}
        </p>

        <div class="cta reveal">
          <!-- 加载骨架屏 -->
          <div v-if="isLoadingDownloads" class="cta-skeleton">
            <div class="sk-btn"></div>
          </div>

          <!-- 下载按钮 -->
          <div v-else class="cta-panel">
            <a v-if="showWin" class="download-btn" :href="winUrl" target="_blank" rel="nofollow">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path
                  d="M0 3.449L9.75 2.1V11.7H0V3.449zm0 17.1L9.75 21.9V12.3H0v8.249zM10.5 1.8L24 0v11.7H10.5V1.8zm0 20.4L24 24V12.3H10.5v9.9z"
                />
              </svg>
              <span class="label">
                {{
                  isEn
                    ? version
                      ? `Download for Windows ${version}`
                      : 'Download for Windows'
                    : version
                      ? `下载 Windows 版 ${version}`
                      : '下载 Windows 版'
                }}
              </span>
            </a>

            <a v-if="showMac" class="download-btn" :href="macUrl" target="_blank" rel="nofollow">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path
                  d="M17.057 12.781c.032 2.588 2.254 3.462 2.287 3.477-.025.065-.338 1.15-1.118 2.273-.679.973-1.381 1.94-2.486 1.96-1.087.02-1.391-.651-2.629-.651-1.241 0-1.609.63-2.67.67-.1.04-1.766-.02-2.527-1.12-1.554-2.245-2.657-6.333-1.055-9.09.795-1.373 2.215-2.248 3.76-2.268 1.171-.025 2.212.748 2.927.748.717 0 1.98-.923 3.342-.782.572.022 2.181.23 3.213 1.731-.082.051-1.922 1.112-1.902 3.33zm-2.404-7.334c.615-.747 1.026-1.783.912-2.821-.892.036-1.972.593-2.612 1.341-.571.659-1.072 1.716-.938 2.731.996.078 2.016-.491 2.638-1.251z"
                />
              </svg>
              <span class="label">
                {{
                  isEn
                    ? version
                      ? `Download for macOS ${version}`
                      : 'Download for macOS'
                    : version
                      ? `下载 macOS 版 ${version}`
                      : '下载 macOS 版'
                }}
              </span>
            </a>
          </div>

          <!-- 其他平台按钮 -->
          <a v-if="!isLoadingDownloads" href="#" class="toggle-platform" @click="togglePlatform">
            {{ isEn ? 'Other Platforms' : '其他平台' }}
          </a>
        </div>
      </div>
    </header>

    <!-- 视觉震撼区 (Visual Impacts) -->
    <section id="features" class="impacts-section">
      <div
        v-for="(impact, index) in pageContent.impacts"
        :key="impact.id"
        class="impact-block reveal"
        :class="{ reverse: index % 2 !== 0 }"
      >
        <div class="container">
          <div class="impact-inner">
            <div class="impact-text">
              <h2>{{ impact.title }}</h2>
              <h3>{{ impact.subtitle }}</h3>
              <p>{{ impact.details }}</p>
            </div>
            <div class="impact-media">
              <div
                class="hero-frame"
                @click="
                  openLightbox(
                    withBase(theme === 'light' ? impact.imageLight : impact.image),
                    impact.title
                  )
                "
              >
                <img
                  class="hero-img"
                  :src="withBase(theme === 'light' ? impact.imageLight : impact.image)"
                  :alt="impact.title"
                />
                <div class="zoom-hint">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35M11 8v6M8 11h6" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 核心整理痛点区 (Core Features) -->
    <section class="core-features-section">
      <div class="container">
        <div class="core-header reveal">
          <h2>{{ pageContent.coreFeaturesIntro.title }}</h2>
          <p>{{ pageContent.coreFeaturesIntro.description }}</p>
        </div>
        <div class="core-grid">
          <div
            class="core-card reveal"
            v-for="(feature, index) in pageContent.coreFeatures"
            :key="index"
          >
            <div class="core-icon">
              <!-- 这里可以用简单的数字或SVG占位 -->
              <span>0{{ index + 1 }}</span>
            </div>
            <h3>{{ feature.title }}</h3>
            <p>{{ feature.details }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 极客特性便当盒 (Bento Grid) -->
    <section class="bento-section">
      <div class="container">
        <div class="bento-header reveal">
          <h2>{{ pageContent.bentoFeaturesIntro.title }}</h2>
          <p>{{ pageContent.bentoFeaturesIntro.description }}</p>
        </div>
        <div class="bento-grid">
          <div
            class="bento-card reveal"
            v-for="(bento, index) in pageContent.bentoFeatures"
            :key="index"
            :class="`bento-item-${index + 1}`"
          >
            <h3>{{ bento.title }}</h3>
            <p>{{ bento.details }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Specs Section -->
    <section class="specs">
      <div class="container">
        <div class="specs-grid">
          <div>
            <h2>{{ pageContent.specs.title }}</h2>
            <ul>
              <li v-for="item in pageContent.specs.systems" :key="item">{{ item }}</li>
            </ul>
          </div>
          <div>
            <h2>{{ pageContent.specs.formatsTitle }}</h2>
            <p>{{ pageContent.specs.formats }}</p>
          </div>
        </div>
      </div>
    </section>

    <footer class="footer">
      <div class="container">
        <small>
          © 2026 Track Studio.
          <a class="footer-alias" :href="withBase(isEn ? '/en/frkb' : '/frkb')">{{
            isEn ? 'Rename note' : '更名说明'
          }}</a>
        </small>
      </div>
    </footer>

    <!-- 图片放大 Lightbox -->
    <Teleport to="body">
      <Transition name="lightbox">
        <div v-if="lightboxSrc" class="lightbox-overlay" @click="closeLightbox">
          <button class="lightbox-close" @click.stop="closeLightbox" aria-label="Close">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <img class="lightbox-img" :src="lightboxSrc" :alt="lightboxAlt" @click.stop />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
@import './custom.css';

.custom-home-wrapper {
  min-height: 100vh;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

.mouse-glow {
  position: fixed;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(var(--accent-rgb), 0.08), transparent 70%);
  border-radius: 50%;
  pointer-events: none;
  z-index: -1;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 1s cubic-bezier(0.16, 1, 0.3, 1);
}

.footer {
  padding: 60px 0;
  text-align: center;
  border-top: 1px solid var(--glass-border);
  color: var(--muted);
}

.footer-alias {
  margin-left: 8px;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* 图片放大查看样式 */
.hero-frame {
  cursor: zoom-in;
  position: relative;
}

.zoom-hint {
  position: absolute;
  bottom: 12px;
  right: 12px;
  width: 36px;
  height: 36px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  opacity: 0;
  transition: opacity 0.25s ease;
  pointer-events: none;
}

.hero-frame:hover .zoom-hint {
  opacity: 1;
}

.lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
  padding: 40px;
}

.lightbox-img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  cursor: default;
  object-fit: contain;
}

.lightbox-close {
  position: fixed;
  top: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  cursor: pointer;
  transition: background 0.2s ease;
}

.lightbox-close:hover {
  background: rgba(255, 255, 255, 0.2);
}

/* Lightbox 过渡动画 */
.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity 0.3s ease;
}

.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}

.lightbox-enter-active .lightbox-img {
  animation: lightbox-zoom-in 0.3s ease;
}

.lightbox-leave-active .lightbox-img {
  animation: lightbox-zoom-out 0.2s ease;
}

@keyframes lightbox-zoom-in {
  from {
    transform: scale(0.9);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes lightbox-zoom-out {
  from {
    transform: scale(1);
    opacity: 1;
  }
  to {
    transform: scale(0.9);
    opacity: 0;
  }
}
</style>
