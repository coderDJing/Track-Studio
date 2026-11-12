# Dynamic 网格施工审核记录

施工日期：2026-11-12；RC 开放修订：2026-11-13。结论：本轮开发实现通过工程检查；生产准确率与平台验收尚未完成，不能视为方案 P0～P5 全部通过。

关联：[最小改动方案](./dynamic-grid-analysis-minimal-plan.md)、[长期规范](./dynamic-segmented-beat-grid-design.md)、[验收速查](./dynamic-segmented-beat-grid-test-checklist.md)。

## 实现与审核范围

四个独立 CodeBuddy CLI 原会话固定使用 `deepseek-v4.1-flash`，分别负责算法/评测、桥接/扫描、设置/队列/UI、worker/持久化/能量。协调者独立复现问题、运行检查并退回原会话返工。账号限额后按用户授权预览影响、核对进程并切换已保存账号，只恢复未完成的原会话；账号与凭据未写入仓库。

- Normal 默认保留；Dynamic 提供全曲分窗扫描、有限局部精扫、完整 map 拟合和最终 runtime 拍线审计。按用户 2026-11-13 的明确要求，RC 与开发环境均开放该实验模式；发布启用不代表标定完成。
- 动态结果区分 fixed/dynamic 与 unresolved/unsupported/cancelled/error；失败不改存首段、不写 no-bpm、不清空旧网格。
- 坐标通过实际 PCM 起点和可靠 audio 时长核对，audio→timeline 共用转换函数；能量使用有效完整网格并绑定源签名。
- 持久化在实际 SQLite 事务内核对最新网格、人工来源、代次及磁盘身份，完整 map 和模式/policy 同次写入。成功提交后才更新内存并广播，重复结果幂等；最新非网格字段保留。
- Dynamic 扫描全局单飞，公开进度只携带阶段/窗口/覆盖时间，不暴露 sidecar PID。取消、抢占和 worker 销毁由主进程按所属 PID 清理；生命周期按 worker + job 隔离。
- UI 使用现有主题变量和 bubbleBox 提示；段落算法、接口、缓存、重算及专项验收继续暂缓。

## 已运行的检查

| 检查 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | 通过 |
| `pnpm run build` | 通过，包含 native freshness 与扫描 worker 依赖检查 |
| 本轮定向 Vitest 回归 | 41 个文件、323 项通过，零失败 |
| `pnpm run test:key-analysis` | 16 个文件、99 项通过；与定向集合有重叠，不累计为独立用例总数 |
| Python 窗口协议 unittest | 33 项通过 |
| Prettier（本轮 TS/Vue/SCSS/JSON/YAML/MTS）与 `git diff --check` | 通过 |
| WorkBuddy Switch Next Skill 校验 | 通过 |

定向回归包含 shared 动态算法/坐标/评测、bridge/scanner、worker/queue、真实临时 SQLite 提交竞态、能量缓存、列表比较、设置和 renderer 进度。全部数据库测试仅用独占临时目录，没有写入真实曲库。

复现与实测：

- 稳定速度、阶跃、三段阶跃、微小变速长累计、连续漂移和相位变化的最终 runtime 拍数与构造证据一致；缺重拍证据明确 unresolved。实际算法结果通过跨 worker 严格读取边界。
- 真实本地 Beat This! 模型在同一 Python 进程按 Normal→动态窗口→Normal 运行，Normal 的 BPM、首拍与重拍投影一致，动态窗口返回全曲 audio 坐标。这是协议冒烟测试，不能证明真实音乐准确率。
- 独立合成 PCM/MP3/AAC、48k 重采样及非零容器起点的 seek 检查：MP3 原约 25ms 原点偏差及起始瞬态已修正；所测重采样/容器 seek 位移低于 1ms。契约仍明确 `sampleAccurateSeek=false`、允许 5ms 对齐容差，不承诺所有格式逐样本一致。
- 132 秒合成音频的有界 EOF 时长验证：WAV/MP3/48k 为 132 秒；包含 2 秒起点的 MKA 从容器 134 秒校验为约 132.000483 秒；AAC 按实际解码 PCM 为约 132.005442 秒。首轮单次尾部校验约 17～38ms，发布复核的冷启动最高约 93ms；仅说明这些样本，不代表长曲资源预算。
- 真实自有子进程实验覆盖已知 PID 后取消、取消后才上报 PID 两种情况：所属子进程均退出，对照进程保持运行。自动测试额外覆盖 PID 复用、旧任务消息与重复清理。
- SQLite 竞态测试覆盖首次读后人工编辑、实际事务前人工更新、异步 stat 后文件替换、代次失效、写入失败、外部缓存、事件顺序及重复提交。

