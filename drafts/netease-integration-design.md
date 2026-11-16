# FRKB 网易云音乐库方案（草案）

维护状态：主体已实现（尚未提交），细节以代码为准；正文里仍有过时段落，以第 15 节与代码为准。

创建日期：2026-11-15

修订记录：

- 2026-11-15 初稿。按"搜索抽屉 + 下载进主库"模型撰写。
- 2026-11-15 重写。改为独立核心库模型（与筛选库/精选库平级），初稿方案作废。
- 2026-11-16 对照实现回填。同步失败不再整表写半份关系；试听缓存落盘时序、路径校验、CDN Referer、下载写标签、业务码处理已在代码落地。第 9.1 节后来在 15.11 落地。
- 2026-11-16 审查后修正（见 15.9）。账号隔离改成"只清当前账号的歌单行 + 曲目关系跨账号共用"；`.part`/试听缓存留在库内改为由监听器忽略点目录；「查看已下载」的传输动作一律降级为复制；i18n 命名空间收进 `netease.*`。

本文记录网易云库的目标形态、数据契约、与现有流水线的接点。实现细节以代码为准；未定项集中在第 12 节，讨论出结论后应回填到对应章节并更新本节的修订记录。

## 1. 一句话形态

在库树里新增一个**与筛选库、精选库平级的核心库**「网易云音乐」。它的**结构**镜像网易云账号（歌单、我喜欢的音乐、收藏的专辑），它的**音频**按需下载；没下载的歌也能点击试听，走流式，不落库。

不是"搜索一下下几首进主库"，也不是"自动把整个账号的歌全拉下来"。

## 2. 边界

要做：

- 独立核心库，物理目录在库根下，与其它核心库同级。
- 结构跟随账号：打开库时同步一次歌单清单（只拉元数据），歌单增删改名反映到树上。
- 音频按需：只有真正需要文件的操作（分析、导出、拖进 SET、手动下载）才落盘。
- 试听流式：点击即播，不产生库内文件。

不做：

- 不自动全量下载音频。
- 不做 VIP 绕过；无权益的曲目明确报错。
- 不解析 `.ncm`（该格式只属于官方客户端下载，我们的通道拿的是明文直链）。
- 不引入 Deemix / Deezer 通道。
- 不把这个库当普通库暴露给资源管理器（见 6.2）。

## 3. 参考实现（EngineX-OS 5.3.0.4）

只借它的前两步半，播放模型完全不同。

| 步骤 | 它的做法 | 我们是否采用 |
| --- | --- | --- |
| 登录 | 屏幕二维码 → 网易云 App 扫码 → 轮询拿 cookie | 采用 |
| 目录 | `user/playlist`、`album/sublist`、`dj/sublist`、`playlist/detail` + 批量 `song/detail`、`cloudsearch` | 采用（电台先不做） |
| 取音频 | `song/url/v1` 按 `lossless → exhigh → standard` 降级，拒绝 `freeTrialInfo` 试听片段 | 采用 |
| 播放 | 伪装 TIDAL API，本机 ServeFile 喂给碟机 | 不采用，我们有真实播放器与 `frkb-preview` 流协议 |

三个已核实结论：

1. **落地不是 ncm。** 它请求的是 `/song/enhance/player/url/v1`（`encodeType=flac`），返回 CDN 明文直链；网页播放器本身不具备 ncm 解密能力，走的是同一条通路。
2. **它的上限 CD 级是它自己的选择，不是网易云的上限。** 档位列表固定为 `lossless / exhigh / standard`，不请求 `hires` / `jymaster`。2026-11-15 实测：同一账号请求 `jymaster` 可取到 24bit/96kHz FLAC，说明这条线还能往上抬（见第 14 节）。
3. **不消耗下载额度。** 它取的是播放地址而非 `song/download/url`，其文档里"省每月下载额度"的说法与实现不符，我们不为此做任何设计。

## 4. 库的形态

### 4.1 核心库注册

`src/main/coreLibraries.ts` 的 `CoreLibraryName` 增加 `NeteaseLibrary`，中文名「网易云音乐」，物理目录 `<dbRoot>/library/NeteaseLibrary/`。与现有六个核心库同级，走同一套 `ensureEnglishCoreLibraries` 建目录逻辑。

### 4.2 树的分层

二级按类型分组，三级是具体歌单。「已下载」**不在树里**：

```text
网易云音乐
  我喜欢的音乐
  创建的歌单
    <歌单名>
  收藏的歌单
    <歌单名>
  收藏的专辑
    <专辑名>
```

### 4.2.1 「查看已下载」视图

入口是**库图标右键菜单 →「查看已下载」**，打开一个歌曲列表视图，形态与回收站一致：不进树、不占树的位置，是一个由数据表驱动的虚拟列表。

```text
查看已下载
  97 首 · 3.9GB                       ← 顶部合计，这就是"这套库占了多少盘"的入口
  ─────────────────────────────
  仍在歌单中   90 首 · 3.6GB
  ─────────────────────────────
  已不在歌单    7 首 · 280MB           ← 孤儿组，可全选删除
```

- **判定只有一条**：`.store/` 里存在该 `songId` 的文件。不区分是否已导入其它库——导入是复制语义，`.store/` 那份保留，所以导入过的歌也在这里出现。
- **孤儿组不自动删。** 一首歌从所有歌单里消失（被移出、下架、歌单被删），`.store/` 里那份就没有任何入口会用到它。它单独成组、可全选删除，但清理是用户的动作，不是同步的副作用。
- 这个分组不违反"不做派生标记"的原则：它只由"本次同步拿到的歌单"+"本地文件"两个当前事实算出，每次重算。跨库的"已在精选库"那种标记才需要实时校验、会变错，所以不做。
- 删除入口在这个视图里：右键「删除本地文件」，支持多选与全选孤儿组。删除后曲目回到未下载状态，文件走系统回收站（复用 `moveToRecycleBin`），已导入其它库的副本不受影响。
- **支持排序与搜索。** 数据全在本地，没有懒加载的范围问题，所以标题 / 艺人 / BPM / 时长 / 体积都能排，也支持关键字搜索。清孤儿时按体积倒序是最实用的一条。
- 右键菜单给全套：播放、导入到四个库（同 9.6 的四个入口）、导出、删除本地文件。既然在这里看到了这首已下载的歌，"送去精选库"就该就地能做，不必回歌单里找。
- 但传输动作**一律是复制**，没有「移动到筛选库/精选库」：这里的源是 `.store/` 里的下载缓存，移动等于把它从缓存目录搬走，「已下载」会立刻多一条指不到文件的幽灵行，也不符合 9.6「网易云来源只复制」的约定。菜单里 `library.moveTo*` 在构造时被改写成 `library.copyTo*`。

### 4.2.2 曲目行的「已下载」标记

歌单视图里，已下载的曲目行显示一个已下载角标。这一条与"不做跨库标记"不冲突：

| 标记 | 数据源 | 会不会变错 |
| --- | --- | --- |
| 已下载角标 | `netease_file` 是否存在该 `songId` | 不会。只由我们自己的下载动作写入 |
| 「已在精选库」 | 需要跨库实时比对 | 会。精选库删掉那首就成错数据 |

**数据源不是歌单树。** 「查看已下载」由本地 `netease_file` 驱动、`netease_track` 提供显示信息。同步只重写歌单与歌单-曲目关系，因此：

| 情况 | `netease_track` 行 | `.store/` 文件 |
| --- | --- | --- |
| 有本地文件 | 永久保留 | 保留 |
| 无文件、仍在某个歌单 | 保留 | — |
| 无文件、且不在任何歌单 | 可回收 | — |

电台（`dj`）本期不纳入；网易云的播客、云盘、MV、每日推荐均不纳入。

### 4.3 曲目存一份

