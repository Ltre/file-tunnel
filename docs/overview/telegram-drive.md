# Telegram 虚拟网盘：身份、文件系统、上传、流媒体与管理

> **源码基线 Commit**：`10ebe1000b9bd57097f90e51337a251ba17734f3`  
> **文档更新时间**：`2026-10-17`
> **重要现状**：网盘共享元数据已改用 node:sqlite 的磁盘 SQLite WAL（当前 schema 6）；S3 Compatible 子集、共享 Content Object、渐进上传、回收站、协同挂载等均已合入。S3 凭据、上传暂存、Telegram Chat 字典等仍有独立文件；不等于实现完整 AWS S3 或多实例分布式一致性。

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
- Range 播放；
- 文件/目录级协同邀请与受限协作。

## 2. 主要文件

服务端：

- `server/disk-repository.js`、`server/disk-content-repository.js`、`server/disk-content-proof.js`
- `server/disk-partitions.js`、`server/disk-collaboration-mounts.js`、`server/disk-mounted-namespace.js`
- `server/disk-progressive-upload.js`、`server/telegram-upload-scheduler.js`、`server/growing-file-readable.js`
- `server/disk-trash.js`、`server/disk-pending-saves.js`、`server/disk-account-sessions.js`
- `server/object-storage.js`、`server/s3/*`
- `server/disk-api.js`
- `server/telegram-drive.js`
- `server/disk-telegram.js`
- `server/disk-auth.js`
- `server/disk-operations.js`
- `server/disk-shares.js`
- `server/disk-collaboration.js`
- `server/disk-part-cache.js`
- `server/disk-chunk-file-cache.js`
- `server/disk-limits.js`
- `server/disk-upload-log.js`

客户端：

- `client/disk-ui.js`
- `client/disk-client.js`
- `client/disk-collaboration.js`、`client/disk-directory-picker.js/.css`
- `client/disk-mount-ui.js/.css`、`client/disk-copy-picker.js/.css`
- `client/disk-file-editor.js`、`client/disk-folder-upload.js`、`client/disk-trash-ui.js`
- `client/disk-pending-save.js`、`client/disk-operation-order.js`
- `client/disk-import-picker.js`、`client/s3-management.js`
- `client/disk-tunnel-adapter.js`
- `client/disk-share.js`
- `client/disk-management.js`
- `client/telegram-drive-cache.js`
- `client/disk.css`

页面：

- 主网盘 Overlay 在 `pages/index.html`；
- `/disk-share/:token`；
- `/disk-collab/:token` 与 `/disk-collab/view/:collaborationId`（`pages/disk-collaboration.html`）；
- `/disk-management`；
- `/s3-management` 与 `/s3-api-guide`（管理员）；
- `/S3API` 与 `/s3/{bucket}/{key}`（SigV4）；
- `/s3pub/{token}/path`（受签名、路径和有效期约束的静态只读资源）。

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

S3 Bucket 也映射到明确用户及其分区，不能把应用 ID、Bucket、分区 ID 或 Telegram 频道当作同一个 namespace。

## 5. 当前数据持久化

### 5.1 原生 SQLite WAL

`server/disk-repository.js` 使用 Node 24.15+ 内置 `node:sqlite` 的 `DatabaseSync`，管理 `.tunnel-data/disk.sqlite`；使用 WAL、外键、5 秒 busy timeout 和 FULL 同步。这里与 `server/infra-store.js` 使用 `sql.js` 的 `infra.sqlite` 不同，**不要混称为同一数据库架构**。

Repository 包含文件、目录、用户、应用、后端、令牌、分区、分享、协同、任务、分片缓存及引用、Content Object/Anchor、回收站、挂载、目录上传、用户设置和待转存等实体。逻辑文件、共享物理 Content、引用和 Telegram Anchor 分层管理。当前 schema 为 **6**；版本升级保留升级前 SQLite 备份，旧二进制不可直接混跑新 schema。

按记录版本差量提交，冲突拒绝并重新载入；文件/目录与授权路径、Content 引用等需共同修改的元数据在短事务内处理。Telegram 网络操作、传输字节和消息清理不持有长 SQL 事务。在线备份应通过 SQLite 备份接口，运行中不可只复制主 `disk.sqlite` 漏掉 WAL。SQLite 并不自动提供跨进程实时状态通知或分布式业务锁。

