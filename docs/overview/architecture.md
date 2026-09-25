# 系统架构、运行边界与数据所有权

> **源码基线**：`dev/2609-s1@b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> 本文描述当前实现事实，并补充可从历史 Prompt、Devlog 和 Git Log 追溯出的设计初衷。规划中的 SQLite WAL 网盘重构、S3 Compatible API 等必须与当前实现区分。

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
- `server/disk-part-cache.js`
- `client/disk-client.js`
- `client/disk-ui.js`
- `client/disk-tunnel-adapter.js`
- `client/disk-share.js`
- `client/disk-management.js`

这是独立于“隧道浏览器文件缓存”的服务器托管能力，底层实际文件实体主要在 Telegram，Node 维护逻辑索引、操作状态和临时缓存。

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

### 4.3 Telegram 网盘 JSON

截至本基线，Telegram 网盘的共享权威元数据仍主要是 JSON / 文件系统持久化，而不是 `disk.sqlite` WAL。

已知包括：

- `telegram-drive-index.json`
- `telegram-drive-directories.json`
- `disk-auth.json`
- `disk-operations.json`
- `disk-shares.json`
- `disk-spaces.json`
- `disk-space-usage.json`
- `telegram-chunk-file-ids.json`
- `telegram-part-cache/.owners.json`
- 以及上传 staging / manifest、占位 file_id 等辅助状态。

`prompts/dev-prompt-logs/dev-tgdisk-json2sqlite-WAL-transaction-260915.md` 与 `QA-of-tgdisk-json2sqliteWAL.md` 已规划未来迁移到原生 SQLite WAL / Repository / Adapter，但 **当前分支尚未实现**。后续 AI 不得把规划文档当成现状。

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

以下在基线中属于**当前能力**：

- 多设备隧道；
- 浏览器缓存 + P2P + Relay；
- Telegram 网盘；
- 网页工坊；
- SNS / YouTube Premium；
- 视频转码；
- VClient；
- Telegram 内容管理。

以下属于**规划/设计材料，不能当成已经实现**：

- Telegram 网盘共享 JSON 全面迁移 `disk.sqlite` WAL；
- Repository / Database Adapter 完整替换当前网盘 JSON Store；
- S3 Compatible Gateway；
- 更完整的多实例数据库/分布式业务锁；
- 260925 后提出但尚未合入当前源码基线的协同网盘目录/文件邀请等需求。

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