**磁盘不按歌单建目录。** 所有音频平铺在 `.store/` 下，按 `songId` 命名：

```text
<dbRoot>/library/NeteaseLibrary/
  .store/
    1234567.flac
    2345678.flac
```

歌单与曲目的关系只存在于数据库。理由：一首歌可同时在多个歌单里，按歌单建目录会导致同一文件存多份、各自分析一遍、占用多倍空间与 Stems 缓存。树是虚拟视图，磁盘不必跟着复制。

这条只管**网易云库内部**：同一首歌出现在 5 个歌单里，仍只有一个文件。跨库不算——把曲目导入筛选库/精选库/SET库/自动混音库时是一份真实副本（见 9.6），副本与原文件此后互不联动。

代价：磁盘上看不到"歌单"这个结构，必须通过应用浏览（见 6.2）。

### 4.4 文件命名与标签

- 文件名：`.store/` 内为 `<songId>.flac`，不用标题命名，避免非法字符、重名、改名后引用断裂。
- 真实标题、艺人、专辑、封面写入文件标签，读取一律以标签/实测为准。
- **导入到其它库时重命名为 `艺人 - 标题.flac`**（见 9.6）。导入后它是目标库里的正式曲目，不该带着内部 id 当文件名。重名加序号 `艺人 - 标题 (2).flac`；顺序按目标目录扫描 + 数据库现存记录判定，不靠覆盖。
- 重命名前必须清洗 Windows 非法字符 `\ / : * ? " < > |` 与控制字符，并压缩连续空格；清洗后若为空则回退为 `<songId>`。全路径长度超过 240 字符时截断标题部分，保留扩展名。
- 导出时由导出流程再按同一口径命名；`.store/` 内的原始文件名始终不改。

### 4.5 同步策略

- **以网络结果为准，不做首屏缓存。** 打开库时先请求，拿到歌单清单再画树；不使用数据库里的旧结构参与渲染，避免"看到的和服务器不一致"。
- **同步失败就是打不开。** 断网、401、429、接口变更都显示"加载失败 + 重试"，不展示上次同步的结构。
- **但「查看已下载」始终可用。** 同步失败或未登录时，右键仍能打开已下载列表，曲目照常播放、分析、导出；否则演出场地网络差会让本地已有的歌一起不可用。
- **本地文件从不因歌单变化而回收。** 下载只由用户动作触发（拖进 SET、导出、发起分析、右键下载），因此已下载文件的所有者是用户而非歌单。曲目从歌单移除、平台下架、换账号登录都不删除本地文件，也不弹"是否清理"。
- 只在库节点内提供手动「立即同步」，不做定时后台轮询。
- 数据库中的歌单表只作为同步结果的落点与"是否已下载"的判定依据，不承担缓存职责。

## 5. 数据契约

### 5.1 表

```sql
CREATE TABLE IF NOT EXISTS netease_account (
  list_root        TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  nickname         TEXT NOT NULL DEFAULT '',
  avatar_url       TEXT NOT NULL DEFAULT '',
  vip_type         INTEGER NOT NULL DEFAULT 0,
  last_sync_at_ms  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (list_root, user_id)
);

CREATE TABLE IF NOT EXISTS netease_playlist (
  list_root    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  playlist_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- liked | created | subscribed | album
  title        TEXT NOT NULL,
  track_count  INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  cover_url    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (list_root, user_id, playlist_id)
);

CREATE TABLE IF NOT EXISTS netease_track (
  list_root     TEXT NOT NULL,
  song_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL DEFAULT '',
  album         TEXT NOT NULL DEFAULT '',
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  cover_url     TEXT NOT NULL DEFAULT '',
  has_lossless  INTEGER NOT NULL DEFAULT 0,   -- 目录层声明，不代表账号一定拿得到
  playable      INTEGER NOT NULL DEFAULT 1,   -- privilege.st < 0 时为 0
  PRIMARY KEY (list_root, song_id)
);

CREATE TABLE IF NOT EXISTS netease_playlist_item (
  list_root    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  playlist_id  TEXT NOT NULL,
  song_id      TEXT NOT NULL,
  position     INTEGER NOT NULL,
  PRIMARY KEY (list_root, user_id, playlist_id, song_id)
);

CREATE TABLE IF NOT EXISTS netease_file (
  list_root        TEXT NOT NULL,
  song_id          TEXT NOT NULL,
  rel_path         TEXT NOT NULL,
  requested_level  TEXT NOT NULL,  -- 请求档位
  bit_depth        INTEGER,        -- 实测
  sample_rate      INTEGER,        -- 实测
  bitrate          INTEGER,        -- 实测
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  fetched_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (list_root, song_id)
);

CREATE INDEX IF NOT EXISTS idx_netease_item_playlist
  ON netease_playlist_item(list_root, user_id, playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_netease_file_fetched
  ON netease_file(list_root, fetched_at_ms);
```

要点：

- **目录真相与文件真相分离**：`netease_track` 有行但 `netease_file` 没行 = 未下载，这是"按需"的唯一判据。
- `requested_level` 与 `bit_depth/sample_rate/bitrate` 都存：前者是"我们要了什么"，后者是"实际拿到什么"，只留一个就无法核对降级。
- 文件按 `song_id` 唯一，跨账号共用；歌单与账号结构按 `user_id` 隔离，换账号不会串。

### 5.2 不升 `user_version`

`libraryDb.ts` 中 `MAX_SUPPORTED_DATABASE_SCHEMA_VERSION = 41`，且 `user_version` 超过该值直接抛 `DatabaseSchemaVersionError`。若升到 42，**任何旧版 FRKB 打开该库都会失败**，用户无法回退版本。

`applyLibraryDbSchema` 尾部已有先例（`waveform_surface_cache`、`playlist_view_snapshot`）：无版本条件、纯幂等的 `CREATE TABLE IF NOT EXISTS`，追加即生效。本方案同样**只追加幂等 DDL，不动 `user_version`**。旧版本正常放行，只是不认识这些表，降级安全。

代价：schema 版本号不再反映全部结构变化。后续对本组表的列变更必须用列存在性判断（沿用 `listTableColumns` 模式），不能依赖版本号分支。

### 5.3 真值边界

- 文件是唯一音频真值：音质、时长、标签一律从磁盘读（`music-metadata`），不信任 API 声明与扩展名。
- 数据库只是目录索引；索引缺失时功能降级（无法按歌单浏览），不得影响已下载曲目的读取、分析、导出。
- 视图快照（`playlist_view_snapshot`）仍只服务读；任何写操作必须先精确核对磁盘。

## 6. 访问与安全边界

### 6.1 路径

`<dbRoot>/library/NeteaseLibrary/.store/`，点开头隐藏目录。

### 6.2 不提供资源管理器入口

`mainWindowFilesystemHandlers.ts` 里现有的"打开库根目录"能力对本库不生效（菜单项隐藏，或点击时提示"该库只能在应用内浏览"）。这个库的文件名是 id，人工整理会破坏引用。

### 6.3 手动改动文件

用户在外部删除 `.store` 里的文件，视为"退回未下载"：下次对账时删除对应 `netease_file` 行，曲目仍在 `netease_track` 里，歌单结构不变，可重新下载。不报错、不丢歌单。

## 7. 登录态与账号切换

