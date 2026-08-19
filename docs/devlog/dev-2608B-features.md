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
