调研我最近开发的项目（github: Ltre/file-tunnel）。自己拿去给别人测试，发现如果这个应用被作为主体app使用去推广的话，没什么人用。于是我重新考虑软件的产品定位：考虑作为第三方寄生，可以将万物转发到自己的隧道，可以收藏隧道中的任何内容（保存到自己的存储库），且能将自己存储库或隧道的内容转发到别的任何平台。 你有什么高见？请深度调研




你的判断是对的：**Ltre/file-tunnel 不适合继续以“一个让别人专门打开来用的主体 App”推广**。它更像一个底层能力很强的“内容交换内核”，真正可行的产品壳应该是：

> **个人内容中转层 / Universal Share Router**
> 从任何 App 收进来 → 临时进入隧道 → 可长期收藏进个人库 → 再转发到任意设备、任意 App、任意平台。

我建议你把“隧道”从产品中心降级为**传输通道**，把“分享入口 + 内容库 + 转发出口”升级为产品中心。

---

## 1. 为什么作为主体 App 推不动

你现在 README 的定位是“安全、快速、去中心化的设备间文件传输和协同编辑工具”，核心入口是二维码、会话 ID、多设备加入、聊天、文件传输、协同编辑、本地 IndexedDB。

问题在于：普通用户没有“我要打开一个传输隧道 App”的心智。

他们真实的触发场景是：

“我在微信/浏览器/相册/文件管理器/Telegram/小红书/ChatGPT/邮箱里看到一个东西，想立刻扔到电脑、手机、资料库、另一个平台。”

也就是说，用户不是从你的 App 出发，而是从**别人的 App** 出发。你要抢的不是“文件传输 App 市场”，而是**系统分享面板里的一个动作位置**。

LocalSend 已经把“局域网 AirDrop 替代品”做得很强：跨平台、无账号、无服务器、局域网内快速传输，官网还直接打出 “Share files without the cloud / Fast, private, offline”。([localsend.org][1]) PairDrop 也已经覆盖浏览器端跨平台文件发送、临时房间、持久配对、复杂网络下 TURN 中继、Share 菜单/右键菜单/CLI 入口。([GitHub][2]) ShareDrop 也早就主打“浏览器内 P2P，不先上传服务器”。([sharedrop.io][3])

所以你如果继续说“我也是跨设备文件传输”，会进入一个成熟、低付费意愿、强替代品密集的红海。

你的机会在于：**别人只解决 send file；你可以解决 collect → route → save → resend。**

---

## 2. 你现在代码里已经埋了新定位的种子

你的项目其实已经不是单纯文件传输了。仓库里已经有几个很有价值的内核：

第一，你已经有 PWA `share_target`。manifest 里注册了 `/share/`，可以接受 `title`、`text`、`url` 和任意文件。 Chrome 官方文档说明，安装后的 Web App 可以作为系统分享目标；接收文件时需要 `POST`、`multipart/form-data` 和 `files` 参数，并且只能有一个 `share_target`，如果要分发到多个地方，需要在分享落地页里做选择。([Chrome for Developers][4]) 这正好支持你的“入口寄生”方向。

第二，你的 Service Worker 已经拦截 `/share/` 的 POST 请求，把收到的文件写进 IndexedDB 的 `shareQueue`，然后跳回 `/?share=1`。 这说明你已经有“从系统分享面板进入隧道”的雏形。

第三，前端数据库已经有 `shareQueue` 对象仓库，启动时也会检查共享队列，并在有分享文件时进入选择目标隧道的落地流程。

第四，你已经做了“资源浏览器”：按名称/格式筛选资源，区分有引用、未引用、缓存缺失、本机缓存大小，并支持下载、清除缓存、还原、移除未引用资源。 这其实就是“个人存储库”的初级形态，只是现在还被困在“会话资源”里。

第五，你的文件资产系统已经有 provider、负载分配、请求、分块中继、多来源下载等能力。服务端 `fileAssets` 记录 provider，客户端 10MB 以上可进入 multi-source 分块下载，最多并发 range，这已经比很多简单传输工具复杂。

所以我的核心建议是：**不要重做产品，而是把已有能力重新组织成“内容中转系统”。**

---

## 3. 新定位：别叫“文件隧道”，叫“万能中转站”

我建议新的产品一句话是：