- 登录入口：**只有树内一处**。点「网易云音乐」节点，未登录时主窗口弹二维码（复用 `--z-dialog` 弹窗体系），扫完直接进库。不做设置页账号卡，不做独立登录窗口。
- 未登录时该节点照常显示在树里，点进去是一行「点击登录网易云音乐」提示，不隐藏整个库——否则用户不知道存在这个功能。
- 退出登录、换账号走库节点右键菜单（「重新扫码登录」/「退出登录」）。
- 登录：屏幕二维码 → 网易云 App「扫一扫」→ 轮询拿 cookie，存 `safeStorage` 加密后落盘。
- 失效：任意请求返回 401 或 code 301/302 判定失效，提示重新扫码；**不自动删除旧 cookie**，避免误判导致登录丢失。
- **登出保留数据**：登出后歌单结构消失，但 `netease_file` 与磁盘文件全部保留，可通过「查看已下载」照常播放、分析、导出、拖进 SET。
- 换账号：`netease_playlist` / `netease_account` 按 `user_id` 隔离，同步只清**当前账号**的歌单行；`netease_playlist_item` 不带 `user_id`——歌单 id 全局唯一，"这首歌是否还在某个歌单里"是跨账号的事实，带上 `user_id` 会让另一个账号的歌单把它判成孤儿。`netease_track` 与 `netease_file` 按 `song_id` 共用，同一首歌两个账号下过只占一份。
- 已登录只显示当前 session 的 `user_id`，未登录不注入子树。
- 两个账号收藏同一张歌单时，一个账号取消收藏**不能**清掉曲目关系（另一个账号还在用）：回收条件额外要求"没有任何其它账号的歌单行引用它"。

## 8. 试听（流式）

### 8.1 通路

复用现有流协议，新增一个分支：

```text
frkb-preview://?netease=<songId>
→ 主进程取 CDN 直链（带 Referer/UA，经 fetchWithSystemProxy 体系）
→ 边拉边 pipe 给播放器，透传 Range 支持拖动
```

播放器不需要改动：它本来就消费 `frkb-preview://`，对渲染层而言这就是一个音频源。

### 8.2 临时缓存

试听落一个 LRU 临时缓存（默认 10GB，userData 下），用于拖动与重播，不进入库内、不写 `netease_file`、不出现在树上。

按实测体积，10GB 大约相当于：`lossless` 250 首 / `jymaster` 130 首 / `exhigh` 900 首。取这个默认值的理由是：`lossless` 均值 40MB，2GB 只够 50 首，一张 97 首的歌单听到一半就开始反复淘汰，"回头再听又要重拉"的体感很明显；10GB 基本不淘汰。缓存按"整首"为单位淘汰，不做分段裁剪——半首歌的缓存对拖动没有价值。

**上限可在设置里手动调整**：设置 → 存储（或流媒体分区）提供「试听缓存上限」（2GB / 5GB / 10GB / 20GB / 自定义），旁边配「清空试听缓存」。账号相关的操作仍只在树内，设置里不放账号卡。

调整上限后按 LRU 立即淘汰到新上限，不等待下次重启。

若用户随后决定下载，已拉取的字节优先复用，避免同一首歌下两遍。

### 8.3 试听的边界

试听只能听，不能分析：没有波形、没有 BPM、没有调性。播放器与列表按"尚未分析"的既有表现处理，不伪造数据。

## 9. 下载

### 9.1 触发

| 动作 | 行为 |
| --- | --- |
| 点击曲目 | 播放（已下载播本地文件，未下载走流式） |
| 拖进 SET | 立即加入 SET 并标记"待下载"，后台下载，完成后自动就绪 |
| 歌单右键「导入到…」 | 整张歌单导入所选目标库的具体歌单（见 9.6） |
| 导出 / 触发分析 | 没有文件时先下载，完成后再继续原操作 |
| 右键「下载到本地」 | 显式下载，不依赖其它动作 |

> 现行实现（2026-11-16，见 15.11）：拖进 SET 会立即入单并后台下载；导出 / 触发分析会先下载到 `.store/` 再继续。从歌单视图拖到筛选库 / 精选库 / 混音库仍先提示再下载，不会自动导入。

落盘有两条独立通路，互不替代：

1. **导入**（拖进 SET、歌单右键导入）→ 下载到 `.store/` 再复制进目标库，一次动作同时完成"有文件"和"进库"。
2. **对未导入的曲目直接动作**（下载 / 分析 / 导出）→ 只下载到 `.store/`，曲目留在网易云库里，可在「查看已下载」里找到。

第 2 条是有意保留的：让用户不必先决定"这首放哪个库"就能本地可用、能看 BPM、能导出。分析只对未导入曲目开放，是因为它需要真实文件，而 `.store/` 里的文件与导入后的副本内容一致。

注意副作用：分析结果记在网易云库的曲目上；导入后的副本是目标库里的另一条曲目，是否需要重新分析由目标库自身的分析状态决定，不从网易云库继承。批量导入 97 首会带来一次 97 首的分析开销，这是复制语义的必然代价。

拖进 SET 不弹确认框、不阻塞：SET 表达的是"我要放这些歌"的意图，不该被下载这个技术细节卡住。SET 顶部显示"N 首待下载"，条目带待下载状态，下载完成后自动转为正常条目。点待下载的条目会触发下载并等待。

### 9.2 落盘顺序（不可调整）

```text
下载到 .store/<songId>.<level>.part（临时文件，半成品）
→ 容器头/帧校验，确认真完整
→ 写标签与内嵌封面（同目录 .<uuid>.<ext> 过渡）
→ fs.rename 成 .store/<songId>.<ext>
→ 写 netease_file 行
```

**半截文件绝不能进库树的视野**：`libraryTreeWatcher` 是 `fs.watch(recursive)`，进入库目录的文件都会触发 reconcile，半截文件会被当成曲目入库，产生无法自动修复的脏数据。

现行做法是 `.store/` 与 `.preview-cache/` 都放在库根下（缓存跟着库走，用户搬库不用重下），靠两条约定隔离：扫描器（`libraryTreeDb`）跳过点开头的目录；监听器（`libraryTreeWatcher.isIgnoredWatchPath`）对任何一段以 `.` 开头的路径直接返回，既不推进对账也不记内容变更。**新增任何写库目录的临时文件，必须落在点目录里**，否则一次 40MB 下载就该变成几百次全库核对。

### 9.3 批量

批量下载必须包在 `beginLibraryTreeWatcherBulkOperation()` 的 release 区间内，结束时统一对账一次。`reconcileLibraryTree(fromBulk = true)` 不调用 `mutationListener`，因此不会逐首触发云同步调度。

反面做法：每下一首调用 `notifyLibraryFsChanged()`，它内部会调 `mutationListener?.()`，导致每首都排一次精选库同步 tick 并各自触发全量 diff。

### 9.4 分析与并发

- **不新增任何分析触发。** 导入/下载落盘后曲目就在库里，现有闲时分析（`src/main/services/keyAnalysis/background.ts`）会扫到缺调性 / beatgrid / 能量 / 结构的曲目并按批次补齐，节奏由后台调度器统一决定。
- 该调度器已通过 `registerBackgroundForegroundBusyProvider` 把 `import-songs`、`playback-active`、混音 Stem/波形预热注册为前台忙条件，导入期间不会与导入抢资源，不需要我们额外加互斥。
- 批量导入 97 首不会立刻触发 97 首分析；它们进库后由闲时分析慢慢吃掉。用户想立刻要结果就显式发起分析，走手动队列。
- 已下载但未导入的曲目（`.store/` 里的文件）同样会被闲时分析扫到，分析结果记在网易云库的曲目上。
- Stems 不自动触发，只允许用户显式发起。
- 下载并发固定 1，遇到 429 指数退避。

### 9.5 音质档位

实测（2026-11-15，会员账号，见第 14 节）四档都可用，且体积差距极大：

| 档位 | 实测规格 | 单曲均值 |
| --- | --- | --- |
| `jymaster` | 24bit/96kHz、24bit/44.1kHz、16bit/44.1kHz（按曲目母带而异） | ~77MB |
| `lossless` | 16bit/44.1kHz（少数 24bit/44.1kHz） | ~40MB |
| `exhigh` | MP3 320kbps | ~11MB |
| `standard` | MP3 128kbps | ~4.4MB |

