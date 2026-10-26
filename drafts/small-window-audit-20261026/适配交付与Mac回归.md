# 小窗口适配交付与 Mac 回归

日期：2026-10-26。工作区：`/Users/wzz/playground/FRKB_Rapid-Audio-Organization-Tool`，基线 `7f08fccc`。发布更新：已合并远端048b166a（无冲突），本轮适配纳入RC `1.2.6-rc.202610261612`。

## 结论

已修复初轮实测的弹窗拖动后缩窗丢失、欢迎页末尾不可访问、设置颜色面板被正文裁切问题，并补齐共用弹窗尺寸约束、下拉浮层定位及若干长内容滚动区域。Mac 回归中这些入口在 1260×650 截图窗口下可用。没有提高最小高度，默认启动高度仍为780。

这不是所有业务状态和 Windows 平台的完整验收：同步/分析/导入导出的动态结果与复杂嵌套状态仍需要后续验证。现有证据不支持用提高最小高度替代布局修复，也不足以断言所有650高度场景均已通过。

## 修改内容

| 层级 | 文件/入口 | 调整 |
|---|---|---|
| 共用弹窗 | `styles/main.scss` | 35px标题栏+8px顶部间距，其余边缘8px；最大高度/宽度约束，标题与页脚不压缩，页脚允许换行 |
| 拖动 | `directives/dialogDrag.ts`、`utils/overlayLayout.ts` | 四边限位；窗口或面板大小变化后重新约束已拖动位置；失焦/卸载清理拖动 |
| 通用浮层 | `composables/useAnchoredPopover.ts`、BaseSelect、ColorPicker | Teleport到body；统一锚点位置与可用高度，必要时向上展开；跟随拖动和滚动，锚点离开滚动区域或父弹窗关闭时收起 |
| 下拉交互 | BaseSelect | 高亮项滚入视野，Tab/Esc收起，选择后返回触发器焦点 |
| 设置 | SettingDialogBody.scss | 正文可收缩，滚动区域不挤出页脚 |
| 欢迎页 | welcomePage.vue | 两种排版均允许滚动，空间不足时安全对齐起始处 |
| 同步与结果 | cloudSyncSyncDialog、cloudSyncSummaryDialog、curatedLibrarySyncDialog、addSongFingerprintFinishedDialog、importFinishedSummaryDialog、conversionFinishedSummaryDialog | 正文可滚动，长文本可换行 |
| 批量重命名 | PlaylistBatchRenameDialog、PreviewDialog、PresetManagerDialog | 最小高度不超过统一安全区 |

共用几何定位新增5项单元测试，另回归现有右键菜单定位4项。未新增IPC、网络请求或业务写入逻辑。

## 开发环境核对

使用本工作区 `pnpm run dev`。最初本地 node_modules 与锁文件不一致（Vite7/electron-vite5），导致 worker 构建缺失；已执行 `pnpm install --frozen-lockfile` 同步到锁文件依赖，package.json/pnpm-lock.yaml没有修改。依赖同步后现有 House 歌单正常显示2首曲目。初轮报告中“没有可用曲目”的限制保留作为历史记录，本轮以下项目使用这2首已有曲目补测。

## 实际界面回归与证据

下列图片均为 CUA 原始 JPEG 窗口截图，尺寸1260×650。窗口通过实际拖动边缘调整，不将默认启动高度当成650。窗口外框、客户端、renderer viewport 的三个独立API数值此次未取得，因此不把截图像素直接认定为三者相同；Windows接手要求独立测量。Mac结果不能替代Windows225%缩放与最大化验证。

