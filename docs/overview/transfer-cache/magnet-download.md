# Drop2Tunnel 磁链分享、种子发现与独立下载器

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 术语说明

本项目中的“磁链”是 **Drop2Tunnel 自定义的临时文件分享链接**，不是 BitTorrent 的 `magnet:?` 协议，也没有 DHT / Tracker / BT swarm。

它的核心语义是：

> 为某个隧道中的 file asset 生成一个短期 capability link，外部打开链接后，通过仍在线的 Drop2Tunnel 供源设备和现有 FileAssetTransfer 协议获取该文件。

主要实现：

- `server.js` 中 magnets registry/API；
- `pages/downloader.html`
- `pages/downloadList.html`
- `app.js` 中 `shareFileMagnet*`；
- `client/file-assets.js`

历史来源：

- `docs/devlog/dev-260625-multi-relay.md`
- `docs/devlog/dev-260625-multi-relay-step2.md`
- `docs/devlog/dev-260628-features.md`

## 2. 为什么存在

早期项目强调设备间 P2P/Relay 传输，但用户还需要：

- 把某一个已经在隧道里的文件单独分享出去；
- 接收者不需要先知道整个隧道 UI；
- 可以看到当前有没有在线“种子”；
- 下载到浏览器后形成独立本地缓存；
- 再次打开同一分享时尽量命中本机缓存。

所以“磁链”是 FileAsset 层上的可分享定位能力。

## 3. 服务端 Registry

服务端内存：

`magnets = new Map()`

当前限制：

- `MAX_MAGNETS = 1000`
- 单个 magnet asset 最大约 1 GiB；
- `MAGNET_TTL = 24h`

Magnet ID：

`crypto.randomBytes(12).toString('base64url')`

合法格式约束为 URL-safe 字符串，长度 12-64。

注意：registry 当前是进程内状态，服务重启后不会像数据库记录一样永久存在。

## 4. 创建磁链

API：

`POST /api/magnets`

输入核心：

- sessionId；
- fileId；
- deviceId；
- asset metadata。

流程：

1. 校验 session / asset；
2. 查当前 session 的 `fileAssets`；
3. 如果服务端尚未登记资产，但请求设备在线且 metadata 合法，可将请求设备登记为 provider；
4. 如果已有同 `sessionId + assetId` magnet，复用已有 ID；
5. 保存 creator device；
6. 计算当前 live seed devices；
7. 返回：
   - magnet ID；
   - URL；
   - asset；
   - seed devices。

因此 magnet 是围绕“已有 file asset”建立的，不是上传一份新服务器文件。

## 5. 分享入口

主应用文件操作可调用：

- `shareFileMagnet()`
- `shareFileMagnetForInfo()`

创建后：

- 尝试复制 URL；
- 支持浏览器 `navigator.share` 时可继续系统分享；
- 日志记录 `file-magnet-shared`。

历史需求明确：磁链是在用户点击“分享磁链”时创建，不是在每次文件发送时预生成。

## 6. Magnet URL

公开入口：

`/magnet/:magnetId`

服务端验证 ID 后重定向到：

`/downloader?magnet=<id>`

读取：

`GET /api/magnets/:magnetId`

管理员可查看：

`GET /api/magnets`

管理员列表会展示：

- 文件名/类型/大小；
- session；
- creator device；
- createdAt；
- seed count；
- live seed devices。

## 7. 过期清理

`cleanupExpiredMagnets()` 在相关请求/清理流程中运行。

删除条件：

- 超过 TTL；
- 所属 session 已不存在。

管理员删除 session 时，也会清掉该 session 的 magnet registry。

所以磁链不是永久公开链接。

## 8. 独立下载器

页面：

`/downloader`

浏览器独立数据库：

- DB：`TunnelDownloaderDB`
- store：`magnetFiles`

下载器首先读取 magnet metadata，然后按顺序寻找文件：

