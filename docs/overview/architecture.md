# 系统架构、运行边界与数据所有权

> **源码基线 Commit**：`10ebe1000b9bd57097f90e51337a251ba17734f3`  
> **文档更新时间**：`2026-10-17`
> 本文按当前合入实现区分隧道基础审计的 sql.js、网盘元数据的原生 SQLite WAL、独立 S3 凭据和 Telegram 外部消息。不得把已有 SQLite/S3 仍写作计划，也不得把有限兼容与多实例安全夸大成完全实现。

## 1. 整体定位

Drop2Tunnel 的核心不是“把文件统一存到服务器”，而是把浏览器设备组织进一个逻辑隧道，让隧道中的内容、文件资产和协同状态可以在多设备间流动。随着项目演进，Node 服务又承担了 Telegram、SNS 下载、转码、VClient、后台审计等服务器能力，因此当前系统属于“浏览器本地状态 + Node 协调/中继 + 外部服务/缓存节点”的混合架构。

最初需求反复强调两个方向：

1. 设备之间应尽量直接传输，尤其大文件不应天然依赖中心服务器；
2. 即使 P2P 失败，也必须有可用的降级路径和恢复来源，不能因为理想化 P2P 设计牺牲可用性。

这也是当前“P2P 优先、Socket.IO Relay 降级、server asset / Telegram / VClient 作为特定场景来源”的根本原因。

## 2. 主要运行组件

### 2.1 Browser 主应用

主入口：

- `pages/index.html`
- `app.js`

`app.js` 仍是最大的前端编排器，负责：

- 路由页与隧道进入；
- IndexedDB 初始化；
- Socket.IO 生命周期；
- WebRTC PeerConnection / DataChannel；
- 传输记录与历史协调；
- 文件预览、音乐播放器、资源管理器；
- 富文本协同；
- 联系人、附近设备、邀请；
- 实时媒体入口；
- PWA / 移动三栏 / 主题；
- 网页工坊与 Telegram 网盘等模块的集成入口。

近年来新增的大功能已经逐步移入 `client/*`，但不能假设 `app.js` 已经只是薄壳。修改子模块时仍应搜索 `app.js` 是否保存了入口、状态、历史栈、缓存恢复或 Socket 事件。

### 2.2 Node 主服务

主入口：

- `server.js`

职责包括：

- Express 静态页面和 HTTP API；
- Socket.IO；
- 隧道短码、历史协调、权限与设备状态；
- 文件资产供源/Relay；
- Telegram Bot、Telegram 网盘、Telegram 内容管理；
- SNS / YouTube Premium；
- server asset；
- 音轨修复；
- FFmpeg 视频转码；
- VClient 控制面；
- 管理员认证和后台；
- 运行时配置、PWA Manifest、数据占用等。

大型子系统逐渐拆到 `server/*`，但 `server.js` 仍保存大量路由、队列、Telegram/SNS 集成和 Socket 处理。

## 3. 当前模块边界

### 3.1 文件资产链路

主要实现：

- `client/file-assets.js`
- `server/file-assets.js`
- `app.js`

浏览器侧 `FileAssetTransfer` 负责请求、分片、传输和进度；服务器维护在线供源索引、provider 候选、receiver load、assignment 和 Relay 生命周期。

Socket 事件至少包括：

- `file-asset-discovery`
- `file-asset-manifest`
- `file-asset-request`
- `file-asset-available`
- `file-asset-unavailable`
- `file-asset-relay-start/chunk/complete`
- `file-asset-transfer-status`

旧的 `file-offer/file-answer` 仍存在于主应用，后续修改不能仅根据事件名判断哪条链路已经完全废弃。

### 3.2 实时媒体

主要实现：

- `client/media.js`
- `server/media-session.js`
- `app.js`

包含摄像头广播、群语音、对讲机、联系人语音通话、远程预览控制等。它们共享 WebRTC / ICE 概念，但并不是一个完全相同的状态机。

### 3.3 Telegram 网盘

主要实现：

- `server/disk-api.js`
- `server/telegram-drive.js`
- `server/disk-telegram.js`
- `server/disk-auth.js`
- `server/disk-operations.js`
- `server/disk-shares.js`
- `server/disk-collaboration.js`
- `server/disk-part-cache.js`
- `client/disk-client.js`
- `client/disk-collaboration.js`
- `client/disk-ui.js`
- `client/disk-tunnel-adapter.js`
- `client/disk-share.js`
- `client/disk-management.js`