| 场景 | 主题/语言 | 实际结果 | 截图 |
|---|---|---|---|
| 双轨欢迎页末尾 | 亮/中文 | 可滚到最后的呼出/隐藏快捷键 | [01](mac-regression/01-welcome-end-light-zh.jpg) |
| 设置颜色浮层 | 亮/中文 | 初次展开即可看到HEX输入与色条，不再受正文裁切 | [02](mac-regression/02-color-light-zh.jpg) |
| 拖动并缩窗 | 亮/中文 | 设置在780窗口拖到底部，再缩到650，标题和底部关闭均完整可见；横向拖动也限位 | [03](mac-regression/03-drag-resize-recovered-light-zh.jpg) |
| 设置颜色浮层 | 暗/英文 | 完整显示，配色正常 | [04](mac-regression/04-color-dark-en.jpg) |
| 靠底部颜色浮层 | 暗/英文 | 面板与HEX完整可见；此案例下方仍有足够空间，未触发向上展开 | [05](mac-regression/05-color-bottom-dark-en.jpg) |
| 标签编辑 | 暗/英文 | 滚动到最后封面区域，标题与Save/Cancel仍可见，取消退出 | [06](mac-regression/06-metadata-dark-en.jpg) |
| 批量重命名预览 | 暗/英文 | 2首曲目的只读预览及Start Rename/Close可见；未执行重命名 | [07](mac-regression/07-rename-preview-dark-en.jpg) |
| 格式转换配置 | 暗/英文 | 配置与页脚可见；打开格式下拉并用方向键/Esc退出，取消配置 | [08](mac-regression/08-convert-dark-en.jpg) |
| Stem配置 | 暗/英文 | 提示、4个分轨与页脚可见，未启动分离 | [09](mac-regression/09-stem-dark-en.jpg) |
| 浏览器欢迎页末尾 | 暗/英文 | 可滚动到最后Show/Hide说明 | [10](mac-regression/10-browser-welcome-end-dark-en.jpg) |

切换主题和语言的下拉鼠标选择实际可用。已有列表/双栏及RGB波形正常显示，但没有进行播放或对波形功能作完整验收。测试结束恢复跟随系统主题、简体中文、双轨布局和780窗口高度，退出本次开发进程。

## 代码验证与未覆盖边界

- `npx vue-tsc --noEmit`：通过。
- `pnpm exec vitest run src/renderer/src/utils/overlayLayout.spec.ts src/renderer/src/utils/contextMenuPosition.spec.ts`：2文件、9测试通过。
- `pnpm run build`：通过，songListScanWorker依赖检查13文件通过。
- `git diff --check`：通过。交付补丁反向check通过，确认与当前源代码修改一致。
- 向上展开及超高列表定位有单元测试覆盖，未用真实长选项列表完成向上展开UI验收。
- 同步/导入/转换/指纹结果的长内容调整是代码层修复，未执行业务操作制造结果；不是这些结果状态的实测通过。
- 右键子菜单、复杂嵌套、全部主题×语言组合、Windows最大化与225%缩放仍需接手回归。初轮其他入口覆盖见[修改前检查报告](小窗口适配检查报告.md)，不把旧结果自动视为修改后的结果。
- 未删除、移动曲目，未保存标签、执行重命名/转换/分析/正式导出/同步。

## Windows交付

完整步骤见[Windows接手提示词](Windows接手提示词.md)。源代码补丁为[small-window-adaptation.patch](small-window-adaptation.patch)，包含15个已有文件修改和3个新增源文件（含测试）。适配、报告与截图随本次RC提交；Windows直接拉取包含该RC的main即可，不要重复应用补丁。补丁保留为初始适配的离线备份。新增BPM校正弹窗仅检查了代码滚动布局，未进行实际界面或业务操作回归。

## 发布前合并验证

快进合并远端048b166a，无冲突。合并后重新执行类型检查与完整构建通过；定位、BPM校正文件处理、歌单播放成员关系共4个测试文件22项通过。构建存在远端新增bpmFixActions静态/动态导入混用的分包提示，不影响本次构建成功。适配相关18个源文件均不超过1100行。发布标签为 `1.2.6-rc.202610261612`，按先push main、再push标签执行；不等待远端构建结果。