### 8.1 Magnet 自己的本机缓存

如果 `TunnelDownloaderDB` 已有完整文件：

> 已命中本地缓存，可直接下载

不再联网拉取。

### 8.2 当前浏览器主 TunnelDB

如果 magnet 专用缓存没有，但浏览器主 `TunnelDB.files` 中已经存在：

- 相同 asset ID；
- 相同 source session；
- 完整 byte；

则先复制到 magnet cache，再直接下载。

目的：同一个浏览器如果原本就是隧道参与者，不应该再经过网络把自己已有的文件下载一次。

### 8.3 在线种子拉取

仍缺数据时：

1. 建立 Socket.IO；
2. 以临时设备名“磁链下载器”加入源 session；
3. 创建 `FileAssetTransfer`；
4. 请求某个 seed/provider；
5. 处理 manifest / available / unavailable / relay；
6. 完整数据写入 `TunnelDownloaderDB`；
7. 开放本机下载。

## 9. 下载器为什么 Relay-first

独立 downloader 对 FileAssetTransfer 配置：

- `connectPeer` 直接拒绝；
- `waitForDataChannel` 返回 false。

即当前 standalone downloader 有意不承担完整 P2P 建链 UI/状态，主要走现有 Relay/FileAsset fallback。

不要在文档里把 magnet 描述为“必定 P2P”。

## 10. 在线种子刷新

下载页面会周期刷新：

`GET /api/magnets/:id`

以获得新的 live seed devices。

历史上多源传输会把后来发现的 provider 加入候选池，目的是让长时间下载在原供源掉线后仍能发现新的在线副本。

## 11. 磁链缓存列表

页面：

`/downloadList`

功能：

- 列出 `TunnelDownloaderDB` 已完整缓存文件；
- 下载；
- 复制磁链；
- 删除本机 magnet cache；
- 输入完整磁链 URL 或 magnet ID；
- 校验后在当前页内嵌 downloader iframe。

内嵌下载器有：

- `-` 最小化；
- `x` 关闭。

历史上专门修过 iframe 横向溢出，避免右侧按钮被裁掉。

## 12. 为什么下载后不自动删缓存

浏览器通过 `<a download>` 触发保存后，网页无法可靠知道用户最终是否真的保存成功。

所以当前策略：

- 下载动作不自动删除 `TunnelDownloaderDB`；
- 用户在缓存列表手工删除。

## 13. 临时下载设备的 UI 语义

“磁链下载器”会以临时设备身份加入 session。

主功能首页不应把它当成正常人类设备显示所有直接交互入口，例如历史上明确隐藏过一对一对讲按钮。

后续新增设备动作时要考虑 `clientType` / 临时 downloader 语义。

## 14. 与 BitTorrent 的区别

当前没有：

- infohash；
- DHT；
- tracker；
- peer wire protocol；
- torrent piece map。

真正的数据仍通过 Drop2Tunnel：

- FileAsset registry；
- Socket.IO；
- Relay；
- 既有 provider/cache。

因此命名虽然叫“磁链”，技术上更接近：

> 短期 capability URL + asset/provider discovery。

## 15. 与网盘分享的区别

Telegram 网盘 share：

- 服务端有持久 share metadata；
- 底层文件在 Telegram；
- token 指向网盘逻辑对象。

Magnet：

- 源文件属于隧道 file asset；
- registry 当前内存态；
- 依赖在线 seed/provider；
- 独立 downloader 获取后写浏览器本机缓存。

两者不能合并成同一种 share ID。

## 16. 高风险点

- server restart 后 magnet registry 丢失；
- session 删除后链接失效；
- provider metadata 与真实 byte 不一致；
- downloader 自己加入 session 造成设备 UI 污染；
- 把 magnet cache 和主 TunnelDB cache 当同一个引用；
- 后续如果改为持久 magnet，需重新评估 TTL、权限和已删除历史。