这是独立于“隧道浏览器文件缓存”的服务器托管能力，底层实际文件实体主要在 Telegram，Node 维护逻辑索引、操作状态和临时缓存。

当前还包含文件/目录级协同 capability：所有者可创建一次性邀请，把单文件或某个目录子树开放给指定成员；服务端在每次请求时重新校验 collaboration scope。它与隧道富文本的 `collaborativeEdit` 权限不是同一套机制。

### 3.4 网页工坊

主要实现：

- `client/web-workshop.js`
- `client/web-zip-runtime.js`
- `pages/web-zip-preview.html`
- `pages/web-workshop-guide.html`
- `service-worker.js`
- `app.js`

它不是普通 ZIP 预览器，而是把 `.html.zip` 解包成浏览器虚拟运行目录，并允许草稿编辑、预览、发布、更新原记录和资源导入。

### 3.5 下载与转码

主要实现：

- `server/sns-downloader.js`
- `server/youtube-premium.js`
- `server/audio-track-repair.js`
- `server/video-transcode.js`
- `pages/sns-dl.html`
- `pages/youtube-premium-dl.html`
- `pages/video-transcode.html`
- `client/audio-track-repair.js`
- 浏览器成品缓存模块。

截至当前基线，已完成下载的视频任务可以把“任务 ID / 来源类型”作为安全定位参数传到视频转码页，由服务端定位原下载缓存作为输入，不要求浏览器重新上传。

### 3.6 VClient

主要实现：

- `vclient/index.js`
- `vclient/runtime.js`
- `vclient/cache-store.js`
- `server/vclient-control.js`
- `scripts/vclient-push.js`
- `pages/vclient.html`

它是独立进程式缓存节点，不等于普通浏览器页面。服务器通过控制面记录某个隧道是否希望启用 VClient、节点心跳及缓存状态。

## 4. 数据所有权与持久化

### 4.1 浏览器 IndexedDB

当前浏览器承担大量真正的用户态数据。

主应用 IndexedDB 包括：

- session；
- message；
- file；
- editor；
- 其它随版本演进添加的对象存储。

此外还有独立数据库，例如：

- 网页工坊 `TunnelWebWorkshop`：`drafts`、`sandboxes`；
- 网页 ZIP Runtime `TunnelWebZipRuntime`：虚拟运行目录；
- Telegram 网盘浏览器缓存；
- SNS / YouTube Premium 成品缓存；
- CacheStore 的 IndexedDB / OPFS 驱动。

这意味着“服务器有传输记录”不等于“服务器拥有全部文件字节”。很多正常文件仍以浏览器副本为主要来源。

### 4.2 `.tunnel-data/infra.sqlite`

当前 `server/infra-store.js` 使用 **sql.js**。它在启动时把数据库读进 WASM 内存 DB，修改后通过 `db.export()` 把整个数据库重新写回文件；因此它虽然是 SQLite 文件格式，但不是原生长连接 SQLite WAL 数据库。

当前表包括：

- `tunnels`
- `devices`
- `tunnel_members`
- `transfer_records`
- `transfer_files`
- `file_assets`
- `asset_transfer_events`
- `vclient_tunnels`
- `vclient_asset_states`

用途主要是服务端基础设施审计、短码、设备/成员、传输记录和文件资产审计、VClient 状态。

历史上曾发生“高频审计写入导致整个 sql.js DB 频繁 export、拖慢实时传输”的回归。因此当前架构的重要原则是：

> 实时传输/广播链路优先完成，审计写入作为旁路批量处理，不能让持久化审计阻塞实时协议。

### 4.3 Telegram 网盘 SQLite WAL、Content 与外围文件

网盘当前由 `server/disk-repository.js` 的 `node:sqlite` / `DatabaseSync` 操作 `.tunnel-data/disk.sqlite`，开启 WAL、外键、busy timeout 和 FULL 同步；区别于上节 `infra.sqlite` 的 `sql.js` 整库 export。Node 最低版本已提升至 **24.15**。当前 SQLite schema 6，承载用户/应用/分区、文件/目录、协同与 Mount、共享 Content/Anchor/引用、分享/静态签名、任务、回收站、用户设置、待转存等实体。