> **一个本地优先、加密、跨设备的个人内容中转站：任何 App 分享进来，任何内容都能先放进隧道或仓库，再转发到设备、联系人、网页、平台。**

更产品化一点：

> **Send to Tunnel：把任何内容先扔进你的私人中转站。**

你现在的“隧道”不要再被用户理解为房间、聊天、协同编辑，而应该被理解为：

* **临时通道**：当前在线设备之间快速互通。
* **暂存区**：我现在不知道发给谁，先扔进来。
* **个人库**：值得保留的东西收藏起来。
* **转发器**：以后从这里再发到微信、邮箱、Telegram、电脑、手机、网页、网盘、下载目录。

这比“文件传输工具”大很多，也更容易形成日常使用习惯。

---

## 4. 竞品格局：你不能正面打文件传输，但可以侧翼打“内容路由”

可以把竞品分成四类：

| 类别         | 代表                                             | 已解决        | 没解决                  | 你的机会                            |
| ---------- | ---------------------------------------------- | ---------- | -------------------- | ------------------------------- |
| 局域网文件传输    | LocalSend、Quick Share、AirDrop                  | 快速发文件到附近设备 | 不擅长收藏、二次转发、跨 App 工作流 | 不跟它们拼“快”，拼“从任何 App 进来、可沉淀、可再路由” |
| 浏览器 P2P 传输 | PairDrop、ShareDrop                             | 免安装或轻安装传文件 | 仍以“打开网页传文件”为中心       | 你做成系统分享目标和个人收件箱                 |
| 临时链接传输     | Wormhole、WeTransfer、Send Anywhere              | 链接分享、跨网络   | 内容过期或云端托管，缺少个人本地库    | 你主打本地优先、可私有部署、可转发               |
| 收藏/稍后读     | Pocket、Raindrop、Notion、Telegram Saved Messages | 收藏链接、文本、图片 | 不擅长大文件、跨设备 P2P、临时隧道  | 你做“文件级收藏 + 传输级收藏 + 转发级收藏”       |

LocalSend 的强点是“不需要账号、不需要互联网、不依赖第三方服务器、局域网高速传输”。([localsend.org][1]) PairDrop 的强点是浏览器即用、公共房间、持久配对、NAT 复杂环境 TURN 自动连接，以及从 Android/iOS Share 菜单发送。([GitHub][2]) Wormhole 的强点是 10GB、端到端加密、自动过期链接。([Wormhole][5])

你不要把自己定位到这些产品正中心。你应该定位到：

> **“Share Sheet 之后的下一站”**
> 不是替代 Airdrop，而是替代“发给自己微信/发给自己 Telegram/先存相册/先存网盘/复制粘贴到电脑”的杂乱流程。

---

## 5. 产品核心不是“万物转发”，而是“万物先进入一个可控中间层”

你说“第三方寄生，可以将万物转发到自己的隧道，可以收藏隧道中的任何内容，且能将自己存储库或隧道的内容转发到别的任何平台”。

这个方向对，但要改一句：

**不要承诺“转发到任何平台”，要承诺“把任何内容交给系统分享机制、下载机制、复制机制、链接机制、扩展机制，让它尽可能去任何地方”。**

原因是 Web 端不能自动控制微信、QQ、小红书、Instagram、Telegram、邮箱等第三方 App。Web Share API 可以调用系统分享面板，但 MDN 明确说 `navigator.share()` 必须由按钮点击等用户激活触发，而且浏览器支持并不完整。([MDN Web Docs][6]) MDN 也标注 Web Share API “Limited availability”，并且只在安全上下文可用。([MDN Web Docs][6])

所以产品承诺应该是：

* 收进来：尽量无摩擦。
* 存起来：本地优先、可加密、可清理、可还原。
* 发出去：通过系统分享、复制、下载、生成链接、设备推送、浏览器扩展、Webhook、CLI、原生插件。

这会更真实，也更可实现。

---

## 6. 新信息架构：从“会话中心”改成“内容中心”

你现在是：

> 连接 / 隧道 / 协同
> 会话 → 消息 → 文件 → 资源

建议改成：

> **收件箱 / 隧道 / 存储库 / 出口**

### 收件箱

系统分享进来的东西先进这里。用户可以马上选择：

* 发到最近隧道
* 发到指定设备
* 存入库
* 复制
* 下载
* 调用系统分享转发
* 稍后处理