两条来自实测的行为，决定了实现方式：

1. **`jymaster` 会自己降级，不报错。** 没有 Hi-Res 母带的曲目，`jymaster` 返回的就是该曲最高可用文件（体积与 `lossless` 完全相同）。因此**不需要逐档降级重试**：请求一次最高档，解析返回文件的容器头得到真实位深/采样率，即可判定这一首拿到了什么。
2. **规格只能靠文件头判断，不能靠档位名。** 同档位不同曲目会给出不同位深与采样率，UI 上要显示"这首实际是什么"，而不是"我们请求了什么"。

档位是全局设置（设置 → 流媒体），默认 `lossless`。原因：`jymaster` 均值 77MB，同样 10GB 缓存可装 130 首，而 `lossless` 40MB 能装 250 首且覆盖绝大多数曲目的最高可用音质。DJ 场景下"能装多少首"直接影响拖动与回头重听的体验，所以默认取覆盖面更广的那一档，`jymaster` 留给确实要那几首 24/96 母带的时候。

试听与下载共用同一个档位设置——不做"试听用低档、下载用高档"，否则同一首歌会缓存两份不同码率的字节。

### 9.6 整张歌单导入

网易云歌单、我喜欢的音乐、收藏的专辑，右键菜单按目标库分四项，沿用现有文案口径：**导入到筛选库… / 导入到精选库… / 导入到 SET 歌单… / 导入到 Mixtape…**。目标库由点哪一项决定，点了之后复用现有 `selectSongListDialog` 选具体歌单，再由 `ImportTracksDialogBase` 承载选项与执行。

**只有复制，没有移动。** 网易云库是来源，`.store/` 里那份是我们自己下的副本；把它移走等于让曲目回到未下载，没有意义。因此现有菜单里的「移动到筛选库 / 移动到精选库」这一对在这里不出现，导入对话框里的「删除导入后原文件」勾选项对网易云源也不显示，固定按复制执行。

这不是"批量下载到本地"：**没有"本地"这个中间态。** 导入完成即成为目标库里的正式曲目——有真实文件路径、能被分析、能导出、能进 SET，与本来就是目标库的歌没有区别。

- 确认前给出体积与数量（如「97 首 · 约 3.9GB（lossless）」），档位跟随全局设置。已在导入对话框落地，见 15.11。
- 固定为复制**并重命名**：文件以 `艺人 - 标题.flac` 写进目标库目录（重名加序号，规则见 4.4），网易云库 `.store/` 里那份保留原名 `<songId>.flac`，该曲在网易云库里继续显示为已下载、仍可直接播放本地文件。两份此后互不联动——在目标库里改标签、做分析、改名、删条目，都不影响网易云库那份。
- 因此一次导入的实际占用是目标库的体积；确认框要按"97 首 · 约 3.9GB"给出目标库增量，并说明网易云库里另有一份副本。
- **对话框沿用现有，只去掉一项。** `ImportTracksDialogBase` 的 `addToFingerprintLibrary`、`deduplicateMode` 照旧对用户开放（默认沿用现有：去重 `library`、加入指纹库）；`deleteAfterImport` 对网易云源不显示，固定复制。
- **顺序按网易云歌单原始顺序**（`trackIds` 顺序），追加在目标歌单已有曲目之后。现有导入本身不控顺序（落盘后由扫盘决定），所以导入成功后要在同一个 bulk 区间内调一次 `updateLibraryNodeOrder` 显式重排。
- 批量落盘包在 `beginLibraryTreeWatcherBulkOperation()` 内（见 9.3）。
- 把整个歌单节点拖进 SET 不触发批量导入：SET 是演出曲目列表，不该被 97 行塞满；"囤下来慢慢挑"用右键菜单表达。


## 10. 交互

- **不加"未下载"文案。** 未下载的曲目与已下载的在列表里表现一致：点击即播（流式），播放器区域正常显示。是否已下载不构成视觉差异。
- 波形格子在音频未就绪时沿用既有占位机制（`useWaveformPreview` 的 `loading` / `unavailable` 状态），不新增文案与样式。
- **歌单视图不支持列排序、不支持筛选/搜索。** 只按歌单原始顺序显示（`trackIds` 顺序，与网易云网页端一致）。理由：这些操作都受"已加载范围"限制，半真半假的结果比没有更糟。「查看已下载」视图不受此限，见 4.2.1。
- **字段分两类处理。** 永远拿不到的字段（评级、文件路径、文件大小、码率、加入日期）整列隐藏；下载并分析后才有的字段（波形、BPM、调性）保留列，未下载时为空，分析完成后正常显示。
- **大歌单懒加载。** 总数与顺序来自 `trackIds`，滚动到接近底部时再拉下一批详情；首屏只显示已加载部分，总数始终准确。
- 下载过程只在真正进行时给出反馈（行内进度或播放器状态），失败按原因分三类文案：网络失败（可重试）、需要会员（不可重试）、协议失效（升级版本）。
- 下载完成后不抢焦点、不自动滚动、不切换歌单。

## 11. 与现有流水线的接点

| 现有机制 | 位置 | 用途 |
| --- | --- | --- |
| 核心库注册 | `src/main/coreLibraries.ts` | 新增 `NeteaseLibrary` |
| 流协议 | `src/main/index.ts` 的 `frkb-preview` | 试听与本地播放共用 |
| 系统代理 | `src/main/fetchWithSystemProxy.ts` | 所有对外请求，禁止裸 fetch |
| 库树对账 | `src/main/libraryTreeWatcher.ts` | 文件落盘后统一对账；批量用 bulk 包裹 |
| 波形占位 | `useWaveformPreview.ts` | 未就绪状态的既有表现 |
| preload 白名单 | `src/preload/index.ts` | 新增 IPC 必须同步登记，否则表现为"点击无反应" |
| 导出 | 现有导出流程 | 导出时重命名为 `艺人 - 标题` |

## 12. 待定

本轮讨论已把交互与数据层面的决策清空。剩下三条都需要实测或实现阶段才能回答，不阻塞开工：

- **音频直链 TTL。** 未测网易云下发的直链有效期（通常几十分钟）。当前设计缓存字节而非 URL，因此不受影响；将来若做预取需要再验证。
- **免费账号的行为。** 本轮只测了会员账号（vipType=110），免费账号各档位是否给 30 秒试听片段未验证。实现上按"出现 `freeTrialInfo` 即视为不可用"处理，不依赖这一结论。
- **`.store/` 的体积与「查看已下载」的统计口径。** 目前按文件实际大小统计；如果将来支持多档位并存（同一 `songId` 存 flac + mp3），需要重新定义合计。

以下问题留待实现阶段决定：

- 电台（`dj`）、播客、云盘是否纳入：本期不做，后续再议。

## 13. 决策记录

