// 官网首页文案。首屏 slogan 保持原文不改；章节按 docs/features.md 的功能模块讲全。
// 每个章节是一个 Hot Cue：字母 + 应用 Hot Cue 槽位色（src/shared/hotCues.ts）。

export type SurfaceKind =
  | 'library'
  | 'dedup'
  | 'player'
  | 'deck'
  | 'mixtape'
  | 'stem'
  | 'external'
  | 'sync'

export interface Chapter {
  id: string
  cue: string
  color: string
  kicker: string
  title: string
  lead: string
  surface: SurfaceKind
  surfaceCaption: string
  groups: { title: string; items: { name: string; detail: string }[] }[]
}

export interface HomeContent {
  nav: { label: string; href: string }[]
  hero: {
    titleTop: string
    titleBottom: string
    subtitle: string
    platforms: string
    formats: string
    scrollHint: string
  }
  chapters: Chapter[]
  keyboard: { kicker: string; title: string; lead: string; points: string[] }
  finale: {
    title: string
    subtitle: string
    systemsTitle: string
    systems: string[]
    formatsTitle: string
    formats: string
    upgradeTitle: string
    upgrade: string[]
  }
  footer: { license: string; features: string }
  download: { windows: string; mac: string; otherPrefix: string }
  progressLabel: string
}

// 与应用 HOT_CUE_SLOT_COLORS 一致
const CUE_COLORS = [
  '#20c997',
  '#2f80ed',
  '#9b51e0',
  '#eb5757',
  '#f2c94c',
  '#ff6b9a',
  '#27ae60',
  '#56ccf2'
]

const FORMATS =
  'MP3 · WAV · FLAC · AIF · AIFF · OGG · OPUS · AAC · M4A · MP4 · WMA · AC3 · DTS · MKA · WEBM · APE · TAK · TTA · WV'

