# 动态网格分析 · 最小改动方案

维护状态：本轮开发通过工程检查；按用户要求在 RC 开放 Dynamic 实验模式，真实音频标定与完整验收待完成

创建日期：2026-11-12

修订日期：2026-11-13

关联文档：[动态多 clip 网格功能规范](./dynamic-segmented-beat-grid-design.md)、[功能验收速查](./dynamic-segmented-beat-grid-test-checklist.md)

## 1. 目标、范围与兼容边界

给 BPM/网格分析增加 `Normal / Dynamic` 选择。Normal 默认保持现有算法、120 秒扫描范围和缓存行为；Dynamic 扫描全曲，输出通过质量校验的固定网格或多 clip 网格。

Dynamic 覆盖阶跃变速、渐变速度以及黑胶/现场录音的连续漂移。连续漂移使用分段固定 BPM 近似，分段由累计拍线误差决定，不能因相邻窗口 BPM 接近而直接排除。它不承诺恢复任意自由节奏、任意拍号或不可靠录音。

- 不增加逐曲 Auto 分类器；用户选择模式，算法仍负责结果质量。
- 不做 Rekordbox 网格导入产品功能、写回或 per-playlist-item override。离线评测可读取 PQTZ 参考数据。
- 复用 `SongBeatGridMapV2`、播放、同步、编辑及 Mixtape 的动态网格解释，不另建网格格式。
- 段落分析正在独立重构，本期暂缓段落算法适配、接口设计、缓存改造、自动重算与专项验收；这些工作不作为 Dynamic 网格实施和交付的前置条件。
- 本文的“最小”指尽量复用既有数据和消费模型；并非只修改两个构造函数。
- 长期规范和验收速查已同步区分既有人工能力与自动 Dynamic 试验能力；通过工程检查不表示生产准确率、平台和声音验收已完成。

Dynamic 中的单段是有效分析结果，不等于失败后自动运行 Normal。扫描不完整、拍序列歧义或表达能力不足时保留旧网格并报告原因，禁止静默改存第一段。

## 2. 已核对的实现与必须补齐的链路

| 位置 | 当前行为 | 本方案要求 |
|---|---|---|
| `src/shared/songBeatGridMapV2.ts` | 支持多 clip、首段投影、运行时拍线 | 复用；另加分析质量校验，规范化本身不证明准确 |
| `src/main/workers/keyAnalysisWorker.ts` | 网格校验构造固定网格 | 增加 Dynamic 编排和完整网格结果；段落分析分支适配暂缓 |
| `src/main/workers/beatThisAnalyzer.ts` | 一次 PCM 请求，默认扫描 120 秒 | 保留 Normal；增加无状态窗口拍点请求 |
| `scripts/beat_this_bridge.py` | `prepared_windows` 持有局部 beats/downbeats；`finalized_results` 只有摘要 | 增加独立拍点分支，不把固定网格摘要当逐拍输入 |
| `keyAnalysis/types.ts`、`workerDispatch.ts` | 显式定义并构造消息 | 显式传递模式、结果、坐标和进度 |
| `keyAnalysis/workerPool.ts` | `analyze-done` 中途落库与最终落库 | 两条路径共用完整网格结果，幂等写入 |
| `keyAnalysis/persistence.ts` | audio 首拍转换后构造固定网格 | 原子写入完整 map 与其首段投影 |
| `songEnergyModel.ts` | 按固定 BPM 分桶并生成分析窗口 | Dynamic 改用完整拍线与边界；Normal 不变 |
| 播放、同步、编辑、Mixtape | 已有动态分支 | 必须做自动分析来源的跨段回归，不能仅凭已有分支免验收 |

新增实现按职责拆为窗口编排、纯拍点拼接/切段、坐标转换等模块，避免把全部逻辑继续塞入 worker 或 Python bridge。纯算法放在 `src/shared/`，进程和解码逻辑放在 `src/main/workers/`；所有代码文件遵守项目行数限制。

## 3. 设置、请求与任务合并语义

新增 `src/shared/analysisGridMode.ts`：

```ts
export type AnalysisGridMode = 'normal' | 'dynamic'

export const DEFAULT_ANALYSIS_GRID_MODE: AnalysisGridMode = 'normal'
export const ANALYSIS_GRID_MODES: readonly AnalysisGridMode[] = ['normal', 'dynamic']

export const isAnalysisGridMode = (value: unknown): value is AnalysisGridMode =>
  value === 'normal' || value === 'dynamic'

export const normalizeAnalysisGridMode = (
  value: unknown,
  defaultMode: AnalysisGridMode = DEFAULT_ANALYSIS_GRID_MODE
): AnalysisGridMode => (isAnalysisGridMode(value) ? value : defaultMode)
```

