# 双轨大波形统一实际播放时间标尺

同样缩放下，两轨在未临时推拉时每秒经过的屏幕像素一致。可见源音频时长按正式播放倍率调整，
BPM 仅影响拍线位置：150 BPM 原速的拍线比 120 BPM 更密，调到 0.8 倍后拍宽一致。
修改网格 BPM 不再拉伸源波形。

音频 Sync、render-sync 时钟、联动拖拽时间换算及物理像素对齐算法继续使用原实现。
实时调速仅缩放旧画布，native 中间快照不触发密度重绘；松手后保留缩放，直到最终密度
buffer 准备完成再交接。Sync 事务使用事务自身的目标播放倍率准备密度，避免读到旧 props。

临时加快／减速使用推拉前的正式倍率计算密度，实际播放倍率只驱动滚动时钟。
按住、切换方向、松手等待 native 恢复、等待期间重新按住以及重置时，都连续保留基准密度。

## 自动回归

```powershell
pnpm exec vitest run src/renderer/src/composables/horizontalBrowse src/renderer/src/workers/horizontalBrowse --reporter=dot
npx vue-tsc --noEmit
pnpm run build
```

新增覆盖：不同 BPM / 播放倍率 / 缩放下等速滚动、实际 BPM 一致时拍线间距、网格编辑不改变
波形尺度、live / Sync 事务冻结显示密度、联动拖拽像素位移、native 快照滞后、连续调速反转、
旧帧迟到、松手重入、取消调速、暂停与播放中的 buffer 交接，以及事务准备不修改当前画面。
临时推拉回归覆盖原速、0.8 与 1.2 正式倍率，恢复延迟、快速反向推拉、旧按钮松手、重置，
以及事务读取时密度和实际时钟倍率的区分。当前 41 个测试文件、272 项测试全部通过。

## Renderer 实际渲染检查（2026-10-02）

独立隐藏 Electron 窗口挂载真实 Vue 大波形组件，使用合成的 120 / 150 BPM 鼓点数据，
运行真实 waveform worker、OffscreenCanvas、双 buffer 和分块渲染。IPC 音频与数据加载用测试
数据替代，未访问用户资料库；这项检查不代表原生音频引擎或 macOS 实机验收。

- 亮暗主题均检查，亮色底使用现有统一灰色变量。
- 连续倍率 1.1 → 1.3 → 0.8，拖动期间旧 buffer 保持可见，松手后最终 buffer 上屏。
- 120 BPM / rate=1 与 150 BPM / rate=0.8 的拍线间距相同。
- 暂停态松手前后的网格截图比较，最大位置差为 0.5 个物理像素。
- 缩放从 20 到 60，播放态两轨滚动位移一致。
- 短 Loop 多次回环、播放中两轨再次调速和松手，每帧保持一个可见 buffer，无空白帧和运行时错误。
- 临时推拉期间拍线间距和画布缩放保持不变；模拟 native 延迟 120 ms，松手恢复等待期间密度不变。
- 播放中在暗色临时加快、亮色临时减速，逐帧测得约 250.5 / 229.6 CSS 像素每秒，
  理论值为 249.6 / 230.4，基准滚动速度为 240；正式倍率和密度均保持 0.8。

临时 fixture、截图和逐帧数据位于被忽略的 `.codex_tmp/dual-waveform-qa/`，不提交诊断代码。

## 拆分后的行数

组件保留波形数据、网格编辑、生命周期与交互接线；调速缩放和换帧控制独立为可测试模块。

| 文件 | 行数 |
| --- | ---: |
| `HorizontalBrowseRawWaveformDetail.vue` | 1026 |
| `horizontalBrowseLiveTempoPreviewController.ts` | 115 |
| `horizontalBrowseLiveTempoPreviewController.spec.ts` | 144 |
