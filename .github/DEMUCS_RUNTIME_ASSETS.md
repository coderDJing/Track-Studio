# Demucs Runtime Assets Release

## 目的

这套流程用于发布 `demucs-runtime-assets` GitHub Release 资产。

当前资产除了 Stem runtime 之外，还承载 Beat This 运行时依赖与本地 `final0.ckpt` checkpoint。
Windows / macOS GPU runtime 现在必须使用新资产，旧资产会被客户端识别为需要迁移重下。

## RC 与正式版通道

客户端现在按版本默认切换 runtime manifest：

- 正式版：`demucs-runtime-assets`
- 预发布版 / `-rc`：`demucs-runtime-assets-rc`

对于 `1.1.7` 起的正式版及采用渠道分流后的 RC，这意味着：

- `-rc` 客户端不会再读取正式版 runtime manifest
- 正式版客户端不会再读取 RC runtime manifest

历史例外：`1.1.5`、`1.1.6` 和 2026-04-11 渠道分流改动之前的下载实现，
包括当时的 RC，统一读取 `demucs-runtime-assets`。不能仅根据应用版本里是否有 `-rc`
来推断所有历史客户端的渠道。

如果要临时覆盖，可使用：

- 环境变量 `FRKB_DEMUCS_RUNTIME_RELEASE_TAG`
- 或环境变量 `FRKB_DEMUCS_RUNTIME_MANIFEST_URL`

## 推荐做法

优先使用 GitHub Actions 工作流：

- 工作流：`Demucs Runtime Assets`
- 文件：`.github/workflows/demucs-runtime-assets.yml`

### 首次发布或大版本迁移

首次发布某个 `release_tag`，必须一次性构建全部平台：

- `build_win = true`
- `build_mac_arm64 = true`
- `build_mac_x64 = true`

否则合并阶段拿不到旧 manifest，会直接失败。

### 这次 Beat This 迁移的建议输入

RC 运行时建议先发到：

- `release_tag`: `demucs-runtime-assets-rc`

正式版确认稳定后，再发到：

- `release_tag`: `demucs-runtime-assets`
- `win_profiles`: `cpu,cuda,directml,xpu`
- `mac_arm64_profiles`: `cpu,mps`
- `mac_x64_profiles`: `cpu`
- `build_win = true`
- `build_mac_arm64 = true`
- `build_mac_x64 = true`

如果想强制区分资产版本，可以填写 `asset_version`。
如果想让 RC / 正式版 manifest 明确记录当前应用版本，可以额外填写 `app_version`。

### 正式版优先做 RC 提升

如果正式版发布前最后一个 RC 与正式版之间只有版本号变化，没有其他代码变化，
优先不要重新构建正式版 runtime，而是直接把 RC runtime 提升到正式通道：

- 工作流：`Promote Demucs Runtime Assets`
- 文件：`.github/workflows/promote-demucs-runtime-assets.yml`

输入建议：

- `app_version`: 例如 `1.2.3`
- `source_release_tag`: `demucs-runtime-assets-rc`
- `target_release_tag`: `demucs-runtime-assets`

这会：

- 下载 RC runtime release 当前 manifest 和资产
- 重写 manifest 中的 `releaseTag/archiveUrl/channel/appVersion/appBaseVersion`
- 把同一份资产上传到正式通道

这样正式版 runtime 与最后验过的 RC runtime 保持一致，避免“正式版再次重建出另一份内容”。

## 本地命令

只做本地构建时，可用这些脚本：

```bash
pnpm run demucs:runtime:ensure:win -- --ci --profiles "cpu,cuda,directml,xpu"
pnpm run demucs:runtime:package:win -- --profiles "cpu,cuda,directml,xpu" --release-tag "demucs-runtime-assets"
```

```bash
pnpm run demucs:runtime:ensure:mac-arm64 -- --ci --profiles "cpu,mps"
pnpm run demucs:runtime:package:mac-arm64 -- --profiles "cpu,mps" --release-tag "demucs-runtime-assets"
```

```bash
pnpm run demucs:runtime:ensure:mac-x64 -- --ci --profiles "cpu"
pnpm run demucs:runtime:package:mac-x64 -- --profiles "cpu" --release-tag "demucs-runtime-assets"
```

多平台产物合并：