设置默认值、加载规范化、写入白名单、共享设置类型、renderer 默认值与界面一起补齐。BPM 范围和分析模式是两个独立选项；每个 Dynamic clip 的 BPM 都必须满足任务冻结的范围，倍频/半频消歧也使用该范围。

解析与队列规则：

1. 新任务按“有效显式参数 → 入队时的全局设置 → normal”解析，入队后冻结。IPC 不得先把缺失字段规范化为 normal，导致全局 dynamic 被覆盖。
2. 全局设置只决定后续实际需要计算的任务，不使老缓存失效；缺失网格的新曲按该设置分析。仅 Key/波形任务不触发 Dynamic 扫描。
3. 显式重新分析 BPM/网格必须强制执行所选模式，不能被既有 complete-grid 或 no-bpm 缓存跳过。
4. 同路径待执行任务可合并同模式请求；不同模式且都要求重新分析时以最新显式请求为准，并将所有等待方绑定到最终任务。未显式指定模式的可见/后台请求不能覆盖已有选择。
5. 已执行任务的模式不可修改。不同模式的显式请求进入该路径的后续任务，替代更早的待执行请求；旧任务结果不能覆盖更新的请求或运行期间的人工修改。
6. 调整 `deferredQueue.requiresFollowUp`、已有 pending/deferred 合并分支及抢占后的重入队，不能只处理新 job 的构造分支。

完整透传位置：设置层 → `keyAnalysisHandlers.ts` / `cacheHandlers.ts` → manual batch options → `queueJobOptions.ts` → `KeyAnalysisJob` → `deferredQueue.ts` → `workerDispatch.ts` → worker 输入 → bridge 请求。

复用现有 renderer IPC 通道，不因字段扩展新增通道；实施时仍须对照主进程、preload 白名单和 renderer 调用。内部 worker/bridge 消息不是 renderer 通道。

## 4. 架构决定：TS 统筹全曲，Python 返回窗口证据

采用无状态窗口协议：

1. worker 负责可信时长、分块解码、窗口计划、取消、进度和资源释放。
2. Python 只对当前块里指定的窗口推理，返回 beats/downbeats 和必要质量数据，不保存整曲会话，不拼接跨请求状态。
3. TS 收集轻量拍点，完成全曲匹配、拍序推断、局部精扫计划、切段和结果判定。
4. 正常路径必须返回拍点，拍点不再由“仅调试开启的 includeBeats”控制；不把 PCM、mel、logits 放入返回值。
5. Normal 继续调用现有 `analyze_pcm` 和固定求解器。Dynamic 请求使用新增内部命令 `analyze_beat_windows`，不复用全局固定 BPM 仲裁来覆盖动态证据。

切段放在纯 TS 模块，评测工具调用同一实现或同一 CLI，禁止另写一套 Python 切段算法作为基准候选。

## 5. 全曲扫描、重叠与解码契约

初始执行参数：块长 120 秒、块重叠 15 秒、粗扫窗口 30 秒、窗口步长 15 秒、精扫窗口 10 秒。参数全部纳入 policy 版本与评测记录。

全曲窗口先在绝对 audio 坐标上计划，再分配到包含完整窗口的块；每个窗口只推理一次。例如首块处理起点 `0, 15, …, 90` 的窗口，下一块从 105 秒解码，处理 `105, 120, …`。窗口间保留 15 秒重叠，不能把每块重新独立切成无重叠 30 秒窗。

- 使用 `decodePcmWithNative(startSec, maxDurationSec)` 有界解码，不通过 `undefined` 放开全曲 PCM。
- 最后窗口对齐真实曲尾；不足现有 8 秒推理下限的尾部并入前一个窗口。全曲不足推理下限时返回明确 unsupported 状态。
- 探测时长必须来自精确文件核对后的可靠音频元数据，并区分 audio 时长与 timeline 时长。不能把当前块的 `totalFrames` 当全曲长度。
- 必须验证 seek 后首样本与请求起点的关系，包括 MP3/AAC 编码延迟、非零容器起点、重采样和曲尾。当前 API 没有返回实际块起点，不能凭参数就断言样本精确对齐。
- 原生解码器必须保证可验证的 audio 坐标契约；若测试不能证明现有实现满足要求，先修正 native 解码并返回必要的实际起点/有效帧数信息，再接 Dynamic，禁止通过拍点整体平移掩盖解码错误。
- 时长不可信、提前截断、解码失败均不能按“已分析全曲”提交；无拍的静音区须保留显式无证据区间。

