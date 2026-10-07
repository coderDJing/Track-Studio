# rekordbox 本机库写入耗时优化

2026-10-05 用户反馈本机库写入慢。本轮处理写入前检查及歌单排序、重新编号、移除成员后的刷新；没有修改数据库写入算法、USN 更新或 pyrekordbox 提交规则。

## 写入前检查

原 `probe-write` IPC 先强制执行完整 `probe`，打开 SQLCipher 数据库统计歌单、文件夹和收藏集，再执行轻量 `probe-write`。现直接执行后者：Python helper 每次读取当前配置、确认数据库路径存在并检查 rekordbox 进程，不读取展示缓存。真正写入仍打开当前数据库，执行原有校验，并由 pyrekordbox 在提交时再次检查进程；配置、进程或通信检查失败即停止。

现有通道 `rekordbox-desktop-library:probe-write` 与 `reorder-playlist-tracks` 保持原名；preload 的 `sourceChannelPrefixes` 已覆盖完整通道，renderer 仍使用 `buildRekordboxSourceChannel`。

## 歌单就地刷新

排序、重新编号和移除成员成功后，使用 `refreshPlaylistTracks` 替代首次打开用的 `loadPlaylistTracks`。元数据继续从当前数据库读取，完全一致的行复用引用，保留选中项、滚动及播放状态；完整加载且路径一致的歌曲复用网格和时间基准，不再次启动 ANLZ runtime 读取。新增或不完整记录仍读取分析文件；Serato 的 runtime 刷新保持开启。

本机 Cue 来自 SQL，不能与 USB ANLZ Cue 一样复用旧值。元数据合并保留刚读到的 Hot/Memory Cue，并同步已经加载的播放歌曲；未知或分析变化刷新仍读取完整 runtime。写入期间切换来源或歌单时，清除原来源缓存，但不操作新选中的列表；同一歌单写操作保持单飞。

## 验证及耗时范围

在本机 `master.db` 与 `masterPlaylists6.xml` 私有副本上，使用原生 Python bridge 执行三轮排序提交并重新读取：顺序及连续编号正确，原始源文件哈希不变。原完整检查为 144/91/91 毫秒，轻量检查三次均约 1 毫秒；排序写入为 100/93/102 毫秒，元数据读取为 123/98/97 毫秒。该副本只有七个歌单、目标歌单两首歌，不代表大库固定延迟。

此计时为 Python bridge 各阶段，不包含 renderer、IPC 队列、首次 Python 启动或 Rust runtime 读取；额外 Python 完整 Grid 读取的计时仅作资料，不用于推断 FRKB 界面的整体耗时。

随后通过开发版及 computer use 对私有副本执行标题排序后的“重新编号曲目顺序”，两次完整写入及刷新为 850/227 毫秒，列表顺序、连续编号与选中歌曲符合预期。前一次发生在 helper 闲置一分钟退出后，后一次使用仍运行的 helper；现将解释器闲置回收延长至五分钟，各命令仍关闭数据库 session，正常退出应用会回收进程。五分钟回收本身未等待实测。自动化原生拖动没有产生落下事件，不将这份点击重新编号计时声称为拖动验收。临时计时日志已经移除，记录保存为证据目录的 `ui-timing.txt`。

五份 Vitest 测试文件 28 项通过，覆盖每次新鲜检查、运行中/库消失/通信失败、就地刷新、写入失败与切换歌单、SQL Cue 更新及既有 USB 刷新行为。`npx vue-tsc --noEmit`、目标 ESLint、`pnpm run build` 与 `git diff --check` 通过。没有增加常驻诊断日志、没有写入真实本机库或测试 U 盘。证据为 `.codex_tmp/desktop-write-profile-before.json` 与 `.codex_tmp/desktop-write-optimization-20261005-v2/result.json`。