const zhChapters: Omit<Chapter, 'cue' | 'color'>[] = [
  {
    id: 'library',
    kicker: '曲库整理',
    title: '歌单就是磁盘上的文件夹',
    lead: '导入的每一首歌都真实落盘。先在筛选库里快速过一遍，留下的放进精选库，删掉的进回收站，随时能恢复。',
    surface: 'library',
    surfaceCaption: '浏览器模式 · 筛选库：逐首试听，一键移入精选库',
    groups: [
      {
        title: '整理',
        items: [
          {
            name: '真实文件管理',
            detail: '歌单和库目录真实对应磁盘结构，界面里怎么排，文件夹就怎么排'
          },
          { name: '筛选库 / 精选库', detail: '先快速筛，再沉淀精选，贴合 DJ 的选曲习惯' },
          {
            name: '拖拽导入与移动',
            detail: '拖入文件或文件夹；歌单间拖拽移动，按 Ctrl/Option 外拖复制'
          },
          { name: '安全回收站', detail: '删除和去重移除的曲目都进回收站，可恢复到原歌单' }
        ]
      },
      {
        title: '维护',
        items: [
          { name: '合并音乐库', detail: '歌单、曲目、分析、SET、Mixtape 一起合并，来源库不被修改' },
          { name: '移动音乐库', detail: '同盘或跨盘整体搬迁，中断可续传' },
          { name: '批量重命名', detail: '按预设规则或自定义格式统一整个歌单的文件名' },
          { name: '歌单树排序', detail: '按名称、曲目数或手动排序；清空歌单有进度反馈' }
        ]
      }
    ]
  },
  {
    id: 'analysis',
    kicker: '去重与分析',
    title: '重复的歌，一次清干净',
    lead: '基于音频指纹识别真正重复的内容，封面、标题、艺术家不同也认得出来。BPM、调性、能量和段落分析都在后台闲时完成。',
    surface: 'dedup',
    surfaceCaption: '歌单右键 · 指纹去重：重复项直接移入回收站',
    groups: [
      {
        title: '去重',
        items: [
          { name: '内容哈希', detail: '忽略封面、标题、艺术家等元信息差异，识别真正重复的音频' },
          { name: '整文件哈希', detail: '只按文件整体计算，速度最快' },
          { name: '指纹库', detail: '扫描全库建立可复用的指纹库，后续去重和相似推荐更稳定' }
        ]
      },
      {
        title: '分析',
        items: [
          {
            name: 'BPM 与节拍网格',
            detail: '速度与网格分析，Tap Tempo 手动点拍，困难曲目有更严格的候选规则'
          },
          { name: '调性', detail: 'Classic（C#m）与 Camelot（1A/1B）两种显示' },
          { name: '能量与段落', detail: '综合能量、舞池能量、舞蹈性可在列表里查看和筛选' },
          {
            name: '可控的分析',
            detail: '分析可确认、暂不分析或手动启动；列表内显示进度，闲时调度不抢播放'
          },
          { name: '元数据补齐', detail: 'MusicBrainz 条件搜索、AcoustID 声纹匹配、批量自动补齐' }
        ]
      }
    ]
  },
  {
    id: 'playback',
    kicker: '播放与波形',
    title: '看一眼波形，就知道 Drop 在哪',
    lead: '播放器、列表预览和大波形统一使用 RGB 三频能量波形，下面一条段落条标出 INTRO、BUILD、DROP。跳着听重点，不用从头听到尾。',
    surface: 'player',
    surfaceCaption: '底部播放器：半高 RGB 波形 + 段落结构条',
    groups: [
      {
        title: '试听',
        items: [
          {
            name: 'RGB 三频波形',
            detail: '低频、中频、高频按颜色叠加，鼓点和段落一目了然；可切换半高 / 全高'
          },
          { name: '区间播放', detail: '只播放指定片段，也可以按分析出的段落区间试听' },
          { name: '小窗播放器', detail: '浏览器模式可弹出小窗，支持区间播放、波形跳转和封面操作' },
          { name: '多格式播放', detail: '内置媒体工具链，18 种常见和专业格式导入即可试听' }
        ]
      },
      {
        title: '编辑与控制',
        items: [
          {
            name: '单曲音频编辑',
            detail: '剪切、复制、粘贴、重复插入，支持撤销重做，可另存新版本'
          },
          { name: '输出设备', detail: '指定声卡输出，或跟随系统默认设备' },
          { name: '全局快捷键', detail: '窗口最小化时也能控制播放，可自定义呼出 / 隐藏' },
          { name: '外部试听', detail: '从系统直接用 Track Studio 打开音频，临时试听不强制入库' }
        ]
      }
    ]
  },
  {
    id: 'decks',
    kicker: '双轨横推',
    title: '像在混音台上一样挑歌',
    lead: '两首歌上下并排，共用一条节拍基线。Beat Sync、Master、自动增益、CUE 监听都在手边，衔接顺不顺，听一遍就知道。',
    surface: 'deck',
    surfaceCaption: '双轨模式：首屏演示的就是它',
    groups: [
      {
        title: '单轨控制',
        items: [
          {
            name: 'Hot Cue / Memory Cue',
            detail: '每轨 8 个 Hot Cue 槽位，Memory Cue 列表，一键跳转'
          },
          { name: 'Loop 与 Quantize', detail: '按拍数设 Loop，量化让操作自动吸附到网格' },
          {
            name: '追速与临时调速',
            detail: '按住追速按钮临时变快变慢，松开干净回到基础速度，不写回源文件'
          },
          { name: '只监听的节拍器', detail: '节拍器用来听网格，不会被录进最终音频' }
        ]
      },
      {
        title: '混音',
        items: [
          { name: 'Beat Sync 与 Master', detail: '同步双轨速度与网格，波形显示比例保持稳定' },
          { name: '自动增益', detail: '按当前 Master 对齐另一轨响度，A/B 对比不被音量差误导' },
          {
            name: '交叉推子与 EQ 削减',
            detail: '展开推子面板即可按 HI / MID / LOW 削减频段、开 CUE 监听'
          },
          { name: '双轨录音', detail: '把双轨输出录成非压缩 WAV，直接进独立录音库' }
        ]
      }
    ]
  },
  {
    id: 'mixtape',
    kicker: 'SET 与 Mixtape',
    title: '把歌排成一场演出，再录出来',
    lead: 'SET 歌单映射源曲目，可重复、可拖拽、有删除保护。Mixtape 时间线上对齐节拍、画增益与三频包络、加 Loop 和静音段，预听满意再导出。',
    surface: 'mixtape',
    surfaceCaption: 'Mixtape 自动录制：两条轨道交替排歌，包络逐段自动化',
    groups: [
      {
        title: 'SET',
        items: [
          { name: 'SET 托管歌单', detail: '按演出或场景准备映射型歌单，支持重复曲目和稳定序号' },
          { name: 'SET 时长', detail: '按歌单顺序估算时长，起止点可以用 Hot Cue' },
          { name: '删除保护', detail: '被 SET 引用的源曲目不会被误删' }
        ]
      },
      {
        title: 'Mixtape',
        items: [
          { name: '时间线工作台', detail: '独立窗口编排曲目，从主库跨窗口拖入，或在歌单右键加入' },
          {
            name: '节拍对齐',
            detail: '网格调整、统一波形预览与节拍器，播放与编辑后的网格保持一致'
          },
          { name: '自动化包络', detail: '增益、高中低频、音量逐点绘制，带静音段、Loop 叠层与撤销' },
          { name: '录音库', detail: '录音进独立的录音库，完成后显示文件名、格式、时长和路径' }
        ]
      }
    ]
  },
  {
    id: 'stems',
    kicker: 'Stem 分离',
    title: '一首歌拆成四轨',
    lead: '对单曲做高质量 4 轨分离：人声、其他伴奏、贝斯、鼓组。可以逐轨试听、单独导出 WAV，需要时再下载超高质量模型。',
    surface: 'stem',
    surfaceCaption: 'Stem 工作台：分离进度与四轨逐个就绪',
    groups: [
      {
        title: '分离',
        items: [
          { name: '4 轨分离', detail: '人声 / 其他伴奏 / 贝斯 / 鼓组，逐轨试听、导出 WAV' },
          { name: '两档质量', detail: '高质量分析与超高质量分析，超高质量模型按需下载' },
          { name: '硬件加速', detail: 'ONNX fast 分离，支持 DirectML / XPU 加速' }
        ]
      },
      {
        title: '接入工作流',
        items: [
          { name: '受管运行时', detail: 'Stem 运行时由应用管理，不用自己装 Python 环境' },
          { name: '分轨缓存', detail: '分离结果缓存复用，Mixtape 的 Stem 模式直接用' }
        ]
      }
    ]
  },
  {
    id: 'external',
    kicker: '外部曲库',
    title: '不替换你的 DJ 软件，而是接上它',
    lead: '直接读取 Rekordbox 本机库、U 盘里的 Device Library 与 OneLibrary，以及 Serato 曲库。Cue 和 Loop 原样保留，分析结果留在 Track Studio 里，不改写来源。',
    surface: 'external',
    surfaceCaption: 'Rekordbox U 盘曲库：在 Track Studio 里浏览、试听、复制到本地库',
    groups: [
      {
        title: 'Rekordbox',
        items: [
          { name: '本机库直读', detail: '直接读取本机 Rekordbox 数据库和歌单，无需先导出 XML' },
          {
            name: 'U 盘曲库',
            detail: 'Device Library 与 OneLibrary，包含歌单树、预览波形和多盘识别'
          },
          { name: 'Cue 与 Loop', detail: '读取 Hot Cue、Memory Cue 与 Loop，复制到本地库时保留' },
          { name: 'XML 导出', detail: '整理好的歌单导出为 Rekordbox XML' }
        ]
      },
      {
        title: 'Serato 与只读分析',
        items: [
          {
            name: 'Serato 曲库',
            detail: '浏览、创建、重命名、排序和移动 Crate，把曲目写入 Serato 歌单'
          },
          { name: '只读分析', detail: '外部曲目也能做 BPM、网格、能量和段落分析，结果不写回源库' },
          { name: '失效记录处理', detail: '找不到原文件的曲目会标出并阻止播放，可清理失效记录' }
        ]
      }
    ]
  },
  {
    id: 'sync',
    kicker: '同步与发现',
    title: '换台电脑，接着准备',
    lead: '精选库的目录树、歌单和音频可以跨设备云同步，指纹和精选表演者也一起同步。全局搜歌跨界面一步定位，相似歌曲从多个来源推荐新歌。',
    surface: 'sync',
    surfaceCaption: '全局搜歌与云端同步完成摘要',
    groups: [
      {
        title: '同步',
        items: [
          {
            name: '精选库云同步',
            detail: '首次连接选择对齐方式：合并两边、用云覆盖本机或用本机覆盖云'
          },
          { name: '指纹同步', detail: 'SHA256 指纹双向同步，含差异分析、分页拉取和分批上传' },
          { name: '精选表演者', detail: '多表演者曲目自动拆分联动，跨设备同步' }
        ]
      },
      {
        title: '发现',
        items: [
          {
            name: '全局搜歌',
            detail: '按标题、艺人、专辑、调号、BPM 等任意关键词搜索并跳回原位置'
          },
          {
            name: '歌曲筛选',
            detail: '按标题、BPM、时长、格式、加入时间等条件筛选，可保留到重启后'
          },
          { name: '相似歌曲', detail: 'ListenBrainz 与 Last.fm 双源推荐，可屏蔽不想再看到的' },
          { name: '网易云 / Spotify', detail: '右键直接去网易云或 Spotify 搜当前曲目' }
        ]
      }
    ]
  }
]