L1 对所有粗扫窗口运行拍点推理。L2 针对拼接冲突、累计残差超限、疑似变速点及重拍冲突，在其前后补带上下文的 10 秒窗口。BPM 均值不是唯一触发条件，窗口内部短暂变速也须由逐拍残差发现。精扫轮次与窗口数有预算；耗尽后仍不确定则不提交网格。

全曲粗扫成本随时长增长，重叠窗口还会增加推理次数。分级只限制额外精扫成本，不宣称全曲扫描成本不随时长增长。

## 6. 内部桥接协议与严格校验

以下为拟议类型，字段名在实施前按同一契约冻结：

```ts
type BeatWindowRequest = {
  type: 'analyze_beat_windows'
  protocolVersion: 1
  requestId: string
  chunkStartAudioSec: number
  sampleRate: number
  channels: number
  byteLength: number
  windows: Array<{ windowId: string; localStartSec: number; durationSec: number }>
}

type BeatWindowEvidence = {
  windowId: string
  startAudioSec: number
  analyzedDurationSec: number
  status: 'ok' | 'no-beats'
  beatsAudioSec: number[]
  downbeatsAudioSec: number[]
}

type BeatWindowResponse = {
  type: 'beat-windows-result'
  protocolVersion: 1
  requestId: string
  windows: BeatWindowEvidence[]
}
```

请求 JSON 后发送该块 PCM，沿用现有二进制传输和请求排队方式。响应拍点由 Python 将窗口局部时间加窗口及块起点转换为绝对 audio 秒；TS 校验后不再重复加偏移。模型不可用、输入损坏和推理异常使用明确 error 响应，不能伪装成 `no-beats`。

`finalized_results` 不包含逐拍拍点；新分支从预测产生的 beats/downbeats 提取证据。`rawBpm`、拍点稳定性等可作为诊断摘要，但不能代替数组，也不能给未校准的质量值命名为概率置信度。

校验要求：

- 请求/响应 ID、版本、窗口 ID 和数量必须完全匹配；验证上限，拒绝未知或重复窗口。
- 时间、时长必须有限且在当前实际解码区间内；拍点严格递增，无重复、NaN 或越界。
- downbeats 必须能在容差内匹配 beats；记录匹配误差，不能凭空生成 PQTZ `beatNumber`。
- 限制单响应字节数和数组长度，按支持 BPM 范围、窗口长度和合理余量设置；不为“不得报错”吞掉畸形数据。
- 没有 dynamic 字段的旧 Normal 响应仍正常解析；收到不支持新协议的 bridge 应报告运行时版本不匹配，禁止悄悄运行 Normal。
- 包装层分别解析两种命令结果，不能将新响应送入只认固定字段的 `normalizeBeatThisAnalyzeResult`。

最终固定字段由 TS 在完整网格验收后生成，不要求每个窗口返回一个可落库的固定网格。

## 7. 拍点拼接与全曲拍序

1. 对相邻窗口的整个重叠区做单调一对一拍点匹配，用多拍残差估计对应关系；匹配容差随局部拍间隔受限，避免跨到相邻拍。
2. 先核对时间，再核对拍间隔比例及 downbeat 一致性。检测漏拍、多拍和半频/倍频冲突，禁止只拿重叠区第一拍对齐。
3. 重叠区的选择以窗口中部证据优先，接缝取一侧完整拍序列；另一侧用于校验。不得简单平均不同节拍层级的检测点。
4. 用有界编辑匹配推断拍序增量，普通相邻拍为 +1；缺拍只有在前后速度和多窗证据支持时才允许推断整数增量，并保留该推断标记。不能把去重后的数组索引直接当真实拍序。
5. downbeats 用于确定每段模 4 相位。它与跨窗推断冲突时精扫；无法确定时返回 unresolved，不能靠连续累加掩盖重拍错位。
6. 静音/无鼓点区间仅在两端证据共同约束且相位延续成立时跨越；长空白中的拍序存在多解时不猜测。
7. 最终要求全曲证据覆盖、接缝匹配率、漏拍/多拍比例和重拍一致性均达标，之后才进入切段。