Logical File 是网盘用户/分区内的逻辑名称和权限实体，Content Object 表示可共享且已验证的正文，Telegram Anchor 代表远端消息与分片定位；必须分别检查引用、所有权、持有证明（PoP）、租约和清理状态。SQLite 元数据短事务不能涵盖 Telegram 网络操作；未知发送结果依靠 staging manifest、outbox、补偿及恢复状态处理。版本差量与唯一约束不会自动提供跨 Node 进程业务分布式锁。

旧 JSON 索引不再是运行时权威数据；`tools/migrate-tgdisk-json-to-sqlite.cjs` 是独立停服离线导入工具。运行中的数据库应走在线备份，不应单独复制不含 WAL 的主文件。`disk-secret.key`、S3 `s3-credentials.json` / `s3-secret.key`、Telegram Chat 字典、上传 staging、缓存二进制等仍在独立文件系统中。

S3 网关通过 `server/s3/*`、`server/object-storage.js` 直接复用网盘对象核心，`/S3API` 和原生 `/api/telegram/disk/v1` 为不同协议入口；前者为有限 SigV4 子集，不等于完整 AWS S3。协同 Mount 通过来源授权实时解析，普通浏览并不自动复制 Content；跨 Scope Copy 和某些移动使用显式事务/恢复边界。


### 4.4 Telegram

Telegram 在不同子系统中扮演不同角色：

- Bot 入站内容入口；
- Telegram 网盘实际持久文件实体；
- 隧道历史文件的恢复兜底来源；
- SNS / YouTube 下载成品的指定目标转发；
- Telegram 内容管理页的 Chat / Message 后端。

同一个 `file_id` 不应脱离 Bot 身份理解；历史需求明确处理过换 Bot 后 `file_id` 失效及重新上传换绑。

### 4.5 文件系统

`.tunnel-data` 还保存：

- 管理员 TOTP / session secret；
- SNS / YouTube cookies；
- 下载工作目录与缓存；
- Telegram 网盘 staging；
- Telegram 分片 Range cache；
- video-transcode 工作区；
- 日志；
- VClient 控制 token；
- 各种临时资产。

不能把整个 `.tunnel-data` 都理解成“数据库”。

## 5. 网络与传输层

### 5.1 Socket.IO

Socket.IO 同时承担：

- 隧道 join / history / metadata；
- WebRTC signaling；
- P2P 不可用时的文件 Relay；
- editor asset relay；
- device / nearby / invite；
- permissions；
- realtime media signaling；
- 部分 server asset / SNS 调度通知。

生产部署历史最终收敛为 HTTP/HTTPS 与 Socket.IO 可以经同域名、同反向代理入口工作，不再要求额外独立 Socket 域名。

### 5.2 WebRTC

文件与媒体都用 WebRTC，但目的不同：

- 文件：DataChannel；
- 实时摄像头/语音：MediaStream；
- 联系人通话与远程控制又有额外服务端状态机。

P2P 历史回归极多，尤其涉及：

- ICE candidate；
- 代理/VPN 多网卡；
- offer 重复；
- P2P 完成 ACK 与 Relay fallback 竞态；
- 多源分片进度；
- 旧任务残留。

任何改动应优先运行 P2P regression 测试并阅读相关 Devlog，而不是重写“看起来更干净”的流程。

## 6. UI 状态与浏览器历史

当前大量全屏/浮层 UI 都使用 `history.pushState/popstate` 管理返回行为，例如：

- 文件预览；
- 合辑；
- 全屏媒体；
- 音乐播放器；
- 网盘；
- 资源管理器；
- 网页工坊；
- 移动端三栏。

历史上多次发生“关闭子浮层却把父网盘一起关掉”“重复 history.back() 跳回旧目录”等问题。因此新增或修改浮层时，应明确：

1. 谁负责 pushState；
2. close 是否调用 history.back；
3. popstate 是否只消费自己拥有的状态；
4. 子层关闭是否保留父层；
5. PC / Android back gesture 是否一致。

## 7. Service Worker 与版本缓存

`service-worker.js` 不只是离线壳层，它还参与网页 ZIP Runtime。

高风险点：