const enChapters: Omit<Chapter, 'cue' | 'color'>[] = [
  {
    id: 'library',
    kicker: 'Library',
    title: 'Playlists are real folders on disk',
    lead: 'Every imported track lands on disk. Skim new music in the Screening library, keep the good ones in Curated, and send the rest to a recycle bin you can restore from.',
    surface: 'library',
    surfaceCaption:
      'Browser mode · Screening library: audition track by track, move keepers to Curated',
    groups: [
      {
        title: 'Organize',
        items: [
          {
            name: 'Real file management',
            detail: 'Playlists and library folders mirror the disk structure'
          },
          {
            name: 'Screening / Curated',
            detail: 'Triage fast, then keep what matters, the way DJs actually work'
          },
          {
            name: 'Drag and drop',
            detail: 'Import files or folders; drag between playlists; Ctrl/Option to copy out'
          },
          {
            name: 'Safe recycle bin',
            detail: 'Deletions and dedup removals can be restored to their playlists'
          }
        ]
      },
      {
        title: 'Maintain',
        items: [
          {
            name: 'Merge libraries',
            detail: 'Playlists, tracks, analysis, SETs, and Mixtapes merge; source untouched'
          },
          {
            name: 'Move library',
            detail: 'Relocate the whole library, same disk or cross-disk, with resume'
          },
          { name: 'Batch rename', detail: 'Rule-based or custom filenames across a playlist' },
          {
            name: 'Tree sorting',
            detail: 'Sort by name, track count, or manually; clearing shows progress'
          }
        ]
      }
    ]
  },
  {
    id: 'analysis',
    kicker: 'Dedup & analysis',
    title: 'Clean out duplicates in one pass',
    lead: 'Audio fingerprints catch real duplicates even when cover art, title, or artist differ. BPM, key, energy, and section analysis run in the background when the app is idle.',
    surface: 'dedup',
    surfaceCaption: 'Playlist menu · Fingerprint dedup: duplicates go straight to the recycle bin',
    groups: [
      {
        title: 'Dedup',
        items: [
          {
            name: 'Content hash',
            detail: 'Ignores tags and artwork to find truly identical audio'
          },
          { name: 'Whole-file hash', detail: 'Hashes the file as-is, the fastest mode' },
          {
            name: 'Fingerprint library',
            detail: 'A reusable store for consistent dedup and similar-track picks'
          }
        ]
      },
      {
        title: 'Analysis',
        items: [
          {
            name: 'BPM & beat grid',
            detail: 'Tempo and grid analysis, Tap Tempo, stricter rules for hard tracks'
          },
          { name: 'Key', detail: 'Classic (C#m) or Camelot (1A/1B) notation' },
          {
            name: 'Energy & sections',
            detail: 'Overall energy, dancefloor energy, danceability, filterable in the list'
          },
          {
            name: 'Controlled analysis',
            detail: 'Confirm, skip, or start manually; per-track progress; idle scheduling'
          },
          {
            name: 'Metadata fill',
            detail: 'MusicBrainz search, AcoustID matching, and batch auto-fill'
          }
        ]
      }
    ]
  },
  {
    id: 'playback',
    kicker: 'Playback & waveforms',
    title: 'Spot the drop at a glance',
    lead: 'The player, list previews, and big waveforms all use RGB three-band energy waveforms, with a section rail marking INTRO, BUILD, and DROP. Skip to what matters.',
    surface: 'player',
    surfaceCaption: 'Bottom player: half-height RGB waveform plus section rail',
    groups: [
      {
        title: 'Audition',
        items: [
          {
            name: 'RGB waveforms',
            detail: 'Low, mid, and high bands blend into color; half or full height'
          },
          {
            name: 'Range playback',
            detail: 'Play just a region, or audition by analyzed sections'
          },
          {
            name: 'Mini player',
            detail: 'Pop out a compact player with range playback and waveform seek'
          },
          {
            name: 'Wide format support',
            detail: 'Built-in media tooling plays 18 common and pro formats'
          }
        ]
      },
      {
        title: 'Edit & control',
        items: [
          {
            name: 'Track editing',
            detail: 'Cut, copy, paste, repeat insert, with undo; save as a new version'
          },
          { name: 'Output device', detail: 'Pick an audio interface or follow the system default' },
          {
            name: 'Global shortcuts',
            detail: 'Control playback while minimized; custom show/hide hotkey'
          },
          {
            name: 'External playback',
            detail: 'Open audio files from the system without importing them'
          }
        ]
      }
    ]
  },
  {
    id: 'decks',
    kicker: 'Dual-deck browse',
    title: 'Pick tracks like you are on the mixer',
    lead: 'Two tracks stacked on a shared beat baseline. Beat Sync, Master, Auto Gain, and CUE monitoring are right there. One listen tells you whether the blend works.',
    surface: 'deck',
    surfaceCaption: 'Dual-deck mode: the one running at the top of this page',
    groups: [
      {
        title: 'Deck controls',
        items: [
          {
            name: 'Hot Cue / Memory Cue',
            detail: '8 Hot Cue slots per deck plus a Memory Cue list'
          },
          {
            name: 'Loop & Quantize',
            detail: 'Beat-length loops; quantize snaps actions to the grid'
          },
          {
            name: 'Tempo nudge',
            detail: 'Hold to speed up or slow down, release to return; never written back'
          },
          {
            name: 'Monitor-only metronome',
            detail: 'Hear the grid without printing clicks into recordings'
          }
        ]
      },
      {
        title: 'Mixing',
        items: [
          {
            name: 'Beat Sync & Master',
            detail: 'Sync tempo and grid while waveform scale stays stable'
          },
          { name: 'Auto Gain', detail: 'Match loudness to the Master so A/B checks stay honest' },
          {
            name: 'Crossfader & EQ kills',
            detail: 'Expand the fader panel for HI / MID / LOW kills and CUE monitor'
          },
          {
            name: 'Deck recording',
            detail: 'Record the output as uncompressed WAV into the Recording Library'
          }
        ]
      }
    ]
  },
  {
    id: 'mixtape',
    kicker: 'SET & Mixtape',
    title: 'Program the set, then record it',
    lead: 'SET playlists map source tracks, allow repeats and drag reorder, and protect sources from deletion. On the Mixtape timeline, align beats, draw gain and EQ envelopes, add loops and mutes, then export.',
    surface: 'mixtape',
    surfaceCaption: 'Mixtape auto-recording: two alternating lanes with per-clip automation',
    groups: [
      {
        title: 'SET',
        items: [
          {
            name: 'Managed SET playlists',
            detail: 'Mapping-based crates per venue with repeats and stable order'
          },
          {
            name: 'SET duration',
            detail: 'Estimate length in order, using Hot Cues as start and end'
          },
          {
            name: 'Deletion protection',
            detail: 'Sources referenced by a SET cannot be removed by accident'
          }
        ]
      },
      {
        title: 'Mixtape',
        items: [
          {
            name: 'Timeline workspace',
            detail: 'A dedicated window; drag tracks in or add from playlist menus'
          },
          {
            name: 'Beat alignment',
            detail: 'Grid tools, unified waveform preview, and metronome stay in sync'
          },
          {
            name: 'Automation envelopes',
            detail: 'Gain, high, mid, low, and volume, with mutes, loops, and undo'
          },
          {
            name: 'Recording Library',
            detail: 'Recordings get their own library and a saved-file summary'
          }
        ]
      }
    ]
  },
  {
    id: 'stems',
    kicker: 'Stems',
    title: 'Split a track into four',
    lead: 'High-quality 4-stem separation for a single track: vocals, other, bass, and drums. Preview each stem, export WAV, and download the ultra-quality model when you need it.',
    surface: 'stem',
    surfaceCaption: 'Stem workspace: separation progress, stems ready one by one',
    groups: [
      {
        title: 'Separation',
        items: [
          {
            name: '4 stems',
            detail: 'Vocals / other / bass / drums, each previewable and exportable'
          },
          {
            name: 'Two quality levels',
            detail: 'High and ultra quality; the ultra model downloads on demand'
          },
          {
            name: 'Hardware acceleration',
            detail: 'ONNX fast separation with DirectML / XPU support'
          }
        ]
      },
      {
        title: 'In the workflow',
        items: [
          {
            name: 'Managed runtime',
            detail: 'The app manages the Stem runtime, no Python setup needed'
          },
          { name: 'Stem cache', detail: 'Results are cached and reused by Mixtape Stem projects' }
        ]
      }
    ]
  },
  {
    id: 'external',
    kicker: 'External libraries',
    title: 'Keeps your DJ software. Plugs into it.',
    lead: 'Reads the Rekordbox desktop library, Device Library and OneLibrary on USB drives, and Serato. Cues and Loops come along; analysis stays inside Track Studio and never rewrites the source.',
    surface: 'external',
    surfaceCaption: 'Rekordbox USB library: browse, audition, and copy into your local library',
    groups: [
      {
        title: 'Rekordbox',
        items: [
          {
            name: 'Desktop library',
            detail: 'Reads the database and playlists directly, no XML export first'
          },
          {
            name: 'USB libraries',
            detail: 'Device Library and OneLibrary with trees, previews, multi-drive'
          },
          {
            name: 'Cues & Loops',
            detail: 'Hot Cues, Memory Cues, and Loops preserved when copied locally'
          },
          { name: 'XML export', detail: 'Export curated playlists as Rekordbox XML' }
        ]
      },
      {
        title: 'Serato & read-only analysis',
        items: [
          {
            name: 'Serato library',
            detail: 'Browse and edit crates, write Track Studio tracks into Serato'
          },
          {
            name: 'Read-only analysis',
            detail: 'BPM, grid, energy, and sections for external tracks, never written back'
          },
          {
            name: 'Missing files',
            detail: 'Missing sources are flagged, blocked from playback, and cleanable'
          }
        ]
      }
    ]
  },
  {
    id: 'sync',
    kicker: 'Sync & discovery',
    title: 'Switch machines, keep preparing',
    lead: 'The Curated folder tree, playlists, and audio sync across devices, along with fingerprints and curated artists. Global search jumps anywhere; similar-track picks come from multiple sources.',
    surface: 'sync',
    surfaceCaption: 'Global search and the cloud sync summary',
    groups: [
      {
        title: 'Sync',
        items: [
          {
            name: 'Curated cloud sync',
            detail: 'First connection: merge both, cloud over local, or local over cloud'
          },
          {
            name: 'Fingerprint sync',
            detail: 'Two-way SHA256 sync with diffing, paged pulls, and batched uploads'
          },
          {
            name: 'Curated artists',
            detail: 'Multi-artist tracks split and link, synced across devices'
          }
        ]
      },
      {
        title: 'Discovery',
        items: [
          {
            name: 'Global search',
            detail: 'Search by title, artist, album, key, BPM, and jump back'
          },
          {
            name: 'Song filters',
            detail: 'Filter by BPM, duration, format, date added, and more; can persist'
          },
          {
            name: 'Similar tracks',
            detail: 'ListenBrainz and Last.fm picks; hide ones you do not want'
          },
          {
            name: 'NetEase / Spotify',
            detail: 'Search the current track on NetEase Cloud Music or Spotify'
          }
        ]
      }
    ]
  }
]