这会把你的 PWA share target 价值放大。现在你的 Service Worker 主要保存文件，但 manifest 已经声明可以收 `title/text/url/files`。 下一步要把文本、链接、标题也完整保存，而不是只处理 `File`。你当前 `handleSharedFiles()` 遍历 `formData.values()` 时只收 `File`，非文件分享会被丢掉。 这是最应该立刻补的产品漏洞。

### 隧道

隧道变成临时在线传输层，不再是整个产品的主界面。它负责：

* 在线设备
* 当前通道
* 传输进度
* 临时聊天/备注
* 实时协同

### 存储库

存储库是跨会话的全局内容库。现在你的资源浏览器是“会话资源浏览器”，它统计当前 session 的资源、本机缓存和引用。 要升级成：

* 全局资源库
* 文件、图片、视频、音频、文本、链接、网页摘录、富文本
* 标签、来源 App、来源设备、来源 URL、首次进入时间、最近转发时间
* 内容 hash 去重
* 引用关系：在哪个隧道出现过、被哪些笔记/富文本/消息引用
* 是否仅本机缓存、是否已同步、是否可从其他设备还原

### 出口

出口不是一个按钮，而是一套 destination registry：

* 分享到系统分享面板
* 复制文本/链接/文件名
* 下载到本机
* 发到当前在线设备
* 发到最近设备
* 发到临时链接
* 发到 webhook
* 发到浏览器扩展
* 发到 CLI
* 发到未来的 Telegram Bot / WebDAV / S3 / OSS / Alist / 自建网盘

---

## 7. 技术架构：把“资源”抽象成全局 ContentItem

你现在的数据结构仍然偏 session/message/file。建议引入全局对象：

```js
ContentItem {
  id,
  kind: 'file' | 'text' | 'url' | 'rich' | 'image' | 'video' | 'audio' | 'folder',
  title,
  text,
  url,
  mime,
  size,
  hash,
  createdAt,
  updatedAt,

  source: {
    type: 'share_target' | 'upload' | 'paste' | 'browser_extension' | 'cli' | 'device',
    appName,
    deviceId,
    sessionId,
    originalUrl,
  },

  storage: {
    backend: 'indexeddb' | 'opfs' | 'native' | 'remote',
    hasLocalData,
    isPartial,
    cacheCleared,
    encrypted,
    chunks,
  },

  routing: {
    lastSentTo,
    sendHistory,
    pinnedDestinations,
  },

  refs: [
    { type: 'session_message', sessionId, messageId },
    { type: 'editor_asset', sessionId, editorId },
    { type: 'library_note', noteId }
  ],

  tags,
  note,
  favorite
}
```

这样你现有的 `messages`、`files`、`editorContent`、`shareQueue` 都可以逐步迁移到 `ContentItem` 体系里。

现阶段你的 IndexedDB 包括 `sessions`、`messages`、`files`、`editorContent`、`shareQueue`。 这对会话型应用够用，但对“个人库”不够，因为库不应该依附某一个 session。你需要新增：

* `contentItems`
* `contentBlobs` 或 OPFS chunk index
* `destinations`
* `routingHistory`
* `tags`
* `rules`
* `devicePairs`

---

## 8. 存储层建议：大文件不要长期堆 IndexedDB，转向 OPFS/分块

你现在大量使用 IndexedDB 存文件 ArrayBuffer。短期可以，但如果要做“个人存储库”，IndexedDB 会越来越吃力：大文件、部分下载、断点恢复、清理策略、浏览器配额、迁移都会变复杂。

MDN 对 File System API/OPFS 的描述很契合你的场景：OPFS 是 origin 私有、用户不可见的存储端点，适合持久上传器、断点上传、大文件离线、部分下载、附件缓存等。([MDN Web Docs][7])

建议路线：

* 小文本、小图、小文件：IndexedDB 直接存。
* 大文件：OPFS 分块存，IndexedDB 只存元数据和 chunk index。
* 临时分享队列：IndexedDB。
* 长期库：OPFS + hash 去重。
* 导出/下载：用 File System Access API 或普通 Blob download。
* 桌面 Chrome/Edge：可以考虑 `showDirectoryPicker()` 做“本地库目录”。
* Android/iOS：优先保持浏览器沙盒库，必要时用原生壳补能力。

