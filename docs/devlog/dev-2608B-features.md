# dev-2608B-features

日期：2026-08-16  
基线：用户提供的 `Drop2Tunnel-20260816-updated.zip`  
目标分支语义：`dev/2608B-NEWCODE`

> 本文记录本轮实现的工程决策、协议设计、修改点、验证过程和已知运行环境边界。它不是隐藏推理草稿，而是可复核的开发日志。

## 1. 本轮范围

本轮完成以下五组需求：

1. YouTube Premium 音乐任务多艺术家统一使用半角 `/` 连接。
2. “编辑歌曲元信息”参考信息尽可能额外采集歌曲源语言版本。
3. YouTube Premium 支持可选 `--download-sections` 参数值。
4. 设备详情页增加双向摄像头实时共享入口。
5. 功能首页加入“光媒分享 / 接收”完整 MVP，包括动态二维码数据帧、Manifest 高频穿插、任意帧开始、残片续收、多来源去重、距离模式、可选网络补块、点阵进度、合辑原结构恢复、完整性校验、本机残片管理页。

技术参考使用仓库内：

`prompts/ideas/LIGHT-TRANSFER-overview-260813.md`

其中“活动大屏、微信小程序、彩色码、Fountain/RaptorQ、签名体系”等不属于本次明确业务范围的部分没有强行引入。本轮先实现可直接接入现有 file-tunnel 文件缓存/传输记录体系的固定原子块协议；协议层保留后续增加纠删码/喷泉码的空间。

---

## 2. YouTube Premium

### 2.1 多 Artist 使用 `/`

修改 `server.js`：

- `getStructuredArtistValue()` 优先读取 `meta.artists` 数组。
- 多个 artist 通过 ASCII 半角 `/` 拼接，不加空格。
- `album_artists` 同样采用 `/`。
- `buildYoutubeSongMetadata()`、页面参考信息、源语言参考信息统一使用该规则。
- 文件名仍会经过现有文件名安全过滤，因此文件系统路径中的 `/` 会被替换为可用字符；**歌曲元信息本身保留半角 `/`**。

例如：

`Artist A/Artist B/Artist C`

### 2.2 源语言版本参考信息

新增：

- `normalizeYoutubeLanguageCode()`
- `guessYoutubeSourceLanguage()`
- `getYoutubeSourceLanguageFields()`
- `collectYoutubeReferenceInfo()`

流程：

1. 先按现有方式抓取 yt-dlp JSON。
2. 优先采用 `language / audio_language / original_language`。
3. 没有明确语言时，再根据歌曲名、标题、artist、album 等 Unicode script 推测日/韩/泰/阿拉伯/希伯来/印地/俄/中文。
4. 能确定候选语言时，再执行一次 yt-dlp，并通过：

   `--extractor-args youtube:lang=<language>`

   尝试获取该语言版本。
5. YouTube 未返回独立语言版本或第二次抓取失败时，安全回退到普通页面元数据，不影响原编辑流程。

参考面板新增并优先显示：

- 推测源语言
- 源语言标题
- 源语言歌曲名
- 源语言专辑名
- 源语言艺术家
- 源语言专辑艺术家

同时保留 YouTube 当前页面版本，方便人工交叉判断。

为避免每次打开编辑器都重复跑第二次 yt-dlp，参考信息增加：

- `sourceLanguageCheckCompleted`
- `sourceLanguageVersionAttempted`
- `sourceLanguageVersionResolved`

“重新采集”仍明确绕过本地 yt-dlp 缓存策略并重新抓取。

### 2.3 `--download-sections`

页面 `pages/youtube-premium-dl.html` 新增可选输入框：

`指定片段（可选 · --download-sections 参数值）`

只填写参数**值**，例如：

`*00:01:30-00:03:15`

行为：

- 空：不传 `--download-sections`，保持完整下载。
- 非空：任务记录保存 `downloadSections`，实际调用 yt-dlp 时作为两个独立 argv：

  `--download-sections`, `<用户填写值>`

- 没有拼接 shell 字符串，避免参数值进入 shell 解释。
- 普通视频下载和音乐下载流程都支持。
- 任务卡中显示已设置的指定片段值。

---

## 3. 设备详情摄像头

新增：

`client/device-camera.js`

设备详情页新增按钮：

- `打开对方的摄像头`
- `共享我的摄像头`

### 3.1 传输模型

视频数据使用 WebRTC MediaStream，不走 Socket.IO 视频帧中继。

Socket.IO 只承担信令：

- `device-camera-request`
- `device-camera-response`
- `device-camera-signal`
- `device-camera-stop`

服务端按 deviceId 定向转发。

### 3.2 权限语义

“打开对方的摄像头”不会静默开启对方摄像头：

1. A 发请求给 B。
2. B 显示确认提示。
3. B 允许后才调用 `getUserMedia()`。
4. B 通过 WebRTC 将视频发送给 A。

“共享我的摄像头”：

1. A 请求 B 是否接收画面。
2. B 接受后，A 才调用自己的 `getUserMedia()`。
3. A 通过 WebRTC 发送给 B。

### 3.3 ICE 稳定性

增加 `pendingIce` 队列：

- SDP remote description 尚未设置时到达的 ICE candidate 不直接丢弃/报错。
- 设置 remote description 后统一 flush。

主功能首页也加载并初始化 `DeviceCameraBridge`，因此对方停留在正常隧道首页时也能收到设备详情页发来的摄像头请求，不要求双方都打开 device.html。

---

## 4. 光媒协议 D2L1

新增核心模块：

`client/light-transfer.js`

协议标识：

`D2L1`

### 4.1 为什么单文件和合辑使用统一协议

没有做：

- 单文件一套协议；
- 合辑再打 ZIP / 再做另一套协议。

统一定义为：

`一个光媒任务 = Manifest + 一个连续逻辑字节空间 + 固定原子块`

单文件只是 `files.length = 1` 的特例。

合辑文件按照原顺序映射到连续逻辑空间：

- `order`
- `offset`
- `length`
- `sha256`
- `fileInfo`

因此：

- 合辑不需要 ZIP；
- 文件名、顺序、备注、collection 结构可保留；
- 每个文件都能独立判断自己的块范围是否已齐；
- 某文件先完整时可提前校验和预览；
- 整个 collection 全部校验成功后才恢复正式合辑记录。

### 4.2 原子块

固定：

`ATOMIC_BLOCK_SIZE = 256 bytes`

选择固定原子块而不是随距离模式改变底层块大小，原因是：

- 远/近距离提供方必须能共享同一个 taskId / chunk identity；
- 网络补块必须和光学补块完全去重；
- 暂停恢复后的 bitmap 必须稳定；
- 两台分享同一任务的设备必须能同时补齐不同缺口。

距离模式只改变“每个二维码帧携带几个原子块”。

### 4.3 三种距离模式

当前参数：

| 模式 | 原子块/帧 | 帧率 | QR ECC | QR 尺寸 | 留白 |
|---|---:|---:|---|---:|---:|
| 远距离 | 1 | 2 fps | H | 560 | 6 |
| 常规距离 | 2 | 4 fps | Q | 500 | 4 |
| 近距离 | 4 | 6 fps | M | 460 | 3 |

因此距离模式同时调整：

- 数据密度
- 单帧载荷
- 纠错等级
- 帧率
- 二维码尺寸
- 留白

不是只做 CSS 放大缩小。

### 4.4 taskId / Manifest / Hash

发送前：

1. 对每个文件算 SHA-256。
2. 生成 canonical identity。
3. 对 canonical identity 算 SHA-256 得到稳定 `taskId`。
4. Manifest 再单独算 SHA-256。
5. 每个数据二维码帧有 CRC32。
6. 最终恢复时再次对每个完整文件做 SHA-256。
7. Manifest identity 再计算 taskId 进行整体身份校验。

本机收藏状态、缓存状态、外部句柄状态等设备本地字段不会进入 task identity，避免同一份隧道数据仅因为某设备本地 UI 状态不同而变成不同 taskId。

### 4.5 动态二维码三类帧

- `s`：Summary
- `m`：Manifest fragment
- `d`：Data

Summary 包括：

- taskId
- Manifest hash
- 总大小
- 原子块数量
- 原子块大小
- 文件个数
- 标题
- 单文件/合辑类型
- 所属隧道
- 原消息 ID
- 可选网络加速 URL

Manifest 使用 Base64URL 分片。

数据帧包括：

- taskId
- 起始原子块 index
- 原子块 count
- blockCount
- blockSize
- CRC32
- payload

因此接收端不依赖第 0 帧，可从任何时刻开始。

### 4.6 高频摘要 / Manifest

发送端不把 Manifest 只放在循环开头。

当前调度：

- 每 4 个屏幕帧至少插一个 Summary；
- Manifest 持续穿插；
- Data 填充其余帧。

额外修正：

- `manifestFrameNo` 独立计数，避免 Manifest 周期和 Summary 周期重合后永久跳过某个 Manifest part。
- `dataFrameNo` 独立计数，避免根据 provider salt 偏移后某些 block group 永远无法被播出。

### 4.7 多设备同时分享同一光媒任务

同一来源记录 + 同一文件内容：

- taskId 相同；
- Manifest 结构相同；
- block index 相同；
- 文件 SHA 相同。

每台 provider 使用 deviceId 派生 `senderSalt`，仅改变数据块组的播放起点。

接收端 BarcodeDetector 对一帧画面返回的多个二维码逐个处理：

- 同 taskId：可同时吸收；
- 已有块：自动去重；
- 不同 taskId：当前任务锁定后不混入；
- 相同 taskId 但 Manifest hash 不同：拒绝混合并报警。

### 4.8 本机残片 IndexedDB

独立数据库：

`drop2tunnel-light-transfer-v1`

Stores：

- `tasks`
- `chunks`
- `receipts`

每个 `chunks` 记录保存实际 ArrayBuffer，不只保存进度数字。

暂停扫描：

- 停止摄像头；
- 不删除 task；
- 不删除 chunks；
- 不删除 Manifest fragments；
- 下次按 taskId 恢复 received bitmap。

这些数据完全属于当前浏览器/当前设备本地数据，不进入现有隧道历史同步。

### 4.9 01 点阵

接收层 K 使用 canvas 显示 block possession bitmap：

- 暗色：0 / 缺失块
- 绿色：1 / 已拥有块

点阵来自 IndexedDB 实际 chunk 集合，不是根据百分比虚构，也不要求与屏幕当前二维码帧一一对应。

### 4.10 残片身份校验

恢复旧任务时 `lockedTaskId` 固定。

若扫描到不同 taskId：

- 不保存该帧；
- 不合并到旧残片；
- 明确提示不是同一个光媒数据。

若 taskId 相同但 Manifest hash 不同，也拒绝混合。

---

## 5. 光媒发送浮层 J

功能首页文件预览 G 右上角新增：

`✴↗`

位置在 `『 』` 左侧。

点击后：

1. 从现有文件缓存/外部文件句柄读取真实文件字节。
2. 生成 D2L1 Manifest。
3. 对文件计算 SHA-256。
4. 切成原子块。
5. 全屏 J 循环生成二维码数据帧。

J 下方显示：

- 单文件 / 合辑
- 文件数量
- 总大小
- 原子块数量
- taskId
- 所属隧道
- 网络加速状态
- 当前距离模式 / fps / 正在播放的帧类型

文件没有完整本机数据时禁止开始“伪分享”，提示先还原。

---

## 6. 光媒接收浮层 K

“连接设备” header 最右侧新增 hamburger：

- 扫描隧道码
- 接收光媒

### 6.1 扫描隧道码

增加连续二维码相机扫描：

- 支持当前站点隧道 URL；
- 支持 5 位短码；
- 识别成功后进入现有 join 流程。

### 6.2 接收光媒

K 结构：

- 顶部：标题 / 暂停 / 关闭
- 上方主体：后摄像头扫描框
- 中部：摘要、百分比、进度条、01 block bitmap、状态
- 网络加速 checkbox
- 文件级完成状态
- 提前预览区
- 底部：“继续光媒接收”入口

连续二维码解析依赖浏览器 `BarcodeDetector` + `getUserMedia`。

### 6.3 提前预览

Manifest 完整后，可以计算每个 collection file 覆盖的 block range。

某个文件对应范围全部齐全时：

1. 从本地原子块重组该文件；
2. 做该文件 SHA-256；
3. 校验成功后标记文件完成；
4. image/video/audio 可以提前预览。

整个 collection 不需要先完成。

---

## 7. 光媒 + 网络双通道

接收端 checkbox：

`使用网络加速`

默认：**不勾选**。

未勾选时：

- 不请求任何网络补块接口；
- 即使二维码里存在 network URL，也只显示“检测到可用入口”。

勾选后且二维码 Summary 包含 URL 时：

1. 接收端根据本地 bitmap 计算缺失 block index。
2. 每次最多请求 32 块。
3. HTTP 请求到：

   `/api/light-transfer/network/:taskId?provider=<deviceId>`

4. Node.js 只把本次 block 请求定向转给当前 provider 页面。
5. provider 只在 J 仍开启且“提供网络加速入口”启用时返回对应 D2L1 原子块。
6. 网络块重新进入和光学块同一个 `acceptFrame()`，因此 CRC、block index、去重、最终 SHA 全部共用。

这里没有建立“第二套网络文件协议”。

provider 关闭网络加速广播后，即使旧 URL 被保留，provider 也会拒绝提供 block。

---

## 8. `/light-file-parts`

新增：

`pages/light-file-parts.html`

路由：

- `/light-file-parts`
- `/light-file-parts.html`

标题：

`继续光媒接收`

页面内容：

### 未完成任务

显示：

- 标题
- 单文件 / 合辑
- 已有块 / 总块数
- 百分比
- 大小
- 最近更新时间
- taskId

点击后通过 `postMessage` 回到父页面并重新打开 K，锁定对应 taskId 继续扫描。

### 简易接收记录

完整接收后保留：

- 完成日期时间
- taskId
- 标题
- 文件数量
- 总大小
- 所属正式传输记录链接

### iframe 行为

K 底部打开的是全屏 iframe overlay。

右上角关闭：

- 只删除 iframe overlay；
- 不 reload 功能首页；
- 不退出当前隧道；
- 不重置下层 K / 当前会话状态。

---

## 9. 完整接收后写入隧道

只有在以下条件全部满足时才正式写入：

1. blockCount 全部拥有；
2. Manifest hash 校验通过；
3. Manifest -> taskId 身份校验通过；
4. 每个文件 SHA-256 都通过；
5. collection 所有文件都完整。

在此之前只属于本机 `drop2tunnel-light-transfer-v1` 临时任务。

### 9.1 原记录已经存在

如果本机本来就有 Manifest 指向的正式隧道记录：