```bash
pnpm run demucs:runtime:merge -- --input-roots "dist/demucs-runtime-assets-win32-x64,dist/demucs-runtime-assets-darwin-arm64,dist/demucs-runtime-assets-darwin-x64" --output-root "dist/demucs-runtime-assets" --release-tag "demucs-runtime-assets"
```

## 发布后检查

至少检查下面几件事：

1. `demucs-runtime-manifest.json` 中对应资产的 `contentHash` 已更新。
2. manifest 中的 `channel/appVersion/appBaseVersion` 与当前发布通道一致。
3. 新 runtime 解压后存在 `.frkb-runtime-meta.json`，且其中包含：
   - `beatThisInstalled`
   - `beatThisVersion`
   - `beatThisCheckpointRelativePath`
   - `beatThisCheckpointSha256`
4. runtime 目录下存在 `beat-this-checkpoints/final0.ckpt`。
5. Windows 新装或清空 `userData/demucs-runtimes` 后，首次分析会下载 GPU runtime，且 BPM 不再报 `Beat This! Python runtime not available`。
6. 已安装旧 runtime 的环境里，客户端会把旧资产判定为不可用并触发迁移重下。

## 风险说明

这次变更会让 GPU runtime 资产体积上涨，因为 `beat_this` 依赖和 `final0.ckpt` 被直接打进 GPU runtime。

这是当前阶段的有意取舍：

- 优点：用户只需下载一个目标 GPU runtime，体验简单。
- 代价：单个 GPU runtime 资产会比之前更大。

等后续用户规模上来，再评估是否拆成单独的 analysis support 资产。

## 发布成功后的保留与清理

构建发布和 RC 提升都通过 `scripts/publish-demucs-runtime-assets.mjs` 发布，
两个工作流使用同一个 `demucs-runtime-publication` job concurrency group，且不取消正在发布的任务。
正常应用版本发布（`release.yml`）不触发运行环境清理；运行环境和应用版本不是一一对应关系。

每个渠道独立保存 `demucs-runtime-retention.json`：

- `current`：当前完整清单；`previous`：上一次成功发布、资源集合不同的完整清单。
  只改应用版本说明、重试发布或重复提升同一套资源，不会挤掉回退版本。
- `pending`：切换清单前的发布记录。失败重试时，根据公开清单判断是否已经切换，
  保留对应的上一套资源。发布失败不会执行删除。
- `retired`：未被引用的资产 ID、文件名及首次观察到不再引用的时间。
  这不是包的上传时间，也不是文件名里的时间戳。

发布顺序为：校验本地产物 SHA256 → 上传缺少的不可变压缩包 → 校验远端大小、上传状态和 SHA256
→ 保存发布记录 → 上传并回读公开清单 → 确认 Release 发布成功且不是 Latest
→ 保存回退清单 → 再核对两条渠道的引用 → 清理。
同名不同内容的压缩包会拒绝发布，需要换新的 `asset_version`，禁止覆盖旧包。

JSON 元数据仍使用 `gh release upload --clobber` 替换；该操作会先删除同名旧资产，
不能把它当作原子切换。如果网络中断恰好造成公开清单缺失，流程会报错并停止清理，
需从已保存的 retention 发布记录恢复经核对的清单后再运行；压缩包及回退文件仍保留。
有完整公开清单时的中断重试才会自动判断发布记录的前后状态。

删除仅适用于这两个 Release 中符合既有命名规则的 Windows/macOS runtime zip 或分卷，
必须同时满足：

1. 两条渠道的当前清单和回退清单均不再引用该文件（按下载 URL 所属渠道判断）。
2. 本渠道已经有一套不同于当前资源的、完整且可验证的回退清单。
3. 从首次记录不再引用起已满 7 天；期间再次被引用会取消待删记录。
4. 当前所有清单、回退资源和 SHA256 均校验通过。读取失败、缺包、分卷不完整、
   清单被流程之外修改或不认识的下载来源，均停止处理。

7 天内可以暂时多于两套资源。宽限期过后，在下一次成功发布本渠道运行环境时删除，
不额外创建定时任务。模型 Release、应用 Release、tag、清单文件及未知类型资产均不删除。
局部平台更新保留完整合并清单，不按全局时间戳截取“最新两个版本”，以免删掉未重建的平台。

首次接入时没有历史完整回退清单，不能根据旧包文件名猜测一套“可用回退”。
重复发布现有资源只建立跟踪记录，不删除；第一次成功发布不同资源时，之前的当前清单
自然成为回退清单。之后再按宽限期清理积累的历史包。

