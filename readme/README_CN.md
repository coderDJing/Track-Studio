<div align="center">
  <img src="../docs/public/assets/icon.webp" alt="Track Studio 图标" width="88">
  <h1>Track Studio</h1>
  <p>整理真实音频文件，在一处完成试听、分析与演出准备。</p>
  <p><a href="../README.md">English</a> · <a href="./README_CN.md">简体中文</a></p>
  <p><a href="https://github.com/coderDJing/Track-Studio/releases/latest">下载</a> · <a href="https://coderDJing.github.io/Track-Studio/">官网</a> · <a href="../docs/features.md">完整功能</a></p>
</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="../docs/public/assets/softwareScreenshot_cn_light.webp">
    <img src="../docs/public/assets/softwareScreenshot_cn.webp" alt="Track Studio 主界面" width="960">
  </picture>
</p>

Track Studio 面向需要整理大量音乐的 DJ 和收藏者。曲库与歌单的整理结果会对应到磁盘上的真实音频文件，离开应用后目录依然清楚、可用。

## 下载

获取最新的 [Windows 与 macOS 安装包](https://github.com/coderDJing/Track-Studio/releases/latest)，或访问[官网](https://coderDJing.github.io/Track-Studio/)。

- **Windows：**10 或更高版本（x64）
- **macOS：**12 或更高版本。Intel Mac 支持计划持续至 2027 年夏季。
- 暂无 Linux 正式版。

正在使用 FRKB？Track Studio 会原位更新，保留原有设置和音乐库。[查看更名说明](../docs/frkb.md)。

## 可以做什么

- **整理真实文件：**建立筛选库、精选库和 SET 歌单，移动或合并音乐库，并从回收站恢复误删曲目。
- **查重与分析：**按音频内容识别重复曲目，分析 BPM、调性、能量和段落，补齐标签与封面。
- **试听与编辑：**浏览 RGB 波形、双轨并排试听、录制混音，并直接编辑单曲音频。
- **接入 DJ 曲库：**浏览 Rekordbox 本机库与 U 盘曲库、Serato Crate，并使用各来源支持的歌单与 Cue 功能。
- **同步收藏：**跨设备同步精选库的文件夹、歌单和音频，以及指纹和精选表演者数据。
- **准备混音：**在 Mixtape 时间线上编排过渡，准备并导出单曲 Stem。

工作流程、支持格式和完整能力清单见[详细功能说明](../docs/features.md)。

## 开发

```bash
pnpm install
pnpm run dev
pnpm run build:win # Windows
pnpm run build:mac # macOS
```

单独编译 Rust 原生模块：

```bash
pnpm add -g @napi-rs/cli
cd rust_package
napi build --platform --release
```

## 项目与贡献

Track Studio 来自 DJ 的日常整理需求：快速筛歌、听歌、移动真实文件，并让音乐库离开应用后也能使用。欢迎提交 issue、功能建议和 pull request。

- [计划开发的功能](../backlog.md)
- [云同步后端 FRKB-API](https://github.com/coderDJing/FRKB-API)
- **许可证：**CoderDJing 编写的项目代码使用 [PolyForm Noncommercial License 1.0.0](../LICENSE)，仅允许非商业用途。打包应用包含 GPL/LGPL 第三方组件，详见[第三方组件声明](../THIRD_PARTY_NOTICES.md)。