### 5.2 旧 JSON 与离线迁移

旧版 `telegram-drive-index.json`、`telegram-drive-directories.json`、`disk-auth.json`、`disk-shares.json`、`disk-collaborations.json`、分片索引等**不再是运行时权威源，也不双写**。存在 `tools/migrate-tgdisk-json-to-sqlite.cjs`：默认只读预检，在 SQLite 副本中试跑与检查；停服后显式 `--apply` 才做带备份和冲突校验的事务导入，原 JSON 不删。迁移工具经过旧用户身份映射、旧分片哈希冲突等兼容修正。不要凭脚本存在推断某一正式环境已完成迁移。

### 5.3 独立文件的边界

`disk-secret.key`、上传 staging/manifest、Telegram 分片/Range 物理缓存、S3 `s3-credentials.json` / `s3-secret.key`、管理员维护的 `telegram-chat-dictionary.json` 等仍在文件系统。S3 Secret 使用独立 AES-256-GCM 保护，不位于网盘 SQLite 内。备份需要同时理解 SQLite、外部缓存/暂存和这些独立密钥的生命周期。

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

当前路径结构仍由逻辑文件与目录实体维护；SQLite Repository 的差量版本校验、唯一约束和短事务替代旧 JSON 整集合覆盖。

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

持久操作任务现保存在 SQLite `disk_operations`；旧 `disk-operations.json` 仅为迁移来源。

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

- 旧 `.owners.json` 仅供旧数据离线导入；当前缓存归属在 SQLite `disk_cache_owners`
- 一个 cache digest 可属于多个 `userId + diskSpace`。

清理支持：

- all；
- user；
- partition；
- user + partition。

正在 read / prepare / inflight 的文件必须跳过，不能把播放器正在读的 part 删除。

## 16. Chunk `file_id` 重用

当前哈希分片 → Telegram `file_id` 映射位于 SQLite `disk_chunk_ids`；旧 `telegram-chunk-file-ids.json` 仅作迁移输入。

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

分享 capability 记录位于 SQLite `disk_shares`；旧 `disk-shares.json` 不再作为运行时共享存储。

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

## 22.1 文件/目录协同编辑

这套“协同”属于 Telegram Drive 文件系统能力，与隧道里的富文本 `collaborativeEdit` 不是同一个状态机。

持久化：

- SQLite `disk_collaborations`（旧 `.tunnel-data/disk-collaborations.json` 只属于离线迁移输入）；
- 协同目标可以是单文件或目录；
- 记录 owner、disk space、目标路径/fileId、成员和一次性邀请；
- 文件/目录移动后会同步调整协同目标路径。

所有者可以：

- 为文件或目录开启协同并创建一次性邀请；
- 撤销尚未使用的邀请；
- 查看成员；
- 移除成员；
- 停止整个协同。

邀请流程刻意分成“预览”和“加入”：

1. `GET /collaborations/invitations/:token/preview` 只返回受邀目标摘要，不建立成员关系；
2. 访客明确确认后才 `POST /collaborations/join`；
3. 一次性 token 在加入后失效；
4. 所有者打开自己的邀请可以直接进入目标，但不会消耗 token。

目录邀请摘要包含文件数/目录数/总体大小等；所有者管理视图可看到现有安全身份展示字段，普通成员不会拿到 invites/member 管理数据。

受邀页面：

- `/disk-collab/:token`
- `/disk-collab/view/:collaborationId`

使用独立的 `pages/disk-collaboration.html` + `client/disk-collaboration.js`。面包屑以受邀根目录为边界，不能向上跳出 owner 授权范围。

服务端通过 `/collaboration-scope/:collaborationId` 对每次访问重新校验：

- path；
- file id；
- upload id；
- operation id；
- file/directory move 目标。

在授权范围内可以浏览、预览、下载、上传、新建、改名、移动、删除和替换文件内容；越界请求返回协同 scope 错误。协同单文件的内容替换复用服务器暂存与 Telegram 队列，普通新文件上传仍使用既有分片流水线。

