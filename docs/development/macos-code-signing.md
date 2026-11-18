# macOS 代码签名与 Apple 公证

Track Studio 的 macOS 产物走 **Developer ID 直链分发 + Apple 公证**：用户在 GitHub Release
下载 DMG 后双击安装，Gatekeeper 不再弹「无法验证开发者」，应用内也能原地一键更新。

本文覆盖从 Apple 开发者后台到 CI 发布整条链路。

## 一、前置条件

- 已加入 Apple Developer Program。本项目用的是**个人**开发者账号
  （`Renlu Tong - MQP48TLX8K`，Team ID `MQP48TLX8K`）。
- 本机装有 Xcode 13 以上版本（`xcrun notarytool` 随 Xcode 提供）。
  本项目验证环境：Xcode 26.3.0 / macOS 15.6.1。
- CI 使用 `macos-latest` runner，自带 Xcode。

## 二、创建 Developer ID Application 证书

Developer ID Application 是**在 App Store 之外分发 macOS 应用**必须使用的证书类型。
`Apple Development` 只能用于本机开发，Apple 的公证服务会直接拒绝。

1. 生成证书签名请求（CSR）：

   ```bash
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout DeveloperIDApplication.key \
     -out DeveloperIDApplication.csr \
     -subj "/CN=Developer ID Application: Renlu Tong (MQP48TLX8K)/"
   ```

   私钥和 CSR 都放在仓库之外（`.gitignore` 只忽略仓库内 `tmp/`，
   建议放 `~/.frkb-macos-signing/`），不要提交进 git。

2. 打开 <https://developer.apple.com/account/resources/certificates> →
   「Certificates」→ 左上角「+」→ 选择 **Developer ID Application** → 上传刚生成的
   `.csr` → 等待 Apple 签发。

3. 下载证书（`.cer`），双击导入「钥匙串访问」，在「我的证书」分类下能看到
   `Developer ID Application: <你的名字> (MQP48TLX8K)`。

   > 本项目当前证书：`Developer ID Application: Renlu Tong (MQP48TLX8K)`，
   > 由 `Developer ID Certification Authority (G2)` 签发，**有效期至 2027/12/16**。
   > 到期前需要重新走一遍本节流程（GitHub Secrets 也要同步更新）。

4. 导出成 `.p12`：在「钥匙串访问」中右键该证书 →「导出」→
   文件格式选 **Personal Information Exchange (.p12)**，并设置一个密码。
   这个密码后面要作为 CI secret 使用。

   ```bash
   # 导出成 base64，方便塞进 GitHub Secret
   base64 -i DeveloperIDApplication.p12 -o DeveloperIDApplication.p12.base64
   ```

## 三、创建 App Store Connect API Key

公证需要能代表开发者提交软件的凭据。推荐用 API Key 而不是 Apple ID + 专用密码，
因为 API Key 没有两步验证、不会因为 2FA 弹窗卡住 CI。

1. 打开 <https://appstoreconnect.apple.com/access/integrations/api>。
   **新注册的个人账号默认没有 API 权限**，页面会显示
   「必须拥有权限才能访问 App Store Connect API」并要求点「请求访问」；
   勾选确认框提交后一般会立刻显示「你对 App Store Connect API 的访问请求已获得批准」。

2. 在「团队密钥」页签点「生成 API 密钥」：
   - 名称随意，例如 `TrackStudio Notary`；
   - 访问权限选 **开发者（Developer）**——公证要求这个角色。

   > 个人账号的「个人密钥」页签是空的：个人密钥只能由团队成员在**自己的个人资料页**
   > 里生成，集成页看不到。不要为了这个去建团队密钥以外的账号。

3. 下载 `AuthKey_XXXXXXXXXX.p8`（**只能下载一次**，请立刻保存）。
   点「下载」后还会再弹一次确认框，两次都点「下载」才会真正吐出文件。

4. 在同一页面记录 **Key ID**（与文件名一致）和 **Issuer ID**。
   本项目当前凭据：Key ID `ZX227ZV6A5`，Issuer ID `f4141b84-50cd-4a87-9028-9390041a9623`。

   > 确认密钥能不能用（不需要真的提交公证）：
   > ```bash
   > xcrun notarytool history --key AuthKey_ZX227ZV6A5.p8 \
   >   --key-id ZX227ZV6A5 --issuer f4141b84-50cd-4a87-9028-9390041a9623
   > # 输出 "No submission history." 且 exit 0 就说明鉴权没问题
   > ```

## 四、导入本地钥匙串（本地打包用）

有两种做法，**推荐第一种**：不动你的登录钥匙串。

