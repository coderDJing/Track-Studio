# Repository Guidelines

## Project Structure & Module Organization
- `src/main/` Electron main process (app lifecycle, native bridges, IPC handlers).
- `src/preload/` contextBridge layer for safe renderer APIs.
- `src/renderer/` Vue 3 UI, Pinia stores, styles, i18n assets.
- `src/shared/` cross-process utilities; `src/types/` shared TS types.
- `rust_package/` Rust N-API module, with tests in `rust_package/__test__/`.
- `resources/` app assets, `build/` packaging assets, `vendor/` bundled ffmpeg/chromaprint binaries, `out/` build output, `docs/` VitePress documentation site.

## 多实例开发
本地固定三份目录：API、主客户端、对照客户端。改代码只允许在前两份里进行。
- 改代码：`D:\playground\FRKB-API` 与 `D:\playground\FRKB_Rapid-Audio-Organization-Tool`。
- 禁止在 `D:\playground\FRKB_Rapid-Audio-Organization-Tool-5` 改功能代码，也禁止把文件拷过去当同步。
- 日志各落各的。用户说在哪个项目复现，就先读那个项目的日志；跨设备问题交叉读多份。
  - 主客户端开发日志：`D:\playground\FRKB_Rapid-Audio-Organization-Tool\log.txt`
  - Tool-5 开发日志：`D:\playground\FRKB_Rapid-Audio-Organization-Tool-5\log.txt`
  - API：`D:\playground\FRKB-API\logs\`（`app-*.log` / `error-*.log`）

## Build, Test, and Development Commands
- `pnpm install` installs root dependencies.
- `pnpm run dev` starts the Electron + Vite dev workflow.
- `pnpm run build` builds main/renderer into `out/`.
- `pnpm run build:win` (or `build:mac`, `build:linux`) packages installers via electron-builder.
- FRKB 不做 Linux 平台；`build:linux` 仅视为历史残留脚本，禁止将 Linux 作为正式支持、发布、验收或修复目标继续扩展。
- `pnpm run docs:dev` starts VitePress dev server for documentation site.
- `pnpm run docs:build` builds VitePress site into `docs/.vitepress/dist/`.
- `pnpm run docs:preview` previews the built documentation site locally.
- `pnpm run lint` and `pnpm run format` apply ESLint/Prettier rules.
- `cd rust_package` then `napi build --platform --release` builds the native module (requires `@napi-rs/cli`).
- `cd rust_package` then `yarn test` runs `ava` tests.

## Coding Style & Naming Conventions
- Indentation: 2 spaces; LF; trim trailing whitespace; end files with a newline.
- Prettier: single quotes, no semicolons, `printWidth: 100`.
- ESLint extends Vue 3 + Electron toolkit; component names may be single-word.
- 禁止编写非必要的 `any` / `as any`；优先使用明确类型，其次使用 `unknown` 配合运行时守卫，最后才允许保留极少数有充分理由的边界类型。
- 禁止用“兜底 / fallback / 回退到系统环境”代替真正修复；如需临时兜底，必须明确标注为临时措施，并继续修复根因后方可交付。
- Renderer UI 禁止使用原生 DOM `title` 属性做悬停提示；凡是按钮说明、状态说明、路径/文件名完整内容展示、文本省略后的悬停提示，统一使用项目现有 `bubbleBox.vue` 气泡框组件或基于它的明确封装。
- 上一条仅针对原生 DOM `title` 属性；自定义组件自身的 `title` prop 若不下沉为原生 DOM 属性，可以按组件设计继续使用，但禁止借此变相把提示文案重新落回原生 `title`。
- 遇到 `disabled` 按钮、图标按钮、输入框包装层等 hover 不稳定场景，也必须通过可悬停的外层锚点接入 `bubbleBox`，禁止为了省事退回原生 `title`。
- 新增或修改 Renderer UI 时必须同时适配并检查 `theme-light` 和 `theme-dark`；禁止只按暗色或只按亮色交付。颜色、背景、边框、阴影、伪元素、canvas 绘制、worker 绘制都应优先走主题变量。日间模式下所有波形区域必须使用统一灰色底色变量（如 `--waveform-bg` / `--waveform-bg-elev`），避免 RGB 波形直接落在白底上。
- 单个代码文件不应超过 1100 行；超过 1100 行时必须进行拆分，且拆分后的模块放置位置与命名应符合现有项目结构与习惯。
- 临时运行时排查期间，如果仅因新增调试日志导致代码文件超过 1100 行，可以暂时不拆分；调试日志默认按 Debug Logging 规则在交付或提交前删除，删除后仍超过 1100 行才需要拆分。若用户明确要求把诊断日志提交上去，用于排查未来偶发问题，则允许保留并提交这类日志，但必须保持轻量、阈值化、目的明确。
- 不要在每次普通代码修改后都主动检查全量代码文件行数；只有准备提交、用户明确要求拆分/检查行数，或当前修改明显会让目标文件长期超过 1100 行时，才执行行数检查并按规则拆分。
- 如果用户提出“拆分代码”并指定了行数上限 `N`，则拆分后所有相关文件（包括原文件与新拆出的文件）都必须 `<= N` 行；若用户未指定，则默认执行 `<= 1100` 行规则。
- “拆分”必须为真拆分：禁止把主体逻辑整体挪到一个新文件后，仅在原文件保留单行转发/导入；原文件必须保留清晰且有实际价值的职责边界与实现。
- 拆分完成后必须执行行数校验并在交付时明确给出每个相关文件的实际行数，确保可核验。

## 歌单打开与后台刷新（红线）
- 后台核对、重扫、增量补丁绝不能让用户看见列表“退出重进”或不断闪动。刷新必须就地合并：等价的行复用旧对象引用（`src/shared/playlistViewMerge.ts` 的 `planSongListMerge`），禁止用整份新列表覆盖 `originalSongInfoArr` 让 Vue 重建所有行。
- 后台刷新禁止重跑首次打开的渐进渲染、禁止重置滚动位置 / 选中项 / 当前播放行；内容完全没变化时必须**一个 UI 动作都不做**（连赋值都不做）。连续到达的多个刷新事件必须合并成一次（最新优先 + 单飞）。
- 行等价判定必须主进程与 renderer 共用 `src/shared/songListItemCompare.ts`；两边各写一套会导致反复推空补丁或漏刷新。
- 视图快照（`playlist_view_snapshot`）只服务“读 / 展示”。移动、删除、改标签、写分析、导出 rekordbox XML、云同步对账等任何写操作都必须先走精确磁盘核对，禁止读快照。

## Testing Guidelines
- Rust module tests live in `rust_package/__test__/` and follow `*.spec.mjs` naming.
- There is no root JS test runner yet; add new suites near the code they cover and document how to run them.
- 代码修改完成后必须运行 `npx vue-tsc --noEmit`；若存在错误，必须先修复再交付。

## Debug Logging
- 涉及运行时排查、交互链路排查、状态机排查时，默认把调试日志写入 `log.txt` 可落盘链路，不要依赖浏览器控制台临时输出。
- 开发模式通过 `pnpm run dev` 启动时，`log.txt` 固定在**当前这个客户端实例**的项目根目录；主客户端与 Tool-5 各有一份，禁止读错目录。只有打包运行时才读取 Electron `userData` 目录下的 `log.txt`，禁止混淆两者。
- Renderer 侧调试信息应通过现有 console bridge / `outputLog` / 主进程 `log` 体系进入 `log.txt`，确保我复现一次后，Codex 可以自行读取日志继续排查。
- 禁止把“请把控制台日志复制给我”当成默认方案；除非日志链路本身损坏，否则应优先由 Codex 自己读取 `log.txt`。
- 常驻代码里禁止保留非报错落盘日志；提交前默认必须清理 `log.info` / `log.warn` / `log.debug`、普通 `console.log` / `console.info` / `console.warn` / `console.debug`、以及各类 trace 型 `outputLog`。默认只保留真正的错误/异常日志进入 `log.txt`。若用户明确要求提交诊断日志用于排查未来偶发问题，可以保留对应日志，但必须说明触发条件、字段含义和后续清理条件，禁止把泛滥 trace 当成常驻日志提交。
- 只有在当前任务明确需要运行时排查时，才允许临时增加非错误调试日志；这类日志必须走现有 `log.txt` 链路，并且默认在交付前删除，不能把调试噪音留在仓库里。用户明确要求保留并提交的诊断日志除外，但仍必须保持最小范围、可检索、可关闭或有明确阈值。
- `pnpm run dev` 启动阶段的开发提示、脚本提示、端口提示等输出，默认只打印终端，不写入 `log.txt`。这类输出应使用开发脚本/终端控制台，不要接入主进程 `log` 或 renderer `outputLog` 落盘链路。

## Network & Proxy Rules
- 任何对外网络请求都必须默认遵守用户当前网络环境：用户开启 VPN / TUN 时应跟随系统路由；用户配置系统代理 / PAC 时必须显式接入系统代理，不能绕过。
- 主进程新增外部 HTTP 请求时，禁止直接写裸 `fetch`；必须复用现有系统代理链路（如 `getSystemProxy()` + `ProxyAgent` 或统一封装），确保请求自动走用户已开启的 VPN / 代理。
- Renderer 禁止直接发起新的外部网络请求；涉及外部服务统一下沉到主进程代理层处理，再由主进程按系统代理规则发出。

## Commit & Pull Request Guidelines
- Recent commits use Conventional Commit prefixes with optional scopes: `feat(ui): ...`, `fix(player): ...`, `refactor(...)`, `docs(...)`.
- 提交信息必须使用中文（保留 Conventional Commit 结构）。
- PRs should include a clear summary, testing notes, and screenshots for UI changes; link related issues and call out packaging or native-module impacts.

## Release Rules
- 如果我说“发布预发布版本”，默认执行：更新 `package.json` 版本号为 `X.Y.Z-rc.<当前时间>`（时间格式 `YYYYMMDDHHmm`），提交，并**先 push main**，再打同名 tag 并 push tag 触发发布流程。
- 如果当前版本是正式版（不含 `-rc`）且我要求预发布版本，自动把版本号 **补丁位 +1**（`Z+1`，逢 10 进 1，例如 `1.1.9 -> 1.2.0`），再加 `-rc.<当前时间>` 并发布。
- 如果我说“发布正式版”，就把 `-rc.` 以及后面的时间后缀去掉，仅保留 `X.Y.Z`，提交，并**先 push main**，再打同名 tag 并 push tag 触发发布流程。
- 发布顺序固定：提交 → push main → 打 tag → push tag。

## Documentation Updates
- Do not modify `README.md` or `readme/README_CN.md` without explicit maintainer approval.

## Configuration & Security Tips
- Copy `env.example` to `.env` for local config; never commit secrets.
- If updating `vendor/` binaries, ensure `electron-builder.yml` packaging paths stay in sync.

## 按需脚本

- **rekordbox样本预分拣**：`scripts/move_rekordbox_playlist_grid_diffs.py`，详细用法见 `drafts/rkb-benchmark-workflow/分拣脚本.md`。
  - Python 环境：`vendor/demucs/win32-x64/runtime-cpu/python.exe`（含 torch、soxr、beat_this 等 ML 依赖）。Rekordbox bridge 子进程会自动使用 `vendor/rekordbox-desktop-runtime/win32-x64/python/python.exe`。
  - 用户人工流程固定为 `Upan -> test -> needReview -> review`：艾特 `分拣脚本.md` 时从 Upan 取 500 首、
    分拣后用户把 test + needReview 的本轮剩余项移入 review；艾特 `准备好rkb新样本.md` 时只从 review 的
    report 绑定完整 roster 创建 consumed development batch。禁止绕过统一入口手工拼接 truth / benchmark / sealed 命令。
  - 中央 `rkb-dataset-registry.json` 必须先一次性覆盖历史 3745 个 consumed 样本，并具备不可变 `familyId`、完整 Chromaprint、`batchId` 和 `batchStatus = consumed`；注册未完成时禁止 fresh prepare/evaluate，fresh/evaluating/exposed 记录禁止进入 development split。split / LOBO 必须先按固定纯音频 policy 合并为 `isolationFamilyId`，禁止只按 exact family 声称无泄漏。
    初次迁移固定按历史批次执行 `import-consumed`，全部导入后执行
    `initialize-registry --expected-track-count 3745`，并用重复的 `--expected-batch <batchId>=<数量>`
    锁死 `current1407 / blind608 / old377 / new357 / test327 / test353 / test316` 七批；
    `rebuild-registry` 只用于初始化后的派生视图重建。
  - FRKB 数据库根目录只认 `.env` 的 `FRKB_BENCHMARK_DATABASE_ROOT` / `FRKB_DEV_DATABASE_URL`；
    D 到 G 的文件迁移未完成时禁止切换配置、禁止按迁移中的目录瞬时数量初始化 registry，也禁止脚本自行猜盘符。
    当前 FRKB-5 已切到 `G:/FRKB_database-E`，历史 baseline 为 7 批 / 3745 首；禁止回退到已不存在的 D 盘目录。
  - PCM / Chromaprint 身份计算默认使用 `audio-identity-cache`，按 16 首分块断点续算。缓存命中仍必须重算
    asset SHA-256 并校验文件大小、mtime、helper SHA 和参数；缓存只能减少重复解码，不能代替身份校验。
  - G 盘旧 `.frkb_audio_library_manifest.json` 是 registry 建立前的 1916 首迁移快照，仅作历史记录；
    当前数据权威源是 `rkb-dataset-registry.json` + baseline，禁止再拿旧 manifest 判断样本总数或根目录。
  - `test` 差异分拣是 pre-review label QA：完整 roster、audio SHA-256、solver/hash 必须先写入 report，
    再按同一 report 把差异项移至 `needReview`。旧算法的这次比对不改变未来候选的证据资格；只有 review batch
    被用于训练/调参后，才不能验证使用过它的同一候选。review prepare 必须按 report 绑定整批 roster 与音频身份；缺 fingerprint 或近重复时 fail closed。
  - 同一时刻只允许一个 fresh/evaluating/exposed 批次；存在活动批次或 `sealed-intake` 除 `.frkb.uuid` 外仍有内容时，必须先 finalize/清理，禁止强行 prepare。`.frkb.uuid` 是资料库节点身份标记，必须保留。
  - 执行流程仍是先跑 dry-run；如果 `errorTrackCount == 0`，固定使用已生成报告的
    `--from-report <report> --apply` 写回，不重新分析后直接 apply，也不需要再次询问用户。写回前必须校验
    report 的 solver/snapshot 身份和 playlist `rowKey`。若用户要把本批纳入训练/调参，使用
    `prepare --playlist review --reviewed-development --triage-report <report>` 直接 consumed；之后禁止根据本批
    结果调参后再用本批证明同一候选提升。旧 consumed 数据维护才可传 `--consumed-maintenance`。
- **Upan 源头清理**：`scripts/move_upan_non_integer_bpm_tracks.py`，默认 dry-run；确认后加 `--apply`。固定顺序：先从 `Upan` 直接移除 current truth 重复曲目和源歌单内部重复多余项，再将剩余曲目里 UI BPM（bridge `bpm` 字段）非整数的移动到 `upanNonIntegerBpm`。