活动协同还承担删除保护：协同目标文件、目录及必要上级关系在停止协同前不能被 owner 直接破坏。移除成员或停用协同后，后续请求会立即重新鉴权，而不是依赖客户端已打开页面继续放行。

主网盘 UI 通过角标、协同列表和单项“邀请/管理协同编辑”入口展示状态；窄屏把“已分享/查看协同列表”收进刷新按钮旁的更多菜单，管理浮层按实际渲染尺寸钳制在视口内。

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
- 从网盘导出到隧道后，隧道文件仍按普通资产模型传播；
- 选择目标隧道并点击“继续”后直接进入读取/发送流程，不再弹第二次 `confirm`。

不要把两个系统的 fileId 当成同一 namespace。

## 26. SQLite / Content Object / 渐进上传：已实现，不再是未来规划

### 26.1 Repository 与共享 Content

网盘现采用 Logical File → Content Object → Telegram Anchor 三层实体，另有按逻辑文件版本绑定的 revision/引用记录。两个用户各自持有独立 Logical File，校验合格后可引用同一份内容，而不必重复上传 Telegram 正文。浏览器快速复用须完成基于随机取样的持有证明（PoP），**不能只报同名、相同大小或 SHA 值就得到他人的内容**；0 字节按独立规则处理。不同 Bot/存储后端的引用、归属及取样授权继续检查。

Content 在仍有引用、租约、历史已确认关联或可疑频道别名时不得被误清理；删除最后一个引用后走状态机与受控 GC，删除中/已删除 generation 不能简单重新激活。Telegram 远端消息与本地 SQLite 无法同一事务提交，未知发送结果保留恢复记录而不盲目重试。管理员提供 Content 查询、已删除逻辑记录关联、清理状态和技术数据诊断。完整语义与灰度开关参见 [共享 Content Object 说明](../../docs/telegram-drive-content-objects.md)。

### 26.2 浏览器渐进上传

显式 `progressive:true` 的网盘上传使用增长文件 reader/writer：浏览器当前分片写入一部分后，Telegram 已可读取已落盘的增长字节；前后两段相互解耦。XHR 产生浏览器发送进度，授权 SSE `/uploads/:id/progress` 回传服务端阶段与进度，轮询仍是兜底。

临时片先发送，完成来源校验后经最终媒体组确立正式 `file_id/message_id/media_group_id`，并先持久化最终关联、整批提交逻辑文件，再低优先级清理临时消息。独立调度器支持全局/单 Bot/单 Chat 并发与 429 冷却；只对确定安全的失败重试。Manifest v2 持久化来源、尝试、最终关联与清理债务供重启恢复。完整请求体已发送而结果不明时不宣称成功、也不盲重发。传统非渐进 API 和 S3 上传仍保留各自路径。

### 26.3 上传/目录性能与错误语义

目录导航不再每次先等待完整 /me；元数据列表按一次聚合处理，轻量 mkdir 可直接返回完成结果。进入挂载与权限确认优先使用 `getDirectoryRecord()` 轻量记录，不重复投影完整子树或 Content；`Server-Timing`、`X-Disk-Request-Id` 和磁盘日志记录可脱敏定位目录、挂载解析、队列等待阶段。

上传队列满时使用轻量 queue 查询和 `UPLOAD_BACKPRESSURE`，客户端真实网络故障通过 failure API 与主动取消区分。完整已确认的 Telegram 响应才推进确认进度，浏览器缓存角标按实际已接收字节从 0% 计算。分片缓存与 `getFile` 路径复用均有 Bot/哈希/大小及失败刷新校验。统一错误输出 `userMessage` 与安全 `errorDetails`，不泄漏 SQL、密钥或服务端路径。模拟性能改善不能替代真实网关/代理诊断。

## 27. S3 Compatible：有限协议子集

入口 `/S3API`（path-style，AWS SigV4），另有需要签名的 GET/HEAD `/s3/{bucket}/{key}`。Bucket 绑定指定 Access Key 的用户 UUID、分区及可选后端；后台 `/s3-management`、CLI `tools/s3-credentials.cjs` 管理独立密钥、停用和轮换。前台也可给自身分区启用稳定映射；管理帮助 `/s3-api-guide` 读取单一源码手册。

