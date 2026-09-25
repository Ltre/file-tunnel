# 传输记录、文件资产、缓存与恢复链路

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 子模块文档

- [Drop2Tunnel 磁链分享、种子发现与独立下载器](./transfer-cache/magnet-download.md)
- [文件夹 ZIP、合辑打包与本机目录镜像](./transfer-cache/folder-archive-directory-mirror.md)

## 1. 设计目标

文件传输链路经历了项目中最多的回归之一。最终形成的核心目标不是“只用某一种协议”，而是：

- 有本机完整副本时立即使用；
- 有在线浏览器供源时优先设备间获取；
- P2P 建链失败或传输失败时允许 Socket.IO Relay；
- server asset / Telegram 等特殊来源作为兜底；
- 当前设备获得完整副本后，再成为其它设备的普通供源者；
- UI 始终能区分记录存在、完整缓存存在、正在恢复、来源离线、中断等状态。

## 2. 文件与记录是两个对象

传输记录保存：

- message ID；
- 类型；
- 文件元信息；
- sender；
- remark；
- 时间；
- collection 关系等。

真实文件字节可能在：

- 当前浏览器 CacheStore；
- IndexedDB；
- OPFS；
- File System Access 外部句柄；
- 其它在线浏览器；
- VClient；
- server asset；
- Telegram；
- 暂存下载目录。

因此：

> 删除某条记录、释放某份缓存、删除服务器临时资产、删除 Telegram 文件，是不同操作，不能用一个“delete file”概念混在一起。

## 3. 浏览器缓存层

### 3.1 CacheStore

`client/cache-store.js` 抽象了：

- MemoryTempDriver；
- IndexedDbBlobDriver；
- OpfsCacheDriver；
- Drop2TunnelCacheStore。

历史上单纯把所有大 Blob 放 IndexedDB 会遇到性能/配额问题，因此当前缓存层已经具有独立驱动思维。

### 3.2 “完整缓存”判断

前端有：

- `hasCompleteFileCache()`
- `materializeCachedFileRecord()`
- `getStoredFileBytes()`
- file inventory / cache status helpers。

不要仅以“files store 中有一行”判断文件完整。

### 3.3 清理

用户操作分为：

- 释放当前浏览器缓存；
- 删除传输记录；
- 垃圾缓存清理；
- 网盘浏览器缓存清理；
- 合辑成员清理。

删除记录后，为降低大文件 DB 扫描阻塞，历史实现把孤立缓存清理推迟到 idle/异步队列。

## 4. File System Access 外部句柄

Chrome/Edge 安全上下文下，可以保留本机文件/目录句柄。

初衷：

- 大文件不用复制一份完整 Blob 到浏览器数据库；
- 原文件仍在本地时可直接供源。

但句柄并不可靠：

- 用户移动文件；
- 删除；
- 重命名；
- 权限过期；
- 不同浏览器不支持。

因此 UI 必须能从“💾 外部文件”回退到普通恢复状态。

历史需求特别强调：

- 远端副本确认前，不要过早清掉同 fileId 的安全缓存；
- 远端恢复成功后，立即刷新记录、合辑卡片和预览；
- 不应把外部句柄状态误判成“已经有可释放的浏览器缓存”。

## 5. 供源发现

服务器 `server/file-assets.js` 保存在线资产供源状态，并按：

- freshness；
- provider；
- receiver load；
- assignment

选择来源。

相关事件：

- `file-asset-discovery`
- `file-asset-manifest`
- `file-asset-request`
- `file-asset-available`
- `file-asset-unavailable`

浏览器获得完整缓存后会 announce，成为后续普通来源。

## 6. WebRTC P2P

### 6.1 初衷

大文件直接设备间传输，避免服务器成为带宽瓶颈。

### 6.2 当前实现要点

- RTCPeerConnection；
- DataChannel；
- offer / answer / ICE signaling；
- chunk send；
- bufferedAmount/backpressure；
- completion ack；
- timeout / retry；
- multi-source / range 场景。

### 6.3 历史高风险问题

Git 历史中大量提交专门处理：