- 不重复创建记录；
- 只补齐该记录所引用文件的本机缓存；
- 标记 lightTransfer 收取信息；
- 从 partial task 删除；
- 生成 receipt。

### 9.2 原记录不存在

创建新的正式 file/collection message：

- sender 使用**当前接收设备**，满足现有服务端 sender 防冒充检查；
- `lightTransfer.sourceSender / sourceSenderName / sourceMessageId / taskId` 保留原来源语义；
- 当前就在目标隧道且 Socket.IO 在线时，走 `publishHistoryMessage()`；
- 目标隧道不是当前隧道时，先保存到该 session 的本机 IndexedDB，之后进入该隧道由现有 history reconcile 机制同步。

接收到的完整文件标记为本机可提供 file asset；当前隧道在线时立即 announce，使其它设备可以按现有文件资产机制恢复。

---

## 10. 合辑分享入口语义

### 整个合辑

传输记录 hamburger：

`✴↗ 使用光媒分享`

对 collection 生成完整“合辑光媒任务”。

### 合辑内单独文件

先进入合辑，再打开某个具体文件的预览 G：

右上角 `✴↗` 只分享当前文件。

不会误把整个 collection 一起下发。

---

## 11. 构建系统

`tools/deploy/build.mjs` 已加入：

- `client/device-camera.js`
- `client/light-transfer.js`
- `light-file-parts.html` route

因此 deploy build 会对新模块生成 hashed asset，而不是在 dist 页面残留 `/client/*.js` 源路径。

`tools/deploy/verify.mjs` 同步认识 `/light-file-parts` 路由。

---

## 12. 新增回归测试

新增：

`tests/features-2608B.test.cjs`

package script：

`npm run test:2608b`

覆盖静态契约：

- artists 数组 `/` 拼接优先级；
- `--download-sections` 前后端接线；
- 源语言字段；
- device camera bridge / WebRTC / ICE queue；
- D2L1 本机 stores；
- 单文件/合辑统一协议；
- Summary 高频穿插；
- 残片摘要冲突保护；
- receiver 网络 checkbox 默认关闭；
- J/K 入口；
- light network route；
- `/light-file-parts` 本机任务/receipt 行为。

---

## 13. 本轮验证结果

### JavaScript 语法

通过：

- `app.js`
- `server.js`
- `server/youtube-premium.js`
- `client/device-camera.js`
- `client/light-transfer.js`
- `tools/deploy/build.mjs`
- `tools/deploy/verify.mjs`

并单独抽取检查了以下 HTML 的 inline script：

- `pages/index.html`
- `pages/device.html`
- `pages/youtube-premium-dl.html`
- `pages/light-file-parts.html`

### 回归测试

`npm run test:youtube-premium`

- 11/11 PASS

`npm run test:p2p:unit`

- 38/38 PASS

`npm run test:2608b`

- 4/4 PASS

### Deploy build

执行：

`npm run deploy:build -- --profile txsl --source-branch dev/2608B-NEWCODE --source-commit local-20260816-final`

成功，最终 build id：`txsl-20260816-082240-local-20`。

随后：

`npm run deploy:verify -- --profile txsl`

成功。

构建环境没有安装 terser/esbuild，因此 deploy 工具按现有 fallback 策略生成未 minify 的 hashed JS asset；哈希和 service-worker/app-shell 仍正常生成并通过 verify。

### 直接启动服务端的环境限制

当前代码执行沙箱未安装项目 runtime dependency `express`，因此直接 `node server.js` 会在 Node 模块加载阶段报：

`Cannot find module 'express'`

这是沙箱依赖未安装，不是本轮 JS 语法或测试错误。原始用户 ZIP 同样没有附带 `node_modules`。

---

## 14. 仍需真实设备验收的项目

自动化/静态验证无法代替以下物理链路测试，建议上线前重点验收：

1. 两台真实 Android/PC Chromium 对动态 QR 在 2/4/6 fps 下的识别成功率。
2. 不同摄像头焦距、曝光、屏幕刷新率下三种距离模式的参数是否需要再调。
3. 两个 provider QR 同时入镜时 BarcodeDetector 在目标设备上的多码返回能力和吞吐提升比例。
4. 大文件残片 IndexedDB 的设备配额表现。
5. 网络补块在高延迟/断网/Provider 关闭 J 后的恢复表现。
6. Android Chrome / Samsung Internet 对 `BarcodeDetector` 支持差异；缺少 BarcodeDetector 的浏览器当前会明确提示无法连续扫码。
7. 两台设备跨 NAT 时摄像头 WebRTC 是否需要项目现有 TURN 配置进一步接入；当前 bridge 默认使用公共 STUN，信令本身已打通。
8. YouTube 的源语言字段受 YouTube/yt-dlp 返回能力影响，需用日语、韩语、多语言显示歌曲各抽样验收；无法获取独立源语言版本时 UI 已明确回退。

---

## 7. 2608B 第二轮 Bugfix 与新功能（2026-08-17）

本轮处理用户在灰度测试中反馈的 8 个 Bug 和 2 组新功能需求。

### 7.1 Bug#3：光媒分享在 HTTP 环境报 `Cannot read properties of undefined (reading 'digest')`

**根因**：`client/light-transfer.js` 中的 `sha256()` 直接调用 `crypto.subtle.digest()`。在非安全上下文（如 `http://10.0.0.11`）中，`crypto.subtle` 为 `undefined`。

**修复**：在 `sha256()` 调用前检测 `global.crypto?.subtle?.digest` 是否可用；不可用时回退到纯 JS 实现的 SHA-256（`_fallbackSha256`），算法正确性等价于标准 SHA-256。

文件：`client/light-transfer.js`

### 7.2 Bug#7：光媒分享二维码 `code length overflow`

**根因**：合辑数据较大时，manifest 分片或数据帧的 base64 payload 超过了 QR 码在当前纠错级别下的容量上限。QRCode 库抛出 "code length overflow" 异常。

**修复**：在 QR 码渲染时实现自动降级策略——从当前模式指定的纠错级别开始（如 H），逐级尝试更低的级别（Q → M → L），直到成功或已到最低。若最低仍失败则跳过该帧（不阻塞后续帧）。状态栏显示降级标记。

文件：`client/light-transfer.js`

### 7.3 Bug#6：扫描隧道码后不自动切换隧道

**根因**：`applyScannedTunnelCode()` 使用 `location.assign(url.href)` 切换隧道。当扫描到的 URL 与当前页面同源同路径仅 hash 不同时，`location.assign` 只更新地址栏不触发页面重新加载。`DOMContentLoaded` 监听器只在首次加载时执行 `initSession()`，不存在 `hashchange` 监听器重新初始化会话。

**修复**：检测到仅 hash 变化时先设置 `location.hash` 再调用 `location.reload()` 强制重载。非纯 hash 变化的场景也统一添加 `location.reload()` 确保页面刷新。

文件：`app.js`（`applyScannedTunnelCode()` 函数）

### 7.4 Bug#2：设备页语音通话/对讲机误提示"请先在功能首页关注设备后发起"

**根因**：`pages/device.html` 中的语音通话和对讲机按钮硬编码为 `alert('请先在功能首页关注设备后发起。')`，无论用户是否已关注都只弹提示。设备页是独立页面无 `mediaController`，无法直接发起通话。

**修复**：按钮点击后构造 URL 跳转到功能首页（`/?open=1&from=...&call=DEVICE_ID#SESSION_ID` 或 `&intercom=DEVICE_ID`），首页 `startTunnelApplication` 完成后由 `handlePendingDeviceCallOrIntercom()` 读取 URL 参数自动发起对应操作。

文件：`pages/device.html`、`app.js`

### 7.5 Bug#8：摄像头共享第一次点击无反应/误报对方拒绝

**根因 A**：`client/device-camera.js` 的 `beginRequest()` 同步调用 `this.emit()` 发送 `device-camera-request`。若 socket 尚未连接（首次点击常见），`emit()` 抛异常被 device.html 的 `try/catch` 静默吞掉——表现为第一次点击无反应。

**修复 A**：`beginRequest()` 改为使用 `_safeEmit()`：先 toast 再异步发送。若 socket 未连接则注册 `once('connect')` 监听器等待连接就绪后发送。

**根因 B**：`handleResponse()` 收到 `accepted === false` 时 toast "对方拒绝了"。但同一 requestId 的 `handleResponse` 可能被重复触发（网络重传、迟到消息），导致用户在对方实际已接受后仍看到拒绝提示。

**修复 B**：在 `pendingRequests` 条目中增加 `responseProcessed` 标记，重复响应直接忽略。

文件：`client/device-camera.js`

### 7.6 Feature#1：光媒分享下载状态上报

**需求**：分享者在发送端能看到有多少接收端在下载、各自进度如何。

**实现**：
- **协议扩展**：Summary 帧新增 `ru` 字段（report URL），指向服务端 `/api/light-transfer/report/:taskId`。
- **接收端上报**：扫描到 Summary 帧后启动 `startProgressReporting()`，每 2.5 秒 POST 自己的 `receiverId`、`receiverName`、`received`、`blockCount`、`percent`、`status` 到 report URL。完成或关闭时发送终态上报。
- **发送端轮询**：`openSender` 界面每 3 秒 GET report URL 获取下载者列表，在 info-panel 的"下载者"信息项中展示。
- **服务端**：新增 POST/GET `/api/light-transfer/report/:taskId` 端点，内存存储 `Map<taskId, Map<receiverId, report>>`，5 分钟无更新自动清理。

文件：`client/light-transfer.js`、`app.js`、`server.js`

### 7.7 Feature#4：Telegram 频道歌曲分享配置

**需求**：在 tgbot.html 后台配置页新增三个频道（Base/Pro/Ultimate）地址填写框。

**实现**：
- 服务端 `normalizeTelegramBotConfig` 新增 `songShareChannels: { base, pro, ultimate }` 字段。
- GET/POST `/api/telegram/config` 读写 `songShareChannels`。
- `pages/tgbot.html` 新增三个输入框：Base 频道、Pro 频道、Ultimate 频道。支持 `t.me/xxx` 或 `@username` 格式。

文件：`server.js`、`pages/tgbot.html`

### 7.8 Feature#5：YouTube Premium 转发到 Telegram 频道

**需求**：音乐任务完成后可点击"转发到telegram频道"按钮，选择频道级别、编辑文案和封面，按 Base→Pro→Ultimate 引用链发送，失败时事务级回滚。

**实现**：
- **服务端**：新增 `POST /api/telegram/song-share` 端点：
  - 读取 YouTube Premium 任务成品文件和封面
  - 按引用链发送：Base 歌曲文件 → Base Tb 图文 → Pro Tp 图文 → Ultimate 正式/试行
  - 每成功创建一条消息立即记录 `chat_id + message_id` 到事务清单
  - 失败时逆序 `deleteMessage` 回滚事务清单中的消息
  - 已完成成功后不再回滚
- **前端**：`pages/youtube-premium-dl.html` 新增 `tgShareDialog` 浮层：
  - 频道选择（Base 必选、Pro 可选、Ultimate 可选且需先选 Pro）
  - Ultimate 二选一：正式图文记录 / 入选试行
  - 文案默认从歌曲元数据提取，支持全级别共用或分级别自定义
  - 封面默认正方形裁剪，可选原尺寸或自己上传（上传仅用于本次发布，不反向修改歌曲文件封面）
  - 发送时显示进度，完成后展示创建的消息链接

**事务安全保证**：
- 只有 Telegram API 明确返回成功并拿到 `chat_id + message_id` 的消息才加入事务清单
- 回滚只删除事务清单中的消息，绝不按标题/链接/歌曲名搜索删除
- 全流程成功后关闭浮层、刷新页面均不触发回滚

文件：`server.js`、`pages/youtube-premium-dl.html`

### 7.9 Bug#9：转发到 Telegram 报 `fetch failed`（ConnectTimeoutError 连不上 api.telegram.org）

**现象**：`/api/telegram/song-share` 返回 `{"ok":false,"error":"fetch failed"}`；服务端日志为
`TypeError: fetch failed → [cause] ConnectTimeoutError: Connect Timeout Error (attempted address: api.telegram.org:443, timeout: 10000ms)`。
前端仅显示"发送失败：fetch failed"，无法定位原因。

**根因（两层）**：

1. **代码层：Telegram API 的 fetch 从没显式走代理**。`git blame` 显示 `telegramApi()` / `sendDocument` / `getFile` 等自 2026-07 引入起
   一直是裸 `fetch('https://api.telegram.org/...')`；全历史搜索 `ProxyAgent` / `dispatcher` / `NODE_USE_ENV_PROXY` 零命中。
   yt-dlp 之所以能成功，是因为 `buildYtDlpEnv()` 会把 `DR2T_PROXY / DR2T_ALL_PROXY / HTTPS_PROXY / HTTP_PROXY / ALL_PROXY` 显式注入 yt-dlp 子进程环境；
   而 `server.js` 内所有对 `api.telegram.org` 的 `fetch()`（`sendAudio` / `sendPhoto` / `sendDocument` / `telegramApi` / `getFile`）完全忽略代理。

   **为什么"以前能用"（重要澄清）**：Telegram 的出站请求（扫描 bot 的 `getMe`、防失联检测的 `getFile`/`sendDocument` 等）之所以历史上可用，
   是因为**生产服务器本身能直连 Telegram**——部署配置 `tools/deploy/profiles/*.json` 中 `txsl` 标注为 `"Seoul direct Node.js"`（首尔直连）、
   `txhk`/`alyhk` 为香港节点，这些机房不墙 Telegram，裸 `fetch` 即可直连，无需代理。
   本次报错发生在 `http://10.0.0.56`（内网/大陆环境）：`api.telegram.org:443` 被墙（TCP 握手 10 秒超时），
   而 Node 的 fetch 又没有像 yt-dlp 那样显式走本机 Clash，于是超时。即"以前靠直连，现在这台机器无直连又没走代理"。

2. **Node 全局 fetch 的代理支持是「启动期」语义**。Node 24 的 `fetch`（undici）只有在**进程启动时**设置了
   `NODE_USE_ENV_PROXY=1` 才会读取 `HTTP_PROXY / HTTPS_PROXY`；运行期修改 `process.env.NODE_USE_ENV_PROXY` 无效（已实测验证）。
   因此无法在业务代码里临时打开，必须保证进程启动环境里就带上该开关。

**修复**：