## 兼容性调研记录（2026-10-28）

依据：本地 83 个应用 tag、运行环境下载模块的 Git 历史、两个线上 Release 的当前 manifest
及资产 API。正式渠道有 137 个上传文件，RC 有 17 个；两边当前均引用 `202604181347`
的 7 个平台/后端条目（CUDA 两卷，共 8 个资产），大小和 GitHub SHA256 均校验通过。
这些数字不含 GitHub 自动生成的源码压缩包。

| 使用场景 | 清理的影响 |
| --- | --- |
| 当前正式版 / RC 首次下载、重装运行环境 | 读取各自固定 URL 的当前清单，当前所有包及 CUDA 分卷都被保留 |
| `1.1.5`、`1.1.6`，以及采用旧下载实现的早期 RC | 读取正式渠道当前清单；并没有按应用版本固定到同名历史包，因此保护正式清单也覆盖这些默认下载路径 |
| `1.1.7` 起的历史正式版及分流后的 RC | 仍读所属渠道当前清单，而非与应用版本绑定的历史包 |
| 更早的 `1.0.0`–`1.1.4` tag | 未含该独立运行环境下载模块，不依赖这里的按需下载链路 |
| 已安装且可用的运行环境 | 删除 GitHub 历史资产不会删除用户电脑上的文件，也不修改客户端的可用性判断 |
| 发布时已经开始的下载、断点续传 | 上一套完整资源保留，更早的未引用包另有至少 7 天宽限；不能保证无限期挂起的下载，过期旧链接可能 404，重启后重新读取当前清单 |
| 自定义 `FRKB_DEMUCS_RUNTIME_MANIFEST_URL` 指向冻结历史清单，或用户手工保存的旧直链 | 不在两条受管理清单的可见引用内；若引用超过保留范围的文件，清理后会失效，需在清理启用前迁移到受管理渠道或另行永久托管 |

现行下载模块和上述已核对的正式版在请求完成后清除 `runtimeManifestPromise`，
它主要用于合并同时发起的请求；早期 Git 历史实现曾有较长期的进程缓存。
保留和宽限期旨在保护正在使用旧清单的任务，不宣称能覆盖无限期缓存或外部固定直链。

当前和旧应用是否兼容未来发布的新 Python/Torch/Beat This 组合，仍须在升级运行环境时验证。
这是原本“所有同渠道应用读取同一份当前清单”的兼容性约束；保留历史压缩包本身不会让旧应用
自动选回旧环境。本机制保存的 `previous` 是维护者可恢复的发布快照，不是客户端自动回退功能。

## 审计、测试与回退操作

只读线上审计，不上传或删除，也不开始宽限计时：

```bash
node scripts/publish-demucs-runtime-assets.mjs audit --repo coderDJing/Track-Studio
node --test scripts/publish-demucs-runtime-assets.spec.mjs
```

发布命令默认只校验并预览，传入 `--apply` 才发布及执行满足条件的清理。
工作流中已明确使用 `--apply`。正式/RC 的常规发布应通过工作流进行，以使用共享发布锁。

需要回退时，在没有运行环境发布任务运行的维护窗口，导出已保存的回退清单到新目录，
先预览校验，再执行同一发布流程（无需重新下载仍在 Release 上的压缩包）：

```bash
node scripts/publish-demucs-runtime-assets.mjs snapshot --repo coderDJing/Track-Studio --tag demucs-runtime-assets --previous --dir artifacts/runtime-rollback
node scripts/publish-demucs-runtime-assets.mjs publish --repo coderDJing/Track-Studio --tag demucs-runtime-assets --dir artifacts/runtime-rollback
node scripts/publish-demucs-runtime-assets.mjs publish --repo coderDJing/Track-Studio --tag demucs-runtime-assets --dir artifacts/runtime-rollback --apply
```

回退 RC 时将上述 tag 改为 `demucs-runtime-assets-rc`。没有可信回退快照时命令直接报错。
不要手工覆盖公开 manifest 或运行环境 zip，否则后续发布会因状态不匹配而停止，需要先人工核对。

GitHub 行为参考：[上传与覆盖资产](https://cli.github.com/manual/gh_release_upload)、
[资产分页、SHA256 和按 ID 删除 API](https://docs.github.com/en/rest/releases/assets)。