const withCues = (chapters: Omit<Chapter, 'cue' | 'color'>[]): Chapter[] =>
  chapters.map((chapter, index) => ({
    ...chapter,
    cue: String.fromCharCode(65 + index),
    color: CUE_COLORS[index % CUE_COLORS.length]
  }))

export const zhContent: HomeContent = {
  nav: [{ label: '完整功能', href: '/features' }],
  hero: {
    titleTop: '终结混乱的',
    titleBottom: 'DJ 音频工作站',
    subtitle:
      '从真实文件整理、指纹去重、波形试听，到双轨横推、SET 编排、Mixtape 录制和 Stem 分离。演出前要做的事，在一个键盘优先的桌面应用里做完。',
    platforms: 'Windows 10+ · macOS 12+',
    formats: '18 种音频格式',
    scrollHint: '往下滚，整页就是一首歌'
  },
  chapters: withCues(zhChapters),
  keyboard: {
    kicker: '键盘优先',
    title: '手不离键盘，把一个歌单筛完',
    lead: '高频操作都有快捷键：载入、播放、跳小节、移入筛选库或精选库、删除。双轨模式下两套按键分别控制两个 Deck。',
    points: [
      '所有弹窗按钮都标着对应按键',
      '窗口最小化时全局快捷键照样能控制播放',
      '快捷键可以自定义'
    ]
  },
  finale: {
    title: '免费下载，开始整理你的曲库',
    subtitle: '选择适合你设备的版本，开始准备下一场演出。',
    systemsTitle: '系统要求',
    systems: ['Windows 10 或更高版本 (x64)', 'macOS 12 或更高版本'],
    formatsTitle: '支持格式',
    formats: FORMATS,
    upgradeTitle: '界面语言',
    upgrade: ['简体中文', 'English']
  },
  footer: { license: '源码公开 · 非商业许可', features: '完整功能清单' },
  download: { windows: '下载 Windows 版', mac: '下载 macOS 版', otherPrefix: '或' },
  progressLabel: '章节'
}