1. **出站代理引导（进程重拉一次）**：在 `server.js` 顶部（任何出站请求之前）新增 `resolveTelegramProxyUrl()` 与一次性引导块：
   - 代理解析优先级：`DR2T_PROXY`（HTTP 代理）→ `DR2T_ALL_PROXY`（SOCKS/通用代理）→ `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`（标准变量仅作兜底）。
   - 若解析到代理但缺少 `NODE_USE_ENV_PROXY`，则设置 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY/HTTP_PROXY`（未配置时才覆盖），
     用 `spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)])` 重新拉起一次本进程（`DR2T_PROXY_REEXEC` 防重复），
     父进程转发 `SIGINT/SIGTERM/SIGHUP` 并透传退出码后等待子进程退出。
   - 这样既兼容 `node server.js` 直启，也兼容 `npm run dev` 的 `node -e "...require('./server.js')"` 形式（`execArgv` 里包含 `-e` 脚本）。
   - 代理为 SOCKS（如 `socks5://`）时 Node 也能支持（会打印 experimental 警告），HTTP(S) 代理最稳定。

2. **错误信息可读化**：新增 `describeTelegramNetworkError()`，把 undici 的
   `UND_ERR_CONNECT_TIMEOUT / ConnectTimeoutError / ETIMEDOUT / ECONNREFUSED / ECONNRESET / ENOTFOUND` 等映射为
   "无法连接 Telegram API（连接超时）。请确认服务器能访问 api.telegram.org，或配置出站代理后重启服务（环境变量 DR2T_PROXY / DR2T_ALL_PROXY）"，
   `song-share` 的 catch 改用该函数返回 `error`。

3. **yt-dlp 歌曲错误信息可读化（顺带）**：`sanitizeYoutubePremiumError` 的 labels 补齐
   `yt-dlp-song-download-timeout` / `yt-dlp-song-audio-missing` / `yt-dlp-song-cover-missing` 的中文提示，
   不再把 "yt-dlp-song-audio-missing" 这类内部码直接甩给前端（对应首条反馈里的 `yt-dlp-song-audio-missing`）。

**验证**：
- `node --check server.js` 通过。
- 用独立脚本模拟引导块：`node script.js`（直启）与 `node -e "require(script)"`（-e 模式）两种入口均能正确重拉一次，
  子进程继承 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY`，且 `DR2T_PROXY_REEXEC` 防止二次重拉。
- 实测 `NODE_USE_ENV_PROXY` 运行期修改无效（fetch 仍直连）、启动期设置有效（fetch 走代理）。

**运维提示**：
- 首尔/香港等**直连机房**（`txsl`/`txhk`/`alyhk`）通常不设 `DR2T_PROXY`，引导块会直接跳过，行为与以前完全一致（零影响）。
- 若服务器已有可用的 `DR2T_PROXY`（yt-dlp 能下载即说明有），本修复会自动复用该代理访问 Telegram，无需额外配置；
- 若 Telegram 需要走不同代理，显式设置 `DR2T_PROXY` 即可（优先级最高，`DR2T_ALL_PROXY` 次之）。
- 注意：走代理后最终能否连通 Telegram，还取决于本机代理（如 Clash）的规则是否把 `api.telegram.org` 路由到代理节点而非「直连/拒绝」；yt-dlp 能下 YouTube 通常说明 Clash 规则对墙内被墙域名是走代理的。

文件：`server.js`

### 7.10 代理变量统一 + 转发到 Telegram 的进度浮层（Feature）

用户反馈两点：一是代理环境变量名太杂，要求统一为 `DR2T_PROXY`（HTTP）/ `DR2T_ALL_PROXY`（SOCKS）；
二是"转发到 telegram 频道"要等待很久、看不到中间过程，要求加浮层面板逐步展示状态、最后展示消息链接并关联到任务记录。

**一、代理变量统一为 `DR2T_PROXY` / `DR2T_ALL_PROXY`**

- `resolveTelegramProxyUrl()`（`server.js` 顶部引导块）优先级简化为：
  `DR2T_PROXY` → `DR2T_ALL_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`（标准变量仅兜底）。
  删除了 `TELEGRAM_API_PROXY` 与 `YT_DLP_PROXY` 两个自造名。
- `buildYtDlpEnv()`（`server.js`）把 `YT_DLP_PROXY` → `DR2T_PROXY`、`YT_DLP_ALL_PROXY` → `DR2T_ALL_PROXY`。
- `describeTelegramNetworkError()` 的提示文案改为 `DR2T_PROXY / DR2T_ALL_PROXY`。
- `package.json` 的 `dev` 脚本：`process.env.YT_DLP_PROXY=...` → `process.env.DR2T_PROXY=...`，
  `process.env.YT_DLP_ALL_PROXY=...` → `process.env.DR2T_ALL_PROXY=...`（值不变：`http://127.0.0.1:58591` / `socks5://127.0.0.1:51837`）。
- 语义不变：`DR2T_PROXY` 是 HTTP 代理（Telegram fetch + yt-dlp 的 HTTP_PROXY/HTTPS_PROXY），
  `DR2T_ALL_PROXY` 是 SOCKS/通用代理（yt-dlp 的 ALL_PROXY，也作为 fetch 的兜底代理）。

**二、转发到 Telegram 频道的进度浮层 + 链接持久化**

改造前 `/api/telegram/song-share` 是**同步**接口：一次性把所有请求做完才返回 JSON，前端只看到"正在发送…"，
中途卡在哪个请求、每个请求成功失败都不可见。

改造后：

- **后端异步任务化**（`server.js`）：
  - 新增内存任务表 `telegramSongShareJobs`（Map）+ `pruneSongShareJobs()`（30 分钟 TTL）。
  - `POST /api/telegram/song-share` 仅做参数校验、创建 `job`（含动态 `steps` 步骤列表），**立即**返回 `{ ok, jobId }`，
    实际发送在后台 `runSongShareJob(job, params)` 里异步执行。
  - 新增 `GET /api/telegram/song-share/:jobId` 返回 `publicSongShareJob(job)`：
    `{ status: running|completed|failed, steps:[{key,label,status,detail,link}], messages:[{role,label,link}], error }`。
  - 每个步骤在开始/完成时用 `setSongShareStep(job, key, patch)` 更新状态与细节；失败时标记该步骤 `failed` 并回滚已发消息。
  - 步骤顺序：`prepare`（读文件）→ `base-audio`（发 Base 音频）→ `base-tb`（Base 图文）→ 可选 `pro-tp` → 可选 `ultimate`。
  - 成功后把 `{ messages, sharedAt }` 通过新增的 `youtubePremiumService.setTelegramShare(taskId, share)` 持久化到任务记录。

- **任务记录持久化**（`server/youtube-premium.js`）：
  - 任务对象新增 `telegramShare` 字段；`publicTask()` 透出 `telegramShare`。
  - 新增 `setTelegramShare(id, share)` / `getTelegramShare(id)` 方法。
  - `clear()` / `retry()` 清空成品时同时清空 `telegramShare: null`（旧链接随成品失效而失效）。

- **前端浮层**（`pages/youtube-premium-dl.html`）：
  - 新增 `<dialog id="tgProgressDialog">`，含错误条、步骤列表、消息链接列表三块。
  - `tgShareConfirm` 点击后先 `POST` 拿到 `jobId`，关闭配置弹窗，调用 `startTelegramSharePolling(jobId, task)`：
    `showModal()` 后每 700ms 轮询 `GET /api/telegram/song-share/:jobId`，用 `renderTgShareProgress()` 刷新
    步骤状态（✅完成 / ⏳进行中 / ❌失败 / ⏺待处理）与最终链接；完成后 `loadTasks()` 刷新任务列表。
  - 任务卡片按钮：若 `task.telegramShare.messages.length` 存在，按钮文字变为 **"已发到telegram"**，
    点击调用 `showTelegramShareResult(task)` 弹出浮层展示各条消息链接（`https://t.me/...`，新窗口打开）。

**验证**：
- `node --check server.js`、`node --check server/youtube-premium.js` 通过；抽出前端内联脚本 `node --check` 通过。
- `node tests/features-2608B.test.cjs` 6/6 通过（新增"Telegram song-share 任务化 + 链接持久化"断言）。
- 代理变量：`package.json` dev 脚本与 `resolveTelegramProxyUrl` / `buildYtDlpEnv` 已全部改为 `DR2T_PROXY` / `DR2T_ALL_PROXY`。

**运维提示**：
- 部署时在 systemd 或启动脚本里设置 `Environment=DR2T_PROXY=...`（HTTP）与 `Environment=DR2T_ALL_PROXY=...`（SOCKS）即可，
  之前若用 `YT_DLP_PROXY`/`YT_DLP_ALL_PROXY` 需要同步改名，否则 yt-dlp 与 Telegram 都将回到"无代理直连"。
- 转发任务为内存态，重启服务会丢失进行中的 job（但已完成的结果已持久化到 `telegramShare`，不受影响）。

文件：`server.js`、`server/youtube-premium.js`、`pages/youtube-premium-dl.html`、`package.json`、`tests/features-2608B.test.cjs`

### 7.11 Bug#10：媒体格式解析失败 `[youtube] <id>: The page needs to be reloaded.`

**现象**：youtube premium 页「媒体格式」处解析失败，前端直接显示
`解析失败：[youtube] 5OlwM1L1b6Q: The page needs to be reloaded.`，无法定位原因。

**根因**：这是 yt-dlp 的 YouTube 提取器错误——YouTube 对请求返回了「需要重新加载」的拦截页。
通常由 cookies 失效/被轮换（`VISITOR_INFO1_LIVE` / `LOGIN_INFO`）、缺少 `SOCS` 同意 cookie，
或出口 IP 触发机器人校验导致；yt-dlp 自身给出的建议也是 `--cookies-from-browser`（即刷新 cookies）。

**修复**（`server.js`）：

1. **错误可读化**：`getYtDlpFailureMessage()` 新增对 `page needs to be reloaded / must be reloaded / reload the page`
   的匹配，映射为「YouTube 返回"页面需要重新加载"（通常是 cookies 已失效/被轮换，或触发机器人校验）。
   请在 /sns-cookies 重新导出包含 VISITOR_INFO1_LIVE、SOCS、LOGIN_INFO 等完整登录态的 cookies.txt 后重试；
   若仍失败请稍等片刻或更换代理出口节点」。该函数同时服务于分析（`runYtDlpJson`）与下载（`spawnCapture`）两条路径。

2. **自动兜底重试（player client 切换）**：`runYtDlpJson()` 支持 `options.playerClient`（拼 `--extractor-args youtube:player_client=...`）。
   当首次失败且 stderr 命中 `page needs to be reloaded` 且尚未指定 player client 时，自动以
   `playerClient: 'web_embedded'` + `bypassCache: true` 重试一次（`playerClientFallback: false` 防重复），
   用 `web_embedded` 客户端（嵌入式播放器端点，对 `visitorData` 依赖更弱）绕过默认 `web` 客户端被拦截的情况。

**验证**：
- `node --check server.js` 通过。
- `node tests/features-2608B.test.cjs` 7/7 通过（新增"reload 映射 + player client 兜底重试"断言）。

**运维提示**：兜底重试只是缓解；若频繁出现该错误，根因大概率是 cookies 过期或出口 IP 信誉下降，
应在 `/sns-cookies` 重新导出完整 cookies（含 `SOCS`、`VISITOR_INFO1_LIVE`），必要时更换代理出口节点。

文件：`server.js`、`tests/features-2608B.test.cjs`

### 7.12 非 Premium 账号解析仍报 reload + 转发面板「全级别共用」改造

**一、非 Premium 账号解析普通视频仍报 `page needs to be reloaded`**

用户反馈：同一普通视频，用**无 YouTube Premium 资格**的账号即使是最新 cookie 也会间歇性报
`The page needs to be reloaded`，换成**有 Premium 资格**的账号即可正常解析。说明问题跟账号类型（Premium 与否）相关，
单靠 `web_embedded` 一个兜底客户端不够。

处理（`server.js`）：
- 把 7.11 的兜底 player client 从单一的 `web_embedded` 扩展为 `web_embedded,android,tv_embedded`，
  让 yt-dlp 按顺序在多个客户端间回退（不同客户端对 `visitorData`/登录态/广告注入的依赖不同），提高非 Premium 账号的成功率。

**二、转发到 Telegram 面板：去掉「全级别共用」，始终分级别设置**

原面板用 `tgCaptionUnified` / `tgCoverUnified` 两个「全级别共用」checkbox 在「共用一个输入框」与
「分三个级别输入」之间切换。用户反馈该切换不好用，且存在两个 bug：
- BUG1：取消勾选 Pro/Ultimate 后，对应级别的表单控件没有隐藏。
- BUG2：勾选 Pro/Ultimate 后，「封面图」区域对应级别的控件没有显示出来。

根因：`tgCaptionSplitRows` / `tgCoverSplitRows` 容器同时写了 `hidden` 属性和内联 `style="display:grid"`，
内联 `display` 优先级高于 UA 样式表的 `[hidden]{display:none}`，导致 `hidden` 切换失效；另外
`updateTgShareVisibility()` 里强制勾选 Pro 时没有同步更新局部 `showPro`，造成可见性与实际勾选不一致。

处理（`pages/youtube-premium-dl.html`）：
- 移除 `tgCaptionUnified` / `tgCoverUnified` 两个「全级别共用」checkbox 及各自的统一输入行，
  改为**始终展示** Base/Pro/Ultimate 三级的「文案」输入框和「封面图」下拉（square/original/upload）。
- 新增全局 CSS `[hidden]{display:none!important}`，杜绝内联 `display` 覆盖 `hidden` 的隐患。
- 封面「上传」改为独立按钮 `tgCoverUploadBtn`（原来藏在 `tgCoverSource` 下拉的 upload 选项里），
  三个级别下拉选到「上传...」且尚未上传时自动打开文件选择器。
- `updateTgShareVisibility()` 简化：只做三级行显隐，并在强制勾选 Pro 后同步 `showPro = true`（修复 BUG1/BUG2 的可见性错乱）。
- 确认发送时始终读取三个级别的文案/封面值（`captionPro = Pro 值 || captionBase`，封面同理）。

**验证**：
- 抽出前端内联脚本 `node --check` 通过；`node --check server.js` 通过。
- `node tests/features-2608B.test.cjs` 8/8 通过（新增"三级表单恒展示 + 无统一开关"断言，并把 fallback 断言更新为 `web_embedded,android,tv_embedded`）。

文件：`server.js`、`pages/youtube-premium-dl.html`、`tests/features-2608B.test.cjs`


### 7.13 Telegram 频道转发：原尺寸封面修复 + “自定义封面上传”标识

**需求/现象**：
- YouTube Premium 下载页的“转发到 Telegram 频道”面板选择“原尺寸”封面后，实际发送出的仍可能是任务内现有的正方形封面。
- 面板底部的上传按钮原文案为“上传封面...”，用途不够明确，应标注为“自定义封面上传”。