离散模型拍点是拟合证据，不是无噪声 truth。局部离群点可按预先固定规则剔除，但必须计入未解释证据比例，禁止通过大量删点换取低残差。

## 8. 切段、拟合与质量判定

对已消歧的拍序 `(n_i, t_i)` 拟合 `t_i = a + n_i × 60 / bpm`。使用稳健损失处理有限离群点；候选 BPM 的范围、倍频/半频一致性和重拍相位作为约束。

### 8.1 先尝试单段，再搜索分段

- 先做全曲单段拟合；全曲残差、尾部误差和重拍均达标时返回 `fixed`，防止稳定曲被无谓切碎。
- 单段不通过时，在拍点边界产生候选切点，使用带段数惩罚的分段线性拟合。漂移、阶跃、相位变化都由拟合误差产生候选，不以某个 BPM 差阈值单独决定。
- 搜索目标为满足质量约束的最少 clip 数，再比较稳健残差；使用固定排序规则解决并列，保证可复现。
- 最短段初始目标为 16 拍。真实短变速无法在此约束内表达时返回 `unresolved`，不得强行并入邻段后标记成功。
- 最多 clip 数初始资源上限为 128，须经播放和 Mixtape 性能验证。超限返回 `unsupported / clip-limit`，不为满足上限破坏网格。
- 每次合并重新拟合整个合并区间，并检查全段残差、最大累计偏差和重拍；BPM 差接近仅用于排序候选，不能作为允许合并的依据。

### 8.2 边界与输出约束

- `startSec` 位于最后确认的左段拍与右段首拍之间，按半开区间裁剪左段外推拍线，不能让它在右段首拍前多生成一根假拍。边界与右段锚点不必相等；右段首个有效拍仍须对应确认的拍序。首段 start 固定为 0，首段 anchor 允许恰为 0。
- 右段锚点必须对应实际拟合拍，按锚点的拍号计算 `downbeatBeatOffset`，不能复制上一窗口摘要的相位。
- 无真实相位重置的变速点要求左右网格在共同边界拍上衔接；若独立拟合不能满足，做约束拟合或精扫，禁止手动平移整段来隐藏误差。
- 将 clips 展开成 runtime.lines 后再次检查边界重复/漏拍、异常短间隔、序号和 downbeat。这一步验证最终消费形式，不能只校验拟合参数。
- `createSongBeatGridMapV2FromClips` 的排序、合并和签名生成仅属于格式规范化。调用前先拒绝输入乱序；调用后用最终 map 重新计算质量。
- 单段规范化显式传 `allowSingleClip: true`，避免默认返回 null 被误判成分析失败。

### 8.3 参数标定与可解释结果

取消无定义的 `segmentationConfidence >= 0.7`。使用有明确分子/分母的指标：有效覆盖时长比例、重叠拍匹配率、未解释拍点比例、拟合拍点绝对残差 P95/最大值、边界误差和 downbeat 冲突数。无证据区间单列，不能被窗口整体长度掩盖。

初始实验参数：拟合 P95 ≤ 15ms、未剔除点最大残差 ≤ 40ms、未解释拍点比例 ≤ 2%、有节拍证据的重叠区匹配率 ≥ 95%、接受结果的重拍冲突数为 0。覆盖率及可跨越空白长度需在含静音标注的 development 集上标定，未冻结前不开放生产入口。以上是实验起点，不是已验证的准确率或发布承诺。

另外约束最终网格与原始证据的累计相位偏差，不能只看相邻拍误差。例：120 与 120.1 BPM 的差很小，持续 600 拍仍相差约 250ms。

所有阈值、稳健损失参数、离群规则、匹配容差、搜索预算和资源上限统一进入有版本的 policy；标定后冻结再验证。不得根据验证集表现继续调整同一候选。

## 9. 结果类型与坐标契约

Dynamic 整曲结果使用判别联合，字段名为设计提议：

```ts
type DynamicGridOutcome =
  | {
      status: 'fixed' | 'dynamic'
      coordinate: 'audio'
      beatGridMap: SongBeatGridMapV2
      durationAudioSec: number
      policyVersion: string
      metrics: DynamicGridMetrics
    }
  | {
      status: 'unresolved' | 'unsupported' | 'cancelled' | 'error'
      reason: string
    }
```