- 新版本 SW 已安装但旧标签页仍由旧 controller 控制；
- CDN / 静态缓存让 `app.js` 或 Runtime 混跑；
- 预缓存某个资源失败导致 install 整体失败；
- 网页 ZIP 虚拟路径只能由兼容 Runtime 协议的 SW 正确响应。

当前 WebZip Runtime 会：

- 注册 `/service-worker.js`，`updateViaCache: 'none'`；
- 主动通知 waiting worker activate；
- 等待 controllerchange；
- ping controller，要求 Runtime protocol 和 external-script MIME 能力；
- 对虚拟目录入口实际 fetch，并检查 `X-Web-Zip-Runtime: 1`。

因此“第一次预览失败，刷新后成功”不能简单归因于 ZIP 内容错误，必须同时检查 SW controller 和缓存版本。

## 8. 当前与未来架构的明确区分

**已经实现**：SQLite WAL Repository、离线 JSON 导入、共享 Content Object/PoP/GC、渐进上传和 SSE、S3 有限网关及凭据管理、分区与协同 Mount、回收站与 COW 编辑、静态签名、多账号和待转存恢复。详细的状态机与限制应读 `telegram-drive.md` 及 `docs/telegram-drive-content-objects.md`。

**仍有限制或需外部验收**：完整 AWS S3 Multipart/ACL/SSE 功能、多实例实时视图与分布式锁、Telegram 未知请求结果下的严格 exactly-once、实际 FolderSync / Android / 公网代理吞吐及生产迁移。其它分支提案或 Idea 不可作为已合入功能。

## 9. 后续 AI 修改代码时的最低检查清单

涉及核心链路时至少检查：

- 当前源码调用链，而不是只读旧 README；
- 最新 Devlog；
- 对应 Prompt 中最后一次人工验收；
- Git Log 是否有 “WRONGCODE / 有BUG / 待测 / 验收通过”；
- 是否有相关 regression test；
- 是否影响 Service Worker cache version；
- 是否影响浏览器 IndexedDB schema；
- 是否影响 history/popstate；
- 是否影响 P2P / Relay fallback；
- 是否让服务器审计/持久化进入实时链路；
- 是否混淆“服务器元数据”和“文件字节真实来源”。

## 10. 2026-10-13—17 新模块、签名成员及资产所有权

### 10.1 独立媒体收藏的三重存储边界

`/media-library` 由 `server/media-library/index.js` 注册，`server/media-library/routes.js` 负责后台受保护 HTTP API。独立 `media-library.sqlite` 保存会话、任务、帧、候选、收藏、账号/授权和事件，`server/media-library/cache.js` 保存专属工作区中间字节；正式收藏才通过 `server/media-library/disk-adapter.js` 接入网盘的 Logical File/Content Object。FFmpeg 可使用仅监听 loopback 的临时资源地址读取已授权来源。**不得把独立媒体任务 DB、网盘 SQLite、原 infra.sql.js 合并成同一数据所有权模型**。

### 10.2 新的隧道访问身份

服务端 `server/tunnel-access.js` 用稳定的 `sessionId + deviceId` 签名凭据控制已加入成员，而短码用于新设备登记、可由拥有权限者轮换；`.tunnel-access.key` 与 `.tunnel-access-members` 是持续访问所需的服务端持久材料。凭据缺失、账本异常都不能退回“只知道 ID 就能加入”的旧隐式行为。磁链是仅限指定资产的 capability，不能被提升成普通会话成员。

### 10.3 管理后台与服务端转发

`server/admin-layout.js` 和 `pages/admin-layout.html` / `client/admin-layout.js` 以受限页面白名单组织后台导航；磁链登记持久化在 `infra.sqlite`，不是内存热缓存的自然寿命。Telegram 多目标转发另由 `server/telegram-forward-jobs.js` 维护确认、进度、取消与可能的撤回，未知远端结果不能宣称 exactly-once 或已经撤回。

### 10.4 页面资源结构

主 UI 原大量内联 CSS 已迁到 `client/index.css`，`pages/index.html` 仍提供 DOM，`app.js` 继续编排。业务页面已有独立 `client/media-library.js/.css`、`audio-track-repair.css`、`admin-layout.js/.css` 等资源；部署构建和 Service Worker 的版本/哈希需同步检查，但后台专用页面不应机械塞进前台 app shell。