- P2P 100% 后又重新 Relay 一遍；
- DataChannel 提前 close，旧 receiver 兼容；
- 多源分片 completion race；
- 旧 relay attempt 未清；
- ICE restart 无效；
- VPN/代理多网卡 candidate 被错误补写；
- heartbeat/retry 调度风暴；
- 接收进度反复归零；
- 一个失败任务阻塞后续队列。

后续重构绝不能只验证“小文件本机两浏览器能传”，至少要覆盖：

- 大文件；
- 多文件；
- 多设备；
- P2P 成功；
- P2P 失败转 Relay；
- receiver 断线；
- 同 file 多来源。

## 7. Socket.IO Relay

Relay 是可用性保障，而不是错误状态。

服务器：

- 接收 relay start/chunk/complete；
- 把 chunk 转发给指定 receiver；
- 维护 transfer token / relay key；
- 收集 ack；
- 清理超时 relay。

原则：

- Relay 不能与已成功 P2P 的 attempt 同时重复完成；
- late event 必须能识别旧 attempt；
- Relay 的服务器接触文件分块，因此项目不是“服务器永远零接触”。

## 8. Server Asset

某些文件天然先存在服务器，例如：

- SNS/YouTube 下载成品；
- Telegram 恢复临时文件；
- 后端产生的资产。

它们可以注册成 server asset，再让浏览器按普通文件链路获取并缓存。

客户端包含：

- `fetchServerAssetCache()`
- `requestServerAssetWithPeerPreference()`
- recovery stage。

一个关键历史修复是：

> 即使记录来源是 SNS / server asset，如果已有其它在线浏览器缓存，也应先尝试 P2P，而不是每台设备都重新让服务器/上游下载。

## 9. Telegram 作为隧道文件恢复来源

这与“Telegram 网盘”不同。

普通隧道记录可以绑定 Telegram `file_id`，当浏览器供源均不可用时：

- 服务端按需下载；
- 浏览器获取完整文件；
- 浏览器之后成为普通供源者。

资源管理器还有“防失联”检查/修复：

- 检查旧 file_id 当前 Bot 是否仍能获取；
- 如果已有本机/在线副本，则通过新 Bot/当前 Bot 重新上传；
- 更新绑定。

Telegram `file_id` 与 Bot 强关联，不能当成全局永久地址。

## 10. 文件发送

入口包括：

- file input；
- drag/drop；
- PWA Share Target；
- 粘贴板图片；
- 文件夹；
- 已挂载本机文件；
- 网页工坊发布产生的 ZIP；
- SNS/server asset 转入隧道。

### 10.1 首屏记录与本地入库解耦

历史上多文件/音视频因为串行读文件导致发送后长时间看不到记录。后来把“先发布传输记录”与“后续准备本地缓存/封面”解耦。

因此不要为了保证“所有数据准备完再显示”而重新让大合辑首条消息延迟数十秒。

### 10.2 发送处理中占位

文件准备阶段会显示“发送处理中”及阶段进度。

它的目的不是伪造已发送，而是让用户明确知道点击/分享动作已经被系统接受。

## 11. 合辑

合辑是单条传输记录中的多文件集合。

要求包括：

- 合辑 remark；
- 子文件独立操作；
- 宫格；
- P / F / G 多层预览返回关系；
- 全屏跨文件切换；
- 删除单成员；
- 下载全部；
- 缓存恢复；
- 收藏。

“下载全部”可等待缺失缓存完成后打 ZIP，也允许用户提前下载当前已准备内容。

合辑中的 fileId 和单文件记录一样参与全局引用/缓存清理，不能把合辑 ZIP 当成唯一真实文件。

## 12. 文件夹发送与目录同步

### 12.1 发送文件夹

浏览器通过 `client/folder-archive.js` 将目录内容打成普通 ZIP，再复用普通文件资产发送，并标记 `isFolderArchive`、`folderName`、`entryCount`。详细格式与兼容边界见 [folder-archive-directory-mirror.md](./transfer-cache/folder-archive-directory-mirror.md)。

### 12.2 本机目录同步

存在目录 mirror 功能：

