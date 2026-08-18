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