`DynamicGridMetrics` 在实现时定义为明确字段类型，包含第 8 节指标与分母；不能用任意键值对象代替。`fixed` map 恰为 1 段，`dynamic` 至少 2 段。成功结果在 worker 内保留完整 map，跨 worker 的中途/最终 payload 均携带它；失败结果不得带“可落库第一段”。Normal 保持现有结果契约。

坐标转换只有三个阶段：

1. Python：`窗口局部秒 + 窗口块内起点 + 实际块 audio 起点` → 全曲 audio 秒。
2. worker/持久化共用纯转换函数：audio map + `timeBasisOffsetMs` → timeline map。每段 anchor 加偏移，后续 start 加偏移，首段 start 仍为 0；偏移必须按现有时间基准规则规范化，不重复应用。
3. 按可靠 timeline 时长校验并规范化 map，再调用现有投影函数生成 `bpm / firstBeatMs / downbeatBeatOffset`。移到时长外的边界须显式报错，不能静默裁掉。

`workerDispatch` 对 Dynamic BPM 任务始终准备时间基准，不依赖是否勾选其他分析项。持久化接收带坐标标记的原始成功结果，转换并核对签名，防止重复偏移。原始 audio map 用于与解码 PCM 对齐的能量计算。

第一段兼容字段与最终 map 必须始终一致。需要投影的旧调用点应被逐一审查；网格相关计算不能用该摘要代替完整 map。

## 10. 发布结果、人工保护与失败处理

修改 `KeyResultPayload`、`KeyAnalysisWorkerPartialResult`、最终 result，以及 `workerPool.ts` 两条持久化调用。Dynamic 只在整曲扫描、精扫、拟合和坐标校验全部通过后发送一次网格结果；窗口和分块进度不携带可发布的半成品网格。

- `analyze-done` 与最终 result 使用同一份不可变成功结果。相同任务、音频身份和 map 签名的第二次写入幂等，不重复发 UI 更新。
- `persistBpm` 的 Dynamic 分支接收完整 outcome，并强制执行完整 map、坐标、时长和投影一致性校验。不能根据 `clips?.length` 自动决定写动态还是固定。
- 先精确核对文件及当前共享网格，再写入缓存、doneByPath 和更新事件；禁止使用 playlist_view_snapshot 支持写操作。结果、版本、模式元数据和兼容字段必须作为同一份定义更新。
- 除现有 `shouldPersist` 任务所有权校验外，还需每路径请求代次及入队时网格修订信息。更新请求到达、音频被替换或用户修改网格后，旧计算禁止提交。
- 复用 `shouldKeepManualSharedSongGridDefinition`，同时覆盖“分析过程中用户编辑”的竞争；后台分析永不覆盖人工网格。显式重新分析只覆盖用户明确选择的目标，不能因换模式扩大人工覆盖权限。
- Dynamic 重新分析必须先计算后替换。当前 `cacheHandlers.ts` 会先调用 `clearTrackCoreAnalysisForReanalysis`，因此该入口必须为 Dynamic 分离“强制计算”和“立即清空”：新结果成功前保留旧 BPM/网格，不能指望持久化函数恢复已经删除的数据。
- 取消、解码/模型错误、unresolved、unsupported 均保留旧网格；首次分析没有旧网格则保持未分析并展示原因。失败不能写成 no-bpm；“无法确认网格”不等于“没有节拍”。
- 保存成功后按现有局部更新链路合并列表；无变化不赋值，不重开歌单、不重置滚动/选择/播放行。

显式“清除缓存”操作仍按其自身语义执行；不能把保留旧网格的重新分析改成取消了用户要求的清除动作。Normal 入口保持现有行为，这次只为 Dynamic 增加计算后替换语义。

## 11. 能量适配与段落接入边界

### 11.1 本期保留能量适配

- 人工网格被保护时，能量分析也使用该人工 map；不能发布基于被拒绝候选网格的能量结果。
- 能量输入使用有效 map 的 audio 坐标：分析结果直接保留原始 audio map；有效源若为人工 timeline map，则用同一时间基准逆变换，并按实际 audio 区间裁剪派生视图、重定首段 start=0。该转换不反写共享源网格，也不能继续使用被拒绝的分析候选。提交时核对有效源签名。
- 能量分析现有固定 BPM 分桶、窗口边界和节拍相关评分都必须审查。Dynamic 按完整 audio 拍线分桶，窗口由实际 beat ordinal 范围决定；模型权重可复用，Normal 的公式和结果不变。
- 动态能量缓存增加源网格签名与相应分析 policy 标识。只有首段相同而后续 clips 改变时，旧能量结果必须失效或标记待更新。
- 网格成功不依赖能量分析成功，失败单独报告；但不能把未适配的首段计算当作 Dynamic 的正确能量结果交付。能量适配完成前不开放对应组合入口及自动能量任务。
- 旧能量结果可按既有产品规则继续显示为待更新；新能量结果提交前再次核对当前网格签名，防止晚到结果覆盖。