**排查结论**：
- 前端原逻辑在选择“原尺寸”时只向 `/api/telegram/song-share` 发送字符串哨兵值 `original`，实际原图并没有随请求提交；因此最终是否能取到原图依赖服务端对该哨兵值的额外解释和回退逻辑。
- 同时三级封面虽然注释说明“each can be set independently”，但 `Pro`/`Ultimate` 使用 `resolveCover(...) || coverBase`，当 Base 使用非默认封面而 Pro/Ultimate 明确选择“正方形”时，空字符串会被错误回退成 Base 封面，三级设置实际上并不完全独立。
- 本次用户提供的 ZIP 中缺少 `server.js`（但 `package.json` 的 `main/start` 仍指向 `server.js`），因此不能基于该 ZIP 对主服务端的 song-share 实现做可信的直接修改。为避免混入远端或旧版本 `server.js`，本次在现有前端和既有 API 能力内闭环修复。

**修改**（`pages/youtube-premium-dl.html`）：
1. 底部 `tgCoverUploadBtn` 文案改为 **“自定义封面上传”**。
2. 新增 `getTelegramOriginalCoverDataUrl(task)`：
   - 当任一级别选择“原尺寸”时，发送前复用现有 `POST /api/youtube-premium/tasks/:id/thumbnail` 原尺寸封面接口；
   - 读取服务端返回的真实图片 Blob，并转换成 Data URL；
   - 同一次转发面板会话内缓存该 Data URL，Base/Pro/Ultimate 多处选择原尺寸时只取一次原图；
   - 保留 401 管理会话失效处理、HTTP 错误和非图片响应校验。
3. 新增 `resolveTelegramShareCover(select)`：
   - `square` -> 传空值，继续使用服务端现有正方形任务封面；
   - `original` -> 传真实原尺寸图片 Data URL，不再传 `original` 哨兵字符串；
   - `upload` -> 传用户上传的自定义封面 Data URL；如果选了自定义但没有真正上传，明确报错而不是悄悄退回正方形。
4. Base / Pro / Ultimate 三个级别分别独立解析封面，移除 `coverPro || coverBase`、`coverUltimate || coverBase` 的隐式继承，避免明确选择“正方形”却被 Base 非默认封面覆盖。

**兼容性说明**：
- 自定义封面原本已经通过 Data URL 传给 song-share 接口，因此“原尺寸”复用同一数据形态，不新增服务端协议字段。
- 正方形仍保持原有空值语义，不改变现有默认封面流程。

**验证**：
- 新增 `tests/telegram-cover-regression.test.cjs`，覆盖：
  - “自定义封面上传”文案；
  - 原尺寸封面必须调用现有 thumbnail API 并转为实际 Data URL；
  - 不再把 `original` 字符串作为封面值发送；
  - Base / Pro / Ultimate 封面选择互相独立。
- 对 `pages/youtube-premium-dl.html` 的内联 JavaScript 做 `node --check` 语法检查。
- 对现有 `server/youtube-premium.js` 做 `node --check`。
- 由于本次 ZIP 基线缺少 `server.js`，无法执行依赖主服务端入口的整套启动检查和既有 `tests/features-2608B.test.cjs`；该缺口来自输入包本身，不在本次改动中用其他版本文件覆盖。

文件：`pages/youtube-premium-dl.html`、`tests/telegram-cover-regression.test.cjs`、`docs/devlog/dev-2608B-features.md`

### 7.14 Telegram 转发：原尺寸封面获取进度 + 三级封面串用修复

**用户反馈**：
1. 转发面板选择“原尺寸”后，提交时会先调用 `/api/youtube-premium/tasks/:id/thumbnail`，该过程可能较慢，但此前 `#tgProgressSteps` 只有真正创建 song-share job 之后的 Telegram 发送步骤，用户看不到原尺寸封面的获取状态。
2. Base / Pro / Ultimate 混合选择“正方形”和“原尺寸”时，实际多个频道可能都收到原尺寸封面；自定义上传封面未复现该问题。

**根因**：
- 原尺寸封面在前端创建 `/api/telegram/song-share` 任务之前同步获取，因此服务端 job 的步骤列表天然看不到这段耗时。
- 前端已经把三个级别分别提交，但“正方形”使用空字符串表示；服务端仍保留旧逻辑 `coverPro || coverBase` / `coverUltimate || coverBase`，于是当 Base 是原尺寸 Data URL，而 Pro/Ultimate 明确选择正方形（空字符串）时，空值会被错误替换成 Base 原图，造成封面串用。

**修改**：
- `pages/youtube-premium-dl.html`
  - 新增 `tgProgressPrefixSteps`，作为客户端预处理步骤前缀，与服务端返回的 song-share steps 一起渲染到 `#tgProgressSteps`。
  - 本次发送只要实际会发图的级别选用了“原尺寸”，点击提交后立即关闭配置浮层并打开进度浮层，先显示“获取原尺寸封面”运行中；thumbnail API 成功后改为完成，再继续创建 Telegram song-share job，因此该步骤始终排在“发送歌曲到 Base 频道”等 Telegram 步骤之前。
  - 原图获取失败时直接在进度浮层标记该步骤失败并显示错误，不再让用户停留在看不到状态的等待阶段。
  - 只解析本次真正会发送的封面：未勾选 Pro 不解析 Pro；Ultimate 使用“入选试行”时没有封面，不再无意义解析 Ultimate 封面。
  - 已完成历史分享结果重新打开时清空客户端预处理步骤，避免沿用上一次发送的“获取原尺寸封面”状态。
- `server.js`
  - Base / Pro / Ultimate 的 `coverBase` / `coverPro` / `coverUltimate` 改为完全独立读取请求值，移除 Pro/Ultimate 向 Base 的封面回退。
  - 空字符串继续只表示“该级别明确使用任务正方形封面”；Data URL 表示原尺寸或自定义封面，从而确保混合设置严格按各级别选择发送。

**验证**：
- 扩展 `tests/telegram-cover-regression.test.cjs`，覆盖原尺寸获取步骤位于 Telegram 发送步骤之前、服务端三级封面不再继承 Base、以及未发送级别不做无意义封面解析。
- 执行前端内联脚本语法检查、`node --check server.js`、Telegram 封面专项回归、2608B 回归、YouTube Premium 专项测试和 P2P 回归。

文件：`pages/youtube-premium-dl.html`、`server.js`、`tests/telegram-cover-regression.test.cjs`、`docs/devlog/dev-2608B-features.md`

**补充构建校验说明**：
- `deploy:build --profile txsl` 构建成功。
- `deploy:verify --profile txsl` 在构建后的 `server.js` 第 52 行报 `Illegal return statement`。该问题与本轮修改无关：使用用户原始 ZIP 不做任何修改重新执行同样的 build/verify，可稳定复现完全相同的错误；来源是既有代理重拉引导代码中的顶层 `return` 与 `tools/deploy/verify.mjs` 的 `vm.Script` 检查方式不兼容。本轮未擅自修改该无关基线问题。

### 7.15 Telegram 转发：Ultimate 入选试行关闭链接预览 + 默认文案修复

**用户反馈**：
1. Ultimate 频道选择“入选试行”发送形式时，Telegram 消息中的链接预览应关闭。
2. YouTube Premium 音乐任务打开“转发到telegram频道”面板后，“文案（艺术家 - 歌曲名）”实际预填为单独“歌曲名”，没有按预期带上艺术家。

**排查结论**：
- `server.js` 的 Ultimate trial 分支明确设置了 `link_preview_options.is_disabled = false` 和 `disable_web_page_preview = false`，等于主动开启链接预览。
- `pages/youtube-premium-dl.html` 的默认文案逻辑读取 `task.songMetadataOverride`；但 YouTube Premium 任务列表 API 对前端公开的是 `songMetadata`，并不公开 `songMetadataOverride`。因此该判断通常为 false，代码退回 `task.title`，而 `task.title` 通常只是歌曲名。

**修改**：
- `server.js`
  - Ultimate“入选试行”调用 `sendMessage` 时改为 `link_preview_options: { is_disabled: true }`，同时保留兼容字段 `disable_web_page_preview: true`，确保 Telegram 不展开链接预览。
- `pages/youtube-premium-dl.html`
  - 转发面板默认文案改为直接读取任务公开字段 `task.songMetadata.artist` 与 `task.songMetadata.title`。
  - 默认严格按 `艺术家 - 歌曲名` 格式生成；缺少字段时分别使用“未知艺术家”“未知曲名”兜底，避免再次退化成只有歌曲名。
  - 用户在面板内对 Base / Pro / Ultimate 的独立编辑逻辑保持不变。
- `tests/telegram-cover-regression.test.cjs`
  - 增加默认文案必须由公开 `songMetadata` 生成 `artist - title` 的回归断言。
  - 增加 Ultimate trial 必须关闭链接预览的回归断言。

**验证**：
- `node --check server.js`。
- 抽取 `pages/youtube-premium-dl.html` 内联 JavaScript 后执行 `node --check`。
- `node tests/telegram-cover-regression.test.cjs`。
- `node tests/features-2608B.test.cjs`、`node tests/youtube-premium.test.cjs`、`node tests/p2p-connection-regression.test.cjs`。

文件：`server.js`、`pages/youtube-premium-dl.html`、`tests/telegram-cover-regression.test.cjs`、`docs/devlog/dev-2608B-features.md`

**本次实际回归结果**：
- `server.js` 语法检查：通过。
- `pages/youtube-premium-dl.html` 内联 JavaScript 语法检查：通过。
- Telegram 转发专项：7/7 通过。
- 2608B 功能回归：8/8 通过。
- YouTube Premium 专项：11/11 通过。
- P2P 回归：38/38 通过。

### 7.16 YouTube Premium Track/Disc 补全 + Telegram `sendAudio` 显式歌曲封面

**用户反馈/目标**：
1. 真正的 YouTube / YT Music 歌曲任务希望尽量补全 Track / Disc。yt-dlp 若直接给出 `track_number` / `disc_number` 应优先使用；Track 缺失时，如果当前歌曲带有 YouTube Music 专辑播放列表上下文，至少可按专辑列表中的位置得到曲序；Disc 无可靠来源时按需求默认 `1`。
2. Premium 任务转发到 Telegram Base 频道时，音频文件内部虽然已经嵌入歌曲封面，但 Bot API 发出的音频消息没有显示歌曲封面；Android Telegram 客户端直接分享同一类歌曲时则可以显示。

**外部接口核对结论**：
- yt-dlp 的通用 info-dict 定义包含 `track_number` 与 `disc_number`，但 YouTube / YouTube Music 单曲提取并不保证返回 Track，因此不能把字段存在于通用模型等同于 YouTube 一定会给值。
- Telegram Bot API 的 `sendAudio` 明确支持 `thumbnail` 参数；要求 JPEG、小于 200KB、宽高均不超过 320，并且在 multipart/form-data 上传文件时随本次请求上传。Telegram 返回的 `Audio` 对象也包含可选 `thumbnail` 字段。
- 因此此前 Bot 发送与 Android 客户端直接分享的关键实现差异之一是：项目的 `sendAudioFile()` 原先只传 `audio`，完全没有显式上传 `thumbnail`；不能仅依赖 M4A 内部 `attached_pic` 让 Telegram 自动生成音频消息封面。

**修改：Track / Disc**：
- `server/youtube-premium.js`
  - 新增 `resolveYoutubeMusicOrdinalMetadata(meta, sourceUrl, playlistEntries)`。
  - Track 优先级：
    1. yt-dlp 原生 `track_number`；
    2. 当且仅当确认是 `OLAK5uy_...` 类型 YouTube Music 专辑列表时，使用 `playlist_index`；
    3. 使用 URL 的 `index`；
    4. 如果仍缺失但存在专辑列表 ID，则根据当前 video ID 在专辑 entries 中查找位置并使用 `index + 1`。
  - 不会把普通用户播放列表（`PL...` 等）的顺序误写成专辑 Track。
  - Disc 优先使用 yt-dlp `disc_number`，缺失时按需求默认 `1`。
- `server.js`
  - 新增 `enrichYoutubeMusicOrdinalMetadata()`：真正歌曲分析时，如果 Track 缺失且存在 `OLAK5uy_...` 专辑上下文，会用 yt-dlp `--flat-playlist --yes-playlist` 读取专辑列表并按 video ID 数位置。
  - `buildYoutubeSongMetadata()` 的 `disc` 缺失时默认 `1`；手工元信息编辑归一化也保持同一默认值。
  - `buildYoutubeReferenceInfo()` 增加 `playlistId` / `playlistTitle`，并让参考信息中的 Track / Disc 使用补全后的结果。
  - 对持久化格式分析缓存增加补全步骤：即使 URL 之前已经缓存过 analysis，新代码读取缓存时发现歌曲 Track / Disc 缺失，也会尝试补齐，不要求用户必须先点“重新解析”。
- 边界：如果单曲 URL 本身没有 yt-dlp `track_number`，也没有 `OLAK5uy_...` 专辑上下文/专辑 ID，则没有可靠依据判断它在专辑中的真实位置，此时 Track 保持空值，不凭歌曲名搜索或猜序号；Disc 仍为 `1`。

**修改：Telegram 音频封面**：
- `server.js`
  - 新增 `prepareTelegramAudioThumbnail(sourcePath)`：从 Premium 任务已有的正方形歌曲封面生成 Telegram 专用 JPEG；尺寸限制在 320×320 范围，并按多档 JPEG 质量重试，直到文件严格小于 200KB。
  - `sendAudioFile()` 新增 `thumbnailPath`、`performer`、`title` 参数：通过 multipart 的 `thumbnail` 字段显式上传歌曲封面，同时显式提供 artist/title。
  - Base 音频发送前生成 Telegram thumbnail，发送完成或失败后立即清理临时缩略图，不把它作为长期任务文件保存。
  - 发送进度完成状态会检查 Telegram 返回的 `message.audio.thumbnail`：存在时显示“Telegram 已返回歌曲封面缩略图”，不存在时显示“Telegram 未返回歌曲封面缩略图”，方便真实 Telegram 客户端验收。

**验证**：
- `node --check server.js`：通过。
- `node --check server/youtube-premium.js`：通过。
- `node tests/youtube-premium.test.cjs`：12/12 通过；新增 Track/Disc 优先级、OLAK 专辑 index/entries 推导、普通播放列表不误用等断言。
- `node tests/telegram-cover-regression.test.cjs`：8/8 通过；新增 `sendAudio` 显式 thumbnail、320px/200KB 限制及 Base 音频接入断言。
- `node tests/features-2608B.test.cjs`：8/8 通过。
- `node tests/p2p-connection-regression.test.cjs`：38/38 通过。
- 本轮没有执行真实 yt-dlp 下载、没有读取/修改真实 Cookie、没有向真实 Telegram 频道发送测试消息；Telegram 客户端最终是否展示该 thumbnail 仍需线上 Bot API 实发验收。