- Chromium File System Access `showDirectoryPicker({mode:'readwrite'})`；
- 本机目录签名；
- 约 5 秒扫描变化；
- snapshot ZIP；
- `isDirectoryMirror` 资产标记；
- 远端解包写回；
- `skipSignature` 避免刚应用的快照立即回传。

这不是 Telegram 网盘目录，也不是网页工坊 ZIP 目录，命名相似但数据模型不同。

## 13. Clipboard

早期只有文本剪贴板共享，后来增加图片监听/粘贴区。

图片共享要求：

- 只处理图片，不偷偷读取剪贴板文本；
- 内容指纹避免重复提示；
- 浏览器不完整支持 clipboardchange 时使用前台授权探测；
- 最终复用普通文件发送链路。

## 14. 备份与导入

支持：

- 元数据备份；
- 带文件二进制的完整备份；
- 原时间位置 / 追加到尾部；
- 跨隧道导入。

跨隧道导入特别要求：

- 重映射 fileId；
- 不要让两个隧道错误共享同一个缓存引用；
- 删除一个隧道时不能把另一个仍引用的缓存删掉。

退出隧道和导入大备份属于重操作，应有阻塞式进度反馈。

## 15. 会话资源管理器

资源管理器是“当前隧道文件资产及引用关系”的管理视图，不是 Telegram 网盘。

功能包括：

- 文件/合辑/富文本/协同引用；
- 本机缓存状态；
- 外部句柄；
- 远端 provider；
- Telegram 兜底；
- 类型/缓存/来源筛选；
- 跳转引用；
- 挂载本机文件/目录；
- 清理垃圾；
- Telegram 连续性检查/修复；
- 最小化/恢复。

历史要求桌面居中大浮层、移动端全屏；最小化后保留筛选、搜索、scroll、已加载 DOM。

## 16. 进度 UI

主应用有独立传输进度抽屉。

需求包括：

- 多任务；
- 发送/接收方向；
- 排序；
- active 状态；
- 点击定位对应传输记录；
- 折叠/展开；
- 页面刷新/状态恢复边界。

历史上曾因“为了历史懒加载清理 DOM”误删活动进度元素，说明 progress UI 不能简单绑定可见 message DOM 生命周期。

## 17. 预览与缓存的关系

文件预览只应对有意义的媒体类型直接打开。

常见状态：

1. 本机已有完整缓存：直接预览；
2. 外部句柄有效：直接读取；
3. 缺缓存但有 provider：请求恢复；
4. server asset/Telegram 兜底：按需回源；
5. 无来源：显示等待/恢复提示。

不应该因为用户只是打开“属性”就偷偷拉完整几百 MB 文件。

## 18. 大媒体与 Range

普通隧道文件和 Telegram 网盘都出现过 Range / 流媒体场景，但实现不同。

历史上播放器发生：

- waiting/stalled 时主动重设 URL + load；
- 导致浏览器当前 Range 被中断；
- 新请求又从 `bytes=0-` 开始；
- 看起来像缓存到 100% 仍 Loading。

后续取消了这种激进 reload，更多依赖浏览器原生 Range。

修改播放器恢复策略前，应验证真实大 MP4，而不是只测短样例。

## 19. 引用完整性

清理缓存前需要判断：

- 当前 session 是否还有记录引用；
- 其它 session 是否引用；
- collection 成员；
- rich/editor asset；
- mounted / external state；
- pending transfer。

因此 `findReferencedFileIds()`、`isFileReferencedOutsideSession()` 一类逻辑是安全边界，不应为了清理速度删除。

## 20. 测试与修改提示

核心测试至少包括：

- `tests/p2p-connection-regression.test.cjs`
- `tests/file-asset-audit-isolation.test.cjs`
- `tests/history-startup-regression.test.cjs`
- `tests/infra-store-audit.test.cjs`
- `tests/infra-store-write-batching.test.cjs`
- 版本 features tests。

对传输链路的大改，应把历史 Git 中带“看似能用 / 有 BUG / WRONGCODE”的提交视为反例资料：它们证明某个局部修复很容易破坏另一个 fallback 状态。