| 日期 | 决策 |
| --- | --- |
| 2026-11-15 | 形态是独立核心库，不是搜索抽屉、不是下载进主库 |
| 2026-11-15 | 结构镜像账号，音频不自动全量下载 |
| 2026-11-15 | 接受"部分曲目本地尚无文件、不能立即分析/导出" |
| 2026-11-15 | 试听走流式，不落库；临时 LRU 缓存，下载可复用已拉取的字节 |
| 2026-11-15 | 树按类型分组（我喜欢的音乐 / 创建的歌单 / 收藏的歌单 / 收藏的专辑） |
| 2026-11-15 | 曲目磁盘只存一份，歌单关系只在数据库，磁盘不按歌单建目录 |
| 2026-11-15 | 库不提供资源管理器入口；手动删文件视为退回未下载 |
| 2026-11-15 | 登出保留已下载文件；「查看已下载」视图始终可用（同步失败时是唯一入口） |
| 2026-11-15 | 点击即播（未下载走流），不加"未下载"文案与视觉标记 |
| 2026-11-15 | 不解析 ncm、不做 VIP 绕过、不引入 Deemix 通道 |
| 2026-11-15 | 登录入口只有树内一处（点库弹二维码），不做设置页账号卡与独立登录窗口；未登录时节点照常显示 |
| 2026-11-15 | 结构以网络结果为准，不做首屏缓存；同步失败显示"加载失败 + 重试" |
| 2026-11-15 | 同步失败或未登录时「查看已下载」仍可用，本地已有曲目照常可用 |
| 2026-11-15 | 拖进 SET 不弹确认框：立即入 SET 并标记待下载，后台下载完成后自动就绪 |
| 2026-11-15 | 不支持列排序，只按歌单原始顺序；大歌单滚动懒加载；搜索前先补全剩余曲目 |
| 2026-11-15 | 搜索/筛选不做；永久缺失的字段整列隐藏，下载并分析后才有的字段（波形/BPM/调性）保留列 |
| 2026-11-15 | 不新增分析触发：导入/下载落盘后交给现有闲时分析（`keyAnalysis/background.ts`）自动补齐；Stems 不自动触发 |
| 2026-11-15 | 试听缓存默认上限由 2GB 上调至 10GB（实测 lossless 均值 40MB，2GB 仅约 50 首，淘汰过频）；设置里可选 2/5/10/20GB 或自定义 |
| 2026-11-15 | 音质默认 `lossless`（16/44.1k，均值 40MB），`jymaster`（24bit/96k，均值 77MB）作为设置里的可选高档 |
| 2026-11-15 | 取音频不逐档降级：请求一次目标档位 + 解析文件头判定实际规格；`hires` 不单独暴露（与 `lossless` 实测同档） |
| 2026-11-15 | 歌单只是来源目录，不是本地文件的管理者：曲目移出歌单/下架/换账号都不回收已下载文件，也不弹清理确认 |
| 2026-11-15 | 整张歌单导入复用现有 `selectSongListDialog`，目标是四个核心库之一，不是"下载到本地" |
| 2026-11-15 | 导入采用复制语义：目标库一份、网易云库 `.store/` 保留一份，两份互不联动 |
| 2026-11-15 | 保留"对未导入曲目直接下载/分析/导出"三个入口 |
| 2026-11-15 | 已下载不是树节点：库图标右键「查看已下载」进虚拟列表（仿回收站），顶部显示曲目数与体积合计；孤儿组单独成段可全选删，不自动清理 |
| 2026-11-15 | 歌单视图里已下载曲目带角标（数据源 `netease_file`，不会变错）；跨库"已在精选库"标记不做 |
| 2026-11-15 | 「查看已下载」右键给全套：播放 / 导入到四个库 / 导出 / 删除本地文件 |
| 2026-11-15 | 歌单视图不做排序/搜索（受懒加载范围限制）；「查看已下载」视图全本地，支持排序与搜索 |
| 2026-11-15 | 导入到其它库时把 `<songId>.flac` 重命名为 `艺人 - 标题.flac`（重名加序号），`.store/` 内原名不改 |
| 2026-11-15 | 右键菜单按目标库分四项（筛选库/精选库/SET歌单/Mixtape），库由菜单项决定，不再单独弹选库 |
| 2026-11-15 | 网易云导入只有复制，没有移动：不出现「移动到…」，对话框里「删除导入后原文件」对网易云源不显示 |
| 2026-11-15 | 导入后按网易云歌单原始顺序追加在已有曲目之后：用 `appendSongListTrackNumbers`（歌单内的曲目顺序就存在这里），而不是 `updateLibraryNodeOrder`（那管的是树里歌单之间的顺序） |
| 2026-11-15 | 去重沿用现有默认 `library` 级指纹比对，选项照旧对用户开放 |
| 2026-11-15 | SET 库与混音库的导入不做第三套搬运：只下载，然后交给它们各自的保管接口（`setList:append-custody-items` / `mixtape:copy-files-to-vault` + `mixtape:append`） |
| 2026-11-15 | 清缓存前先做 SET 引用保护：被 SET 引用的文件先进 SET 托管再删，避免「清一下缓存 SET 里就红线」 |
| 2026-11-15 | 「查看已下载」的行用真实路径（不是 `frkb-preview` 地址），导出/复制/资源管理器因此不需要特判 |
| 2026-11-15 | 孤儿段只在列表末尾成段展示 + 面板头给「清理」按钮，永不自动删 |
| 2026-11-15 | 试听缓存单独放 `.preview-cache/`，与 `.store/` 分开：前者可随时清，后者是用户资产 |
| 2026-11-15 | 缓存只在「从第 0 字节开始的整段请求」上落盘，seek 的局部请求直接透传；字节数与 `content-length` 不符就丢弃，不留半截文件 |
| 2026-11-15 | 网易云 5 张表在库合并里是 `discardable`，并由 `reconcileStoreFromDisk()` 从 `.store` 重建索引 |


## 14. P0 探针

脚本：`scripts/netease-probe.ts`（一次性验证工具，不属于生产代码）+ `scripts/netease-qr.ts`（自实现的极简二维码生成器，byte 模式 / 纠错 L / 版本 4-5，登录弹窗也要用）。

### 14.1 登录必须拆成两段

```sh
npx tsx scripts/netease-probe.ts --qr      # 出码：写 PNG + 存 unikey，退出
npx tsx scripts/netease-probe.ts --login   # 扫完续接：等 803 → 登录 → 跑完整探测
```

原因是 unikey **一码一 key、几分钟过期**。早期版本把"申请 key"和"轮询等扫码"放在同一个进程里，期间任何一次重跑都会换掉 key，导致屏幕上那个码立即作废——这是两次卡在 801 的真正原因。拆开后，扫码期间没有任何进程触碰这个 key。

`--qr` 把二维码写成 PNG 落盘（`.workbuddy/tmp/netease-login-qr.png`，灰度、8px/模块、4 模块静默区），不再依赖终端字符画，也不依赖浏览器页面。浏览器打开的 `login?codekey=` 页面会由它自己的脚本拉一份新码，扫到的未必是本次 key。

**二维码必须验解码，不能只看"像不像"。** 本轮就踩了：初版编码器把 15 位格式信息的横竖两臂位序写反了，格子集合完全正确、肉眼看上去完全正常，但解码器读出的格式串是乱的，整码作废。最终用 jsQR 独立解码验证通过（v4/v5 两条分支都验），PNG 解出的 payload 与 `codekey` 一致。

其他可用参数：`--samples <n>`、`--proxy <url>`、`--cookie "<MUSIC_U=...; __csrf=...>"`、`--relogin`、`--smoke`。

### 14.2 实测结果（2026-11-15）

账号 `CoderOffical`，`userId=1483428190`，`vipType=110`（会员），13 个歌单，首个歌单 97 首，抽样 6 首 × 5 档。

| 档位 | 命中 | 实测规格 | 单曲体积 |
| --- | --- | --- | --- |
| `jymaster` | 5 ok / 1 网络失败 | 24bit/96kHz、24bit/44.1kHz、16bit/44.1kHz | 21–136MB |
| `hires` | 6 ok | 16bit/44.1kHz（1 首 24bit/44.1kHz） | 20.9–72.8MB |
| `lossless` | 6 ok | 16bit/44.1kHz（1 首 24bit/44.1kHz） | 20.9–72.8MB |
| `exhigh` | 6 ok | MP3 320kbps | 2.6–13.9MB |
| `standard` | 6 ok | MP3 128kbps | 2.6–5.6MB |

**试听片段 0 例**：6 首 × 5 档共 30 次请求，全部返回完整曲目，没有出现 `freeTrialInfo`。

三条结论：