export const enContent: HomeContent = {
  nav: [{ label: 'All features', href: '/en/features' }],
  hero: {
    titleTop: 'End the Chaos.',
    titleBottom: 'The Ultimate DJ Audio Workspace.',
    subtitle:
      'Real file organization, fingerprint dedup, and waveform auditioning, through dual-deck browsing, SET programming, Mixtape recording, and stem separation. Everything before a gig, in one keyboard-first desktop app.',
    platforms: 'Windows 10+ · macOS 12+',
    formats: '18 audio formats',
    scrollHint: 'Scroll down: this page plays like a track'
  },
  chapters: withCues(enChapters),
  keyboard: {
    kicker: 'Keyboard-first',
    title: 'Finish a crate without touching the mouse',
    lead: 'Every frequent action has a key: load, play, jump bars, move to Screening or Curated, delete. In dual-deck mode, two key sets drive the two decks.',
    points: [
      'Every dialog button shows its key',
      'Global shortcuts work while minimized',
      'Shortcuts are customizable'
    ]
  },
  finale: {
    title: 'Free to download. Ready for your next set.',
    subtitle: 'Choose the version for your device and start preparing your next gig.',
    systemsTitle: 'System requirements',
    systems: ['Windows 10 or later (x64)', 'macOS 12 or later'],
    formatsTitle: 'Supported formats',
    formats: FORMATS,
    upgradeTitle: 'Languages',
    upgrade: ['简体中文', 'English']
  },
  footer: {
    license: 'Source available · Noncommercial license',
    features: 'Full feature list'
  },
  download: { windows: 'Download for Windows', mac: 'Download for macOS', otherPrefix: 'or' },
  progressLabel: 'Chapter'
}
