# RC发布准备

- 版本：1.2.6-rc.202610262124。
- 用户授权：提交、push并发布一版RC，不跟踪远端构建流程。
- 同步远端main：从14aefd5aba408af9eae3076125dd3942c1aecb1a快进至55248f6339d2a5d26f6a29b1209b0c754f96eecd，共6个后续提交；没有冲突，本轮修复保留。
- 本轮发布内容：普通数组菜单子菜单/键盘身份修复，五类结果组件明暗文字色，4项菜单组件回归测试，以及本机Windows回归报告、原始截图和展示夹具记录。
- 发布顺序：提交 → push main → 创建同版本tag → push tag。标签推送触发既有Release工作流；本记录不代表远端构建或资产发布成功。

## 同步main后再次执行

|检查|结果|完成时间（Asia/Shanghai）|
|---|---|---|
|npx vue-tsc --noEmit|退出码0|2026-10-26 21:24:53|
|菜单组件、overlayLayout、contextMenuPosition三份Vitest|3文件、13项通过，退出码0|2026-10-26 21:24:40|
|pnpm run build|退出码0，worker依赖检查通过|2026-10-26 21:25:11|
|node scripts/check-file-path-comparisons.mjs|1211个源码文件通过|提交前执行|
|git diff --check|通过|提交前执行|

机器可读结果：release-typecheck-result.json、release-tests-result.json、release-build-result.json。构建仍有原有bpmFixActions静态/动态重复导入警告，非失败。

主报告和修复展示验证分别基于其标明的历史提交/工作树状态。同步后续main后没有重新进行全部GUI回归；此次重新检查是上述类型、组件/布局测试及构建，不能把后续main新增入口算作已全面验收。

原始运行日志按仓库既有*.log*规则留在本机；独立展示窗口的fixture-profile按本目录.gitignore规则留在本机。报告、截图、测量JSON及验证脚本随本次提交保存。没有提交资料库、密钥或运行时安装目录。