1. **Hi-Res 可用。** `jymaster` 拿到 24bit/96kHz（`Cryo` 117.7MB、`Bipolar Mood` 136MB），比 EngineX 的 CD 级封顶高一档。第 2 节对 EngineX 的"CD 级"判断是它的实现选择，不是网易云的能力上限。
2. **`jymaster` 自带降级。** `Life Energy` / `Anxiety` 两首的 `jymaster` 体积与 `lossless` 完全相同（46.4MB / 21.0MB），说明无 Hi-Res 母带时它直接返回最高可用文件，不报错。因此实现上**请求一次最高档 + 解析文件头**即可，不必逐档重试。
3. **`hires` 与 `lossless` 实质同档。** 6 首里 5 首完全一致，1 首（`Bipolar Mood`）`hires` 给 24bit/44.1kHz 而 `lossless` 给同体积文件。既然 `jymaster` 已覆盖更高，`hires` 不必作为独立档位暴露。

唯一一次失败（`6 Pack` 的 `jymaster` 报 `fetch failed`）是取字节时的连接抖动，与权限无关；同期 `lossless` 正常。

`/w/nuser/account/get` 的 `profile` 在**顶层**而非 `data` 里，按 `data.profile` 取会得到"登录成功但拿不到账号信息"。探针已兼容两种形态。

探针只验证目录与音质，不验证搜索——本方案不做搜索功能，见第 10 节。

## 15. 实施进度

### 15.1 已完成

**主进程**（`src/main/netease/`）

| 文件 | 职责 |
| --- | --- |
| `client.ts` | weapi 加密、二维码登录、账号、歌单/专辑目录、曲目详情、取音频地址；全部走 `fetchWithSystemProxy` |
| `session.ts` | 登录态落 `safeStorage` 加密文件；不可用时不落盘（只留内存），绝不写明文 cookie |
| `paths.ts` | 库根 / `.store/` / session 文件路径；`file_path` 存相对路径，便于整库搬迁 |
| `schema.ts` | 5 张表，幂等 DDL，挂在 `applyLibraryDbSchema` 无条件下沉段，**不升 `user_version`** |
| `library.ts` | 目录同步落库、歌单曲目查询、已下载列表、下载（`.part` → 头校验 → rename → 写库）、删除本地文件 |
| `tree.ts` | 把虚拟子树**注入** `getLibrary()` 返回值，不写 `library_nodes`（否则被后台对账清掉） |
| `stream.ts` | `frkb-preview://?netease=<songId>`：已下载读本地 + Range，未下载透传上游 + Range 透传，直链 5 分钟缓存 |
| `ipc.ts` | `netease:*` 通道；批量下载串行执行并推送逐条进度 |
| `qr.ts` | 二维码编码器（byte 模式 / 纠错 L / 版本 4-5），输出 PNG data URL |

其他接线：`coreLibraries.ts` 增加 `NeteaseLibrary`（中文名「网易云音乐」）；`utils.ts` 的 `getLibrary` 在返回前注入子树并把该库加进三处 coreDirNames / fsToRenderer 映射；`index.ts` 注册 IPC 与预览分支；`preload/index.ts` 增加 `netease:` 前缀（invoke 与 listen 两侧）。

**渲染层**

- `librarySelectArea.vue`：新增库图标（`assets/netease.svg`），点击即登录入口
- `neteaseLoginDialog.vue/.ts`：显示主进程给的二维码，2 秒轮询；过期只提示不自动刷新（自动刷新会让正在扫的码失效）
- `neteaseSongs.ts`：uuid 约定、`frkb-preview` 地址生成、`ISongInfo` 映射、登录后把分组结构贴回树
- `useSongsLoader.ts`：新增网易云歌单分支，与回收站/录音库/混音库同级的 dispatch

### 15.2 已完成（第二轮：导入 / 已下载 / 设置 / 缓存）

| 能力 | 落点 |
| --- | --- |
| 整张歌单导入 | `netease/import.ts` + `netease:import-playlist`。顺序固定：下载缺失 → 指纹去重 → 复制并改名「艺人 - 标题」→ `appendSongListTrackNumbers` 保序 → `stampPlaylistSongsAddedAt`；整批包在 `beginLibraryTreeWatcherBulkOperation()` 里 |
| 只复制、从不移动 | 源是 `.store` 缓存；命中去重时**不删源文件**，这与普通导入的 `deleteAfterImport` 语义刻意不同 |
| 四项右键导入 | `neteaseActions.ts` 的四项菜单 → `ImportTracksDialogBase` 的 `netease` 模式（隐藏选文件与「删除导入后原文件」）→ 筛选库/精选库走上面那条链路；SET 走 `setList:append-custody-items`，混音走 `mixtape:copy-files-to-vault` + `mixtape:append` |
| 「查看已下载」 | 虚拟 uuid `__netease_downloaded__`，`useSongsLoader` 与回收站同级分支；行用**真实路径**，所以导出/复制/资源管理器全按普通本地文件走；`neteaseDownloaded` 标记在歌单视图里显示「已下载」小徽标 |
| 孤儿处理 | SQL 里算 `in_playlist`；孤儿行稳定排到列表末尾形成连续区；面板头显示「共 N 首 · 12.3GB」与「已不在歌单 (M)」一键清理按钮。**永不自动删** |
| 删除本地文件 | `netease:delete-local`：删前先走 `protectSetReferencedFilesForDeletion`，被 SET 引用的文件先进 SET 托管，避免清缓存把 SET 打成红线 |
| 试听磁盘 LRU | `netease/cache.ts`：`.preview-cache/`，只对「从 0 开始的整段请求」tee 落盘，字节数与 content-length 对不上就丢弃 `.part`；上限默认 10GB（2/5/10/20 可选），超限按 mtime 删到 90% |
| 设置页 | 新增「网易云音乐」一栏：音质档位 + 试听缓存上限 + 当前占用 + 清空缓存 |
| `.store` 索引自愈 | `reconcileStoreFromDisk()`：打开「已下载」前顺一次盘，双向对齐——补回缺失的 `netease_file` 行（库合并后必然出现），同时清掉文件已经不在的幽灵行（见 15.5） |
| 树上的曲目数 | 虚拟节点带 `trackCount`（来自 `netease_playlist.track_count`）。`libraryTreeSort` 见到这个字段就直接落库、**不**送 `playlist:batchTrackCount`：它的 `dirName` 只是显示名，盘上没有对应目录，送去扫只会得到 0 并白跑一次 IPC |
| 库合并兼容 | 5 张网易云表在 `LIBRARY_MERGE_TABLE_PARTICIPANTS` 里注册为 `discardable`——它们是本机缓存，`list_root` 指向源库绝对路径，合并后由同步与顺盘重建 |

### 15.3 仍然没做

- 歌单视图**不支持搜索/排序**（接口不支持服务端排序，本地排序会与"只按原始顺序"冲突）——按既定决策不做
- 试听缓存不参与「导出」「库合并」；它只是缓冲，清了不影响任何可见状态

### 15.4 已知风险

- 曲目的 `filePath` 是 `frkb-preview://?netease=...` 而不是磁盘路径。播放器已经对 `frkb-preview://` 前缀直接放行（`webAudioPlayer.shared.ts:170`），但任何按扩展名/路径做判断的地方（波形、缓存键、文件校验）都会拿不到结果，表现为"没有波形/没有分析"——这与设计里"未下载曲目没有波形"一致，不算故障。
- 网易云歌单节点是虚拟 uuid（`netease:pl:` 前缀）。凡是"按 uuid 查库"的代码（如 `buildDisplayPathByUuid`）对它返回空，涉及展示路径的地方会显示为空，需要后续按前缀补分支。

### 15.5 第二轮自检（2026-11-15）