### 方式 A：用 `CSC_LINK` 直接喂 p12（不碰登录钥匙串）

electron-builder 自己会建临时钥匙串、导入证书、设好 partition list，用完销毁：

```bash
export CSC_LINK="data:application/x-pkcs12;base64,$(base64 -i DeveloperIDApplication.p12)"
export CSC_KEY_PASSWORD='<p12 密码>'
npx electron-builder --mac --arm64 --dir
```

### 方式 B：导入登录钥匙串

```bash
security import DeveloperIDApplication.p12 \
  -k ~/Library/Keychains/login.keychain-db \
  -T /usr/bin/codesign -T /usr/bin/productbuild

# 让 codesign 能在无弹窗的情况下访问私钥
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k <你的登录密码> ~/Library/Keychains/login.keychain-db
```

确认导入成功：

```bash
security find-identity -v -p codesigning
# 期望看到 1) xxxx "Developer ID Application: <名字> (MQP48TLX8K)"
```

## 五、配置 GitHub Secrets

在仓库 `Settings → Secrets and variables → Actions` 新建这 5 个 Repository secret：

| Secret | 内容 |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | `DeveloperIDApplication.p12.base64` 的全文 |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_KEY_P8` | `AuthKey_XXXXXXXXXX.p8` 的全文 |
| `APPLE_API_KEY_ID` | API Key 的 Key ID |
| `APPLE_API_ISSUER` | API Key 的 Issuer ID |

CI 里这 5 个 secret **全部是可选的**：没配置时构建照常进行，只是不签名、不公证，
产物会在日志里明确提示「未配置签名证书」。一旦配置了证书却缺少对应密码或公证凭据，
构建会直接失败，不会悄悄降级成未签名产物。

## 六、打包与验证

### 本地打包

```bash
export CSC_LINK="data:application/x-pkcs12;base64,$(base64 -i DeveloperIDApplication.p12)"
export CSC_KEY_PASSWORD='<p12 密码>'
export APPLE_API_KEY=AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