文件：`server.js`、`server/youtube-premium.js`、`tests/youtube-premium.test.cjs`、`tests/telegram-cover-regression.test.cjs`、`docs/devlog/dev-2608B-features.md`

### 7.17 外部系统变化防护审计 + YouTube Music 专辑遍历补 Track

**需求**：
1. 系统存在 yt-dlp/外部站点、Telegram Bot API、公共 STUN 等外部依赖。外部页面、API、协议规则、限额或本地第三方工具版本变化时，需要让异常具备明显的错误、告警与可追踪日志，避免被误判成 Drop2Tunnel 内部随机故障。
2. YouTube Premium 对真正歌曲且存在所属专辑时，若 yt-dlp 没有直接返回 Track，应继续进入专辑遍历定位当前歌曲；仍无法取得时 Track 默认 `1`。

#### 外部依赖面审计

本轮按源码中的出站 URL、`fetch()`、yt-dlp 调用、外部二进制进程、WebRTC ICE 配置逐项检查。确认的运行时外部依赖如下：

| 依赖 | 主要接入点 | 外部变化可能造成的影响 | 本轮防护 |
| --- | --- | --- | --- |
| Telegram Bot API / file API / webhook | `telegramApi()`、歌曲分享 `sendPhoto/sendAudio`、备份 `sendDocument`、`downloadTelegramFile()`、`/api/telegram/webhook` | API 返回结构、权限、限额、文件规则、网络/代理变化导致转发、备份、Bot 收发失败 | 统一 Telegram JSON 请求层；网络/HTTP/API-schema 错误进入 `external-dependency`；token 始终脱敏；webhook handler 异常记录 update 类型摘要 |
| YouTube / YouTube Music + yt-dlp | `runYtDlpJson()`、`spawnYtDlpCapture()`、Premium 分析/下载、参考信息、专辑查找 | 页面/player/signature/cookie/格式/extractor 变化导致解析、格式枚举、元信息、下载失败 | timeout/spawn/非零退出/JSON contract/fallback 全部记录外部依赖日志；已知签名、Bot challenge、reload、403/429/extractor 变化给出明确错误 |
| TikTok / Facebook / Instagram / Threads / LINE / Twitter/X + yt-dlp | SNS URL 解析、metadata scan、下载与恢复 | 各站页面/API/登录态/extractor 变化 | 与 yt-dlp 统一错误分类，标记为 `sns-yt-dlp`，最终错误仍回传现有任务状态 |
| yt-dlp remote components（仅配置时） | `getYtDlpRemoteComponentArgs()` | 远端组件提供方不可用或组件版本变化导致 YouTube signature solving 失败 | 启动时若启用 remote components 明确 warning；运行失败仍走 yt-dlp 外部依赖日志 |
| WebRTC ICE 服务 | `app.js` 文件 P2P；`client/media.js` 媒体；`client/device-camera.js` 设备摄像头 | Google/Cloudflare/stunprotocol 公共 STUN，或 runtime 自定义 STUN/TURN 的 DNS、凭据、服务策略变化导致 P2P/媒体失败 | 三条 RTC 路径均监听 `icecandidateerror` / connection failed；浏览器控制台明确 warning，并把事件通过 Socket.IO 写入服务端 `external-dependency` 日志，即使 HISTORY_DEBUG 未打开也保留 |
| 本机第三方媒体/抓取工具链 | `yt-dlp`、yt-dlp JS runtime、`ffmpeg`、`ffprobe` | 程序缺失、版本不兼容、执行异常 | 启动时做非阻断版本/可执行性检查；runtime timeout/spawn/exit 失败统一记录；不会因为诊断检查失败阻止不相关的隧道功能启动 |

同时检查了其它 URL/网络调用：
- `client/light-transfer.js` 的网络加速 URL 来自同一光媒任务的 Drop2Tunnel provider，不属于固定第三方 API；
- 自动同步 cookies 浏览器扩展只调用用户配置的 Drop2Tunnel 自身 `/api/sns-cookie-sync`；
- PWA host manifest、Nginx upstream、浏览器到本服务的 `/api/*` 均属于本系统部署/内部接口；
- `pages/sns-cookies.html` 的 GitHub URL只是 yt-dlp 官方说明链接，不是运行时 API 接入点；
- 项目未发现运行时 CDN script/style 依赖。

#### 统一外部依赖日志与可观测性

`server.js` 新增：
- `EXTERNAL_DEPENDENCY_REGISTRY`：登记 Telegram、YouTube/yt-dlp、SNS/yt-dlp、remote component、WebRTC ICE、local media toolchain，并列出具体 integration points / impact；
- `recordExternalDependencyEvent()`：所有此类事件统一使用 `source = external-dependency`；warning/error 无论 `HISTORY_DEBUG` 是否开启都输出服务端控制台并进入内存诊断日志；
- endpoint 只保留 protocol/host/path，Telegram Bot token 使用 `[redacted]`，不记录 cookies 内容；
- 管理员接口 `GET /api/admin/external-dependencies`：返回依赖清单与最近外部依赖事件；
- 原有 `GET /api/debug-logs?source=external-dependency` 可直接过滤查看；
- 启动日志明确打印上述诊断入口。

Telegram：
- 新增 `telegramFetchJson()`，将原本散落的 `telegramApi()`、歌曲频道 `sendPhoto/sendAudio`、资产备份 `sendDocument` 收口到统一错误层；
- 网络/DNS/代理异常、HTTP 状态异常、Telegram `ok=false`、非 JSON/意外 schema 都有明确 external-dependency 记录；
- `downloadTelegramFile()` 的文件 API fetch 同样单独记录；
- Bot webhook handler 抛错时记录 update id / update keys，不记录消息正文；
- 本地 20MB `getFile` 拦截发生时记录 warning，明确该阈值属于跟随 Telegram 外部规则的本地策略，未来上游限额变化时可快速定位。

WebRTC：
- `app.js` 普通 P2P、`client/media.js`、`client/device-camera.js` 都新增 ICE server 错误与连接失败提示；
- 客户端 `externalDependencyClientLog()` 不依赖普通 `HISTORY_DEBUG`，已加入隧道且 Socket 在线时可上报服务端；
- 服务端 `debug-log` 对 `external-dependency-*` 事件特判为 always-on，并保存为统一 `external-dependency` source。

外部工具链：
- `auditExternalRuntimeDependencies()` 在启动时检查 yt-dlp / ffmpeg / ffprobe 版本与可执行性；
- 检查 yt-dlp 使用的 JS runtime；
- custom remote components 启用时明确提示这是额外远程依赖；
- 检查仅用于诊断，不让 yt-dlp 缺失阻断纯隧道/聊天等其它功能。

#### YouTube Premium Track：三级回退

原实现的问题：
- `resolveYoutubeMusicOrdinalMetadata()` 已能使用 yt-dlp 原生 `track_number`；
- 如果 URL/metadata 已经带 `OLAK5uy_...` 专辑 playlist，也可以按 `playlist_index` / URL `index` / entries 中 video ID 找位置；
- 但真正的 YouTube Music 单曲链接经常只含 `v=`，即使 metadata 有 `album`，也未必带 `playlist_id/list`。因此此前根本不会进入专辑列表遍历，Track 会保持空。

本轮改为：
1. **原生字段优先**：合法 `meta.track_number` 直接使用；
2. **已知专辑 playlist**：若已有 `OLAK5uy_...`，继续展开该 album playlist，并按当前 video ID 定位 `index + 1`；
3. **按 album 反查并遍历**：若歌曲具有 `album + video id` 但没有可用专辑 playlist：
   - 使用 `album + album_artist/artist` 构造 YouTube Music `search?...#albums`；
   - 对 album search entries 按专辑名、艺术家相关度排序；
   - 最多展开前 8 个候选 album；
   - 在每个候选专辑 entries 中优先按**当前 video ID**精确定位；
   - 只有 entries 缺 ID 且歌曲标题在该专辑中**唯一匹配**时才允许标题兜底，避免同专辑重名歌曲误判；
4. **最终默认 1**：原生值、已知专辑遍历、album search 遍历全部无法取得后，`Track=1`；`Disc` 继续保持缺失时默认 `1`。

专辑搜索/遍历本身也属于外部 crawler 操作：搜索失败、候选专辑展开失败都会留下 `youtube-yt-dlp` warning，但不会把整个歌曲任务打成失败；仍按需求进入 `Track=1`。

新增纯逻辑函数：
- `findYoutubeMusicTrackPosition()`：video ID 优先、唯一标题兜底；
- `rankYoutubeMusicAlbumCandidates()`：对专辑搜索结果排序；
- `finalizeYoutubeMusicTrackNumber()`：严格落实 `native -> derived -> 1`。

#### 真实歌曲验证边界

- 使用真实 YouTube Music 歌曲 fixture：`pErfv9ss264`（羅大佑《鹿港小鎮》，所属专辑《之乎者也》）；公开专辑曲目资料中该曲位于第 1 首，本轮 regression fixture 验证 album entries 遍历得到 Track `1`。
- 本次执行容器本身没有安装 yt-dlp，输入 ZIP 也没有附带 yt-dlp/cookies；尝试临时下载官方 yt-dlp 时容器 DNS 无法解析 `github.com`。因此**没有伪称完成真实 Premium cookie + yt-dlp 联网下载**。
- 实际生产环境只要 yt-dlp 能正常访问 YouTube Music，上述 album search / traverse 会真实执行；若上游再次改变导致搜索失效，系统会留下明确 external-dependency warning 并安全回退 Track `1`。

#### 回归验证

- `node --check server.js`：通过。
- `node --check server/youtube-premium.js`：通过。
- `node --check app.js`：通过。
- `node --check client/media.js`：通过。
- `node --check client/device-camera.js`：通过。
- YouTube Premium：16/16 通过（新增专辑 entries video-ID 定位、唯一标题兜底、native/derived/default=1、真实歌曲 fixture、album candidate ranking）。
- 2608B 功能回归：9/9 通过（新增外部依赖 registry / logs / Telegram 收口 / Track 搜索 / RTC 告警静态断言）。
- Telegram 专项：8/8 通过。
- P2P 回归：38/38 通过。最初新增 RTC 告警时独立 VM 单测暴露 `externalDependencyClientLog` 不在抽取上下文的问题，随后把 `createPeerConnection()` 内的告警改为安全探测并在缺少全局日志器时退回 `console.warn`，最终 38/38。

文件：`server.js`、`server/youtube-premium.js`、`app.js`、`client/media.js`、`client/device-camera.js`、`tests/youtube-premium.test.cjs`、`tests/features-2608B.test.cjs`、`docs/devlog/dev-2608B-features.md`

**部署构建补充验证**：
- `node tools/deploy/build.mjs --profile txsl --out .dist-check-260820`：构建成功；当前环境未安装 Terser，构建器按既有降级策略生成 hashed assets/cache 产物。
- `node tools/deploy/verify.mjs --profile txsl --dist .dist-check-260820`：仍在构建产物 `server.js` 的代理重拉代码顶层 `return` 处报 `Illegal return statement`。已用本次用户原始 ZIP 的 `server.js` 对照，输入基线同一位置原本就存在该顶层 `return`；这与 `7.14` 已记录的 deploy verifier 基线兼容问题一致，本轮没有为无关需求擅自改动该启动结构。
- 本次执行环境没有 `node_modules`，所以未直接启动完整 Express/Socket.IO 服务进程；所有不依赖安装包的源码语法、专项/回归测试已实际执行并通过。

### 7.15 2026-08-20：Telegram Ultimate 试行链接、光媒二维码容量、音乐 Composer/Genre、relay 已缓存短路

#### 1. Ultimate“入选试行”消息缺少 Tp 超链接

现象：选择 Ultimate 的“入选试行”后，实际只发送：

`入选试行：\n艺术家 - 歌曲名`

虽然此前已关闭 Telegram 链接预览，但文案本身没有把“艺术家 - 歌曲名”包装成指向 Pro Tp 的超链接。

根因：服务端 trial 分支只是把 `captionUltimate` 拼进普通 `sendMessage.text`，没有构造 Telegram 可解析的链接实体。

修复：
- 试行消息改为 HTML：`入选试行：\n<a href="Tp链接">艺术家 - 歌曲名</a>`；
- `parse_mode=HTML`；
- Tp URL 与显示文案均做 HTML 转义；
- 保持 `link_preview_options.is_disabled=true` 与 `disable_web_page_preview=true`，因此链接可点击但不展开网页预览。

#### 2. 光媒二维码偶发“帧过长已跳过”并白屏

现象：动态二维码播放几帧后提示帧过长，并出现二维码区域空白。

根因有两层：
1. 旧发送器在生成下一帧前先 `replaceChildren()` 清空当前二维码；若新帧因 QR 容量超限失败，上一张有效二维码已被删除，所以出现白屏；
2. Manifest 分片和 DATA 单帧载荷偏激进，且 summary 带两条较长的绝对网络 URL，叠加 task/hash/文件属性后更容易在高纠错等级或较远距离模式下越过二维码容量。

修复：
- 新二维码先在 detached staging 容器中生成，确认成功后才替换屏幕上的旧二维码；生成失败时保留上一张有效二维码，不再白屏；
- Manifest 单片字符数由 420 下调为 240；
- DATA 调度调整为更保守的基础块数：far=1、normal=1、near=2；
- DATA 帧若仍超长，自动逐级减少同帧携带的数据块，最低降至 1 个原子块后再判定不可编码；
- summary 优先广播精简的 `origin + providerDeviceId + networkEnabled`，接收端本地重建 network/report URL，避免每轮重复携带两条长绝对 URL；仍保留旧 `nu/ru` 解析兼容；
- summary 正常版本无法编码时自动切 compact summary；
- 最终无法编码的单帧只提示容量异常并继续轮播，不清空当前 QR。

目标是同时解决“某帧过长”和“失败后视觉空白”两个问题，而不是仅隐藏错误提示。

#### 3. YouTube Premium 音乐 Composer / Genre