已支持 Bucket 探测、位置查询、ListBuckets、ListObjects V1/V2、普通及 AWS chunked PUT、GET/HEAD/单段 Range、COPY、DELETE、多对象删除；**不支持 S3 Multipart Upload API**、完整 AWS ACL/SSE/Object Lock 等。S3 和传统 JSON 网盘 API 是不同协议入口，共享底层存储但不互相 HTTP 套用；S3 PUT 仍等待 Telegram 确认和索引提交。曾有 FolderSync 兼容修复（根 HEAD 探测、REST-XML 错误），但不能把隔离协议测试等同于完整真机/公网验收。精确请求限制和配置见 [S3 接入说明](../../docs/telegram-drive-s3-compatible.md)。

## 28. 已实现的网盘高级操作

### 28.1 分区、协同 Mount、跨界 Copy

分区已区分稳定 ID / 不可变底层 scopeKey / 可修改显示名；默认分区不可删除。提供新建、重命名、复刻、删除与中断后的受限恢复；复刻独立引用，不复制 Telegram 正文，也不自动复制协同授权、分享、静态签名或 Mount。

受邀协同具 viewer/editor 角色和实时撤权检查；本人可在原生目录创建协同 Mount 指针，浏览不复制远端数据。目录 Mount 在原生面包屑下进入来源授权子树，单文件 Mount 原位预览。跨 Native/Foreign Scope 必须显式 Copy，部分场景的跨界 Move 采用持久两阶段提交：目标复制已完成而删源失败则返回 `COPIED_SOURCE_RETAINED`，保留目标和安全重试材料。Mount 不可二次挂载或逃出授予根；S3/传统外部 API 对 Mount 指针及内部路径只读。

### 28.2 目录上传、编辑与回收站

递归文件夹上传先枚举/预检并确认，默认总量 500,000,000 B，系统真实目录深度硬上限 30 层；按最多 100 文件一批提交，可凭本地清单提示用户确认继续，但不把仅凭文件名/大小当作内容校验。文本、Markdown 和 Hex 编辑器最多支持 20 MB，写入新版本采用 Content Object 写时复制（COW），保留其它引用，不用改动共享正文；冲突拒绝覆盖。

普通浏览器删除进入按账号/分区隔离的回收站，保留内容引用与原路径快照；还原检验祖先、重名、权限及引用，明确永久删除才释放引用。第三方传统 API、S3 和后台删除保留各自永久删除语义；旧版本已经永久清理的文件无法凭新回收站恢复。非空回收站阻止分区删除。

### 28.3 分享、静态开放、任务、转存

分享/协同授权文件支持向自己的分区与目录转存成独立 Logical File；拒绝把自己的来源伪装成外来转存。静态开放使用 HMAC 签名、可撤销和可设置期限的 `/s3pub`，读路径、用户、分区、过期与签名范围受约束；显式开放才显示蓝色 S，父目录继承开放不表示子项独立配置。静态开放保护相关文件/目录免遭破坏性改名、移动和删除；已进入客户端缓存的字节不能因撤销而追回。

任务列表合并/去重后按最新创建、开始、完成时间稳定排序。SNS/YouTube 已完成成品有“转存到网盘”：先验证并 pin 源缓存，保留可恢复待转存记录；用户再选择已验证账号、分区及目录，后端以 `pending_saves` 幂等预约和 attemptId 防止结果未知时重复 Telegram 上传。失败、取消或重启可以恢复，**结果未知时不释放缓存保护或盲重试**。

### 28.4 多账号及登录选择

同一浏览器可保留最多 10 个网盘账号的独立签名 HttpOnly 会话 Cookie，当前账号选择器不是凭据。切换不取消其它账号在途任务，操作必须固定发起账号和分区；账号 Cookie 的保留期限不等于登录仍有效。OIDC 授权尝试采用独立完成回执而非比较有效期，修复重复登录同一账号的误判；候选账号按下即时高亮，切换仍需显式确认。协同页、预览、转存与后台任务不得偷偷退回默认账号。

### 28.5 Chat 字典和频道迁移