做完之后按"逐条回查"过了一遍实现，发现并修掉的问题：

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| 树上的曲目数全是 0 | 虚拟节点有 `dirName`（歌单标题），`findDirPathByUuid` 会拼出 `library/NeteaseLibrary/我喜欢的音乐` 这种不存在的路径。`prefetchLibraryTreeTrackCounts` 把它当真实歌单送进 `playlist:batchTrackCount`，扫不到目录 → 0；歌单多了还会白跑几十上百次 IPC | `IDir.trackCount` + 三处认它：`prefetch`（直接落数量、不进批量扫描）、`getLibraryTreeNodeTrackCount`（优先于缓存）、`useLibraryTrackCount`（徽标读节点值，不发 IPC）。补了一条回归用例 |
| 「删除以上」走错通路 | 播放器的 `delAllAbove` 只认 Rekordbox 外来源为只读；在网易云视图里它会带着不存在的 `songListPath` 调 `delSongsAwaitable`，绕过 `netease:delete-local` 的索引清理 | `usePlayerDeleteAllAbove` 前置分支：抓到 `netease:pl:` 列表就转 `deleteNeteaseLocalFiles`（SET 保护 + 清索引 + 刷两处视图） |
| 幽灵「已下载」行 | `listDownloaded` 纯查表。文件被播放器/资源管理器/回收站彻底删掉后，`netease_file` 行还在，「查看已下载」显示已不存在的东西 | `reconcileStoreFromDisk` 改为双向对齐：磁盘上找不到的行删掉；目录读失败时直接返回，绝不因为"看起来全没了"清空索引；磁盘上还有 `<songId>.part` 的不算消失 |
| 往网易云库空白区拖歌单会建真目录 | 空的 `library/NeteaseLibrary/<名字>/` 建在盘上，下次同步被虚拟子树顶掉，只剩垃圾 | `drop` 里对 `NeteaseLibrary` 直接不收 |
| 空库提示词不对 | 未登录时显示"右键新建歌单"，但网易云右键没有这一项 | `netease.emptyLibraryHint`：「登录并同步后，歌单会出现在这里」 |
| 点击库图标抢列表 | 同步是异步的，用户可能已经点去别的库，回调仍会把右侧面板切到网易云第一张歌单 | 回调先确认 `libraryAreaSelected` 仍是 `NeteaseLibrary` |

### 15.6 第三轮自检（2026-11-15，专挑数据损坏类）

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| **导入会重复下载** | `downloadTrack` 不检查本地是否已有。同一张歌单导到第二个库＝整张重下；导入失败重来也从零开始。200 首的榜单就是几个 G 的流量 | `getLocalFileOutcome()`：命中已下载且文件真在盘上就直接复用。换成别的音质想重下属于另一个功能（没做） |
| **并发复制同名会静默丢歌** | 两首同名（同艺人同标题的不同版本）在 8 并发下都算出同一个目标名，`fs.copy` 后者覆盖前者；计数仍是 2，列表里少一首 | `resolveAvailablePath` 加"本批次已认领"集合（认领是同步的，await 回来再复查一次）；复制改走 `moveOrCopyItemWithCheckIsExist`，顺带拿到 EBUSY/EPERM 重试 |
| **同步不是原子的 → 假孤儿** | 旧实现先删光 `netease_playlist_item` 再逐个歌单拉 id，中途断网就只剩前几个歌单的曲目。「已下载」的孤儿判定是"没有任何歌单含它"，于是大批曲目变成孤儿，用户一键清理就把缓存删了 | 改为先拉齐各歌单曲目，再在单个事务里整表重写。某一张因下架/不可用拉不到时，保留该歌单上次已同步的曲目；登录失效或其它非「不可用」失败则中止整次同步、不写库，避免半份关系被当成完整结果、清理时误删 |
| **树上数量 ≠ 列表条数** | `track_count` 存服务器的数字（含已下架曲目），右侧列表来自 `netease_playlist_item`，两个数对不上 | 落库与 `buildGroups` 统一用实际拿到的 id 数 |
| **半截下载被登记成「已下载」** | `pipeline` 在连接被中途切断时也可能正常结束；文件不完整却已改名落库，之后播放到一半断，而且 reconcile 也修不了（文件存在） | 下载时数字节，与 `content-length` 不符就删掉 `.part` 并报错 |
| **认不出容器就存成 `.bin`** | 那文件既扫不进歌单（不在 audioExt 里）也放不出来，却已经算"已下载" | 扩展名按「文件头 → content-type → URL 后缀」判定；三条都不成立就报错删临时文件，留在"未下载"状态下次重试 |
| 试听缓存 LRU 会删正在写的 `.part` | 删掉后那一路 tee 在 rename 时扑空，缓存白写一遍 | 5 分钟内改过的 `.part` 不进清理列表；更旧的（崩溃残留）照删 |
| 曲目详情一批失败拖垮整次同步 | 200 首一批的 `/v3/song/detail` 失败会让 `syncCatalog` 抛错，可目录结构其实已经写完了 | 单批 try/catch + 警告日志，标题为空下次同步补 |
| 死代码 | `netease:download` 通道与 `netease:progress` 事件没有任何调用方/监听方；`DIRECT_URL_ERRORS` 声明后只被 clear；直链缓存无上限 | 全部删除；`urlCache` 加上限（200 条）与过期清理 |

### 15.7 第四轮：把三处「能用但会失败」补成真功能（2026-11-15）

第三轮末尾列了三条遗留，这轮全部落地。

| 缺口 | 为什么当时不能凑合 | 处理 |
| --- | --- | --- |
| **换音质后不会重下** | `downloadTrack` 为了不重复下载而短路复用已有文件（15.6 第一条）。副作用是：设置里改了音质档位，再导入同一张歌单，拿到的还是旧规格——"确保已下载"的语义和"按当前音质下载"是两件事，缺了后者 | 新增 `netease:redownload` 通道 → `redownloadTracks()`：逐首「SET 引用保护 → `deleteLocalFile` 进回收站 → `downloadTrack`」。不能直接在旧文件上覆盖：旧的是 `.flac`、新的是 `.mp3` 时会留下一个孤儿文件。UI 上曲目菜单与播放器菜单都有入口，带确认弹窗（说明会先删本地、SET 托管的会先被收走） |
| **未下载曲目在播放器菜单里点导出/移动会失败** | 这类行的 `filePath` 是 `frkb-preview://?netease=` 流地址。播放器菜单原来只把 Rekordbox 外来源当只读，网易云行被当成普通本地文件，一路把 URL 当路径送进 `exportSongsToDir` / 移动逻辑 | 判据统一成 `isNeteaseStreamSong()`（只看 `filePath` 前缀——`neteaseDownloaded` 不可靠，歌单里已下载的行路径**仍然**是流地址）。播放器菜单里这组操作整块隐藏，换成网易云自己的三项：下载到本地 / 按当前音质重新下载 / 删除本地文件（与曲目右键菜单同语义）。逻辑层另加兜底：`exportTrack`、`openSongMoveDialog`、`handleMoveSong`、`delSong` 命中流媒体行时给一句提示就返回——快捷键 Q/E/F 和小窗命令都绕过菜单显隐 |
| **混音库 vault 复制失败会退回原路径** | 退回去等于让混音引用网易云缓存文件。SET 有 `protectSetReferencedFilesForDeletion` 兜着，混音没有——用户清一次缓存，混音里那几首全断 | 去掉兜底：复制不成功的那首**不进混音**；一首都没成时弹 `netease.mixtapeVaultCopyFailed` 明确告知。宁可按比例少加几首，也不留断引用 |

顺带补掉同一类的第四个入口：从网易云歌单视图把行**拖**到别的库，`handleSongDragStart` 拿到的也是流地址，现在直接拦下并给一行轻提示（`netease.streamOnlyDragHint`）。「查看已下载」视图不受影响——那里的 `filePath` 是 `.store` 里的真实文件。

