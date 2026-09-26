<p align="center">
  <img width="100px" src="https://github.com/coderDJing/Track-Studio/blob/main/build/icon.png?raw=true" alt="Track Studio" />
  <h2 align="center">Track Studio</h2>
  <p align="center">快速音频整理工具</p>
</p>

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/coderDJing/Track-Studio)](https://github.com/coderDJing/Track-Studio/releases/latest)
[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/coderDJing/Track-Studio)](https://github.com/coderDJing/Track-Studio/commits/main)
[![GitHub last commit](https://img.shields.io/github/last-commit/coderDJing/Track-Studio)](https://github.com/coderDJing/Track-Studio/commits/main)
[![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)](https://www.apple.com/macos)

<p align="center">
  <a href="/README.md">English</a>
  ·
  <a href="/readme/README_CN.md">简体中文</a>
</p>

## Track Studio

<p align="center">
  <img alt="Track Studio in action" src="https://github.com/coderDJing/Track-Studio/blob/main/screenshot/softwareScreenshot_cn.png?raw=true">
</p>

## 这是什么

**Track Studio** 是一款面向 DJ 和音乐收藏整理场景的桌面音频工作流工具。它把真实文件整理、SET 歌单准备、波形试听、指纹去重、Rekordbox、Pioneer 与 Serato 曲库读取、段落与能量分析、本地库合并、双轨横推试听、录音、元数据补齐、格式转换、相似歌曲发现、精选库与指纹云同步、单曲 Stem 分离和 Mixtape 编排整合在同一个 Windows/macOS 应用里。

Track Studio 的核心原则很简单：界面里看到的整理结构，应该能真实反映到磁盘文件。它不只是引用管理器。移动、导出、去重、删除和恢复曲目时，文件系统会跟着整理结果一起保持清楚。

## 更名说明

本项目以前叫 **FRKB**，现在产品名是 **Track Studio**，GitHub 仓库是 [Track-Studio](https://github.com/coderDJing/Track-Studio)。

已经安装的版本可以继续用应用内更新。更新仍会覆盖同一套安装身份，设置和音乐库不会丢。桌面快捷方式和开始菜单会改成 **Track Studio**。Windows 安装目录和可执行文件仍叫 `FRKB`，这是为了让新版本覆盖旧版本，而不是并排再装一份。

## 下载

1. 前往官网或 GitHub Releases 下载 Track Studio。
   - 官网：https://coderDJing.github.io/Track-Studio/
   - Releases：https://github.com/coderDJing/Track-Studio/releases
2. 按系统选择 Windows 或 macOS 安装包。
3. 安装后从桌面快捷方式或应用启动器打开 Track Studio。

## 系统要求

- Windows 10 或更高版本（x64）
- macOS 12 或更高版本

_Intel Mac 支持计划持续至 2027 年夏季。_

Track Studio 暂无 Linux 正式版。

## 功能介绍

### 音乐库整理

- **真实文件管理**：Track Studio 直接管理音频文件本身，歌单和库目录会真实对应到磁盘结构。
- **筛选库与精选库**：按 DJ 选曲习惯设计的双阶段整理流程，先快速筛，再沉淀精选。
- **SET 托管歌单**：按演出或场景准备映射型歌单，支持重复曲目、稳定序号、拖拽重排，并保护被引用的源曲目不被误删。
- **SET 时长**：按歌单顺序估算 SET 时长，起止可用 Hot Cue。
- **合并 Track Studio 库**：把另一个 Track Studio 库合并到当前库，覆盖歌单、曲目、分析、SET 和 Mixtape；来源库本身不会被修改。合并前检查完整性和磁盘空间，同名歌单两边都保留。精选库也可单独合并。
- **移动 Track Studio 库**：将当前 Track Studio 库整体搬到新位置，支持同盘/跨盘和中断续传。设置里也可在资源管理器或 Finder 中打开音乐库。
- **歌单树排序**：歌单树可按名称或曲目数排序，也可切回手动排序。
- **拖拽导入与移动**：支持拖入文件/文件夹，曲目可在歌单间拖拽移动，按 Ctrl/Option 可外拖复制到资源管理器/Finder。
- **安全回收站**：删除和去重移除的曲目会进入 Track Studio 回收站，可恢复到原歌单。
- **歌单整理工具**：清空歌单有进度反馈，支持歌单内批量重命名、清理外部库失效记录、底部显示选中数量，批量操作前更容易确认范围。
- **便携库状态**：数据库可以跟随音乐收藏一起迁移，适合在不同设备之间携带。

### 去重、分析与元数据

- **歌曲查重**：支持内容哈希和整文件哈希两种模式。内容哈希可忽略封面、标题、艺术家等元信息差异，识别真正重复的音频内容。
- **歌单指纹去重**：对单个歌单一键分析，将重复曲目移入回收站。
- **BPM 与节拍网格分析**：支持速度和网格分析、Tap Tempo 手动点拍、恢复系统分析 BPM，并针对困难曲目加入更严格的网格候选规则。
- **调性分析**：支持 Classic（如 `C#m`）与 Camelot（如 `1A/1B`）两种调性显示风格。
- **能量与段落分析**：提供综合能量、舞池能量、舞蹈性等指标，可在歌曲列表中查看和筛选；段落分析结果可用于区间试听。
- **定位待分析曲目**：可从底部状态跳到第一首待分析歌曲。
- **可见分析进度**：歌曲列表直接显示曲目级分析状态，后台任务不再完全不可见。
- **手动分析控制**：歌单分析可以确认、暂不分析或手动启动，导入大批曲目时不会突然抢占前台播放资源。
- **指纹库扫描**：可从指定库扫描并建立可复用的指纹库，让后续去重和相似歌曲推荐更稳定。
- **外部来源分析缓存**：Rekordbox、Pioneer U 盘、Serato 和普通外部曲目可复用分析缓存，减少重复分析。
- **元数据编辑与在线补齐**：支持标签与封面编辑，提供 MusicBrainz 条件搜索、AcoustID/Chromaprint 声纹匹配和批量自动补齐。
- **原生 Chromaprint 声纹**：AcoustID 指纹生成走原生模块，减少元数据匹配时的子进程开销。

### 播放与波形

- **多格式播放**：内置媒体工具链，常见和专业音频格式导入后即可试听。
- **区间播放**：可以只播放曲目的指定片段，适合快速筛掉不需要完整听完的歌。
- **浏览器模式小窗播放器**：可从浏览器模式弹出小窗播放，支持区间播放、波形跳转、封面操作，以及从当前播放列表删除上方曲目。
- **输出设备选择**：可指定播放输出设备，也可以跟随系统默认设备。
- **RGB 波形可视化**：播放器、列表预览和单轨编辑统一使用 RGB 三频能量波形，可切换半波形/全波形高度。
- **大波形浏览**：双轨和编辑模式的大波形支持精确拖拽、Cue 定位、网格检查和播放中的平滑重绘。
- **轻量波形缓存**：RGB 显示数据与不同界面的专用缓存，让大波形、列表预览和 Mixtape 时间线在重复打开时更快响应。
- **标题栏音频可视化**：在标题栏实时查看音频能量，不占用主界面空间。
- **文件关联与外部试听**：可从系统直接用 Track Studio 打开支持的音频文件，临时试听但不强制入库。
- **全局快捷键**：窗口最小化时也能控制播放，并支持自定义呼出/隐藏快捷键。

### 双轨横推模式

- **双轨并排试听**：用类似 DJ 混音台的界面同时比较两首歌。
- **单轨控制**：每轨都有播放控制、波形、Hot Cue、Memory Cue、Loop、Quantize 和节拍网格工具。
- **混音控制**：支持独立音量推子、通道控制和交叉渐变器，快速判断两首歌的衔接效果。
- **Beat Sync 与 Master 行为**：可同步双轨速度和网格，同时保持波形显示比例稳定，不让临时速度变化把视觉参考带跑。
- **追速按钮**：按住可让单轨临时变快或变慢，松开后干净回到基础速度。
- **临时调速**：可在双轨中临时调整单轨速度，只作用于当前试听，不写回来源文件。
- **自动增益**：按当前 Master 对齐另一轨响度，避免 A/B 对比被音量差误导。
- **CUE 监听**：支持按轨监听 Cue 输出，方便预听和比较。
- **双轨录音**：可把双轨输出录成高质量 WAV，并直接保存到录音库。
- **只监听的节拍器**：节拍器用于听网格，不会被录进最终音频。

### 录音库

- **独立录音区域**：录音文件进入单独的录音库，不混进普通整理流程。
- **高质量 WAV**：录音保存为非压缩 WAV，采样率跟随当前输出设备。
- **实时录音时长**：录音按钮旁显示毫秒级时长。
- **录音完成摘要**：停止后显示文件名、格式、时长和保存路径。
- **分析隔离**：录音库文件不会被当作普通后台分析候选，避免刚录完就抢占整理任务资源。

### Rekordbox 与 Pioneer 库集成

- **本机 Rekordbox 读取**：直接读取本机 Rekordbox 数据库和歌单，无需先手动导出 XML。
- **Cue 与 Loop 支持**：可读取 Rekordbox/Pioneer 来源的 Hot Cue、Memory Cue 与 Loop，并在复制到 Track Studio 本地库时保留。
- **Rekordbox 歌单操作**：可浏览歌单、拖拽排序曲目，在支持范围内创建或移动歌单节点，并可导出 XML 用于 Pioneer 流程。
- **Pioneer U 盘库支持**：支持读取 Device Library 与 OneLibrary，包含歌单树、预览波形、多盘识别和曲目播放。
- **外部库右键菜单**：Rekordbox 与 Pioneer 曲目列表支持常用右键操作，包括复制到筛选库或精选库。
- **键盘多选**：Rekordbox/Pioneer 歌曲列表支持类似本地列表的键盘范围多选。
- **精选表演者导入**：可从 Rekordbox 与 Pioneer U 盘库导入精选表演者数据，让跨来源选曲标签继续可用。
- **外部曲目只读分析**：Rekordbox、Pioneer U 盘、Serato 和普通外部曲目可做 BPM、网格、能量和段落分析，结果留在 Track Studio 内，不改写源库。
- **缺失文件处理**：找不到原文件的曲目会标红并阻止播放，必要时可清理 Rekordbox 歌单里的失效记录。

### Serato 曲库集成

- **Serato 曲库浏览**：自动检测本机 Serato 曲库，在 Track Studio 中浏览文件夹、Crate、歌单和曲目。
- **Serato 歌单编辑**：可创建、重命名、删除、排序和移动文件夹与歌单，也可以从歌单移除条目，同时保留音频文件。
- **写入 Serato 歌单**：可把 Track Studio 选中的曲目写入 Serato 歌单；需要时使用独立的 Serato 歌曲副本，原文件移动后 Serato 仍能继续使用。
- **Serato 播放数据**：读取 Serato 元数据、波形预览、Hot Cue、Memory Cue 和 Loop，用于浏览与试听。

### Mixtape 与 Stem 工作流

- **Mixtape 时间线工作台**：在独立时间线上编排曲目、预听过渡、调整节拍对齐，并导出时间线一致的结果。
- **跨窗口拖入曲目**：可直接从主库把歌曲拖进 Mixtape 工作区。
- **歌单右键加入 Mixtape**：可从普通歌单右键把曲目加入 Mixtape 自动录制。
- **节拍对齐工具**：支持网格调整、统一波形控件预览同步、节拍器工具，并保持播放与编辑后的网格数据一致。
- **增益、BPM、静音与 Loop 控制**：可用时间线控制、包络、静音段、Loop 叠层和撤销能力处理混音细节。
- **Stem 准备**：支持受管 Stem 运行时、分轨缓存、ONNX fast 分离和 DirectML/XPU 加速，服务于自动录制和混音准备流程。
- **单曲 Stem 工作台**：对单曲做高质量 4 轨分离（人声 / 鼓组 / 贝斯 / 其他伴奏），可试听、导出 WAV，并按需下载超高质量模型。

### 导出、转换与格式

- **曲目导出**：可将选中曲目导出到文件夹，并可选择导出后删除源条目。
- **导出路径记忆**：导出弹窗会记住上次路径，并检查路径是否仍然存在。
- **独立格式转换**：音频文件无需先入库，也可以单独转换格式。
- **批量转换可取消**：长时间转换任务显示进度，可中途取消，并汇总完成、跳过、失败和取消数量。
- **一键转 MP3**：非 MP3 曲目可通过右键菜单转换为 MP3，已有副本会自动跳过。

| 格式     | 扫描/播放 | 转换 |
| -------- | --------- | ---- |
| `MP3`    | 是        | 是   |
| `WAV`    | 是        | 是   |
| `FLAC`   | 是        | 是   |
| `AIF`    | 是        | 是   |
| `AIFF`   | 是        | 是   |
| `OGG`    | 是        | 是   |
| `OPUS`   | 是        | 是   |
| `AAC`    | 是        | 是   |
| `M4A`    | 是        | 是   |
| `MP4`    | 是        | 是   |
| `WMA`    | 是        | 是   |
| `AC3`    | 是        | 是   |
| `DTS`    | 是        | 是   |
| `MKA`    | 是        | 是   |
| `WEBM`   | 是        | 是   |
| `APE`    | 是        | 是   |
| `TAK`    | 是        | 是   |
| `TTA`    | 是        | 是   |
| `WV`     | 是        | 是   |

### 搜索、发现与同步

- **全局搜歌**：支持跨界面搜索曲目，并跳回匹配位置。
- **歌曲筛选**：可按标题、艺术家、专辑、时长、格式、BPM、加入时间等条件筛选，加入时间支持介于范围，并可选择重启后保留筛选条件。
- **网易云搜索**：右键菜单可直接用网易云音乐网页搜索当前曲目。
- **Spotify 搜索**：可按曲目名、艺术家或专辑搜索，优先打开 Spotify 客户端，未安装时打开网页搜索。
- **相似歌曲查询**：从多个来源检索风格相近的歌曲，可从库菜单快速发起，也可以屏蔽不想再看到的推荐。
- **云端指纹同步**：支持将本地 SHA256 指纹与 Track Studio 云端双向同步，包含差异分析、分页拉取、分批上传、配额、频控、清晰摘要和可最小化进度窗口。
- **精选库云同步**：可同步精选库的目录树、歌单和音频；首次连接时选择两端的对齐方式，之后自动同步本机改动并拉取云端更新。
- **精选表演者同步**：多表演者曲目可自动拆分联动，精选表演者数据可跨设备同步。

### 界面与个性化

- **自定义主题色**：在设置中选择预设颜色，或用取色器设定自己的主题强调色。
- **国际化**：内置简体中文和英文语言包。

## 项目背景

作为 DJ，我日常需要整理大量音乐文件。很多现有工具要么鼠标操作太多，要么快捷键不适合长时间工作，要么只是整理引用，真实文件夹仍然一团乱。Track Studio 的目标是让整理更快、更直接、更不脆弱：听得到、看得到、移动的是真文件，离开软件后目录也仍然能用。

## 开发

### 安装依赖

```bash
pnpm install
```

### 编译 Rust 原生模块

```bash
pnpm add -g @napi-rs/cli
cd ./rust_package
napi build --platform --release
```

### 开发模式

```bash
pnpm run dev
```

### 构建

```bash
# Windows
pnpm run build:win

# macOS
pnpm run build:mac
```

## 贡献

欢迎提交 issue、功能建议或 pull request。

## 许可证

CoderDJing 编写的 Track Studio 项目代码遵循 [PolyForm Noncommercial License 1.0.0](../LICENSE)，仅允许非商业使用。当前打包应用包含 GPL/LGPL 第三方组件；详见 [LICENSE](../LICENSE) 和 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 计划开发的功能清单

<a href="../backlog.md">backlog.md</a>

## 云同步后端项目

- `FRKB-API`：[https://github.com/coderDJing/FRKB-API](https://github.com/coderDJing/FRKB-API)