---

## 9. 入口策略：先吃 Android 和桌面浏览器，不要一开始追全平台原生

你的最短路径是：

### 第一阶段：PWA Share Target

你已经实现了 60%。把它打磨成核心体验：

1. 安装 PWA 后，Android/Chrome 分享菜单出现“传输隧道”。
2. 用户从相册、文件管理器、浏览器、聊天 App 分享进来。
3. 落地页显示“收到 3 个文件 / 1 段文字 / 1 个链接”。
4. 默认动作：发到最近隧道。
5. 次级动作：存入库、选择设备、复制、下载、转发到其他 App。

Chrome 文档明确说 Web Share Target 需要安装后才会作为分享目标出现，而且一个 manifest 只能有一个 share target。([Chrome for Developers][4]) 所以这个落地页必须做成你的核心产品页，而不是一个临时提示页。

### 第二阶段：浏览器扩展

桌面端真正高频入口不是打开 PWA，而是：

* 右键图片 → Send to Tunnel
* 右键链接 → Save to Tunnel
* 选中文本 → Send to Tunnel
* 当前网页 → Save snapshot / Save URL
* 下载文件后 → Send to device

PairDrop 已经把“右键菜单、Share 菜单、CLI”作为扩展入口来做。([GitHub][2]) 你应该借鉴这个方向。

### 第三阶段：Android 原生壳

纯 PWA 的能力足够验证方向，但如果要更像系统工具，Android 原生壳价值很高：

* 原生 share receiver 更稳定。
* 后台上传/下载更可靠。
* 通知栏传输进度。
* 文件选择和 URI 权限更完整。
* 可注册更多 MIME 类型。
* 可做“保存到下载目录/相册”。
* 可绕开部分浏览器限制。

你可以用 TWA、Capacitor、React Native、Flutter 包一层，但内核继续复用 Web 页面。

### 第四阶段：Windows/macOS 托盘助手

这对你的目标用户很关键，因为很多“转给电脑”的场景需要电脑端常驻：

* 托盘接收
* 自动保存到目录
* 右键发送
* 剪贴板监听
* 局域网发现
* 作为 provider 常驻提供文件还原
* 自启动

这比继续堆 Web UI 更能改变留存。

---

## 10. 出口策略：不要幻想“直接发到所有平台”，要做多层出口

我建议把出口分为四级：

### L1：浏览器标准出口

* `navigator.share()`
* copy to clipboard
* download
* open blob URL
* QR code
* 临时分享链接

Web Share API 能把文本、链接、文件交给系统分享目标，但必须用户点击触发。([MDN Web Docs][6])

### L2：系统能力出口

* Android share sheet
* Windows share sheet
* macOS share extension
* iOS share sheet
* Save to Files / Save to Photos

这通常需要 PWA + 原生壳组合。

### L3：连接器出口

* WebDAV
* S3/OSS/R2
* Alist
* Telegram Bot
* 邮件 SMTP
* GitHub release/issue attachment
* Slack/Discord webhook
* Notion API
* 自建 API

这层才适合商业化。

### L4：自动化出口

* 规则：来自相册的图片自动进“照片中转”
* 规则：从浏览器分享的 URL 自动收藏
* 规则：超过 200MB 的文件只进隧道不进库
* 规则：来自手机的截图自动同步到电脑
* 规则：收到 `.apk/.zip/.log` 自动发到 Windows
* 规则：含某关键词的文本自动复制到电脑剪贴板

这层是高粘性来源。

---

## 11. MVP 应该砍掉什么，强化什么

你现在功能很多：文件、聊天、富文本、资源浏览器、语音、对讲机、摄像头、目录镜像、管理后台。作为技术玩具很丰富，但作为产品会让用户不知道你到底是干嘛的。

MVP 应该只保留一条主线：

> **分享进来 → 选择去向 → 完成 → 可在库里找回。**

### 立刻强化

1. **分享进来的文本、URL、title 完整入库**
   你现在 manifest 声明了 title/text/url，但 Service Worker 只处理 File。

2. **最近目标一键发送**
   分享进来后，不要让用户先理解 session。直接给：

   * 发送到：我的 Windows
   * 发送到：最近隧道
   * 存入库
   * 更多