已明确不做：网易云歌单视图的搜索/排序（见 15.3）。打开歌单时不再套用当前列表的搜索/排序，保持平台原始顺序；「查看已下载」视图仍可筛选排序。

### 15.8 第五轮：对照审查回填（2026-11-16）

审查未提交代码后补上的收尾。当时仍维持 15.7 对「自动下载」的取舍，这一取舍已在 15.11 改掉：

- 抽出 `errors.ts` / `importName.ts` 的直接单测，覆盖登录失效、资源不可用、致命业务码，以及导入文件名的非法字符与截断。
- 树上的分组标题（我喜欢的音乐 / 创建的歌单 / 收藏的歌单 / 收藏的专辑）改为 i18n；打开库、同步之后都会按当前语言翻译。
- 「查看已下载」的码率改为用文件体积和时长计算，不再按未压缩 PCM 的位深×采样率估算。
- 设置里的试听缓存上限如果不是预设档位，下拉显示真实大小，不再悄悄显示成 10 GB。
- `streamOnlyNoFile` 文案后来在 15.11 改成与「导出/分析先自动下载」一致；拖到筛选库/精选库仍要先下载。

### 15.9 第六轮：审查修正（2026-11-16）

按代码审查结论逐条修，分「编译/资源」「数据正确性」「工程规则」三类：

| 问题 | 后果 | 修法 |
| --- | --- | --- |
| `library.ts` 从 `./client` 导入 `NeteaseApiError`，但 client 没导出它 | `vue-tsc --noEmit` 报 TS2459，`pnpm run build` 也会因 esbuild 找不到导出而失败 | 改为从 `./errors` 导入 |
| `netease.json` 把 `groups` / `settings` / `streamOnlyNoFile` 写在 `netease` 外面 | locale 由 `locales/*/index.ts` 用 `Object.assign` 扁平合并，顶层 `settings` 与 `settings.json` 撞名（谁后合并谁赢，一旦顺序变化整个设置页 key 全失效）；`netease.groups.*`、`netease.settings.cacheCustom` 实际不存在，英文环境分组标题仍是中文 | 全部收进 `netease.*`；分组 id 改成代码真正用的 `liked/created/subscribed/album`；补 `cacheCustom` |
| 同步按 `list_root` 清空 `netease_playlist`，再按"不在歌单表里"回收曲目关系 | 换账号后另一个账号的歌单行被抹掉，它的曲目关系被当成残留清掉，`.store` 里的文件全被判成孤儿——用户点一次清理就删错文件 | 只清当前 `user_id` 的歌单行；用"同步前该账号有哪些歌单"的差集精确回收；回收时再挡一次"别的账号还收藏着这张歌单"。树上显示规则后来在 15.10 改为：已登录只显示当前 session 的 user_id，未登录不注入子树 |
| `.store/*.part`、ffmpeg 过渡文件、`.preview-cache` 都在库目录内，而 `libraryTreeWatcher` 递归监听且不过滤点目录 | 一次下载或一段试听会持续触发全库目录对账（400ms 去抖），日志与磁盘扫描噪音极大 | 监听器忽略任何含 `.` 开头路径段的变更（扫描器本来就跳过它们）；草案 9.2 同步改写为"临时文件必须落在点目录" |
| `reconcileStoreFromDisk` 用 `readFile().subarray()` 取文件头 | 补录几百首无损时瞬间吃掉几个 GB 内存 | 改成 `open` + `read(0, 128KB)` |
| 「查看已下载」右键里仍有「移动到筛选库/精选库」 | 移动会把 `.store` 里那份搬走，紧接着「已下载」多一条幽灵行；违反 9.6「只复制不移动」 | 构造菜单时把 `library.moveTo*` 改写成 `library.copyTo*` |
| 行内徽标用原生 `title` 做悬停 | 违反项目规则（悬停提示一律走气泡框） | 去掉原生 `title`，徽标文案自身即说明 |
| 9 个新文件是 CRLF、`log.info` 常驻日志 | prettier 2777 条警告；违反「常驻代码不留非报错落盘日志」 | 统一 LF；删掉该 `log.info` |
| 新增 4 个 spec 没进任何 npm script | CI 不会跑到 | 加 `test:netease`（`vitest run src/main/netease`，18 个用例） |

顺手补的健壮性项：试听流协议的 `songId` 加 `isSafeSongId`（它会被拼进缓存文件名）；CDN 回 401/403/404 时清掉直链缓存重取一次，不再傻等 5 分钟 TTL；试听缓存 tee 加背压，磁盘跟不上时刹住上游；未登录点库图标不再先垫一个说明框（扫码窗本身写着要做什么）；`client.ts` 的 `trial` 判定去掉冗余的 `!== null`；`ipc.ts` 三处同源 import 合并。

重下音质已在 15.11 改成原子替换：新文件先下到 `.store` 临时位，成功后再换掉旧文件。

### 15.10 第七轮：第二轮审查后的修正（2026-11-16）

| 问题 | 后果 | 修法 |
| --- | --- | --- |
| 树按 `last_sync_at_ms` 最大的账号取子树，不看当前 session | 登出后重开，或换号后同步尚未成功时，会露出上一个账号的歌单 | `getNeteaseGroupsFromDb` 改为读 session 里的 `user_id`：未登录不注入子树，已登录只显示当前账号 |
| `streamOnlyNoFile` 文案在收整 JSON 时回到「导出会自动下载」 | 与 15.7 / 15.8 的现行行为相反 | 中英文都改回「请先下载再导出或移动」 |
| 「查看已下载」右键已改成只复制，但拖拽和 Ctrl+X 仍会移动 | 内部拖到筛选库/精选库走 `moveSongsToDir`，会把 `.store` 里的文件拖走 | 下载视图一律按复制处理：拖放调用 `mode: 'copy'`，光标为复制，剪切快捷键降为复制；`resolveLibraryTransferActionModeForSongList` 也认这个来源 |
| `schema.ts` 仍写「账号（一行）」；`isIgnoredWatchPath` 没有单测 | 注释过时；过滤逻辑缺少回归 | 改正注释；导出该函数并补单测 |

重下音质已在 15.11 改成原子替换：新文件先下到 `.store` 临时位，成功后再换掉旧文件。

### 15.11 第八轮：补上草案里还没落地的功能（2026-11-16）

对照 9.1 / 9.6 / 15.9 把上一轮明确留着的四件事补上：

| 能力 | 落点 |
| --- | --- |
| 拖进 / 加入 SET | 未下载曲目立即以 `netease-pending:<songId>` 占位入单（分析快照里带 `neteasePendingDownload`），SET 顶部显示「N 首待下载」；后台下载到 `.store/` 后把引用改成真实路径。失败条目留在 SET 里显示「下载失败」，不会改成一个不存在的文件。点待下载条目会触发下载并等待。已下载的（含「查看已下载」）仍走现有引用/托管。从歌单视图拖到筛选库/精选库/混音库仍先提示。整个网易云歌单节点拖进 SET 不触发批量导入。 |
| 导出 / 触发分析 | 没有本地文件时先下载到 `.store/`，成功再用本地路径继续原操作；失败提示，不会把流地址当路径送进去。 |
| 导入体积估算 | `ImportTracksDialogBase` 的 netease 模式确认前显示「N 首 · 约 X（档位）」，并说明 `.store` 里还会留一份副本。按时长与档位均值估算，已下载的用实际文件大小，不请求 CDN。 |
| 重下音质原子替换 | `downloadTrack` 支持指定 `.store` 内临时落点和 `force`。新文件校验并写标签后再替换旧文件；失败时旧文件和 `netease_file` 都还在。扩展名变化时先改 SET 引用再回收旧文件。 |

会话文件仍在库根 `.netease-session`，按草案设计不搬。歌单搜索/排序仍按 15.3 不做。