pnpm run build:mac
```

> 本机 `rust_package/native/ffmpeg/darwin-x64/` 是空的，**本地只能出 arm64 包**
> （`npx electron-builder --mac --arm64 --dir`）；
> universal 包由 CI 的 `macos-latest` runner 用固定 release 资产补齐 x64 FFmpeg 后产出。

### 校验产物

```bash
node scripts/verify-macos-signing.mjs
# 指定路径（CI 的 universal 产物在 dist/mac-universal/ 下）：
node scripts/verify-macos-signing.mjs --app "dist/mac-universal/FRKB.app"
# 只验证签名、不要求已公证（本地还没跑公证时用）：
node scripts/verify-macos-signing.mjs --app "dist/mac-arm64/FRKB.app" --allow-unsigned
```

脚本会依次检查：Developer ID 签名身份、Hardened Runtime 标记、
`codesign --verify --deep --strict`、公证票据 stapling、Gatekeeper 评估。

## 七、仓库里的关键配置

### `package.json` → `build.mac`

| 配置 | 值 | 原因 |
| --- | --- | --- |
| `hardenedRuntime` | `true` | 公证的硬性前提 |
| `identity` | `Developer ID Application` | 见下方说明 |
| `entitlements` | `build/entitlements.mac.plist` | 主程序授权 |
| `entitlementsInherit` | `build/entitlements.mac.inherit.plist` | Electron Helper 授权 |
| `notarize` | `true` | 有公证凭据时自动公证并 stapling |

> **为什么必须显式写 `identity`**：electron-builder 在找不到 Developer ID 证书时，
> 会退而求其次去匹配钥匙串里任意一张非 Apple 前缀证书——本机装的
> `Apple Development` 证书正好符合这个条件，于是会被误当成发布证书用。
> 写死 `Developer ID Application` 之后，找不到证书就明确跳过签名，
> 绝不会拿错证书去签。

### `build/afterPack.cjs`

electron-builder 的 mac 打包顺序是：

```
afterPack → 代码签名 → Apple 公证 → afterSign
```

Rust 原生模块的 `install_name_tool` 改写会改变二进制内容，直接让签名失效。
因此这一步**必须放在 `afterPack`**（签名之前），由 electron-builder 用正式的
Developer ID 证书对改写后的二进制重新签名。

历史问题：早期版本把这套逻辑放在 `afterSign`，只能靠一次
`codesign --force --deep --sign -` 的临时（ad-hoc）签名来恢复完整性。
ad-hoc 签名会直接抹掉 Developer ID 身份和已经拿到的公证票据，Apple 也明确不接受
`--deep` 签名（见 `--deep Considered Harmful`）。

另外注意：`install_name_tool` 改写 Mach-O 会让代码签名失效，arm64 上内核在加载时
会校验签名，签名失效会直接把进程 SIGKILL（表现为 `Killed: 9`，没有任何报错输出）。
所以改写完必须补一次 ad-hoc 签名保证可加载，正式的 Developer ID 签名由
electron-builder 在 `afterPack` 之后统一执行。

### `build/entitlements.mac.plist`

| 授权 | 用途 |
| --- | --- |
| `com.apple.security.cs.allow-jit` | Electron 的 V8 需要 JIT，否则渲染进程崩溃 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Electron 运行时要求 |
| `com.apple.security.cs.allow-dyld-environment-variables` | demucs / Stem 分轨的 Python 运行时依赖 `DYLD_LIBRARY_PATH` 找到自带的 so |
| `com.apple.security.cs.disable-library-validation` | 应用会 dlopen `librubberband.3.dylib` 与 `app.asar.unpacked` 里的 `.node` 模块 |

## 八、macOS 应用内更新

macOS 端现在与 Windows 一样走 electron-updater **原地一键更新**（Squirrel.Mac）：

- 更新包是 GitHub Release 上的 `Track-Studio-<版本>-mac-universal.zip`，
  `latest-mac.yml` 只登记这一个文件。
- 下载完成后点「立即重新启动 Track Studio」，应用退出、安装、重启，一步完成。

以下情况会自动退回「下载压缩包手动替换」的旧流程：

1. 从挂载的 DMG 或只读卷直接运行（应用包不可写）；
2. 当前运行的还是**未签名**的旧版本 —— Squirrel.Mac 要求更新包与当前应用
   同一签名身份，否则拒绝安装。

> **发布节奏提醒**：从旧未签名版本升级到首个签名版本时，用户必须手动装一次；
> 从第二个签名版本开始就可以直接原地更新了。

## 九、常见问题

**公证报 `The binary is not signed`**
包里有没被签到的 Mach-O 文件。确认 `afterPack` 里的 `install_name_tool`
在签名之前跑完，并且没有在 `afterSign` 阶段再改二进制。

**公证报 `The signature of the binary is invalid`**
签名之后文件又被改过。本项目历史上的 `afterSign` ad-hoc 重签就是这个问题。

**公证报 `The signature does not include a secure timestamp`**
签名时缺 `--timestamp`。electron-builder 默认会带，若自定义了 `mac.sign`
函数则需要自己加。

**公证报 `unsupported flag: --deep`**
不要用 `codesign --deep` 签名，逐个嵌套代码从里往外签。

**notarytool 长时间停在 `In Progress`（新账号首次提交最常见）**

Apple 公证服务对**新注册开发者账号的首次提交**会做 *additional analysis*（深度分析），
提交会长时间卡在 `In Progress`，且 `notarytool log` 返回
`Submission log is not yet available`（诊断日志只在有终态时才生成）。

Apple 官方工程师 Quinn（Developer Technical Support @ Apple）在开发者论坛的说明：

> 大部分上传会很快完成公证，但偶尔有些上传会被留作 additional analysis，
> 耗时更久。随着你公证的应用增多，系统会逐渐学会识别它们，延迟会越来越少。

Mac notary service 团队的官方 Q&A
（<https://developer.apple.com/news?id=s8eigiyj>）把机制讲得更清楚：

> **我应该多久公证一次？**
> 你应该提交**所有你打算分发的版本，包括 beta 版本**。因为我们会为你的软件
> 建立一份**独特画像（profile）**，用来把你的应用与其他开发者的应用、以及恶意
> 软件区分开来。随着我们发布新的签名来拦截恶意软件，这份画像能确保你已公证的
> 软件不受影响。

> **如果我的应用被选中做额外分析会怎样？**
> 有些上传需要额外评估。如果你的应用属于这一类，请放心：**我们已经收到了你的文件，
> 会完成分析，只是可能比平时更久**。另外，**如果之前的上传被延迟期间你修改了应用，
> 重新上传新版本是没问题的**。

**所以「首次提交慢」是必然的**：Apple 在给我们的软件建画像，第一份提交正好撞上
建画像的过程。

### 各渠道的真实耗时

| 情形 | 典型耗时 |
| --- | --- |
| 成熟账号 / 后续提交 | 几分钟（Apple 称 98% 在 15 分钟内完成） |
| **新账号首次提交** | **20~42 小时**（社区实测约 36 小时、42 小时） |

这不是孤例。Apple 开发者论坛从 2026-02 到 2026-11 持续有人遇到同样症状，
覆盖新个人账号、新团队账号，也包括「之前一直几分钟就过、某一次突然被卡」的成熟账号。
而且**卡片大小不是原因**：有开发者用 16 KB、10 KB 甚至 **210 字节**的纯测试包，
同样卡住 17~19 小时且拿不到日志——说明这是**账号级 hold**，不是内容问题。

**本仓库实测（第一手数据）**：Team ID `MQP48TLX8K` 的首次提交
`636611fe-c672-4c0d-9f18-76e17447fb4a`（`FRKB.zip`，401 MB，arm64 Electron 签名包）
自 2026-11-16 14:13:45 CST 提交，到 2026-11-18 03:17 CST 变为 `Accepted`，
**耗时约 37 小时**，`statusSummary` 为 `Ready for distribution`。

期间为排除账号侧因素做过完整核对，结论是**账号侧没有可修的阻塞项**，
所有待办都属正常：

- 团队与会员：`status: active`、`developerStatus: active`
- 协议：Apple Developer Program License Agreement 与 Apple Developer Agreement 均为 `active`，无待签
- 账号通知：`notifications` 为空
- 身份：邮箱、手机号、地址均已验证，`isIDVerificationRequired: false`、`isCountryUpdateRequired: false`

> 核对账号状态不必登录浏览器。开发者站点的前端调用了这些接口，
> 在已登录页面里用 `fetch` 直接取同一份数据，比读 UI 更准、也更省事：
>
> - `POST /services-account/QH65B2/account/getTeams`
> - `POST /services-account/QH65B2/account/getAgreementHistory`（body 传 `{ teamId }`）
> - `POST /services-account/QH65B2/account/getNotifications`（body 传 `{ teamId }`）
> - `POST /services-account/QH65B2/account/getUserProfile`（body 传 `{ teamId }`）
>
> `teamId` 就是 Team ID。证书链、签名时间戳、hardened runtime 这些都已经本地验证过，
> 公证长时间 `In Progress` 时不必反复重签或重打包——**换了包体也只会多排一个队**。

> Apple 官方状态页 <https://developer.apple.com/system-status/> 的
> **Developer ID Notary Service** 条目没有事件记录，即这不是一次公开的服务故障，
> 而是一项常态机制。核对状态：<https://developer.apple.com/system-status/data/system_status_en_US.js>

### 三条关键纪律

1. **不要重复提交同一个包。** 一旦某个请求进入 additional analysis，
   **后续所有请求都会排在它后面**（队头阻塞）。重复提交只会让队伍更长。
   社区实测：首次卡住后，同一个 app 的后续 4 次提交在首条放行后
   **全部在 2 分钟内 Accepted**，整轮构建不到 10 分钟。
   （注意区分：Apple 官方明确说**改动应用后提交新版本是允许的**，
   被劝阻的是「原封不动重复提交」。）
2. **不要提 Developer Support 工单。** 公证问题不是工单团队负责的范围
   （论坛原话：*"notarization is an email only support"*）。
   正确渠道是 **Apple Developer Forums**：
   <https://developer.apple.com/forums/> → Code Signing → Notarization 版块发帖，
   DTS 工程师会在帖子里跟进；超过一周仍卡住可在帖子里回复追问。
3. **先等首次放行，再发 CI 版本。** 首个签名版 CI 发版同样会排在队列后面，
   反而会延长队头阻塞。等本地这次 Accepted（系统学会识别本应用）后再发版，
   CI 那次通常几分钟就完。

### 可能触发额外分析的应用特征

官方 Q&A 提示，下列特征容易让应用被多看一眼：

> **空壳应用**，或者**可能在不知情的情况下损坏用户电脑的应用**
> （例如未经所有者知情就修改重要系统设置）**可能被拒绝，即使它们并非恶意软件**。

本项目确实带有一部分此类特征，提交内容与之对照时心里有数即可：

- 声明了 **19 种音频格式的文件关联**（`build.fileAssociations`，role 为 `Editor`）
- 会读写应用目录之外的数据（外部 Rekordbox 资料库）
- 内置 Python 运行时与 ML 模型，会拉起子进程

真正被拒时，Apple 的 `notarytool log` 会明确指出是哪一项，无需猜测。

本项目本地首次提交（2026-11-16）即命中该路径：
`FRKB.zip`（401MB），submission id `636611fe-c672-4c0d-9f18-76e17447fb4a`。

**Gatekeeper 仍然拦截**
说明票据没有 stapling。执行 `xcrun stapler validate <app>` 确认，
并检查公证那一步是否真的跑成功（electron-builder 日志里会有
`notarization successful`）。