yt-dlp 的音乐元数据接口存在复数字段 `composers`、`genres`，同时历史版本/部分 extractor 仍可能出现兼容单值字段 `composer`、`genre`。因此本轮将歌曲元信息解析统一为：
- Composer：优先 `composers[]`，多个值使用 `/` 连接；其次兼容字符串 `composers`；最后兼容旧 `composer`；
- Genre：优先 `genres[]`，多个值使用 `, ` 连接；其次兼容字符串 `genres`；最后兼容旧 `genre`；
- reference info 与最终写入歌曲 metadata 共用同一套解析；
- 若结构化 Composer/Genre 字段均缺失，且该条 metadata 明确呈现为音乐内容（track/album、Music category 或 YouTube 自动生成音乐说明特征），再从 description 的显式信用行中识别 `Composer:` / `Composer, Writer:` / `作曲:` / `作曲者:` / `作曲家:` / `작곡:` 以及 `Genre:` / `ジャンル:` / `曲风/曲風:` / `流派:` / `장르:`；这只是对上游原文中的明确键值做兜底，不根据标题、标签自行猜测；
- 上游没有提供时保持空值，不把 YouTube 常见 `categories=["Music"]` 伪装成具体曲风。

因此“能否获得”仍取决于当前 YouTube/YouTube Music 是否实际暴露结构化字段或明确信用行；本系统现在会在有可靠值时填写，没有值时不伪造。

#### 4. Socket.IO relay 的 `receiver-already-cached` 被误记成服务端错误

用户现场日志中，在两个合辑合计 32 个文件、P2P 不可用转 Socket.IO relay 时，服务端连续出现：

`file-asset-relay-start error: Error: receiver-already-cached`

代码追踪确认这不是 relay 传输故障，而是接收端在 `file-asset-relay-start` 阶段检查 IndexedDB 后发现该 asset 已有完整缓存，主动返回 `{ok:false, reason:'receiver-already-cached'}`。旧服务端通用 `emitWithAck()` 将任何 `ok:false` 一律抛为 Error，于是正常的幂等短路被打印成服务端错误；文件数量多时会成批出现。

修复：
- 新增 `emitWithAckResult()`：仍对 ACK timeout / transport error 抛异常，但允许调用方自行解释业务层 `ok:false`；
- relay-start 对 `receiver-already-cached` 单独识别为正常 `skipped`：删除刚创建的临时 relay，向 source ACK `{ok:true, skipped:true, reason:'receiver-already-cached'}`，记录 `file-asset-relay-skipped`，不进入 error 日志；
- source 的 `sendViaSocketRelay()` 收到该 ACK 后直接把该 asset 视为已完成/100%，不再发送任何 relay chunk；
- 其他 receiver 拒绝原因仍按原来的错误路径处理，不把真正异常吞掉。

这使“接收端已有完整文件”成为幂等成功条件，而不是错误；同时避免无意义的重复数据传输。

#### 回归验证

- `node --check server.js`：通过。
- `node --check server/file-assets.js`：通过。
- `node --check client/file-assets.js`：通过。
- `node --check client/light-transfer.js`：通过。
- YouTube Premium：16/16 通过。
- Telegram 专项：8/8 通过。
- 2608B 功能回归：14/14 通过（新增 Ultimate trial 超链接、光媒 staging/容量自适应、Composer/Genre 结构化字段与自动生成信用行兜底、relay already-cached 幂等短路断言）。
- P2P 回归：38/38 通过。

涉及文件：`server.js`、`client/light-transfer.js`、`server/file-assets.js`、`client/file-assets.js`、`tests/features-2608B.test.cjs`、`docs/devlog/dev-2608B-features.md`。

**7.15 最终部署检查补充**：
- `node tools/deploy/build.mjs --profile txsl --out .dist-check-260820-0757`：构建成功，Build id `txsl-20260820-000622-unknown`；当前执行环境没有 Terser，构建器按项目既有降级策略继续生成 hashed assets/cache 产物。
- `node tools/deploy/verify.mjs --profile txsl --dist .dist-check-260820-0757`：仍在构建产物 `server.js:52` 的代理重拉顶层 `return` 报 `Illegal return statement`。对照本次用户上传的原始 `file-tunnel-260820-0757.zip`，原包同一行/同一结构已经存在该 `return`，因此这是输入基线已有的 deploy verifier 兼容问题，不是本轮四项修改引入的回归。
- 最终代码级回归：YouTube Premium 16/16、Telegram 8/8、2608B 14/14、P2P 38/38。

### 7.16 2026-08-20：光媒二维码完整显示/提帧、Ultimate trial 强制 Tp 超链接、YouTube Premium cookies 格式集合降级

#### 1. “使用光媒分享”二维码底边被裁与实际 FPS 偏低

现场问题：
- 二维码底边附近看起来被白色舞台裁掉，二维码没有完整显示；
- 即使选择“近距离”，动态二维码切换仍明显偏慢。

根因：
1. 发送器原来用 `mode.qrSize` 直接生成二维码，然后再给二维码容器追加 `padding=quiet`。二维码本体尺寸 + 后加 padding 会大于原预期尺寸；外层 `.light-qr-stage` 又使用 `overflow:hidden`，在可用高度较紧时底边会被裁掉。
2. 原调度逻辑是在同步二维码生成完成后，再执行 `setTimeout(render, 1000 / fps)`。因此真实帧周期实际为“二维码生成耗时 + 目标帧间隔”，必然低于界面标称 FPS；帧内容越复杂、二维码生成越慢，偏差越明显。
3. sender 主区此前强制二维码区域 `minmax(280px,1fr)`，信息面板较高时容易出现二维码视觉区与真实可用区尺寸不一致。

修复：
- 距离模式目标帧率提升为：远距离 4fps、常规距离 8fps、近距离 12fps；仍保留远距离更高纠错、近距离更高载荷的差异。
- 二维码生成前读取 `.light-qr-stage` 的实时宽高，以实际可用区域计算 `displaySize`，完整二维码不得超过舞台可用宽/高。
- quiet zone 改为二维码完整方框内部的白边（按模式比例计算），二维码有效码区使用 `displaySize - 2*quietPx`；不再在二维码生成后向外追加尺寸。
- detached staging 现在包含完整 `light-qr-frame + light-qr-render`，确认生成成功后一次性替换上一帧；既保留 7.15 的“失败不白屏”，又保证 quiet zone/底边属于被尺寸约束的二维码整体。
- sender grid 改为 `minmax(0,1fr)`；信息面板设置最大高度并可内部滚动，避免属性区域把二维码区域挤到错误尺寸。
- 帧调度改为统计本帧二维码同步生成耗时：下一次等待 `1000/fps - renderCost`，使“生成耗时”包含在目标帧周期内，而不是额外叠加。这样实际视觉 FPS 会更接近模式标称值。

#### 2. Ultimate“入选试行”仍被用户验收为纯文本：不再依赖 parse_mode

上一版 7.15 使用 HTML：

`入选试行：\n<a href="Tp链接">艺术家 - 歌曲名</a>` + `parse_mode=HTML`

但实际验收仍出现“艺术家 - 歌曲名”只是纯文本、没有指向 Pro Tp 的可点击链接。此前代码只检查 `sendMessage` 返回了 `message_id`，没有验证 Telegram 最终消息实体中是否真的生成超链接，因此“Telegram 接受了消息但链接实体没按预期形成”仍会被错误标记为成功。

本轮改为 Bot API 原生 MessageEntity：
- `text = "入选试行：\n" + captionUltimate`；
- `entities = [{ type: "text_link", offset, length, url: tpLink }]`；
- `offset = trialPrefix.length`、`length = captionUltimate.length`，JS 字符串长度对应 Telegram Bot API 使用的 UTF-16 code units；
- `url` 必须是刚刚成功发送的 Pro Tp 的 t.me 链接；如果 `tpLink` 无法生成，直接判定该步骤失败；
- 不再依赖 HTML/Markdown `parse_mode`；
- 保持 `link_preview_options.is_disabled=true` 与兼容字段 `disable_web_page_preview=true`，因此可点击但不展开链接预览。

额外的强校验：
- Telegram API 返回成功后，检查返回 Message 的 `entities`；必须存在与本次 offset/length/url 完全一致的 `text_link`；
- 如果返回消息没有该实体，抛出 `ultimate-trial-link-entity-missing`，该次频道分享事务不会被标记成功，而是进入既有精确回滚逻辑。

因此现在不允许再出现“消息成功但实际上是纯文本”的静默成功状态。

#### 3. YouTube Premium：Chrome 等浏览器导出登录 cookies 后偶发 `Requested format is not available`

用户现场特征：
- Chrome 导出的 YouTube Premium cookies 近期更容易出现：`Requested format is not available`；
- 改用 Android Firefox 导出的 Premium cookies 后同一流程明显更稳定。

上游背景核对：
- yt-dlp 官方 issue #15330、#16229、#16569 等已有“加入登录 cookies 后反而只暴露有限格式/出现 Requested format is not available”的现场报告；
- yt-dlp YouTube extractor wiki 也说明 YouTube 会在打开的登录浏览器会话中频繁轮换 account cookies，推荐在新的隐私/无痕会话中导出并随后关闭该会话，避免导出值马上被浏览器轮换；
- 因此外部登录态/player-client 返回格式集合变化，不能继续当作固定 Format ID 或固定 `-f` 一定长期有效。

本轮程序侧改动：

**解析阶段**
- 第一次元数据抓取改为 `--ignore-no-formats-error`：解析标题、音乐信息和原始 formats 库存不能因为默认格式选择失败而直接终止。
- 对“歌曲”不再执行第二次带 `-f <音频选择器>` 的元数据抓取。此前这一步只是为了让 yt-dlp替程序选 format，却会在 cookies 对应客户端只返回有限格式时直接触发 `Requested format is not available`。
- 改为在第一次返回的 `formats[]` 上用本地 `getPreferredMusicAudioFormat()` 选择可用音频编号。
- 如果当前登录态返回的 formats 中完全没有可用纯音频，额外做一次绕过缓存的备用 client 探测：`web_safari,web,android_vr,tv_embedded`；只采用其恢复出的 format 库存，不覆盖原歌曲标题/专辑等主 metadata。
- 备用探测成功/失败均记录 `external-dependency` warning，便于判断是否是 YouTube 登录客户端/格式集合变化。

**下载阶段**
- 自动音乐模式如果“解析时选中的具体 Format ID”到真正下载时已经不可用，不立即把任务判失败，而按顺序尝试：
  1. 解析时首选格式；
  2. 当前通用 `getYtDlpAudioFormatSelector()`；
  3. `bestaudio/best[acodec!=none]/best`，必要时允许从带视频的可用格式中提取音频，后续仍统一处理为歌曲 M4A。
- 每次因为 `Requested format is not available` 进入下一档都会留下 `youtube-song-download-format-fallback` 日志。
- 普通 Premium 视频的自动模式也允许从解析时 format selector 降级到当前通用 YouTube selector / `bv*+ba/best`。
- **用户明确选择的自定义 Format ID 不做自动降级**，避免程序违背用户指定的媒体编号。

**错误提示**
- `Requested format is not available` 单独归类，不再因为 stderr 前部可能同时出现 403/客户端警告就笼统显示成“外部平台拒绝或限制抓取”。
- 新提示会明确说明“当前登录态/播放器客户端返回的格式集合不完整，或原选择格式已经变化”，并提示系统已对自动模式提供降级；仍失败时建议重新导出有效 cookies。

#### 回归验证

- `node --check server.js`：通过。
- `node --check client/light-transfer.js`：通过。
- YouTube Premium：16/16 通过。
- Telegram 专项：8/8 通过。
- 2608B 功能回归：15/15 通过（新增 MessageEntity text_link 强校验、二维码完整尺寸/提帧、cookies 格式集合解析/下载降级断言）。
- P2P 回归：38/38 通过。
- 合计执行的四组回归：77/77 通过。

部署检查：
- `node tools/deploy/build.mjs --profile txsl --out .dist-check-260820-1122`：构建成功，Build id `txsl-20260820-032845-unknown`；当前环境没有 Terser，沿用项目既有降级构建路径。
- `node tools/deploy/verify.mjs --profile txsl --dist .dist-check-260820-1122`：仍在构建产物 `server.js:52` 报顶层 `return` 的 `Illegal return statement`。重新从本次用户原始 `file-tunnel-260820-1122.zip` 单独解出 `server.js` 对照，同一 `return` 原本就位于原包第 52 行，因此继续属于既有 deploy verifier 基线兼容问题，不是本轮三项修改产生。
- 当前执行容器没有 `node_modules`，未启动完整 Express/Socket.IO 实例，也没有用户 Telegram token/Premium cookies，因此没有伪称完成真实 Telegram 发频道或真实 Premium 联网下载；本轮通过源码逻辑、Telegram 返回 entity 强校验设计及已有回归测试确保失败不会静默成功。

涉及文件：`server.js`、`client/light-transfer.js`、`tests/features-2608B.test.cjs`、`docs/devlog/dev-2608B-features.md`。

### 7.18 2026-08-20：光媒摘要帧 `code length overflow` 与 YouTube Premium → Telegram 服务端过程日志

#### 需求与可公开工程分析

本轮处理两个现场问题：

1. “使用光媒分享”界面隔几帧出现“当前帧容量异常，已保留上一帧……code length overflow (4220>2960)”；
2. YouTube Premium 下载页把歌曲转发到 Telegram 时，服务器 console 缺少当前处理对象、YouTube 信息、文件信息、上传进度、各频道消息和回滚细节。

这里记录的是可复核的根因、设计依据和验证过程，不记录内部逐字思维链。

#### 1. 光媒为什么固定隔几帧溢出

发送循环按固定节奏混排三类帧：

- 每 4 帧插入一次摘要帧；
- 部分帧发送 Base64URL 编码的 manifest 分片；
- 其余帧发送 Base64URL 编码的数据块。

manifest/data 帧基本都是 ASCII；摘要帧则直接在 JSON 的 `q` 字段携带文件或合辑标题。因此“隔几帧”并不是随机容量波动，而是带 Unicode 标题的摘要帧固定进入二维码编码器。

项目使用的 `qrcode.js 1.0.0` 在补充平面 Unicode 字符（emoji 等，由一对 UTF-16 surrogate code units 表示）上存在长度估算与实际写入不一致：

- 选择 QR version 时，`encodeURI` 路径把一个 emoji 估算为 4 个 UTF-8 bytes；
- 真正写入时，旧库逐个 UTF-16 code unit 编码，把一对 surrogate 当成两个三字节字符，共写 6 bytes；
- 因此先按偏小长度选择 QR version，随后实际写入才抛出 `code length overflow`；
- 纠错等级一路降到 L 仍可能因为同一个错误估算再次选小版本，所以旧的纠错降级/保留上一帧机制只能避免白屏，不能根治提示。

使用 20 个 `🎵` 构造与摘要相同字段的帧，旧路径能稳定复现 `code length overflow (4228>2960)`；现场的 `4220>2960` 只因其它字段长度略有差异，错误形态和容量上限完全一致。

#### 2. 光媒修复方案

`makeFrame()` 现在在 `JSON.stringify()` 后把所有 UTF-16 surrogate code units 转成 JSON 标准的 `\uXXXX` ASCII escape，再加上 `D2L1:` 前缀：