3. **全局收件箱**
   没有在线设备时，也能先收下。现在你的逻辑会提示“已收到 N 个分享文件，请选择要发送到的传输隧道”。 这一步要升级成“已收入收件箱，可稍后发送”。

4. **全局存储库**
   从“会话资源浏览器”升级成“我的内容库”。

5. **从库二次分享**
   每个库项目都要有：

   * 发到设备
   * 发到隧道
   * 系统分享
   * 复制
   * 下载
   * 生成链接
   * 删除本机缓存
   * 永久删除记录

### 暂时弱化

* 富文本协同编辑
* 摄像头广播
* 多人语音
* 对讲机
* 管理后台
* 复杂会话统计
* 目录镜像

这些不是没价值，而是会稀释第一认知。等“万能中转站”跑通后，它们可以作为高级能力回归。

---

## 12. 一个更清晰的产品版本路线

### V0.1：万能分享入口

目标：让用户第一次觉得“这个东西终于能放进分享菜单里用了”。

功能：

* PWA 安装引导
* Share Target 收文件、文本、链接、title
* 收件箱
* 选择目标隧道
* 发到最近隧道
* 存入库
* 系统分享出去
* 复制/下载
* 基础搜索

验收标准：

* Android 从相册分享图片进来成功。
* Android 从浏览器分享 URL 进来成功。
* Android 从文件管理器分享 PDF/ZIP 进来成功。
* 桌面 Chrome 安装 PWA 后可作为 share target。
* 没有在线设备也不会丢内容。

### V0.2：个人库

目标：让用户不是只用一次，而是把它当“中转仓”。

功能：

* 全局 ContentItem
* 标签
* 来源设备/来源 App/来源 URL
* hash 去重
* 大文件 OPFS 分块
* 清理缓存但保留记录
* 从在线设备还原
* 收藏/置顶
* 最近内容
* 最近出口

验收标准：

* 找得到一周前分享进来的东西。
* 清除本机缓存后，记录还在。
* 另一台设备在线时可还原。
* 同一文件多次进入不会重复占空间。

### V0.3：持久设备配对

目标：让用户把它当“我的设备之间的通道”。

功能：

* 设备配对
* 设备别名
* 最近设备
* 默认目标
* 开机自启桌面助手
* Android 后台接收
* 通知栏进度
* 离线队列

PairDrop 的持久配对和临时房间很值得参考：它支持 6 位码/二维码配对，配对后跨网络也能发现设备。([GitHub][2]) 你也需要类似机制，否则“每次进会话”还是太重。

### V0.4：出口连接器

目标：开始商业化。

功能：

* WebDAV
* S3/R2/OSS
* Telegram Bot
* 邮箱
* Webhook
* Notion
* Alist
* 自定义 HTTP POST

收费点：

* 托管中继
* TURN 加速
* 跨网络同步
* 大文件临时链接
* 多设备库同步
* 自动化规则
* 连接器数量
* 团队空间

---

## 13. 商业化方向：不要卖“传输”，卖“私有内容工作流”

普通用户不会为“偶尔传文件”付钱，除非你做到极致免费口碑。但以下人群可能付费：

### 多设备重度用户

典型是 Android + Windows + Mac + VPS + 平板混用的人。痛点是文件、截图、链接、文本到处散。

卖点：

* 不经过微信压缩
* 不经过网盘
* 不用登录一堆平台
* 本地优先
* 可私有部署
* 大文件不怕断

### 开发者 / 运维 / 创作者

痛点：

* 手机截图发电脑
* 电脑文件发手机
* 日志、压缩包、APK、视频素材到处传
* 浏览器资料、命令、代码片段临时收藏
* 需要 CLI / webhook / API

卖点：

* CLI：`tunnel send file.zip`
* 浏览器扩展
* Webhook
* 自建服务
* OPFS/本地库
* E2EE

### 小团队 / 家庭

痛点：

* 不想建 NAS
* 不想用网盘
* 临时互传照片/视频/文件
* 想要一个家庭共享收件箱

卖点：

* 家庭空间
* 局域网优先
* 云中继兜底
* 自动过期链接
* 权限控制

### 私有部署用户

这可能是你最适合的早期商业化：

* 开源核心免费
* Docker 自托管
* Pro 版提供：

  * 管理后台
  * 多用户
  * SSO
  * E2EE 密钥管理
  * TURN 配置
  * 外部存储
  * 审计日志
  * 移动端原生壳