### 11.2 段落相关工作暂缓

- 不按当前段落实现预设新接口，也不在本方案中规定其算法版本、缓存签名、失效重算或与 Dynamic 的联合验收。待段落重构稳定后，在对应方案中单独设计接入。
- 本期提供已落库的完整 timeline map 作为未来接入的数据基础；段落重构未完成不能阻塞网格分析、保存和本期验收。
- 本期不承诺 Dynamic 与段落联合自动分析。现有入口若会连带触发段落，只隔离该任务：不由 Dynamic 网格任务启动基于首段固定投影的段落计算，并将未执行项独立说明；不能静默声称段落已适配，也不能使已成功的网格任务失败或改存 Normal。

## 12. 进度、取消与资源上限

复用现有分析进度通道，增加有类型的 Dynamic 子阶段：扫描、精扫、拟合、保存；附已完成窗口数/总计划数、已覆盖秒数和取消状态。精扫增加工作量时更新计划，不能提前显示 100%；保存结束才报告任务完成。

- 每块结束即释放 PCM 引用，保留轻量拍点；L2 重新按范围解码。单块 120 秒立体声 f32 PCM 约 42.3MB，这只是单份缓冲，不是 RSS 峰值。
- 首版全局只允许一个 Dynamic 重任务占用推理资源，Normal 原有并发不变。避免多个 Dynamic worker 各自启动大模型吞掉内存；统计 worker、Python、传输副本、模型和 GPU 分配。等待资源的任务不能先解码并持有 PCM。
- 基准分别测 BPM-only 与 Key/波形/能量组合。现有其他任务可能持有整曲 PCM，不能把 Dynamic 的有界缓冲等同于整个任务有界内存。
- 取消在窗口/块之间检查，运行中的 Python 推理通过终止该任务拥有的 sidecar 中断；原生同步解码不能依赖同线程消息及时取消，须验证 worker 终止或 native 取消路径。
- worker 销毁、抢占、超时和应用退出都必须回收 Python 子进程。核对现有 process exit hooks 是否覆盖 worker 终止；必要时由主进程记录子进程所有权并清理，不能假定 hook 一定执行。
- 取消后拒绝迟到响应，释放推理占用并使旧任务失去提交资格；多个调用方共享任务时仅移除取消者，最后一个所有者取消才终止。
- Dynamic 使用单请求超时、无进展超时和绝对任务时限；结合窗口预算和设备实测制定，禁止只放大现有统一超时，也禁止仅靠心跳无限延命。
- 正常进度通过现有进度消息展示，不增加常驻 trace 落盘。原型阶段需要诊断时走项目 `log.txt` 链路，交付前移除非错误日志；评测指标写入显式基准报告。

发布前在 Windows 和 macOS 上记录 5/10/30/60 分钟音频的耗时、峰值内存、GPU 占用、取消延迟和残留进程。资源预算及支持时长由这些测量冻结；尚未测量不得宣称固定提速比例或引用 Rekordbox 的耗时代替 FRKB 结果。

## 13. 版本、缓存与元数据

- 实施时重新核对当前版本；若仍为 9，新增算法版本使用 10。版本递增不作为全库自动重算条件，新增一次性迁移也不得批量触发分析。
- 分别记录请求模式、实际结果形态、动态 policy/模型身份和源 map 签名。请求 dynamic 但结果 fixed 是正常组合，不能用 clip 数反推用户模式。
- 模式/来源元数据随共享歌曲定义继承；复制、内部引用和外部缓存保持完整 map。人工编辑后标记新的来源，不能把旧分析元数据当当前事实。
- 元数据用于追踪和重算，不能凭一个 `beatGridMode` 字段恢复被覆盖的旧网格；回滚分析需显式重算或已有备份。
- 完整旧网格仍可读取；只有用户显式重算或原有确实缺失/无效的任务才计算。新增 metadata 缺失不能成为全库失效条件。
- 实施检查缓存准备、doneByPath、共享定义比较、复制继承和本期能量派生缓存，验证新增字段不会被剥离或反复产生空补丁；段落缓存改造留给段落重构。