- 二维码库的“估算字节数”和“实际编码字节数”都看到同一份 ASCII 文本，不再选到过小 QR version；
- `JSON.parse()` 会把 surrogate pair 原样恢复为原 emoji，因此协议对象、摘要标题和任务哈希语义没有变化；
- BMP 中文无需转义，正常标题不会无谓膨胀；
- manifest/data 帧继续沿用原协议，不需要减小 256B 原子块，也不会牺牲光媒传输吞吐；
- 旧的“生成成功后才替换上一帧”、纠错等级降级、摘要精简和数据块自动缩减仍作为其它容量异常的防线保留。

为了做行为级回归，内部测试 API 增加 `_makeFrame`。测试在 VM 中加载项目实际的 `qrcode-1.0.0.min.js`：先证明旧 JSON 帧稳定抛出 overflow，再证明新帧在相同 L 纠错等级成功生成二维码，并验证 `parseFrame(...).q` 仍严格等于原 emoji 标题。

#### 3. YouTube Premium → Telegram console 日志

每个转发任务现在有统一前缀：

`[Telegram歌曲转发][job:xxxxxxxx][task:xxxxxxxx][+N.Ns]`

console 会按实际生命周期输出：

- 创建任务：Base/Pro/Ultimate 目标、Ultimate 模式、各层封面来源；
- 获取 YouTube Premium 任务信息：源 URL、标题、媒体类型、任务状态、artist、album；
- 确认服务端文件：绝对路径、文件名、大小、MIME、封面路径；
- ffmpeg 生成 Telegram audio thumbnail 的每次质量档位与输出大小；
- 开始上传歌曲：频道、音频大小、thumbnail 大小、完整 multipart 请求大小、performer/title；
- Telegram 音频上传的字节数和百分比；
- Base/Pro/Ultimate 每条图片/文案消息的频道、封面来源/大小、文案长度、返回 message_id；
- 完成时的消息角色和链接；
- 失败时的具体步骤、异常，以及逐条删除已创建 Telegram 消息的回滚过程；某条回滚删除失败时会继续处理其它消息并留下日志。

“获取 YouTube 信息”在分享阶段明确读取已经完成的 Premium 任务缓存，不重新执行 yt-dlp、也不重复访问 YouTube。转发依赖的是任务下载时已经解析并持久化的元信息；console 会明确写出“读取任务缓存，不重复请求 YouTube”，避免把本地读取误判为新的外部请求。日志不输出 Telegram bot token 或 Premium cookies。

#### 4. Telegram 音频真实上传进度

原实现先 `readFile()` 把整首歌曲读成 `Blob`，再把 `FormData` 直接交给 Node `fetch`。这个接口没有上传进度回调，服务端只能知道“请求开始/结束”，无法显示真实字节进度。

本轮新增 `server/telegram-multipart.js`：

- 从歌曲文件建立 `fs.createReadStream()`，不再为了 Telegram 上传把整首歌曲额外读入内存；
- 以 async generator 生成标准 multipart/form-data，字段、thumbnail、歌曲文件和 closing boundary 均计入精确 `Content-Length`；
- 文件名按 UTF-8 header bytes 参与长度计算，中文文件名不会让 Content-Length 偏差；
- `Readable.from(generate())` 交给 Node fetch，并设置流式请求所需的 `duplex: 'half'`；
- 每当 fetch 消费一个歌曲文件 chunk 就累计上传字节；console 约每跨过 5% 输出一次，若长时间没有跨档则至少每 5 秒输出一次，最终必有 100%；
- 同一进度会更新前端轮询任务的 `base-audio.detail`，所以页面也能看到当前百分比，而不是一直停留在“可能较慢”。

进度表示 Node 正在向 Telegram 请求体写出的歌曲字节。Telegram 收完整个请求并返回 `ok=true` 后，才输出“上传完成并收到 API 响应”，两种状态不会混为一谈。

#### 5. 验证记录

- `node --check client/light-transfer.js`：通过；
- `node --check server/telegram-multipart.js`：通过；
- `node --check server.js`：通过；
- `tests/features-2608B.test.cjs`：17/17 通过，其中新增：
  - 使用实际旧二维码库复现 surrogate/emoji 摘要帧 overflow；
  - 新帧可成功编码且解析标题无损；
  - multipart 流的实际总字节严格等于 `Content-Length`；
  - audio/thumbnail 原始 bytes 都存在于请求体；
  - 中文文件名 header 正确；
  - 上传进度最终严格到达 `audio.length / audio.length`；
- `tests/telegram-cover-regression.test.cjs`：8/8 通过，已同步为流式 thumbnail/audio 断言。
- `tests/youtube-premium.test.cjs`：16/16 通过；
- `tests/p2p-connection-regression.test.cjs`：38/38 通过；
- 本轮四组相关回归合计：79/79 通过。
- 本地验证未使用用户的 Telegram bot token/频道执行真实发帖，也没有重新请求真实 YouTube 页面；外部副作用不属于本轮自动测试。已覆盖二维码实际旧库行为、multipart 字节流/长度/进度，以及现有 Telegram/YouTube/P2P 代码级回归。

涉及文件：`client/light-transfer.js`、`server.js`、`server/telegram-multipart.js`、`tests/features-2608B.test.cjs`、`tests/telegram-cover-regression.test.cjs`、`docs/devlog/dev-2608B-features.md`。

### 7.19 2026-08-20：YouTube Premium 抓取全过程服务端 console 细节与进度

#### 需求

YouTube Premium 下载任务不能只在网页上显示状态；Node.js 服务器 console 也需要明确显示当前处理的是哪个任务、正在获取什么信息、选择了哪些格式、下载到了多少、是否正在合并或写入元信息，以及最终成品或失败原因。

#### 日志关联方式

所有 Premium 抓取日志统一使用：

`[YouTube Premium抓取][task:xxxxxxxx][+N.Ns]`

- `task` 是任务 UUID 的前 8 位，可与下载页任务对应；
- `+N.Ns` 是从任务创建起算的耗时；
- 普通过程使用 `console.log`，格式降级/恢复/取消使用 `console.warn`，失败使用 `console.error`；
- 日志事件由 `server/youtube-premium.js` 的任务服务产生，再交给 `server.js` 统一格式化。日志回调自身即使异常也不会改变抓取任务的成功或失败。

#### 现在会输出的全过程

**队列和任务生命周期**

- 创建任务并入队：URL、默认/自定义模式、是否强制音乐、所选 Format ID、下载区间、队列位置；
- 开始执行：当前并发、剩余队列、任务处理选项；
- 服务重启恢复：原本处于运行态的任务重新入队；
- 重试、取消、排队任务取消、运行任务取消；
- 完成、失败，以及执行槽释放。

**YouTube 解析过程**

- URL 规范化结果和平台（YouTube/YT Music）；
- 确认私人 Premium cookies 已配置，但不输出 cookie 文件内容；
- 基础 `yt-dlp` 元信息结果：video ID、标题、extractor、时长、原始格式数量、是否有封面；
- 媒体判型以及默认格式选择器；
- 视频默认轨道确认结果；
- 标准化后的 audio/video/combined 格式数量和首选音频 ID；
- 登录态返回的格式不足时，备用 player client 探测的开始、恢复结果或失败原因；
- 最终 requested/selected Format IDs、完整 selector、输出容器和格式摘要；
- 音乐任务的专辑 Track/Disc 补充；
- 最终标题、艺术家、专辑、年份、Track、Disc 等解析结果。

**下载与成品处理**

- 选择歌曲工作流，还是视频/自定义单轨工作流；
- 每次启动 yt-dlp 的尝试序号、选择器、输出容器、下载区间；
- `Requested format is not available` 时失败 selector 和下一备用 selector；
- 下载百分比、已下载量、总量、速度、ETA；
- yt-dlp 输出文件路径和大小；
- 视频任务的音视频合并阶段；
- ffprobe 轨道校验，包括 codec、分辨率和轨道类型；
- 音乐任务的源音频/封面路径与大小、封面裁切、源音频 codec/码率/时长；
- 写入歌曲元信息和嵌入封面时的字段摘要；歌词和 comment 只记录“是否存在”，不把整段内容刷入 console；
- 最终 M4A 封面嵌入校验、文件大小、codec、码率、时长；
- 成品移入私人任务目录后的文件名、路径、大小和封面路径。

#### 下载进度节流

网页原有进度持久化行为保持不变；console 额外输出的进度采用独立节流：

- 第一个有效进度立即输出；
- 百分比相对上次至少增加 5% 时输出；
- 如果下载很慢、5 秒仍未跨过 5%，至少输出一次当前状态；
- 99.9% 以上和最终完成状态一定输出。

这样既能看到持续进度、速度和 ETA，也不会把 yt-dlp 每一个小 chunk 都刷到 console。

#### 安全与错误处理

- console 不输出 Premium cookie 内容、Telegram token 或带 cookie 的完整命令行；
- 失败日志先经过既有 `sanitizeYoutubePremiumError()`，cookie 路径和服务器数据目录继续脱敏；
- 解析/下载内部通过 `onDetail` 回调报告细节，任务服务通过 `onLog` 输出生命周期；两层都属于观测逻辑，不改变格式选择、下载或持久化结果；
- 取消会记录取消前所处阶段；失败会记录脱敏后的最终错误和累计耗时。

#### 回归覆盖

- YouTube Premium 服务测试注入日志收集器，验证入队、解析细节、解析完成、yt-dlp 启动、42%/速度进度、merging、metadata 和完成事件；
- 2608B 回归增加 console 前缀、解析细节、两种下载工作流、5%/5 秒节流断言；
- 未为了测试而请求真实 YouTube 或读取真实 Premium cookies，现有模拟下载保证日志观测不会改变任务行为。
- `node --check server/youtube-premium.js`、`node --check server.js`：通过；
- YouTube Premium 16/16、2608B 17/17、Telegram 8/8、P2P 38/38，合计 79/79 通过。

涉及文件：`server/youtube-premium.js`、`server.js`、`tests/youtube-premium.test.cjs`、`tests/features-2608B.test.cjs`、`docs/devlog/dev-2608B-features.md`。

### 7.20 2026-08-20：YouTube Premium 最小配置向导与光媒帧容量确定性修复

#### 需求边界

本轮继续处理两项需求：

1. 在 YouTube Premium 下载页提供配置向导，但只检查真正必要的配置；不修改后台原有 `/tgbot`、`/sns-cookies` 页面，不在向导中代填或保存配置；
2. 不再依赖“某一帧失败后保留上一帧”的补救方式，而是在光媒轮播开始前科学判断每类帧是否能被当前二维码库编码，从生成路径上杜绝容量异常帧进入轮播。

本文记录可公开复核的工程分析、实现和测试，不记录内部逐字思维链。

#### 1. 最小配置向导

新增只读接口 `GET /api/youtube-premium/setup-status`。接口只返回以下布尔状态：

- 私人 YouTube Premium Cookie 是否已配置，以及最后更新时间；
- Telegram Bot Token 是否已经由管理员保存；
- 歌曲分享的 Base、Pro、Ultimate 三个频道是否分别已配置，以及三项是否全部完成；
- 三个步骤是否全部完成。

接口不返回 Cookie 内容、Bot Token、Token 预览或频道值，也不执行 Telegram API，不写配置文件。

下载页新增三步向导：

1. 引导管理员打开 `/sns-cookies`，并明确说明只需要保存“私人 YouTube Premium Cookie”，不要求填写其它 SNS Cookie；
2. 引导管理员打开 `/tgbot` 手动保存 Bot Token，明确说明向导不会读取、填写、修改或自动配置 Token；
3. 引导管理员仍在 `/tgbot` 中只配置歌曲分享的 Base、Pro、Ultimate，备份频道、文件大小等不属于本向导必要项。

向导打开时每 2.5 秒轮询只读状态，也提供“立即检测”。检测通过后：

- 当前步骤和对应配置项显示绿色勾选；
- “下一步”按钮才会解除禁用；
- 三步全部完成后，顶部按钮显示“配置向导 ✓”。

私人 Premium Cookie 未配置时，首次进入下载页会主动打开第一步；已经配置 Cookie 时不强行打断正常下载操作。`pages/tgbot.html` 与 `pages/sns-cookies.html` 均未改动，向导只通过新窗口链接引导管理员使用原页面。

#### 2. 为什么此前仍会看到 `code length overflow`

光媒循环固定穿插摘要、Manifest、数据三类帧，所以“隔几帧”出现一次通常指向高频摘要帧，而不是随机故障。项目内置的 `qrcode.js 1.0.0` 有两个相互独立的处理路径：

- QR version 选择阶段使用 `encodeURI()` 估计字节长度；
- 真正写入阶段逐个读取 UTF-16 code unit 并生成 byte 数组。

对于 emoji 等补充平面字符，一对 surrogate 在前一条路径按 4 个 UTF-8 bytes 估算，在后一条路径会被旧库当成两个三字节单元，实际写成 6 bytes。于是库先选择偏小的 QR version，写入时才抛出类似 `code length overflow (4220>2960)`。

7.18 的 surrogate escape 已修正已知 emoji 触发器，但仍有两个工程缺口：

- 它仍是“生成当前帧、失败后再降级”的反应式流程，没有在启动轮播前证明摘要、Manifest 和最大数据帧全部可编码；
- `client/light-transfer.js` 当时不在 Service Worker 的显式应用壳清单中，旧缓存可能让浏览器继续执行未修复脚本。这个部署层风险会造成源码已更新、现场提示仍存在的现象。

#### 3. 确定性协议与发送前预检

新帧统一改成：

`D2L1:B<base64url(UTF-8(JSON))>`

这样送入二维码库的整帧只包含 ASCII：

- version 估算和真实写入看到完全相同的 byte 数；
- 中文、emoji、设备 ID、URL 等原始值先按 UTF-8 编码，接收端解包后严格恢复；
- `parseFrame()` 仍兼容旧的 `D2L1:{JSON}`，因此更新后的接收端可以继续识别旧发送端正在进行的任务。

Base64URL 外层会增加字符数，但字符数变得确定且可以预先验证。发送器现在针对所选距离模式，在第一帧显示前使用项目实际的 `qrcode.js` 做容量预检：

- 摘要：同时验证网络入口开启/关闭，普通摘要放不下时在轮播前选择精简摘要；
- Manifest：使用最长分片、最大分片索引位数构造上界帧；
- 数据：使用最大数据块数量、最大块索引位数和完整 payload 构造上界帧；
- 纠错等级按当前模式首选等级向下验证；数据帧必要时在轮播前减少每帧块数；
- 只有摘要、Manifest、数据三类上界都通过真实编码器后，模式方案才进入轮播并缓存复用。