---

## 14. 你真正的差异化可以是“资源关系图”

你已经有“引用资源保护”的雏形：资源浏览器能区分有引用、未引用、派生副本、缓存状态。 这个方向很有潜力。

别人只是“发一个文件”。

你可以是：

> 这个文件从哪里来，被转发到哪里，在哪些隧道/笔记/富文本里出现过，本机有没有缓存，能不能从别的设备恢复，要不要长期收藏。

这会形成非常强的高级用户价值。

建议做成：

* 每个内容一张卡片
* 显示：来源、去向、引用、缓存、设备分布
* 可以查看“流转历史”
* 可以一键“重新发送到上次目标”
* 可以一键“收藏为资料”
* 可以一键“清理本机大文件但保留索引”
* 可以一键“从电脑重新拉回手机”

这就不是普通文件传输了，而是**个人内容物流系统**。

---

## 15. 最大风险

### 风险一：Web 平台能力不完整

PWA Share Target 很适合 Android/Chromium，但不能假设所有平台体验一致。Chrome 文档明确要求安装后才会显示为分享目标。([Chrome for Developers][4]) Web Share API 又要求用户激活，且不是 Baseline。([MDN Web Docs][6]) 所以你必须接受：**纯 Web 只能做验证，真正稳定要有原生壳/扩展/桌面助手。**

### 风险二：用户仍然不知道为什么要装

“传输隧道”这个名字对普通人太抽象。你要用场景文案：

* “从任何 App 发到电脑”
* “把手机里的东西先丢进中转站”
* “截图、链接、文件，先收起来，稍后再发”
* “不要再发给自己微信了”
* “跨设备临时收纳箱”

### 风险三：功能过多导致首屏失焦

你当前有聊天、富文本、设备、对讲、摄像头、文件、资源、目录等功能。作为产品要砍首屏，只留下：

* 收到什么
* 发到哪里
* 是否保存
* 是否完成

高级功能藏到二级。

### 风险四：长期存储会带来责任

只要你做“库”，就会出现：

* 浏览器清数据导致丢失
* 用户以为你云端保存
* 大文件占满空间
* 换设备找不到
* 敏感文件安全
* 服务端是否中继/存储的信任问题

所以必须在产品文案中明确：

* 本地优先
* 哪些内容只在本机
* 哪些内容可从在线设备恢复
* 哪些内容已同步
* 哪些内容已加密上传
* 清缓存不等于删除记录
* 删除记录是否影响其他设备

---

## 16. 我给你的最终判断

**应该 pivot，而且要坚决。**

不要再把它卖成：

> 即时传输隧道：设备间文件传输和协同编辑工具。

应该变成：

> 私人内容中转站：任何 App 分享进来，任何设备拿得到，任何内容可收藏，任何时候可再转发。

你的技术资产里最值钱的不是 WebRTC，也不是 Socket.IO，也不是聊天界面，而是这几个组合：

1. **Share Target 入口**
2. **本地优先资源缓存**
3. **跨设备 provider/relay 传输**
4. **资源引用与还原**
5. **会话临时性 + 库长期性**
6. **出口可扩展**

一句更狠的话：

> **“隧道”不是产品；“把所有内容先扔进我自己的中转层”才是产品。**

下一步最值得做的不是继续修大文件传输边角，而是做一个极简闭环：

> 从 Android 相册分享一张图 → 进入收件箱 → 一键发到电脑 → 同时存入库 → 电脑端可再次分享/下载/复制 → 手机端可清缓存但保留记录。

这个闭环跑顺，你的项目才从“技术演示”变成“日常工具”。

[1]: https://localsend.org/ "LocalSend: Share files to nearby devices"
[2]: https://github.com/schlagmichdoch/PairDrop "GitHub - schlagmichdoch/PairDrop: PairDrop: Transfer Files Cross-Platform. No Setup, No Signup. · GitHub"
[3]: https://www.sharedrop.io/ "ShareDrop"
[4]: https://developer.chrome.com/docs/capabilities/web-apis/web-share-target "Receiving shared data with the Web Share Target API  |  Capabilities  |  Chrome for Developers"
[5]: https://wormhole.app/ "Wormhole - Simple, private file sharing"
[6]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API "Web Share API - Web APIs | MDN"
[7]: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API "File System API - Web APIs | MDN"
