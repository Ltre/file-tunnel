# Telegram 虚拟网盘：身份、文件系统、上传、流媒体与管理

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`
> **重要现状**：当前网盘核心共享元数据仍是 JSON/文件系统持久化。SQLite WAL 与 S3 Compatible 均是已有设计方案，但不属于本基线已实现能力。

## 1. 产品初衷

Telegram 网盘的目标不是把浏览器 IndexedDB 搬到服务器，而是利用用户指定的 Telegram Bot + Channel 作为实际文件托管层，并在 Drop2Tunnel 中提供类似网盘文件管理器的逻辑体验：

- 用户身份；
- 多级目录；
- 文件上传/下载；
- 搜索、排序、列表/网格；
- rename / move / delete；
- 多选；
- 浏览器缓存；
- 公共分享；
- 后台审核；
- 第三方应用 API；
- `disk_space` 分区；
- 多分片大文件；
- Range 播放。

## 2. 主要文件

服务端：

- `server/disk-api.js`
- `server/telegram-drive.js`
- `server/disk-telegram.js`
- `server/disk-auth.js`
- `server/disk-operations.js`
- `server/disk-shares.js`
- `server/disk-part-cache.js`
- `server/disk-chunk-file-cache.js`
- `server/disk-limits.js`
- `server/disk-upload-log.js`

客户端：

- `client/disk-ui.js`
- `client/disk-client.js`
- `client/disk-tunnel-adapter.js`
- `client/disk-share.js`
- `client/disk-management.js`
- `client/telegram-drive-cache.js`
- `client/disk.css`

页面：

- 主网盘 Overlay 在 `pages/index.html`；
- `/disk-share/:token`；
- `/disk-management`。

## 3. 身份与授权

### 3.1 用户身份

网盘从最早 Telegram OIDC 用户认领，逐步扩展到通用用户 + Passkey。

当前 `disk-auth.json` 里逻辑上包含：

- users；
- apps；
- backends；
- tokens；
- user 中的 passkeys。

用户可能来自：

- Telegram OIDC；
- 本地/回环 Mock；
- Passkey。

### 3.2 Telegram OIDC

真实域名走 OIDC Authorization Code + PKCE/state/nonce/JWKS 校验。

回环开发环境可启用受限 Mock。

登录被刻意设计为独立 popup：

> 登录不能刷新整个功能首页、不能中断正在运行的 P2P 文件传输或播放器。

### 3.3 Passkey

第三方/通用账号场景支持 WebAuthn Passkey。

流程大致：

- options；
- 5 分钟左右 pending challenge（内存）；
- verify；
- credential public key/counter 持久化。

Passkey pending flow 是短期内存状态，不等于持久用户记录。

### 3.4 App / Access Token

第三方应用可以：

- `app_id + app_secret` 验证；
- 签发短期 Bearer token；
- token 绑定 app revision；
- app 更新后旧 token 失效；
- token 关联 storage backend。

敏感语义：

- app secret 保存 hash；
- Bot token / credential bundle 加密保存；
- `disk-secret.key` 为独立本地密钥材料。

## 4. Resource Scope

核心逻辑资源标识是：

`user_id + disk_space + path / file id`

而不是：

`app_id + path`

多个 App 可以有意访问同一个用户的同一个 `disk_space`。App ID 更多是：

- 授权身份；
- 来源 attribution；
- usage 统计。

这一点对未来 S3/第三方接口尤其重要，不能重新把 App 变成文件 namespace。

## 5. 当前数据持久化

### 5.1 文件与目录

每一个 Store 当前读取：

- `telegram-drive-index.json`
- `telegram-drive-directories.json`

进内存 Map。

默认 disk space 使用 `.tunnel-data` 根下的索引。

非默认 `disk_space` 当前通过：

`.tunnel-data/disk-spaces/<sha256(diskSpace)>/`

建立独立 Store。

`disk-spaces.json` 记录逻辑分区列表。

`disk-space-usage.json` 记录：

- appId；
- userId；
- diskSpace；
- createdAt；
- lastUsedAt。

### 5.2 其它共享 JSON

- `disk-auth.json`
- `disk-operations.json`
- `disk-shares.json`
- `telegram-chunk-file-ids.json`
- `telegram-part-cache/.owners.json`

单文件写入已使用临时文件 + rename，所以风险重点不是“每次都写半截 JSON”，而是：

- 多个强关联文件不能一个事务提交；
- 整集合反复重写；
- 异步业务存在检查/提交竞争；
- 多进程时进程内锁无效。

未来 SQLite WAL 重构已经有单独设计文档，但尚未执行。

## 6. 目录模型

当前核心仍是 path-based：

- 文件有 `folderPath`；
- 目录有 `path`；
- 目录 key 含 owner；
- Store 会 materialize ancestor directories。

功能：

- create；
- rename；
- move；
- recursive delete；
- tree；
- properties。

目录移动需要批量重写：

- 目标目录；
- descendants；
- descendant file `folderPath`。

当前 JSON Store 通过内存修改后 persist；这也是未来事务化的重点。

## 7. 文件模型

逻辑文件大致包含：

- id；
- ownerId；
- folderPath；
- name；
- type；
- size；
- backendId；
- channelId；
- Telegram message / file ID；
- parts；
- partCount；
- thumbnail；
- mediaIndex；
- fileIdHistory；
- metadata；
- review status；
- source app；
- caption sync state；
- timestamps。

前台 `publicFile()` 会裁剪成客户端需要的字段，不应把 Bot token/backend credentials 泄露给浏览器。

## 8. Telegram 物理分片

当前硬限制来自 `server/disk-limits.js`：

- 单 Telegram 物理 part 最大：`20,000,000` bytes；
- 单 Telegram batch 最大：`40,000,000` bytes。

注释说明这是为了保持在 cloud `getFile` 20 MB 下载上限以下并为 multipart/proxy 留余量。

逻辑文件可以远大于 20 MB；用户看到的仍是一个逻辑文件。

每个 part 记录：

- partIndex / partCount；
- offset / size；
- sha256；
- Telegram fileId / fileUniqueId；
- messageId/date；
- mediaGroupId；
- logicalFileId/original size 等。

下载时必须按顺序重组并校验 size/offset。

## 9. 上传流水线

### 9.1 为什么重构过

早期做法在大文件上出现：

- 浏览器先传大块给 Node；
- Node 再等待 Telegram；
- 两段不能充分流水；
- 多片重新聚合导致 413；
- 进度把“浏览器→Node”和“Node→Telegram”叠加，显示翻倍。

当前方向是：

1. 浏览器按物理 part plan 逐片提交；
2. Node staging；
3. Telegram FIFO/消费；
4. 每个 part 可重用已知 `file_id`；
5. 客户端通过 Operation 轮询；
6. Telegram 全部成功后，最终 commit 逻辑文件。

### 9.2 Staging

目录：

`telegram-drive-staging/<uploadId>/`

包含临时 part 和 `upload-manifest.json`。

manifest 的重要意义是崩溃恢复：即使进程重启，系统还能知道哪些远端 Telegram parts 已经上传但逻辑文件尚未正式 commit。

### 9.3 Telegram 网络与 Store mutation

`disk-api.js` 有：

- 全局 Telegram upload tail / FIFO；
- 按 `[userId,diskSpace]` 的 `mutate()` Promise queue。

`mutate()` 的注释明确说：同一个逻辑网盘的 index mutation 在远程 work pending 时串行化，读和其它用户/分区不受影响。

未来即使切 SQLite，也不应未经分析直接删除此业务级串行机制，因为数据库 transaction 与远程 Telegram 状态机不是同一层问题。

## 10. Operation

`disk-operations.json` 当前保存持久任务。

状态含：

- operation_id；
- userId/diskSpace；
- type；
- status；
- phase；
- percent；
- processed/total bytes；
- message/error；
- created/started/finished；
- uploadId / result 等动态字段。

普通进度约 500ms debounce，terminal 立即写。

服务重启时非 terminal Operation 会被标为：

- failed；
- phase interrupted；
- `SERVER_RESTARTED`。

### 10.1 居中 Loading

需求不是“请求过程中只有一个 spinner”。

网盘支持：

- 当前前台操作的居中 Loading 浮层；
- “后台执行”；
- 任务列表；
- 从任务列表重新点击进行中的任务，恢复 Loading；
- 多任务 Loading 左右切换。

用户选择后台执行后必须仍有恢复查看入口。

## 11. 上传回滚与重启恢复

如果 Telegram 已经上传成功一部分，但：

- 用户取消；
- Node 异常；
- final commit 失败；
- upload 过期；

系统需要删除远端残留。

当前已有：

- recovered upload scan；
- cleanup expired；
- recovery backlog；
- Telegram `remove`；
- 失败后保留 manifest 等机制。

这也是未来 SQLite 事务重构里“Telegram 网络绝不能放进长事务”的基础。

## 12. Telegram 删除策略

Telegram 普通 message 删除有时间限制。

当前代码使用：

`DELETE_WINDOW_MS = 47h57m`

接近但略早于 48h：

- 窗口内尝试 delete；
- 太旧或不允许删除时，用 `editMessageMedia` 替换成 1 Byte placeholder；
- caption 变为“原文件名 已删除”。

placeholder 的 Telegram `file_id` 按 Bot 缓存，避免每删一个旧文件都重新上传 1 Byte 文件。

## 13. Telegram Caption

历史上 caption 曾包含：

- user_id；
- disk_space；
- name；
- channel_id；
- logical_file_id；
- part；
- original_size；
- file_id/message_id/album_id；
- path。

2026-09-17 之后明确调整：

- 移动文件/目录**不再**因为路径改变去批量 edit Telegram caption 的 `path:`；
- 新上传也不再写 `path:`；
- 重命名文件仍保留同步 caption 中 `name:` 的机制；
- 同步失败可设置 `captionSyncPending` 并后台 retry。

动机是目录 move 原本会对大量 Telegram message 做网络 edit，导致一个本地逻辑操作非常慢。

## 14. Thumbnail

视频/音频上传期后来增加独立封面链路：

- 主文件不完整缓存时也能提前展示封面；
- 封面本身保存 Telegram file/message 定位；
- 播放器/list 优先取独立封面；
- 旧记录仍允许从主体提取作为兼容。

历史上曾出现“代码声称实现但真实 Telegram 没出现音频封面”的人工反例，后续 260914 又补齐歌曲封面并通过回归。修改时仍建议真 Bot 验证，而不是只看 Mock。

## 15. Range / Part Cache

服务端 `telegram-part-cache` 用于 Telegram 下载 Range 窗口。

实际 byte：

- `*.part`
- `*.tmp`

仍在文件系统。

缓存 schema 当前为 `2`。

内存状态：

- inflight；
- preparing；
- readers。

owner metadata：

- `.owners.json`
- 一个 cache digest 可属于多个 `userId + diskSpace`。

清理支持：

- all；
- user；
- partition；
- user + partition。

正在 read / prepare / inflight 的文件必须跳过，不能把播放器正在读的 part 删除。

## 16. Chunk `file_id` 重用

`telegram-chunk-file-ids.json` 是内容分片 → Telegram file_id 的缓存。

key 关联：

- backend（baseUrl + Bot token fingerprint）；
- SHA-256；
- size。

如果相同 Bot/backend 已经上传过相同物理内容，可复用 Telegram `file_id`，减少重复上传。

由于 `file_id` Bot-specific，不能跨不同 Bot 共用。

## 17. Stream / 播放

API：

- `GET /files/:id/stream`
- Range 支持。

服务端会：

1. 查逻辑文件 parts；
2. 根据客户端 Range 找到涉及的 Telegram part；
3. 把请求对齐到约 1 MiB cache block；
4. `partCache.open()`；
5. 必要时向 Telegram `readPart` 发 Range；
6. proxy 不支持 Range 时服务端丢弃前缀确保正确性；
7. 合并为浏览器 stream。

播放器关闭/seek 会产生大量中断 Range，所以 cache fill 被设计成可在某个 browser consumer 离开后继续完成，避免重复回源。

## 18. 浏览器网盘缓存

`client/telegram-drive-cache.js` 是浏览器侧独立缓存。

UI 会展示：

- 是否完整缓存；
- cache progress；
- cache/clear；
- recursive cache directory；
- share cache 等。

删除网盘实体前应同步清理相应本机缓存引用；但“清浏览器缓存”不删除 Telegram 远端文件。

## 19. 搜索

支持当前目录及全盘搜索。

260918 修过一个重要 Bug：

> 全盘搜索有多个不同目录的同名 `A.mp4`，删除一个时 UI 按名字把所有同名结果删掉；顶部 refresh 也没有恢复，重新搜索才出现。

修复原则：

- 使用 file id / 完整 path 标识结果；
- 删除只 prune 目标；
- 当前全盘搜索关键词保留并重新检索。

因此任何列表 key 不应退回 basename。

## 20. PC / 移动交互

### 20.1 PC

支持：

- double click/open；
- item 三点；
- right click；
- bottom context button；
- 多选；
- 内部拖动；
- 本地文件拖放上传；
- 拖到 breadcrumb 祖先目录。

260924 已验收：

- 本地文件拖到当前目录或 breadcrumb；
- 上传前提示文件及目标目录；
- 确认后复用正常上传。

### 20.2 移动

历史上专门处理：

- 单击目录进入，不能被 synthetic mouse event 误判为 PC 勾选；
- 长按拖动；
- 双指上下文菜单（部分阶段）；
- 长按/菜单；
- 列表惯性滚动；
- context menu 越界。

修改 pointer/touch 事件要防止同一个 gesture 同时触发 click/context/select。

## 21. Context Menu / History

曾反复出现：

- PC 全屏或宽屏只看到毛玻璃 backdrop、菜单本体在错误位置；
- bottom menu 和 item 三点都受影响；
- 菜单操作触发两次 history.back；
- 关闭预览连带关闭整个网盘或跳到旧目录。

当前 `client/disk-ui.js` 有专门：

- `ownsTelegramDriveHistory()`
- `handleTelegramDrivePopstate()`
- menu close/render；
- preview close/history。

这些逻辑属于高风险回归区。

## 22. 分享

`disk-shares.json` 保存 capability link snapshot。

Share 不是让外部用户自由传 `owner/path` 查询，而是创建时把用户选中的：

- file IDs；
- directory relative paths

做快照。

API：

- `GET /shares`
- `POST /shares`
- `DELETE /shares/:id`
- public `/:token`
- public file download。

分享访问还会再次检查当前文件 review status，blocked/deleted 不应继续暴露。

## 23. 后台审核

`/disk-management` 支持：

- 用户/App/分区树；
- storage overview；
- storage contents；
- 最新 review；
- file/directory moderation；
- part cache 清理。

审核可：

- blocked：阻止分享/转发；
- deleted：删除 Telegram entity 后保留用户侧可见的逻辑占位/清理语义。

后台 UI 不直接读 JSON，而是调用 API。因此未来底层换 SQLite 时应尽量保持 API contract。

## 24. Third-party Disk API

`disk-api.js` 有 browser、external、admin、shared 多 Router。

外部 App 通过 token 后可：

- list/search/tree；
- directory CRUD；
- file properties；
- upload；
- stream；
- check/repair。

历史需求明确：第三方 App 与浏览器用户应使用同一逻辑文件系统，不要复制另一套“API 专用网盘”。

## 25. 从隧道保存到网盘 / 从网盘转回隧道

`client/disk-tunnel-adapter.js` 连接两个子系统。

需要明确：

- 隧道的文件当前可能不在本机；
- 保存网盘前可能先恢复缓存；
- 上传成功后网盘有独立 Telegram 持久对象；
- 从网盘导出到隧道后，隧道文件仍按普通资产模型传播。

不要把两个系统的 fileId 当成同一 namespace。

## 26. 当前数据可靠性问题与 SQLite 规划

已有设计结论：

当前单 Node 进程 + Map + temp rename 并不意味着“多人一操作 JSON 就一定损坏”，但是：

- file index + directory index 跨文件不能事务；
- auth/share/operation 关系复杂；
- 整文件写放大；
- 未来多进程风险高。

用户已经允许测试阶段旧网盘 JSON 全部放弃，因此未来计划是：

- 新建 `.tunnel-data/disk.sqlite`；
- 原生 SQLite WAL；
- Repository + DB Adapter；
- 业务层不散落 SQLite SQL；
- Telegram 网络操作不包进长 transaction；
- 保留 Saga / rollback / recovery；
- 为未来 PostgreSQL/MySQL 留适配边界。

**这仍是计划，不是本文源码基线所代表的当前实现。**

## 27. S3 Compatible 规划

相关材料：

1. `prompts/ideas/Make full use of Telegram storage 260920.md`
2. `prompts/ideas/QA of S3 base on Telegram Storage 260920.md`
3. `prompts/ideas/Telegram Drive S3-Compatible API Implementation Guide (260920).md`

最终 Implementation Guide 的目标是在现有网盘 Object Storage 能力之上提供 FolderSync 等可使用的 S3 Compatible API。

截至本源码基线尚未实现。后续实施应复用现有：

- multipart；
- Range；
- logical file；
- backend；
- auth；

而不是重新实现一套 Telegram 分片系统。

## 28. 未来私有托管频道规划

已有调研考虑把 public `@username` 托管频道改成 private chat ID。

这是未来任务，需检查：

- 当前文件记录是否已经保存 channelId；
- caption 中 channel 显示与真实寻址是否混淆；
- 旧数据是否需要自动修复。

不要因为 caption 里出现 `@username` 就推断底层索引没有 chat ID；必须查当前 source/object。

## 29. 关键测试

至少：

- `tests/telegram-drive.test.cjs`
- `tests/disk-api.test.cjs`
- `tests/disk-client.test.cjs`
- `tests/disk-directory-actions.test.cjs`
- `tests/disk-followup.test.cjs`
- `tests/disk-part-cache.test.cjs`
- `tests/disk-preview-history.test.cjs`
- `tests/disk-sharing.test.cjs`
- `tests/disk-storage-regression.test.cjs`
- `tests/control-center-drive.test.cjs`
- `tests/bugs-260914.test.cjs`
- 多个 2609 feature regression。

真实 Telegram 端到端仍应单独验收，因为 Mock 无法完整覆盖 Telegram 的 delete window、file_id、album、Range proxy、权限等真实行为。