管理员在 `/tgbot` 维护数字 Chat ID、历史 public 名称与别名，`getChat` 验证成功后才能迁移可信来源；“Telegram 文件防失联检测及修复”只在用户主动触发时扫描，已有文件可只更新来源标记，不强迫重新下载。频道从 public 改为 private 可使用停服离线 `tools/change-tgdisk-channel-id.cjs` 修改网盘 SQLite 记录；它不能迁移不属于同一频道的消息，也不会把旧 JSON 自动导入。详见 `docs/setup/telegram-chat-dictionary.md`。

## 29. 关键测试

新增测试族（以当前树为准）：

- `disk-json-migration`、`disk-repository`、`disk-content-*`、`disk-progressive-*`、`telegram-progressive-push`、`telegram-upload-progress`；
- `disk-partitions`、`disk-collaboration-mounts`、`disk-mounted-directory-performance-261012-3`、`disk-trash`（回收站能力通过相关 feature 用例覆盖）；
- `disk-file-editor-261011-2`、`disk-folder-upload`（在 261009 feature 系列中覆盖）、`disk-account-*`、`disk-pending-save-*`、`disk-task-order-261012-1`；
- `s3-gateway`、`s3-admin`、`disk-static-resources`、`disk-error-*`（错误文案在 feature 测试中覆盖）。

2026-10-12 开发记录报告全量 **840/840** 通过；这属于该开发阶段的测试记录，**不是本轮文档维护重新执行的测试**。Telegram 公网、真实 FolderSync、Android 文件夹拖放及真实进程崩溃仍应独立验收。

至少：

- `tests/telegram-drive.test.cjs`
- `tests/disk-api.test.cjs`
- `tests/disk-client.test.cjs`
- `tests/disk-directory-actions.test.cjs`
- `tests/disk-followup.test.cjs`
- `tests/disk-part-cache.test.cjs`
- `tests/disk-preview-history.test.cjs`
- `tests/disk-sharing.test.cjs`
- `tests/disk-collaboration.test.cjs`
- `tests/disk-storage-regression.test.cjs`
- `tests/control-center-drive.test.cjs`
- `tests/bugs-260914.test.cjs`
- `tests/features-260925.test.cjs`
- `tests/features-260926-2.test.cjs`
- 其它 2609 feature regression。

真实 Telegram 端到端仍应单独验收，因为 Mock 无法完整覆盖 Telegram 的 delete window、file_id、album、Range proxy、权限等真实行为。

## 30. 2026-10-13—16 上传与路径定位的新增约束

1. **批量上传重名预检**：`client/disk-upload-names.js` 以最终相对目录与 trim 后文件名组合为碰撞域，整批预留名称，递增重命名并保留扩展名和 Unicode 边界。普通文件与递归目录上传均需确认，File 包装副本保留原字节/类型/修改时间。客户端确认及上传固定原账号，不能中途切换身份。
2. **路径输入**：面包屑手动编辑改为真实 form submit、移动键盘 `enterKeyHint=go`、可点击“前往”，并保护中文输入候选和提交中失焦；指向挂载目录仍使用原本的服务端 scope 校验。点击“前往”的 pointerdown 与提交事件不能被 blur 先移除输入框。
3. **账号管理浮层**：入口立即显示加载态，账号列表与当前身份并行读取，关闭时中止请求并拒绝迟到覆盖；候选高亮不等于真正已切换登录身份。
4. **位置深链**：`/disk`、`disk=1` 所带 `disk_account`、`disk_space`、`disk_file`、`disk_path` 会跨主页面初始化、未登录、OIDC/Passkey 和账号切换保留到导航成功；仅在目标账号、分区和文件当前目录真实核对后滚动高亮。登录其它账号或失败不会消耗原目标；旧响应不得把当前用户带回原目录。
5. **转存结果**：来自隧道、媒体收藏和压缩版本的保存必须固定目标账号、分区、目录以及来源版本；适配器可传入上传进度回调（发送/确认/复用阶段），确认持久文件与 Content 引用后才显示成功。当前没有为了这些页面变化改动 S3 协议本身。

相关入口：`client/disk-ui.js`、`client/disk-directory-picker.js`、`client/disk-folder-upload.js`、`client/disk-tunnel-adapter.js`、`client/disk-upload-names.js`、`server/object-storage.js`。真实 Android 中文键盘、生产登录与真实 Telegram 仍需验收。