由于新协议始终进入同一个 QR byte mode，容量只由 ASCII 帧长度决定；实际帧不会比对应上界探针更长。因此运行时不再存在“先展示轮播、过几帧才发现容量不够”的路径，原“当前帧容量异常，已保留上一帧”提示及其事后重试代码已删除。若二维码库发生与容量无关的意外异常，轮播会暂停并明确报告“二维码渲染器异常”，不会把它伪装成容量问题。

另外把 provider device ID 限制为 120 字符，标题按 Unicode code point 截断；精简摘要在无法形成紧凑 provider descriptor 时不携带可能无限增长的直连 URL。这些是对摘要输入上界的额外约束。

#### 4. 缓存更新

- Service Worker 缓存从 `instant-tunnel-v25` 升级到 `instant-tunnel-v26`；
- `/client/light-transfer.js` 加入 `APP_SHELL`，安装新 Worker 时显式刷新并缓存；
- 激活阶段继续删除旧版本缓存并立即接管客户端。

这保证部署后不会因为旧 Service Worker 缓存继续运行上一版光媒发送代码。

#### 5. 回归验证

语法检查：

- `node --check server.js`：通过；
- `node --check client/light-transfer.js`：通过；
- `node --check service-worker.js`：通过；
- 提取并编译 `pages/youtube-premium-dl.html` 内联脚本：通过。

行为测试：

- 配置向导测试确认只链接 `/sns-cookies`、`/tgbot`，向导内没有 Cookie/Token/频道输入框或写接口；
- 状态接口测试确认只读取 Premium Cookie、Token 是否存在和三级频道布尔状态，不读取 Cookie 内容、不返回 Token 预览、不调用 Telegram API；
- 向导轮询、绿色完成态和“当前步骤未通过时禁用下一步”均有回归断言；
- VM 中加载项目实际 `client/qrcode-1.0.0.min.js`，旧 Unicode JSON 帧稳定复现 overflow；
- 新帧严格匹配 ASCII `D2L1:B[A-Za-z0-9_-]+`，Unicode 标题往返无损，旧 JSON 帧仍可解析；
- 使用长 emoji/中文标题、超长隧道/消息字段、完整 Manifest 分片和 1025B 数据，分别对远距离、常规距离、近距离建立安全方案；三种模式的摘要、Manifest、数据帧均由实际二维码库成功生成；
- 源码回归确认“当前帧容量异常”提示已不存在，Service Worker 缓存版本和应用壳资源已更新。

完整相关回归：

- `tests/features-2608B.test.cjs`：18/18；
- `tests/youtube-premium.test.cjs`：16/16；
- `tests/telegram-cover-regression.test.cjs`：8/8；
- `tests/p2p-connection-regression.test.cjs`：38/38；
- 合计：80/80 通过。

本地测试没有使用真实 Premium Cookie、Telegram Token 或频道执行外部操作；这轮验证覆盖的是配置边界、轮询逻辑、真实内置二维码库容量行为及现有 YouTube/Telegram/P2P 回归。

涉及文件：`server.js`、`pages/youtube-premium-dl.html`、`client/light-transfer.js`、`service-worker.js`、`tests/features-2608B.test.cjs`、`docs/devlog/dev-2608B-features.md`。

### 7.21 2026-08-21：Telegram 配置保存与 Webhook 注册彻底解耦

#### 问题

多个测试服务器使用同一个 Telegram Bot Token 时，只要在任意服务器的 `/tgbot` 页面点击“保存配置”，旧实现就会根据当前请求域名自动执行 `setWebhook`。Telegram 每个 Bot 同时只能注册一个 Webhook，因此后保存配置的测试域名会抢占原生产域名，造成 Bot 更新改投其它服务器。

进一步检查发现，旧保存路径还有两个隐含 Webhook 副作用：

- 每次保存都会生成新的 `webhookSecret`，使已经注册的旧回调路径立即失效；
- 清空 Token 时会自动调用 `deleteWebhook`。

所以只把 `setWebhook` 调用删掉并不足够；配置保存必须同时停止 secret 轮换、Webhook 删除和 Bot 命令同步，才能保证“保存本地配置”不会改变 Telegram 当前投递目标。

#### 实现

`POST /api/telegram/config` 现在只负责：

- 解析和校验页面提交的 Token、文件上限、备份目标、Base/Pro/Ultimate；
- Token 存在时继续通过 `getMe` 做无状态有效性校验；
- 保存本地 `telegram-bot.json`；
- 始终保留已有 `webhookSecret`，包括编辑或清空 Token 的情况；仅全新配置且没有 secret 时才生成本地回调 secret；
- 返回 `webhookUnchanged: true`。

该路由不再包含 `setWebhook`、`deleteWebhook` 或 `setMyCommands`。

新增独立管理员接口：

- `GET /api/telegram/webhook-config`：显式调用 Telegram `getWebhookInfo`，只返回脱敏后的目标地址、待处理更新数和最近错误；回调路径中的 secret 替换为 `***`；
- `POST /api/telegram/webhook-config`：只有管理员明确操作时，才把 Webhook 设置到本次请求对应的服务器域名。成功后同步 Bot 命令，并复查 Telegram 当前 Webhook；命令同步或复查失败会单独报告，不把已经成功的 Webhook 设置误报为完全失败。

`/tgbot` 页面新增独立“Webhook 管理”面板：

- 保存按钮文案明确提示“现有 Webhook 未被修改”；
- 显示当前页面域名和 Telegram 实际 Webhook 的脱敏目标；
- 提供“检查当前 Webhook”和“设置 Webhook 到当前服务器”两个独立按钮；
- 没有 Token 时禁用设置按钮；
- 点击设置前必须确认，并明确警告：如果 Bot 正由另一个服务器使用，原服务器将停止收到新的更新；
- 页面初始化先读取本地配置，再查询 Telegram Webhook，避免 Token 状态读取竞态；
- 页面不存在任何自动 POST Webhook 的初始化或配置保存路径。

#### 安全与多服务器行为

- 服务器返回的 Webhook 地址不会暴露 secret；
- Token 和 Webhook secret 仍只保存在服务器配置文件；
- 测试服务器可自由保存相同 Bot 的频道或其它本地配置，不会影响生产服务器；
- 只有管理员在目标服务器上确认“设置 Webhook 到当前服务器”，Telegram 的唯一投递目标才会发生切换；
- 清空某台服务器的本地 Token 也不会远程删除 Bot 当前 Webhook。

#### 回归覆盖

- 静态路由隔离测试确认配置保存段不包含 `setWebhook`、`deleteWebhook`、`setMyCommands`；
- 确认配置保存保留 `currentConfig.webhookSecret` 并返回 `webhookUnchanged: true`；
- 确认只有独立 Webhook POST 接口调用 `setWebhook` 和命令同步；
- 页面测试确认设置按钮初始禁用、保存提示不再宣称自动注册、切换前存在域名影响确认，并且 POST 只出现在独立按钮事件中；
- `node --check server.js` 与 `/tgbot` 内联脚本编译通过；
- `tests/features-2608B.test.cjs`：19/19；
- `tests/youtube-premium.test.cjs`：16/16；
- `tests/telegram-cover-regression.test.cjs`：8/8；
- `tests/p2p-connection-regression.test.cjs`：38/38；
- 四组相关回归合计：81/81 通过。

涉及文件：`server.js`、`pages/tgbot.html`、`tests/features-2608B.test.cjs`、`docs/devlog/dev-2608B-features.md`。

### 7.22 2026-08-21：YouTube Music 群星专辑的 Album artist 语义修复

#### 现象与根因

当歌曲所属专辑没有单一专辑作者、中文 YouTube Music 显示为“群星”时，下载成品的 `album_artist` 却被写成当前歌曲的 `artist`。

根因不是 yt-dlp 写标签，而是本地元信息链存在三次主动回填：

1. `buildYoutubeSongMetadata()` 在 `album_artist/album_artists` 为空时使用 `|| artist`；
2. SNS/Premium 歌曲成品处理再次使用 `providedMetadata.artist` 兜底；
3. 手工编辑歌曲元信息时，`normalizeEditableSongMetadata()` 又使用 `artist` 兜底，因此管理员即使清空 Album artist，保存后仍会恢复成歌曲艺人。

Track artist 与 Album artist 是两个独立语义。合辑中的歌曲艺人只能说明这一首歌的表演者，不能据此推断整张专辑的作者。

#### 修复规则

在 `server/youtube-premium.js` 新增可独立测试的 `resolveYoutubeAlbumArtist()`：

- `album_artist` 或非空 `album_artists` 明确存在时保留原值；
- `Various Artists`、`Various`、`V.A.`、`群星` 这些等价写法统一输出中文 `群星`；
- 已知存在 `album_artist/album_artists` 字段，但值为 `null`、空字符串或空数组，并且歌曲有专辑时，解释为无单一专辑作者，输出 `群星`；
- `compilation`、`is_compilation`、`album_is_compilation` 或 `album_type=Compilation` 同样输出 `群星`；
- 如果上游完全没有提供专辑作者字段，也没有 compilation 信号，则保持空白，表示“未知”，不再猜成歌曲艺人；
- 没有专辑时保持空白。

该解析器现在统一用于：

- YouTube Premium/SNS 歌曲元信息构建；
- 下载页参考信息和源语言参考字段；
- YouTube Music 专辑搜索查询与候选排序；群星专辑会优先匹配 `Various Artists` 候选，不会按当前歌曲艺人误匹配；
- 服务端 Premium 抓取完成日志中的 `albumArtist`。

后续写成品和手工编辑路径已删除歌曲艺人兜底：

- `providedMetadata.album_artist/albumArtist` 不存在时写空值；
- 手工编辑输入空 Album artist 会保持为空；
- ffmpeg 最终标签不会再由后置处理重新填入 Track artist。

#### 回归验证

专项行为测试覆盖：

- `album_artist: null` + Track artist → `群星`；
- `album_artists: []` + Track artists → `群星`；
- `Various Artists` → `群星`；
- 明确的普通 Album artist 原样保留；
- 完全未知的 Album artist 保持空白；
- compilation 标记 → `群星`；
- 相同专辑名候选中，`Various Artists` 排在当前 Track artist 候选之前；
- 静态回归确认元信息构建、成品处理、手工编辑三个路径都不再以歌曲 artist 回填 `album_artist`。

执行结果：

- `node --check server.js`、`node --check server/youtube-premium.js`：通过；
- `tests/features-2608B.test.cjs`：20/20；
- `tests/youtube-premium.test.cjs`：17/17；
- `tests/telegram-cover-regression.test.cjs`：8/8；
- `tests/p2p-connection-regression.test.cjs`：38/38；
- 四组相关回归合计：83/83 通过。

测试没有请求真实 YouTube Music 页面或修改已有下载文件。已有错误标签的成品需要重新抓取，或者在“编辑歌曲元信息”中将 Album artist 改为“群星”/清空并重新保存。

涉及文件：`server/youtube-premium.js`、`server.js`、`tests/youtube-premium.test.cjs`、`tests/features-2608B.test.cjs`、`docs/devlog/dev-2608B-features.md`。

### 7.23 2026-08-22：YouTube Premium 普通单艺人专辑 Album artist 缺失回归

#### 现象与根因

现场链接：`https://music.youtube.com/watch?v=XnWxihjgR-E`。该音乐条目存在所属专辑，专辑也存在明确作者，但抓取后的成品元数据 `album_artist` 为空。

根因与 7.22 的“群星”修复直接相关。7.22 为避免把合辑中某一首歌的 Track artist 无条件写成 Album artist，删除了原先的 `artist -> album_artist` 后置回填，并规定：当 yt-dlp 完全没有提供 `album_artist/album_artists` 字段时保持空白。这个规则对群星专辑是安全的，但对 YouTube/YouTube Music 的另一种真实返回形态过于保守：部分普通单艺人专辑的单曲 JSON 有 `album + artist`，却根本不包含 Album artist 字段，因此最终被留空。

需要区分两种此前容易混淆的情况：

- **字段明确存在但为空**：沿用 7.22 语义，仍视为“没有单一专辑作者”的上游信号，写 `群星`；
- **字段压根不存在**：不能再直接判定未知。若该条音乐只有一个明确主艺人，则可作为普通单艺人专辑的受限兜底；多艺人仍不猜。

#### 修复规则

`server/youtube-premium.js`：

- 新增 `getSingleYoutubeTrackArtist()`，只读取 yt-dlp 的结构化 `artists[]/artist`，不拿 uploader/channel 代替专辑作者；
- `resolveYoutubeAlbumArtist()` 调整为以下优先级：
  1. 非空 `album_artist/album_artists`：直接使用，Various Artists 等仍归一为 `群星`；
  2. `album_artist/album_artists` 字段明确存在但为空：仍为 `群星`，不撤销 7.22 的保护；
  3. 明确 `compilation/is_compilation/album_is_compilation/album_type=Compilation`：仍为 `群星`；
  4. Album artist 字段完全缺失，且 `artists[]/artist` 去重后恰好只有一个主艺人：用该艺人补 `album_artist`；
  5. Album artist 字段缺失但存在多个不同主艺人：继续留空，避免把协作歌曲或不确定合辑错误归属给某一个艺人。
- `server.js` 的下载、ffmpeg 写标签、手工编辑链路不做重新回填；它们继续只消费 `resolveYoutubeAlbumArtist()` 的最终结果，因此没有重新引入 7.22 已删除的无条件 Track artist 覆盖。
- `rankYoutubeMusicAlbumCandidates()` 也会自然得到这个受限的单艺人 fallback，因此普通专辑的专辑搜索排序不再因为 Album artist 字段缺失而丢失艺人相关度。

#### 回归与验证

新增 `tests/youtube-album-artist-regression.test.cjs`，覆盖：

- `XnWxihjgR-E` 对应的“有 album、无 Album artist 字段、单一 artist”数据形态必须得到单一艺人；
- `artists[]` 重复同一艺人仍视为单一艺人；
- `album_artist: null`、`album_artists: []`、`Various Artists`、明确 compilation 仍得到 `群星`；
- Album artist 字段缺失且存在两个不同主艺人时保持空白；
- 明确的普通 Album artist 始终优先，不被 Track artist 覆盖。

本地对上述纯函数边界执行 8 个断言，结果 `8/8 passed`。当前执行环境没有可用的真实 Premium Cookie/yt-dlp 联网链路，因此没有伪称重新在线抓取 `XnWxihjgR-E`；该链接仍需要在部署该提交后的实际 Premium 环境重新抓取，确认上游返回形态与现场一致并检查最终 M4A 标签。

涉及文件：`server/youtube-premium.js`、`tests/youtube-album-artist-regression.test.cjs`、`docs/devlog/dev-2608B-features.md`。