## 后续标定与运行时验收

真实音频 development 标定、冻结 policy 后的独立验证、统一 registry 中的动态评测接入与资格报告，仍按原方案推进。当前显式本地文件评测脚本不替代中央 prepare/evaluate/finalize，也不证明 holdout 无泄漏。

Windows/macOS 打包运行、5/10/30/60 分钟资源测量、实际 UI 双主题与悬停手感、双轨跨段同步、Quantize/Loop/Metronome 和 Mixtape 声音/导出验收均未完成。本轮只做主题变量与气泡组件静态检查，不把构建成功视作视觉或声音验收。当前窗口/拍数预算可能对长曲明确返回 unsupported，尚不承诺最长支持时长。

本轮随 RC 提交并按 main→tag 顺序触发发布；发布启用已获用户明确授权，待验证事项仍按上述事实保留。切号工具对 WorkBuddy 桌面 prewarm 的误识别修复另保留在 `workbuddy-switch` 工作区，已通过其针对性 Rust 测试与 CLI 构建，未发布或替换全局旧安装。

仓库外曾误建一个目录，清理操作被自动审批以 `blocked by policy` 拒绝，工具未给出更具体原因；目录保留，未通过其他方式重试删除。

## 代码行数核验

以下为本轮修改和新增代码文件在统一格式化后的实际行数，包含拆分原文件、新模块与测试。全部不超过 1100 行；没有仅把主体整体搬迁后保留单行转发。