## 14. 评测先行与发布门槛

### 14.1 数据与 truth

先建立 development 与独立验证协议，再标定算法。沿用中央 registry、不可变音频身份、audio-identity-cache、consumed 状态和 `isolationFamilyId` 隔离规则；当前配置的数据库根目录为唯一入口，不猜盘符，不绕过统一 prepare/evaluate/finalize 流程。

新 Dynamic 数据入口若现有统一工具不支持，应先扩展该工具，不手工拼接 truth 或绕开活动批次限制。训练/调参用过的数据只作 development 回归，不再证明同一候选的泛化提升。

子集覆盖：稳定固定曲、微小阶跃、明显阶跃、连续漂移、短变速、相位变化、静音/长 breakdown、弱鼓点、漏拍/倍频歧义、曲尾变化，以及 120 秒以后的变化。保存原始 PQTZ 拍点、音频身份、时间基准和人工核验记录；Rekordbox 自动分析仅是参考，不能无核验地认作真实节拍。

### 14.2 基准实现

保留现有 single-clip 基准作为 Normal 回归。另建动态评测入口，至少修改或补齐以下职责，不能只放宽 `len(clips) != 1`：

1. truth 读取和签名校验支持完整 map，保留逐拍参考，不能仅取 `clips[0]`。
2. 候选结果规范化保留完整 map，执行与应用相同的坐标和 policy 逻辑。
3. 展开全曲拍线做单调一对一匹配，惩罚漏拍/多拍；不能每拍独立找最近参考拍，也不能逐段重置相位来隐藏错一拍。
4. 统计全曲匹配率、漏/多拍、拍线误差 P50/P95/max、downbeat、边界附近与曲尾误差、稳定曲误切率、未解决比例，以及耗时和内存。
5. 阶跃边界有人工标注时评边界位置；连续漂移优先评拍线拟合，不要求候选 clip 数与参考一致。
6. 报告固定输入 roster、音频 SHA、模型/solver/policy hash、时间基准和运行环境。基准不得写回歌曲网格。

### 14.3 验收条件

- Normal 冻结样本的 BPM、首拍、重拍与有效网格结果零变化；新增模式 metadata 不应触发无意义 UI 更新。
- Dynamic 的固定曲子集不产生未经参考支持的额外切段；误切率与 unresolved 比例同时报告，禁止通过拒绝所有样本取得零误切。
- 动态子集的全曲时间误差、漏/多拍和 downbeat 指标按冻结门槛通过，不能用总体平均改善掩盖某一类型完全失效。
- 正确识别并保留 120 秒以后及接缝附近的变化；固定模式对照的尾部累计误差应能被评测暴露。
- 声称支持的时长和设备均通过资源与取消门槛；阈值须在独立验证前冻结。当前文档参数尚未满足发布条件。

## 15. 自动验证与手动验收

自动验证覆盖：

- 模式缺失/非法值、显式覆盖、入队快照、同路径不同模式、pending/deferred/抢占、后台不覆盖手动请求。
- 新 bridge 协议的 ID/版本/窗口/数组校验、no-beats 与 error 区分、曲尾短窗和截断。
- 构造稳定、三段阶跃、微小变速长累计、渐变、相位变化、短段、漏拍/多拍、半频/倍频和长空白。
- 多窗匹配与 downbeat 一致性；分块结果对窗口计划变化的稳定性。
- PCM 对齐与模型一致性分开测：PCM 样本误差按解码契约验证；拍点匹配率、P95 偏差、漏/多拍单独验证，不要求模型结果达到 1 个采样点精度。
- 非零 timeBasis、第二/第三块、audio→timeline 只转换一次、首段 start=0、边界不越界、投影一致。
- 中途/最终完整落库、重复消息幂等、运行期间人工编辑/文件替换/新请求、失败保留旧网格、首次失败不写 no-bpm。
- 能量分析引用有效 map；后续 clip 改动使能量缓存签名变化；人工保护后不发布候选能量结果。段落分析专项测试和联合验收暂缓。
- 分析中取消、原生解码中取消、Python 异常、worker 抢占/销毁、应用退出，确认旧任务不写回且无残留 sidecar。

手动验收覆盖：固定曲选 Dynamic、阶跃与漂移曲、Normal/Dynamic 显式重算、人工网格保护、重算失败继续播放旧网格、双轨跨段同步、Quantize/Beat Jump/Loop/Metronome、Mixtape 预览和真实导出。验收应检查声音与跨边界连续性，不能只看拍线重合。

界面检查 `theme-light` / `theme-dark`、气泡提示、耗时说明、失败原因和可取消进度；列表沿用已有多段 BPM 摘要、任一 clip 命中筛选和最低 clip BPM 排序，不新增另一套语义。

代码实施后运行 `npx vue-tsc --noEmit` 与 `pnpm run build`，执行相关定向测试；新增/修改 IPC 时用 `rg` 对照注册、preload 和调用。若 Python 拆出辅助模块，必须同步检查 `package.json` / `electron-builder.yml` 的资源映射，并在 Windows/macOS 打包运行时验证新协议和 helper 可用，不能仅验证开发环境。测试命令随具体实现记录，不把仅文档修订误报为功能已验证。

## 16. 实施顺序与交付边界

| 阶段 | 内容 | 完成条件 |
|---|---|---|
| P0 | 动态 truth/评测协议、合成样本、Normal 冻结结果 | 能检测尾部错误、错拍和误切；数据资格明确 |
| P1 | 解码坐标验证、窗口协议、扫描编排、取消/资源原型 | 全曲覆盖可信，分块 A/B 与子进程清理通过 |
| P2 | 拍序消歧、拟合/切段、质量闸门和参数标定 | development 子集通过，失败可解释；冻结 policy |
| P3 | 设置、IPC、队列完整透传、坐标转换、幂等落库和旧网格保护 | 双落库路径完整，竞态与失败不破坏既有数据 |
| P4 | 能量适配及缓存、分析对话框和进度 | 本期承诺组合均使用有效完整网格；段落接入暂缓 |
| P5 | 独立验证、双主题及播放/Mixtape 验收、打包检查 | Windows/macOS 达到冻结的准确率、资源与取消门槛 |

P0/P1/P2 可先开发离线与内部模块；设置及类型透传也可并行准备，但打包 UI 在 P3/P4 完整前不暴露不可工作的选项。段落适配与专项验收不列入 P0～P5 的完成条件，后续跟随段落重构独立接入。经用户于 2026-11-13 明确授权，RC 与开发环境均开放 Dynamic 实验模式；P5 通过前不把试验阈值写成稳定能力承诺。首次功能交付同步更新长期规范和验收速查；不修改 README。

当前主要实施风险是弱节拍区的拍序歧义、连续漂移的 clip 密度、压缩音频 seek 坐标、动态能量适配以及多进程取消。这些都有明确的验证入口；任一关键验证不通过时，应继续修复对应链路或明确收窄支持范围，不能以静默保存固定首段代替。

## 17. 本轮施工与审核记录（2026-11-12）

四个独立 CodeBuddy CLI 原会话固定使用 `deepseek-v4.1-flash` 并发实施；协调者完成独立复现、审核和多轮返工。限额后已按用户授权切号续作，本轮会话均已正常收尾。

- `npx vue-tsc --noEmit`、`pnpm run build` 和格式检查通过，原生模块已重新编译并通过实际解码复核。
- 定向 Vitest：41 个文件、323 项通过；既有 `test:key-analysis`：16 个文件、99 项通过（集合有重叠）；Python 窗口协议：33 项通过。
- 修正最终 runtime 拍线多一拍、MP3 seek 原点/瞬态、非零容器起点时长、完整结果跨进程契约、人工网格/文件替换竞态、单次事务落库与重复广播、取消后迟到 PID 和 PID 复用等问题。
- 实际本地模型 Normal→动态窗口→Normal 冒烟、合成多格式 PCM/EOF 时长检查，以及真实自有子进程清理实验均通过。它们不替代真实音乐准确率和平台资源验收。
- 用户于 2026-11-13 要求取消打包版禁用并发布 RC，已开放 Dynamic 实验模式，Normal 仍默认。未写入真实曲库，未执行真实音频标定、macOS 打包或播放/同步/Mixtape 声音验收。段落接入仍暂缓，P0～P5 不宣称全部完成。

详细范围、检查命令、限制及全部相关文件的实际行数见[本轮施工审核记录](./dynamic-grid-implementation-review.md)。后续继续按第 14～15 节完成数据资格、标定、独立验证与运行时验收，再决定稳定能力承诺；本次 RC 开放不代表这些验证已经完成。