| 文件 | 行数 |
|---|---:|
| `rust_package/native/ffmpeg/frkb_ffmpeg_decode_wrapper.c` | 765 |
| `rust_package/native/ffmpeg/frkb_ffmpeg_decode_wrapper.h` | 89 |
| `rust_package/src/ffmpeg_decode.rs` | 510 |
| `rust_package/src/lib.rs` | 946 |
| `rust_package/types/index.d.ts` | 509 |
| `scripts/beat_this_bridge.py` | 1088 |
| `scripts/beat_this_dynamic_windows.py` | 469 |
| `scripts/benchmark_dynamic_beat_grid.mts` | 140 |
| `scripts/test_beat_this_dynamic_windows.py` | 443 |
| `src/main/bootstrap/settings.ts` | 315 |
| `src/main/ipc/cacheHandlers.ts` | 789 |
| `src/main/ipc/keyAnalysisHandlers.ts` | 175 |
| `src/main/ipc/setListHandlers.ts` | 1003 |
| `src/main/ipc/settingsHandlers.ts` | 204 |
| `src/main/libraryCacheDb.ts` | 135 |
| `src/main/libraryCacheDb/externalAnalysisCache.ts` | 772 |
| `src/main/libraryCacheDb/songCache.ts` | 1081 |
| `src/main/libraryCacheDb/songCacheWriteTypes.ts` | 19 |
| `src/main/services/beatGridAlgorithmVersion.ts` | 10 |
| `src/main/services/childProcessRegistry.spec.ts` | 66 |
| `src/main/services/childProcessRegistry.ts` | 84 |
| `src/main/services/keyAnalysis/deferredQueue.ts` | 236 |
| `src/main/services/keyAnalysis/doneEntry.ts` | 30 |
| `src/main/services/keyAnalysis/dynamicGridAudioDuration.spec.ts` | 49 |
| `src/main/services/keyAnalysis/dynamicGridAudioDuration.ts` | 23 |
| `src/main/services/keyAnalysis/dynamicGridIntegration.spec.ts` | 235 |
| `src/main/services/keyAnalysis/dynamicGridIntegration.ts` | 399 |
| `src/main/services/keyAnalysis/dynamicGridPersistence.race.spec.ts` | 348 |
| `src/main/services/keyAnalysis/dynamicGridPersistence.spec.ts` | 509 |
| `src/main/services/keyAnalysis/dynamicGridPersistence.testFixtures.ts` | 61 |
| `src/main/services/keyAnalysis/dynamicGridPersistence.ts` | 384 |
| `src/main/services/keyAnalysis/dynamicGridScheduler.spec.ts` | 97 |
| `src/main/services/keyAnalysis/dynamicGridScheduler.ts` | 55 |
| `src/main/services/keyAnalysis/dynamicSidecarTracker.spec.ts` | 162 |
| `src/main/services/keyAnalysis/dynamicSidecarTracker.ts` | 117 |
| `src/main/services/keyAnalysis/energyCachePolicy.spec.ts` | 49 |
| `src/main/services/keyAnalysis/energyCachePolicy.ts` | 60 |
| `src/main/services/keyAnalysis/energyPersistence.spec.ts` | 207 |
| `src/main/services/keyAnalysis/energyPersistence.ts` | 240 |
| `src/main/services/keyAnalysis/gridAnalysisMetadata.ts` | 53 |
| `src/main/services/keyAnalysis/gridModeQueue.spec.ts` | 281 |
| `src/main/services/keyAnalysis/gridRequestTracking.ts` | 76 |
| `src/main/services/keyAnalysis/jobTimeoutPolicy.ts` | 77 |
| `src/main/services/keyAnalysis/persistGuard.spec.ts` | 53 |
| `src/main/services/keyAnalysis/persistGuard.ts` | 44 |
| `src/main/services/keyAnalysis/persistence.spec.ts` | 360 |
| `src/main/services/keyAnalysis/persistence.ts` | 1075 |
| `src/main/services/keyAnalysis/queue.ts` | 1086 |
| `src/main/services/keyAnalysis/queueActiveFollowUp.spec.ts` | 149 |
| `src/main/services/keyAnalysis/queueJobOptions.ts` | 209 |
| `src/main/services/keyAnalysis/songCacheEntryPersistence.ts` | 134 |
| `src/main/services/keyAnalysis/structurePersistence.ts` | 191 |
| `src/main/services/keyAnalysis/types.ts` | 303 |
| `src/main/services/keyAnalysis/waveformPersistence.ts` | 136 |
| `src/main/services/keyAnalysis/workerDispatch.spec.ts` | 99 |
| `src/main/services/keyAnalysis/workerDispatch.ts` | 44 |
| `src/main/services/keyAnalysis/workerLifecycle.spec.ts` | 256 |
| `src/main/services/keyAnalysis/workerPool.ts` | 906 |
| `src/main/services/keyAnalysis/workerStageUpdate.spec.ts` | 250 |
| `src/main/services/keyAnalysis/workerTermination.spec.ts` | 37 |
| `src/main/services/keyAnalysis/workerTermination.ts` | 31 |
| `src/main/services/keyAnalysisQueue.ts` | 450 |
| `src/main/services/setSongGridAnalysis.ts` | 36 |
| `src/main/workers/beatThisAnalyzer.ts` | 1042 |
| `src/main/workers/beatThisWindowBridge.spec.ts` | 344 |
| `src/main/workers/beatThisWindowProtocol.ts` | 456 |
| `src/main/workers/dynamicBeatGridScan.spec.ts` | 476 |
| `src/main/workers/dynamicBeatGridScanner.ts` | 853 |
| `src/main/workers/dynamicGridAnalysisRunner.spec.ts` | 395 |
| `src/main/workers/dynamicGridAnalysisRunner.ts` | 408 |
| `src/main/workers/dynamicGridDurationProbe.spec.ts` | 163 |
| `src/main/workers/dynamicGridDurationProbe.ts` | 211 |
| `src/main/workers/keyAnalysisWorker.ts` | 911 |
| `src/main/workers/songEnergyMel.ts` | 150 |
| `src/main/workers/songEnergyModel.spec.ts` | 242 |
| `src/main/workers/songEnergyModel.ts` | 1052 |
| `src/renderer/src/components/settingDialog/SettingDialogBody.scss` | 344 |
| `src/renderer/src/components/settingDialog/SettingDialogBody.vue` | 1092 |
| `src/renderer/src/components/settingDialog/useAnalysisGridModeSetting.ts` | 34 |
| `src/renderer/src/components/settingDialogRuntimeDefaults.spec.ts` | 27 |
| `src/renderer/src/components/settingDialogRuntimeDefaults.ts` | 127 |
| `src/renderer/src/components/trackReanalysisDialog.spec.ts` | 169 |
| `src/renderer/src/components/trackReanalysisDialog.ts` | 43 |
| `src/renderer/src/components/trackReanalysisDialog.vue` | 375 |
| `src/renderer/src/pages/modules/songsArea/SongListRows.vue` | 895 |
| `src/renderer/src/pages/modules/songsArea/SongListRows/RowAnalysisBar.vue` | 112 |
| `src/renderer/src/pages/modules/songsArea/composables/useKeyAnalysisProgress.spec.ts` | 212 |
| `src/renderer/src/pages/modules/songsArea/composables/useKeyAnalysisProgress.ts` | 376 |
| `src/renderer/src/stores/runtime.ts` | 558 |
| `src/renderer/src/utils/analysisGridModeUi.spec.ts` | 73 |
| `src/renderer/src/utils/analysisGridModeUi.ts` | 30 |
| `src/renderer/src/utils/manualKeyAnalysis.ts` | 196 |
| `src/renderer/src/utils/trackReanalysis.ts` | 142 |
| `src/shared/analysisGridMode.spec.ts` | 108 |
| `src/shared/analysisGridMode.ts` | 131 |
| `src/shared/dynamicBeatGridAnalysis.spec.ts` | 577 |
| `src/shared/dynamicBeatGridAnalysis.ts` | 476 |
| `src/shared/dynamicBeatGridCoordinates.spec.ts` | 211 |
| `src/shared/dynamicBeatGridCoordinates.ts` | 233 |
| `src/shared/dynamicBeatGridEvaluation.spec.ts` | 200 |
| `src/shared/dynamicBeatGridEvaluation.ts` | 433 |
| `src/shared/dynamicBeatGridEvidence.ts` | 641 |
| `src/shared/dynamicBeatGridFit.ts` | 486 |
| `src/shared/dynamicBeatGridRuntimeAudit.ts` | 228 |
| `src/shared/dynamicBeatGridTypes.ts` | 186 |
| `src/shared/dynamicGridProgress.spec.ts` | 93 |
| `src/shared/dynamicGridProgress.ts` | 66 |
| `src/shared/songListItemCompare.ts` | 326 |
| `src/types/globals.d.ts` | 939 |

## RC 发布修订

版本：`1.2.8-rc.202611130002`。已同步远端 `1.2.8` RC 的 BPM 弹窗与 macOS 媒体工具打包修复，按用户要求开放打包版 Dynamic 实验模式；Normal 默认与段落暂缓范围不变。类型检查、构建、323 项定向测试、99 项既有分析回归、33 项 Python 协议测试与文件路径比较检查均通过。发布按提交→push main→同名 tag→push tag 执行，不将 tag 推送等同于远端安装包已经生成。
