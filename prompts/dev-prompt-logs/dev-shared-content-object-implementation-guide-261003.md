# 共享 Content Object 重构实施指南（基于本地最新代码）

> 校准日期：2026-10-03（Asia/Singapore）。本轮仅生成实施指南，未实施下述功能。
>
> 当前本地分支：`dev/2609-s5-disk-chunks-progressive-push`。
>
> 本次校准的本地实际 HEAD：`9ee50ba5da2c3ca9712e2387a88889c84d0f9aa1`。
>
> 原草稿调查基线：`dev/2609-s5-disk-chunks-progressive-push` / `09ad7a56e28ec066054deaf7e7d8dffbeb789971`。
>
> 原草稿仅作为设计讨论和旧版本代码调查参考；本指南已根据本地最新代码重新校准。上述两个提交之间目前只有 prompt/讨论文档变化；真正重要的业务代码进展是当前工作区**尚未提交的渐进上传实现及测试**。因此实施基线是“本地 HEAD + 本次核验的工作区实际代码”，不能只 checkout HEAD 后声称已经具备本文列出的全部能力。开始开发前应再次核对工作区及这些文件。

本文区分三种表述：**当前事实**是本地已有实现；**实施要求**是本次确定的目标；**建议新增**的表、函数、API、状态和测试尚未存在。文件位置以本文核验时为准，行号会随后续修改变化，应使用函数名定位。

## 1. 目标、方案演进与不可改变的边界

最终模型为：

```text
Logical File（用户的业务记录）
          ↓ 多对一引用
Content Object（共享的完整二进制内容）
          ↓ 当前 physical revision
Telegram Anchor（实际承载分片/封面的消息）
```

方案演进必须保留以下结论：

| 方案 | 收益与局限 | 最终定位 |
| --- | --- | --- |
| 分片 hash → `file_id`，复用后重新 `sendDocument/sendMediaGroup` | 省正文流量，但每个 Logical File 仍产生新消息、限流、确认、回滚和删除工作 | 当前能力；共享模型上线前的兼容路径，不是最终去重机制 |
| 整文件 Content Key + PoP，仍复制物理消息 | 可以提前跳过浏览器正文上传，但没有解决重复 Anchor 生命周期 | 中间方案，不能作为最终验收结果 |
| 共享 Content Object + Telegram Anchor | 多个 Logical File 引用同一套物理内容；命中后零正文上传、零新存储消息 | 最终实施方案 |

必须遵守：

1. 多用户、多个目录、不同名称/MIME/业务 metadata 的 Logical File 可以引用同一 Content Object。
2. **命中且通过验证后，不上传正文，不重新调用 `sendDocument` 或 `sendMediaGroup`。**首次形成物理内容时仍允许渐进推送及 Album finalization。
3. 上传时跨用户复用必须经过 Proof of Possession（PoP）。不能凭 hash、`file_id`、候选存在或分片缓存命中授予访问权。
4. Content Key 只描述字节内容；不包含名称、目录、MIME、时间、权限、owner、分区、Bot、频道、Logical ID 等。
5. 不做 Content Block/hash denylist。审核某条 Logical File 不禁止以后重新上传相同内容。
6. 仍有 committed Logical references 的 Content Object，其有效 Anchor **绝不能删除或替换成占位文件**。
7. Logical File、Content Object、Anchor 生命周期分离；caption 只保存 Content/physical 排障信息，不再承担用户/Logical File 的归属。
8. Share、协同授权、审核、搜索、路径和用户额度仍按 Logical File 管理；共享内容不意味着共享权限。
9. 保留现有批量上传语义：**整批成功后才统一出现新文件**。混合命中/新上传也不得提前发布其中一部分。
10. 不改变代理控制策略、P2P/provider 传输策略、S3 协议或网页工坊业务。

## 2. 当前代码地图与旧草稿校准结论

### 2.1 真实入口

| 文件 / 函数 | 当前职责 | 重构落点 |
| --- | --- | --- |
| `server/telegram-drive.js` / `createTelegramDriveStore()` | Logical File、目录、上传 manifest、提交、复制、审核 tombstone | Logical 数据与 Content 绑定分离；保留路径/权限业务 |
| `server/disk-repository.js` / `openDiskRepository()` | Node 内置 SQLite、WAL、schema v1、CAS、短事务 | versioned migration、typed Content 表、引用/lease/cleanup 专用事务 |
| `server/disk-api.js` / `createDiskAPI()`、`contents()` | 浏览器/第三方/协同网盘 API、review、upload/recovery、下载 | preflight/PoP、Content resolver、统一 attach/release/replace/repair |
| `server/object-storage.js` / `createObjectStorage()` | S3 所用对象存储核心，`put/remove/deleteFile/copy/open` | 从 Logical 直接删消息改为引用操作；Copy 不再发存储消息 |
| `server/disk-api.js` / `uploadObjectStream()` | S3 流转为旧上传队列，顺序计算 SHA-256/MD5 | 复用已计算的可信整文件 SHA，保留 S3 checksum/ETag |
| `server/disk-progressive-upload.js` / `createProgressiveUploadRunner()` | 首片边收边推、分组 finalize、commit、异常保留/回滚 | 从 Logical upload 改成 Content candidate upload；命中走另一分支 |
| `server/growing-file-readable.js` | 已落盘区间读取、等待 writer、EOF 与关闭协调 | 保留，增加可信整文件 hash 持久化前不得释放全部源文件的约束 |
| `server/disk-telegram.js` / `createDiskTelegram()` | `pushChunk/finalizeGroups/uploadPhysical/upload/remove/check/syncCaption/uploadThumbnail` | 改为 physical representation 操作，禁止业务调用任意 Logical remove；复数 `syncCaptions` 包装位于 `disk-api.js` |
| `server/telegram-multipart.js`、`telegram-upload-progress.js`、`telegram-upload-scheduler.js` | multipart、真实请求体进度、共享 Bot/chat 调度及限流 | 保留基础设施；增加 Content/candidate/revision 标识，不另造上传器 |
| `server/disk-chunk-file-cache.js` | 分片 SHA/size/Bot backend → `file_id` 的 SQLite 缓存 | 保留作为物理构建优化；不替代 Content Key、PoP 或 Anchor |
| `server/disk-part-cache.js`、`disk-api.js:openRemoteRange()` | 共享正在读取的窗口缓存、多 owner scope、Range 流 | 入口改为固定 revision 的物理 part；不重写下载器 |
| `server/disk-shares.js`、`server/disk-collaboration.js` | Logical 范围的分享、邀请、成员与保护 | 保持 Logical 绑定；正文替换改为换 Content 引用 |
| `server/disk-operations.js`、`client/disk-client.js`、`client/disk-ui.js` | 任务、SSE/轮询、上传及缓存进度 | 增加 hash/PoP/reuse/attach 阶段，实际流量与逻辑处理量分开 |
| `tools/migrate-tgdisk-json-to-sqlite.cjs`、`tools/change-tgdisk-channel-id.cjs` | 旧 JSON 合并迁移、频道标识批量调整 | 适配新 schema/Anchor；保持停服、dry-run、备份和幂等 |

`createDiskSpaces()` 当前就在 `server/disk-api.js`，各分区 store 共用根目录的 `disk.sqlite`，用 `scope` 分区。**不存在独立的 `server/disk-spaces.js` 或已实现的 Content repository。**S3 路由在 `server/s3/routes.js`，核心对象存储已经独立到 `server/object-storage.js`，不能将所有 S3 业务都归到 `disk-api.js`。

### 2.2 对草稿的逐类判定

| 草稿内容 | 当前判定 / 调整 |
| --- | --- |
| 分片 `file_id` 复用已存在 | 准确；key 实际包含 backend hash、part SHA、size，`getFile` 验证后仍重新发消息 |
| 上传等待整个分片收齐才能向 Telegram 推送 | 对当前 progressive 路径已过时；首次落盘即唤起 growing reader；legacy/S3 路径仍等该片完整 |
| finalization、断点恢复、请求结果未知需补设计 | 当前已有 v2 manifest、逐组 durable IDs、未知结果保留、SQL 已提交识别；应扩展这些能力，而非重做 |
| 整文件 hash / Content / PoP 已可由分片数据直接形成 | 尚未实现；分片 SHA 拼接不是整文件 SHA；浏览器 progressive 没有可信整文件 hash 字段 |
| `putCopiedObject()` 可能展开源记录 | **仍存在**，`telegram-drive.js:946` 附近使用 `{ ...source, ... }`，只单独移除 `pendingRemoteCleanup`；应显式 allowlist 构造目标 |
| S3 没有完整 hash | 不准确；`uploadObjectStream()` 已算 `actualSha` 并校验请求，当前未持久化它；直接接入 Content commit |
| move 还会批量更新 caption 中 path | 已解决；`diskCaption()` 已无 path，move 不应重新引入 Telegram caption 工作 |
| rename 要取消 Logical caption sync | 仍需实施；当前 PATCH 改名、`syncCaptions/retryCaptions` 仍更新名称 caption |
| part cache 可以多 owner 共享 | 准确；当前为 v2、按所需范围以 1 MiB 对齐，不是一定下载整个 20 MB part；保留 remaining owners 和共享 fill |
| 删除/repair/overwrite/review 只需加 refCount | 不成立；目前直接操作 Logical 物理消息，需统一引用事务与 Anchor cleanup |
| `mediaIndex` 已是完整容器解析索引 | 不应如此表述；当前默认 `{mode:'unavailable'}`，浏览器视频声明 `container-parser-unavailable`，没有完整解析器 |
| `getFile` 成功等于 Anchor 存在 | 不成立；当前 `check()` 检查 file_id 可取，并不能证明存储消息仍存在 |
| 共享状态、Content migration、PoP API 已有 | 均尚未实现；本文后续结构全部是实施目标 |

草稿 1～7 的方案演进及产品结论继续采纳；8～19 按本文新模型/竞态设计实施；20～33 必须映射到当前删除、S3、repair、恢复代码；34 的批量语义明确继续整批提交；35～38 增加真实进度、物理标识兼容及可信 hash 回填；39～42 的三层生命周期/弃用原则保留；43～45 的“先本地校准再开发”已由本文落实。

## 3. 当前 Logical File、SQLite 与事务事实

### 3.1 文件与分片

`telegram-drive.js:commit()` 当前显式创建：

```text
id, ownerId, ownerName, ownerUsername, folderPath, name, type, size,
channelId, backendId?, messageId, mediaGroupId, fileId, fileUniqueId,
parts[], partCount, thumbnail, mediaIndex, fileIdHistory[],
createdAt, updatedAt, lastCheckedAt,
metadata?, sourceAppId?, captionWarning?, captionSyncPending?,
reviewStatus?, reviewUpdatedAt?, deletedAt?, pendingRemoteCleanup?
```

分片包含 `fileId/fileUniqueId/messageId/messageDate/mediaGroupId/mediaType` 与 `logicalFileId/partIndex/partCount/originalSize/offset/size/sha256`。首片的 IDs 又投影到 Logical File 顶层。thumbnail 是独立上传的 Telegram 文件/消息记录。目录是另一个实体，不能变成 Content。

目前不存在 `contentId`、整文件 `contentSha256`、共享引用关系或 Content physicalRevision。`fileIdHistory` 保存旧物理记录片段，但并非完整、版本化、可可靠定位 backend/channel 的物理历史。

### 3.2 当前数据库

`.tunnel-data/disk.sqlite` 使用 `node:sqlite`，`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=FULL`。`disk_schema_migrations` 当前版本 **1**，高于 1 的数据库会被现有代码拒绝打开。

当前 generic 表：

```text
disk_files / directories / users / apps / backends / tokens /
spaces / space_usage / shares / operations / chunk_ids /
cache_owners / collaborations / placeholders
```

其共同列为 `scope,id,owner_id,folder_path,name,payload`，主键 `(scope,id)`。`disk_file_parts(scope,file_id,part_index,payload)` 外键指向 `disk_files`，删除 Logical 行会 cascade 分片行。SQL `part_index` 是数组下标（0-based），payload 的 `partIndex` 是业务序号（1-based），迁移必须显式转换。文件 payload 不保存 parts 正文，只保存 `__partsHash`，`loadWithRevision('files')` 再组装 parts；这个 JSON 布局摘要也不是原文件二进制 SHA。

`disk_files_owner_name` 保证同 scope/owner/path/name 唯一；username、Telegram provider、share token、backend fingerprint 也已有唯一索引。Content 重构不得拆掉这些约束。

### 3.3 不能混淆的两个 revision

`loadWithRevision()` 返回的 `revisions:Map` 是**序列化 payload 的 CAS 快照**，用于 `replaceMany()` 检测 `DISK_WRITE_CONFLICT`；它不是 Content 的 physicalRevision。

`repository.atomic()` 使用同步 `BEGIN IMMEDIATE`，拒绝 async work；`replaceMany()` 差量写入并检查旧值。Telegram 网络工作在事务外，整批文件/目录索引只在最后短事务提交。当前服务的内存队列/用户 scope 序列化可保留，但**不能作为跨用户共享 Content 的唯一锁**。

新增 Content 表应提供专用 SQL 方法，在一笔事务中验证绑定、lease、state 与物理 revision。不能简单把表名塞进 `TABLES`，再用全表数组 `replaceMany()` 实现跨用户引用/GC。

## 4. 目标模型与 schema migration

以下表名、字段和 repository 方法为**建议新增，当前不存在**。本期只做一套共享 Bot 的物理表示，保留未来多 Bot representation 扩展空间。

### 4.1 三层数据归属

| 层级 | 权威字段 | 不应保存的权威状态 |
| --- | --- | --- |
| Logical File | id/owner/scope/path/name/type/metadata/sourceAppId、业务时间、审核、logicalContentVersion、自定义封面 | 当前 Telegram parts、物理清理债务、全局健康状态 |
| Content Object | id/contentKey/contentSha256/size/hashStatus、首次名称/MIME、currentPhysicalRevision、健康、状态 | 用户路径、当前 Logical 名称、分享/协同权限 |
| Physical Revision / Anchor | backend/channel、part offset/size/hash、Telegram IDs/消息时间/Album/mediaType、固有封面、caption 状态、cleanup | Logical owner/review/share/path |

`originalName/originalMimeType` 仅记录首次形成内容时的排障信息，之后复用/改名不会修改；MIME 不进 Content Key。物理位置属于 revision，即使当前只一个 backend，也不能把它误当作用户身份。

### 4.2 建议表及约束

| 表 | 关键列 / 约束 |
| --- | --- |
| `disk_contents` | `id PK, content_key nullable, content_sha256 nullable, size, hash_status, state, current_physical_revision, original_name, original_mime_type, health_status, last_checked_at, last_physical_error, created_at, updated_at, state_version` |
| `disk_content_keys` | `content_key PK, content_id FK, generation, claim_token, claim_expires_at`；每个 key 的可复用/构建候选只有一个当前 canonical 入口 |
| `disk_content_refs` | `scope, logical_file_id, content_id FK, logical_content_version`；`PK(scope,logical_file_id)`，FK → `disk_files(scope,id)`，index(content_id) |
| `disk_content_revisions` | `content_id,revision PK`，backend_id/channel_id、state、creator_candidate_id、时间、可信布局摘要；FK → Content |
| `disk_content_parts` | `content_id,revision,part_index PK`、offset/size/sha256、`selected_anchor_id FK`；FK → revision；part_index 连续，布局无洞/重叠，sum(size)=Content.size |
| `disk_content_anchors` | `id PK, content_id,revision,part_index nullable, role, telegram_realm, backend_id, physical_bot_id, channel_id, message_id, message_date, file_id, file_unique_id, media_group_id, media_type, state, caption_state`；物理唯一 `(telegram_realm,numeric_chat_id,message_id)` |
| `disk_content_leases` | `id PK,content_id,revision?,kind,upload_id,scope,owner_id,viewer_id,grant_id?,grant_version?,expires_at,fencing_token`；kind 区分 upload/reuse/PoP/read/repair |
| `disk_content_cleanup` | `id PK,content_id,revision,anchor_id,purpose,status,claim_token,attempts,next_attempt_at,last_error`；同一 Anchor/purpose 幂等唯一 |
| `disk_content_pop_challenges` | id、真实viewer/session/目标owner/scope/grant及版本/upload/fileIndex、key/Content/revision、ranges/nonce/digest、expires_at/consumed_at；机密 digest 不出 API |
| `disk_content_upload_batches` / `disk_content_upload_files` | batch ID、operation/真实viewer/目标owner与scope、状态、commit token/result IDs；按 `(upload_id,file_index)` 保存目标名称/目录预约、reuse lease或candidate upload ID及预期replacement版本；到期/提交索引 |

主绑定真相是 `disk_content_refs`。Logical payload 可保留 `contentId` 作为兼容投影，但所有写入必须与绑定同事务，并进行一致性检查。不得维护另一套可独立改写的 authoritative contentId。refCount 可做统计缓存，删除必须查询真实 refs 和有效 leases。

每个ACTIVE revision的part必须明确选定一个已经确认且同Content/revision/part的final Anchor；`selected_anchor_id`是权威绑定，不能从多条TEMP/FINAL/退休记录中“找第一条”。构建时可空，发布revision时事务验证全部已选且offset/size/hash一致。cyclic FK可通过先建parts、再建Anchor、最后选定的同事务顺序或deferred FK落地。

Anchor身份不能直接用backend记录UUID或token hash。当前默认backend可能无ID，同Bot也可经多个配置记录/地址访问同一消息；token轮换不意味着消息变成新物理资源。采用稳定Telegram realm（云/本地Bot API如果访问同一Telegram网络应归同realm）+**已确认的数字chat_id**+message_id，backend_id只负责凭据路由，已验证`getMe.id`可记录访问Bot身份但不改变同一Chat消息身份。历史public→数字Chat使用现有resolver/字典的确认映射，无法归一化的记录保留raw定位并隔离GC，不能猜测后建立重复Anchor所有权。cleanup、迁移重叠检测也用相同规范化键。

`disk_content_keys` 的唯一性解决“同 key 同时创建”与“旧对象已进入 DELETING，允许新 generation”之间的冲突。不能在所有 Content 行上简单加永久 `UNIQUE(sha256,size)`，否则删旧代期间无法按草稿要求创建新代。DELETING 时按 token 移除旧 canonical 绑定；后续新对象可 claim 同 key，旧对象仅继续清理自己的 Anchor。BROKEN 对象有现存 refs 时仍保留自身身份，可 repair；是否重新建立 canonical 入口必须 CAS 检查，不覆盖另一个已经 READY 的候选。不同历史对象的自动合并另走显式迁移事务。

小心所有 `ON DELETE`：删 Logical 可以 cascade 绑定，但 Content/Anchor 使用 RESTRICT/显式 GC，不能 cascade 触发 Telegram 删除。`disk_file_parts` 旧表在过渡期保留为 legacy/read-only 兼容与回退备份；新 Content 的 parts 不再归属 Logical ID。

### 4.3 Migration v2

在 `disk-repository.js` 增加按 version 执行的同步 schema migration：

1. 停服备份 `disk.sqlite`（含 WAL，通过现有 backup 机制），检查完整性。
2. 同一短事务创建 Content 表、FK/索引、schema version 2；不在 migration 里访问 Telegram或扫描下载大文件。
3. 结构迁移与可信hash backfill分开。首阶段可由legacy resolver读取尚未绑定的旧文件；**开放共享及统一release前必须完成最小legacy包装和全库Anchor冲突核验**。推荐停服分批包装；若lazy包装，需要操作前原子`ensureLegacyBinding()`及全库物理定位索引，不能把缺绑定删除回退到旧Logical remove。
4. 引用及物理表用新专用方法，例如 `claimContentKey/attachLogicalBatch/releaseLogicalBatch/replaceLogicalContent/claimCleanup/finishCleanup/switchPhysicalRevision`，都是同步事务。
5. 现有 JSON 导入脚本应读新 schema，导入 Logical 后走相同 legacy backfill；禁止旧 generic parts 写入覆盖新绑定。
6. schema v2 后旧程序不应写库。回退使用停服备份，不是强行把 migration version 改回 1。

Migration 重跑无重复绑定；refs 无孤儿；Content 物理布局完整；数据库检查与业务一致性检查同时通过，才可进入下一阶段。

## 5. Content Key、可信 hash 与渐进上传的结合

### 5.1 内容身份

固定编码：

```text
sha256:v1:<十进制字节数>:<64位小写 SHA-256 hex>
```

SHA 为原文件全部字节按顺序的 SHA-256。大小使用 safe integer，按现有文件上限验证。零字节的 key 使用 SHA-256(empty)；S3 目录 marker 是目录元信息，**不创建 Content**。零字节普通对象可引用不含 Anchor 的空 Content；删除不得发空的 Telegram 清理请求。

分片边界、mediaIndex、压缩/转码结果、文件名均不参与 key。客户端声明是候选查找线索，不是可信 hash。新内容成为 `READY` 前必须由 Node 顺序验证整文件 SHA/size。

### 5.2 当前缺口与实施方式

当前 progressive `receivePart()` 只计算该 part SHA。`markProgressiveFinalized()` 在 final groups 保存后会释放该文件暂存正文；v2 manifest 没有可信整文件 hash。实施时：

- 浏览器采用 Worker 中的增量 SHA，按 Blob slice 读取，不能把 2 GB 文件整体 `arrayBuffer()`。UI 显示“计算文件内容摘要”，允许取消。
- **preflight/PoP 必须在 `store.begin()` 启动物理推送之前**。命中路径不能先建消息、之后再宣称复用成功。
- MISS 后继续当前 near-real-time progressive writer/reader；Node 对实际接收的原文件字节顺序更新整文件 hash，并在全部字节验证后持久化 `verifiedContentSha256` 与 key。
- hash 准备不可避免需要读取本地整个文件；不能承诺加入 preflight 后“无需 hash 就立即推第一字节”。允许用户走普通上传作为 fallback，但这种路径不保证 Browser → Node 零流量去重。
- 单片重试不能重复计入 hash。若 hash 的增量状态失效，按完整落盘 parts 有序重读。Node Hash 内部状态不能当作可重启序列化状态。
- **可信整文件 hash 未 durable 保存前，不得删除最后一份可重算 hash 的源字节。**可复用当前 manifest 持久化与读者关闭机制；如需提前释放部分 staging，必须先设计可靠的有序 full hash checkpoint/重读来源。
- S3 `uploadObjectStream()` 已顺序更新 SHA/MD5；把 `actualSha` 传入统一 Content candidate commit，不增加一次完整读取，也不改变 checksum 错误和 ETag。

历史 `logicalManifestHash` 只可作为候选索引：同内容不同切片会得出不同结果，不能充当完整 SHA，更不能绕过 PoP。

## 6. PoP 协议与访问边界

### 6.1 协议建议

建议在现有 `contents()` 路由族添加如下能力，**这些 API 当前尚不存在**：

| 建议 API（浏览器 base `/api/telegram/drive`） | 行为 |
| --- | --- |
| `POST /uploads/preflight` | 批量 name/path/type/size/key；检查权限、名称冲突、额度和目标目录；返回每文件 `upload_required` 或不泄露源身份的 verification 流程 |
| `POST /uploads/:uploadId/files/:index/pop-challenge` | 生成不可预测的一次性 ranges/nonce，绑定用户与候选 revision |
| `POST /uploads/:uploadId/files/:index/pop-proof` | 只接收客户端 digest；成功生成短时 reuse lease，不能直接创建已显示的 Logical File |
| 现有 `POST /uploads/:uploadId/finish` | 整批验证 complete 后原子 attach/commit，兼容既有 202 operation 响应 |

也可把 challenge 直接并入 preflight 响应，但客户端不得根据候选裸 `contentId` 调用不受限制的 attach。第三方 API 按原 app/user/disk_space 权限提供同语义；协同路由必须继续检查获授权路径及目标对象。

返回只含 upload/fileIndex/challengeId/nonce/ranges/expiry。不得包含来源 owner/目录/Logical ID、Telegram IDs、refCount。服务器不得返回 expected digest。未授权者不能通过 hash API直接下载或列举 Content。

preflight先创建durable轻量batch/operation与目标名称预约，返回业务`uploadId`；HIT只保存proof/reuse lease，MISS才建立physical candidate staging。当前`store.begin()`只建暂存job，真正推送由`operations.run()`启动；不得为了拿到uploadId就提前走这条物理runner。新batch文件索引保持用户原顺序，内部candidate ID与业务uploadId显式映射，PUT/finish/取消/恢复由facade路由；全命中批次也有完整operation/result/幂等commit载体。

协同 middleware 当前把请求数据操作身份切换为 owner，同时保留真正访问者 `diskViewerId`。PoP/session/rate-limit 必须绑定真正 viewer，**不能因为请求已经借用 owner 的存储 scope 就当作同用户跳过 PoP**。业务目标 owner 与证明提交人分别记录。

### 6.2 digest 精确定义

保留草稿确定的“双方只交换挑战与 digest，不交换样本正文”。建议 wire v1 统一为：

```text
SHA256(
  UTF8("Drop2Tunnel-PoP-v1\0") ||
  nonceBytes[32] ||
  uint64be(offset) || uint32be(length) ||
  sampleBytes
)
```

nonce/ranges/expected digests 在数据库绑定 challengeId、session/user、scope、uploadId、fileIndex、Content Key、Content ID、physicalRevision、到期和 consumed 状态。客户端不能更改 ranges；重复 proof/finish 通过 idempotency 返回既有结果，不重复 refs。proof 比较采用固定长度与 timing-safe compare；消费 proof 与创建 reuse lease 同事务。

建议初始 6～8 个分散不重叠范围，每个 32～64 KiB；小文件覆盖整个文件，零字节文件为已知空内容，不生成零长度随机range，也不建Anchor。服务端通过 Content resolver 的固定 revision 从现有窗口 cache/Range 下载读取，计算同一 digest；任何读失败、内容健康异常、revision 更换、挑战过期均不授权。慢速回源时告知等待，并允许改走普通上传，不扩大成完整文件后台下载。

这是随机抽样的持有验证，**不是数学上证明每个字节都持有**；抽样风险随对手已持有的内容比例和次数变化。参数、失败次数、速率、有效期和每用户并发需要有上限；不将“8 次抽样”宣称为无条件安全保证。对未经确认的来源无法生成 proof 时只能拒绝复用或正常上传。

preflight是否进入验证流程可能间接透露某个hash存在，不应宣称完全消除了内容存在性oracle。采用统一错误、挑战配额、最少响应信息和日志脱敏控制风险；不返回其它用户身份/目录/权限或样本正文。授权撤销/账户退出后，即使旧proof成功，最终attach也必须重验session/grant版本。

同一用户已授权访问已有 Logical File，可以走受控的内部引用创建；跨用户上传按 PoP。S3 Copy 的来源必须先通过 S3 自身读权限，不能由 hash 查找扩展为跨账号 Copy；未来跨用户 Copy 若开放，应走相同 PoP/显式授权产品协议，不自动免验。

## 7. 上传、send、finalization 与整批提交

### 7.1 当前链路（应保留的基础）

```text
POST /uploads（progressive opt-in）
  → store.begin + manifest
PUT /uploads/:id/files/:index + Content-Range
  → receivePart 首次落盘 onReady
  → 独立 growing reader → pushChunk/sendDocument
  → Telegram 确认 → markPartsUploaded durable
  → 全文件临时 parts 确认 → finalizeGroups/file_id Album
  → 每个 final group 先保存真实 Message IDs
POST /finish → durable clientDone
  → thumbnail（可选）→ 整批 store.commit
  → 任务完成；临时消息清理债务留待重试
```

正文 part 上限当前 `20_000_000` 字节；legacy multipart batch 上限 `40_000_000`。progressive 单片推送后，以 `file_id` 组合最终 Album，分组 2～10 个，避免尾组只有 1 个；单片文件可沿用临时消息作为 final Anchor。新 Content 的首次物理构建可保留这套机制。

`pushChunk()` 当前 hash 缓存可用时仍 `sendDocument`，`finalizeGroups()` 仍产生新 Album。不要把它们误报为共享 Content 已实现。

### 7.2 新状态：业务候选与物理候选分开

每个 batch file 记录二选一：

```text
hashing → preflight
  ├─ candidate hit → pop_pending → reuse_verified → reference_pending
  └─ miss → claim_candidate → receiving/pushing → physical_finalizing
              → content_hash_verified → content_ready → reference_pending
整批所有文件 reference_pending → logical_batch_committed
```

reuse 文件仅持有 lease；不建立“已发布 Logical File”、不造 temporary message、不生成上传正文 multipart。MISS 候选预分配 Content ID、physicalRevision、candidate token，再使用现有调度器/manifest。

当前分片状态 `receiving/queued/pushing/awaiting_response/retry_wait/push_confirmed/push_unknown/push_failed/source_aborted` 与 final group 的 confirmed/unknown 可继续使用。不要把 Content READY 等同于 operation completed：Content 可以已形成，但整个 Logical batch 尚未完成。

### 7.3 提交事务

同一 `BEGIN IMMEDIATE` 内：

1. 重验各目标名称/owner/scope/额度、协同授权版本以及 replacement 的旧 Logical version。
2. 逐文件重验新 Content READY 或可复活的 DELETE_PENDING、proof/reuse lease、canonical generation。
3. 显式构造 Logical allowlist；插入/更新 `disk_files` 和 `disk_content_refs`，处理 replacement 旧引用；触及目录时间/目录及协同路径关联按现有语义同事务。
4. lease 转为 committed refs；记录 durable batch commit 标识及 result Logical IDs。
5. 对失去最后引用的旧 Content 标记 DELETE_PENDING。提交后才安排 cleanup/通知/任务完成。

整批任一失败全部 Logical 创建/替换回滚。命中文件释放本批 lease；**从不删除被命中的共享 Anchor**。本批首次创建且无 refs 的候选进入自己的异步补偿流程。处理重复 finish/进程重启时先查 durable commit 标识，不依赖仅存在于内存的 Promise。

## 8. 状态机、短事务、并发与 fencing

### 8.1 Content 与 revision

```text
CREATING → READY → DELETE_PENDING → DELETING → DELETED
               ↑       │ 未被 worker claim，事务内 attach 可取消删除
               └───────┘
READY → BROKEN → REPAIRING → READY（新 physicalRevision）
```

`DELETED` 保留诊断记录或按保留政策归档；不保留未来上传阻断。`MIGRATING` 用于显式物理迁移（若本期实现），不能自动破坏旧 READY 读者。revision 分别为 BUILDING/ACTIVE/RETIRED/CLEANUP_PENDING/CLEANED；Anchor 分别为 TEMP/FINAL/UNKNOWN/CLEANUP_PENDING/DELETED/PLACEHOLDER。Content、revision、Anchor 的状态不得用同一个字段代替。

历史可读包装可以是`READY + hash_status=legacy_unverified`，允许原Logical继续读取，但不进入verified key索引/跨用户hash命中；新构建Content的READY则必须`hash_status=verified`。状态可读与可信内容身份是两个判定。

### 8.2 关键竞态规则

| 竞态 | 必须采取的规则 |
| --- | --- |
| A/B 已完成 preflight 的同 key 首传 | 短事务 claim `disk_content_keys`；唯一成功者构建。另一方等待/PoP，不并行无界构建两套 Anchor |
| client hash 声明后不上传 | candidate lease 限时、限并发；过期按 fencing token释放 claim，不永久占用 key |
| READY 与最后引用释放 | attach/release 都在共享数据库短事务读 state、refs、leases，不能只依赖每 owner JS mutex |
| DELETE_PENDING 与新 proof attach | 尚未 cleanup claim 时可事务恢复 READY；过期/已 claim proof 拒绝，不在事务外复活 |
| DELETING 与同 key新上传 | 不复用旧 Content；新 generation 构建，旧 worker只能删自己 Anchor |
| repair 与 replacement | CAS 绑定的 logicalContentVersion/contentId；同内容修物理，异内容换 Logical引用 |
| 两个 cleanup worker | 带 claim token/expiry 的 outbox；失效 worker不能写回新状态或删当前 revision |
| 正在 Range 读取与 revision退休 | read lease固定 revision；只在读者释放/lease到期且确认无有效读请求后清旧 revision |
| key命中但 metadata不一致 | metadata 留在各 Logical File；禁止为另一个用户更新原 Content 名称/权限 |

leases 应有 heartbeat、到期与 fencing token；长期读/repair可续租。GC不得仅凭时钟误差删除仍活跃的任务。多进程也必须满足约束；当前调度器为进程级，不能当数据库锁。SQLite事务中禁止 Telegram await、hash整文件、ffmpeg、等待浏览器或睡眠重试。

未预知完整 key 的 S3/legacy streaming candidate 在接收后才竞争 canonical key：允许暂时各自形成物理 candidate，最终只有一个作为可复用入口，其余仅补偿**自身**未被引用的 Anchor。这个情况不适用“第一字节前只有一个 uploader”的承诺。声明 key 的预占也不是 trusted 身份，实际 full SHA 不一致时释放自己的 claim，禁止把虚假候选升级 READY。

## 9. 删除、目录删除、审核、覆盖与 cleanup

### 9.1 统一 release，取消 Logical 直接物理删除

当前 `object-storage.js:deleteFile()` 先删 `pendingRemoteCleanup` 和当前 messages，再 `store.remove()`；`disk-api.js` 的普通/递归删除会调用它。review 删除也删物理后 tombstone。共享后这些入口全部改为 `releaseLogicalBatch()`：

```text
授权 / 协同删除保护 / review规则检查
    → 事务 detach refs + remove/tombstone Logical
    → refs>0：不调用任何 Telegram remove/editMessageMedia
    → refs=0 且无保留lease：DELETE_PENDING + outbox
    → 事务外 worker清理
```

目录 A/B 同指 C1，须批量释放两个 refs后判定一次，不逐文件相互竞态。`tombstone()`/`tombstoneDirectory()` 保留 review 业务记录，但移除 Content binding；不能继续在 Logical tombstone 上保存可访问的当前 Content 引用。blocked 不等于 deleted：blocked 记录仍保持 refs，禁止 GC其内容。

Share/协同只能通过当前 Logical记录访问。A 删除后 A 的分享失效，即使 B 仍引用同 Content；不能让历史 share绕回物理IDs继续读取。协同项目仍按现有规则要求先停用协同，再普通删除。

### 9.2 物理 cleanup

worker 在短事务重查 refs、leases、revision/Anchor角色与 outbox，claim后才到 Telegram清理。当前 `remove()` 的 47小时57分边界、1 Byte placeholder、每Bot placeholder缓存与剩余片继续尝试策略可以复用，调用对象必须是授权的 Anchor 集合。

Telegram [deleteMessage](https://core.telegram.org/bots/api#deletemessage) 有48小时限制；本地提前3分钟选择较保守窗口。[sendMediaGroup](https://core.telegram.org/bots/api#sendmediagroup) 的 Album 数量限制与[getFile](https://core.telegram.org/bots/api#getfile) 的文件下载/链接规则仍需遵守；`getFile`不是按 message_id查 Anchor存在的接口。没有可靠确认的物理结果必须记录 UNKNOWN，不能根据 caption猜测“肯定没发出去”。

cleanup完成逐 Anchorack，重复消息已不存在按可识别错误幂等；编辑失败保留债务重试。超过窗口的占位文案用 Content排障名，不绑定任一当前Logical名字。caption失败不导致重复发送正文。

### 9.3 `pendingRemoteCleanup` 的迁移

目前至少包括 replacement旧物理消息与 progressive临时消息，两种目的不能混用：

- `temporary-upload`：只删本candidate已被final Anchor替代的 TEMP，保留当前 final IDs。
- `retired-revision`：只清该Content的旧 revision，等待读者lease。
- `unreferenced-content`：只有最后Logical refs释放且无leases后清最终Anchor。
- `abandoned-candidate`：只清未被任何Content/Logical接纳的本candidate物理输出。

这些债务迁入 Content/Anchor outbox，不再由某一Logical File持有并任意重放。旧债务导入前与**所有当前有效Anchor**交叉检查；匹配到仍活跃的message直接隔离审计，不能执行。幂等键含规范化realm/numeric chat/message及purpose；messageId单独不够，backend配置UUID也不能代表唯一物理消息。

## 10. Repair、replacement、物理历史与健康

当前 `/files/:id/repair` 有两套语义：普通repair只验证size相同，并未比较整文件SHA；协同请求可换size/type，保留Logical ID并删除`before`物理messages。不能机械改成“所有repair更新Content.parts”。

实施拆成：

- **`repairContentObject()`**：输入可信完整SHA和size必须等于C1，先构建revision2，再短事务CAS切当前revision；A/B/C共同恢复。旧revision只按独立债务清理。普通持有者可提供修复副本，但权限、SHA和索引完整性必须重验。
- **`replaceLogicalContent()`**：新正文得到C2，事务将A从C1换到C2并递增logicalContentVersion；B继续C1。协同仍绑定A，已有协同成员只能通过A读取更新后的正文，不获得C1/C2其它Logical授权。

`fileIdHistory`转换为Content physical revisions；Logical异内容替换是另一个版本概念。当前history缺backend/channel/thumbnail等，不声称旧history可全部自动恢复；缺信息的记录保守隔离，不拿当前backend强行解释旧fileId。兼容check的旧file_id恢复必须确认属于当前Content的可信revision，不能重新激活已经归属别的Logical的内容。

健康状态迁到Content，`lastCheckedAt/healthStatus/lastPhysicalError/repairedAt`按内容共享，再投影到各Logical UI。`check()` 当前主要`getFile`校验，不保证消息存在；hash/layout实际验证与Anchor可达性是不同检查。BROKEN仍有refs时保留记录和修复入口，不能因“坏了”自动释放权限/删除全部用户文件。

## 11. Caption、thumbnail、mediaIndex

### 11.1 caption

当前`diskCaption()`保留user_id/disk_space/name/channel_id/logical_file_id/part/original_size/file_id/message_id/album_id，以`.slice(0,1024)`截断。`diskThumbnailCaption()`也有用户/Logical字段。progressive最终Album已避免把**临时**message/file/group IDs错误写入最终caption，但未实现完整Content两阶段caption。

新Content caption示例：

```text
Drop2Tunnel Content
content_object_id: <C>
physical_revision: 1
part: 2/19
original_size: 370123456
message_id: <final-message>
file_id: <final-file-id>
file_unique_id: <unique-id>
name: <first-upload-name>
mime_type: <first-upload-mime>
```

预分配C/revision发送初始caption；Telegram响应真实IDs先durable保存，再将补全任务放到physical caption outbox。数据库为真相，不用caption恢复私有权限。必留C/revision/part/message/file字段完整；对name/MIME单独限长，按Telegram限制预算，不再整体截断。

Logical rename/move/metadata/review/share/collaboration不调用caption编辑。删除`captionSyncPending`的Logical职责，替换`syncCaptions/retryCaptions`为physical finalize/repair重试；旧`captionWarning`只能投影物理诊断，不重试旧用户caption。

### 11.2 thumbnail

当前`receiveThumbnail/markThumbnailUploaded/uploadThumbnail`作为每个上传文件的可选独立Telegram消息，最终Logical.thumbnail持有IDs。内容固有图片缩略图、音频内嵌封面、视频确定性帧图改归Content revision/derived asset；有共享引用时不可清理。reuse hit直接使用已有固有封面，不重复上传封面。

用户自定义封面若未来开放，归Logical.customThumbnail，单独受权限和生命周期管理。提取失败仍为warning，不回滚完整正文；提取参数/算法版本不同可重新生成derived asset，不能改变Content Key。

### 11.3 mediaIndex

当前store接收`file.mediaIndex`，API原样输出或`{mode:'unavailable'}`，浏览器尚未具备完整容器parser。实施时只将经校验的duration、tracks、codec、keyframes、container layout等固有属性归Content；标签/展示偏好留Logical metadata。来自客户端的索引有size、offset、range边界和版本校验，不因hash命中就相信其它用户上传的任意JSON。

与分片布局有关的derived data绑定physicalRevision，与二进制容器有关的数据绑定contentSha/算法版本；换revision/格式后按依赖失效，不把所有mediaIndex机械移走。

## 12. 下载、窗口缓存、浏览器缓存与隧道备用来源

所有读取先做Logical权限/review/share/collaboration检查，再resolver到当前Content+固定revision，最后沿用`prepareRemoteResponse → objectStorage.openFile → openRemoteRange → partCache.open → telegram.readPart`。返回HTTP名称、MIME、Content-Disposition仍来自Logical。

当前`openRemoteRange()`的cache key为`v2/backendHash/fileId/partSize/partSha/cacheStart/cacheEnd`，所需区间1MiB对齐；`disk-part-cache.js`默认TTL2天，支持inflight共享、读者中止不取消其他fill、多owner scopes、清理时保留remaining owners。保留这些行为；加入稳定physical revision定位/一致性检查，不能每Logical ID复制一份缓存。

物理cache命中不授权。登记cache owner时使用本次请求的Logical访问scope/实际请求人，协同/Share场景不得错误拿Content首次creator当所有者。按用户清理只移除该scope，仍被其他scope使用或正在读的缓存不得误删。全部管理员清理保持现有busy保护。窗口只有覆盖完整part才可校验其整片SHA，局部窗口不能伪称已通过全片hash。

浏览器当前`client/telegram-drive-cache.js`正文key仅Logical ID，status主要比较Blob size；缩略图key为`thumbnail:v2:id`。`disk-client.js:readFile()`和UI也有等size接受缓存的逻辑，尚未实现内容版本校验，这是草稿遗漏的牵连点。

实施后完整缓存按Logical ID与**logicalContentVersion/二进制内容身份**校验；相同大小异内容replacement也必须失效。正文、thumbnail、播放器进度记忆都适配该版本；同内容physical repair则可以保留有效正文及进度，rename/move不应误清缓存。UI的“已缓存”只表示当前版本完整缓存，不能把另一个同Content/同名文件的缓存误当已缓存。读取已开始时固定revision，禁止前半旧物理/后半新物理混拼。

隧道`client/disk-tunnel-adapter.js`、`client/file-assets.js`、`server/file-assets.js`及`app.js`已使用Telegram备用字段和serverAssetUrl。保留provider/P2P优先、缓存记录版本和回源权限；只改物理来源的内部解析，不靠相同hash把隧道文件权限扩散。历史Chat字典/public→数字chat_id兼容继续在物理resolver/backend层工作；不得将已迁移ID降级。

## 13. S3 PUT / DELETE / Copy 与零字节对象

`server/s3/routes.js`保持SigV4、credential、bucket/user/disk_space映射、XML、Range、ETag/Last-Modified输出。当前并未完整实现If-Match/If-None-Match/304/412等条件请求，不能列为已有能力；如另有需求，应独立实施。这里只调整其调用的`server/object-storage.js`和统一Content服务，不另造S3上传/下载系统。

| 入口 | 当前实现 | 实施目标 |
| --- | --- | --- |
| PUT | `uploadObjectStream()`逐片接收，legacy pipeline上传，full SHA/MD5校验，最后commit | 完整流仍按S3规范接收；actualSha汇入Content。有已有候选线索时先接收/校验而不推Telegram，确认命中后attach；未预知key的流单独处理candidate竞争 |
| overwrite | Logical ID通常保留，旧representation存pendingRemoteCleanup | 同一事务换C1→C2，release C1；旧共享Anchor不由overwrite直接删 |
| DELETE | `deleteFile()`先远端删消息再remove Logical | 短事务release，符合S3结果后异步physical cleanup；已不存在仍幂等 |
| Copy同Bot | `getFile`后`uploadPhysical(reuseFileId)`新发消息，再`putCopiedObject` | 来源授权后Target绑定相同C，无send/getFile作为复制必需步骤；显式构造目标业务字段 |
| Copy跨backend | 当前读源再PUT | 同Bot且允许共享的目标可直接引用已有representation；不同Bot或明确隔离的后端不得裸复用file_id，须保持兼容复制或显式representation迁移，不改变Content身份 |
| 0B普通文件 | `putMetadataObject`无parts/messages | 空Content绑定或明确metadata-only兼容，不能发Telegram空文件cleanup |
| `key/`目录marker | 独立directory.s3Marker | 保持目录语义，不参与Content去重 |

S3请求本身通常没有浏览器preflight/PoP协议，不能承诺FolderSync“已命中就不发送PUT正文”。可信完整PUT已经提供正文，可在验证后附着同Content。有合法完整SHA声明且查到候选时，声明仍不可信，但可选择**暂存并验证正文、不启动Telegram推送**；最后真实SHA/size匹配才attach，实际命中必须零新存储消息。声明不匹配返回原checksum错误，不能错误附着候选。

无完整SHA声明（例如UNSIGNED-PAYLOAD）的PUT在EOF才得到key：严格零Telegram重复方案需先全文件spool再查key，代价是失去Node→Telegram的早推；保留当前早推方案则仅保证最终canonical共享，未知key/并发MISS可能生成loser物理输出并补偿。**本期建议保留未知key流的现有早推兼容，不把它包装成快速命中主路径或声称符合零消息验收**；已知候选路径与内部Copy须达到零新消息。不可通过非标准请求或提前返回S3成功来掩盖该边界。

ETag继续使用当前`metadata.s3ETag`的MD5语义；legacy fallback当前用parts JSON hash，迁移时保存原ETag或建立兼容值，不能因为仅改变存储位置/分片边界让同步客户端误判正文变化。Content SHA不能直接替换所有S3 ETag。

Copy的Logical allowlist至少包含新owner/scope/id/path/name/type、按S3规则选择的metadata、新业务时间和content binding；不复制review/deletedAt、share/collab授权、fileIdHistory、captionSyncPending、pendingRemoteCleanup。对覆盖目标执行相同version CAS和保护规则。

## 14. Share、collaboration、review 与其它外围业务

Share仍`share → Logical → Content`，token/revocation/范围/过期保持现状。删Logical分享失效；**Share不额外保留已经被删除的Logical旧Content**。将来若要“分享历史版本”须明确独立pin，本期不悄悄增加这种保留语义。

协同仍绑定`rootPath/fileId`、owner、成员和邀请，contentId相同不互通协同权限。目录移动与协同路径当前已有同SQLite事务保护，必须保留。协同上传路由隔离、路径限制、一次性邀请、所有者删除保护及iframe视图保持原行为。

review的blocked/deleted继续区分：blocked绑定仍占用内容，deleted/tombstone释放引用。管理员Content反向查询可以返回所有Logical refs，但普通用户不得查询其它owner。管理员显式批量unavailable/delete仅影响当前记录，不新增Content Block。

`server/telegram-content-manager.js:uploadArchive()`目前**不是创建普通Logical File**，而是直接把消息JSON发成托管频道document，并保存独立`archivePointer`；`readArchive()`和附件media route直接用指针/file_id读取。它的Chat/message索引与Content refs无关。

因此本期Content GC只能清理明确属于该Content/revision的Anchor，**不能扫描整个托管频道，把没有Logical refs的Bot归档消息判成垃圾**。若以后归档接入Content，要新增显式archive-reference类型与生命周期，不能伪造Logical ref或本次顺手扩展GC。Chat目录、消息顺序、发送方、reply关系仍属聊天业务。向目标Chat发送附件是对外发消息业务，允许必要的send；与“命中共享存储不得再向托管频道send”区分。`tests/features-260918-2.test.cjs`的archive指针/回源测试也应继续通过。

`createDiskSpaces().usages()`目前是app/user/space使用记录，不是Content物理占用统计。用户逻辑容量每Logical.size计算，共享不抵扣其它用户的逻辑额度；物理占用按唯一有效revision/Anchor计算。后台data-usage/cache清理统计需避免多引用重复计费，实际Telegram永久资源与本地缓存容量分列。

`hasChannel()`当前扫描Logical.channelId，配置删除后端/频道使用检测应查Active Content revisions、保留lease和cleanup debt，而非只扫当前Logical。频道ID变更工具应改Content Anchor/revision并核对staging/旧history/债务；如果只是同Chat public→数字ID，不应凭标识改写就增加physicalRevision或宣称重新上传。确实搬到另一Chat才按物理迁移流程。

## 15. API输出、兼容投影与安全

当前`publicFile()`只输出Logical信息、partCount/mediaIndex/thumbnailAvailable；`uploadResultFile()`另输出telegramFileId、telegramFileUniqueId、telegramChatId、telegramMessageId、telegramPartFileIds、serverAssetUrl。分享API使用自己的公开投影，管理API还能拿到更完整记录。

实施应提供`resolveLogicalContent()`与`assembleLegacyPhysicalView()`：旧内部下载/回源仍可得到parts等字段，但它们是**只读投影**，不能拿投影回写Logical或任意remote delete。旧`disk_file_parts`与新Content.parts不得同时成为权威。

共享后不同用户可能见到相同Telegram IDs。需要按API用途处理：

- 普通list/search继续Logical-only，不加入global key/hash/refs。
- 现有网盘第三方/隧道适配器确实依赖upload结果的物理字段，首阶段通过授权后projection保持兼容，文档说明这些不是所有权凭据。
- 新接入优先Logical ID + version + serverAssetUrl；敏感physical诊断限制管理员/明确的受信app能力。不能未经评估直接删旧字段而破坏隧道fallback。
- 服务端asset读取始终重验当前Logical授权；不能仅凭Telegram IDs/contentId访问共享内容。
- 附带logicalContentVersion供浏览器版本失效；隐藏跨用户source/候选信息，返回稳定而不揭露他人目录的错误。

同步更新`docs/adapter/telegram-disk-api.md`（传统API）及`docs/telegram-drive-s3-compatible.md`（S3）；二者保持用途分离。修改上传manifest/API应有明确version/capability，旧client仍走兼容非reuse路径，而不是误触新schema删除。

## 16. Recovery、rollback、未知请求与 staging

当前v2 manifest已经保存owner/scope/collaboration、Logical IDs、parts/sourceComplete、attemptIntent、pushedBytes、tempRemote/finalRemote、finalGroups、clientDone、committedIds、recoveryDisposition、pendingRollbackParts。`activateRecoveredUpload()`重新检查完整源与SHA，逐组已确认结果不会重发；SQL已提交但任务未完成窗口只补任务状态。

`createProgressiveUploadRunner()`在明确失败时回滚已知消息；全请求体可能已发送但响应丢失时保留UNKNOWN和完整源/清单，禁止盲目自动重发。`abortAsync/preserveForRecoveryAsync`等等待writer/readers关闭，避免Windows句柄占用。**这些已实现的故障补救必须保留。**

新增manifest建议version3：candidateContentId/contentKey声明与可信hash状态、physicalRevision、claim/fencing token、每文件reuse lease/challenge状态、batch commit token、各Anchor用途和outbox关联。不要持久化Bot secret/session cookie或把proof成功布尔值作为跨会话永久授权。

恢复顺序：

1. 先查SQLite batch commit与refs；已committed只补operation完成/收尾。
2. 已READY且refs存在的Content禁止rollback anchors；同batch别的文件失败只释放本batch未提交lease。
3. 新candidate确认消息durable，但SQL未commit：验证claim/source/hash，继续原candidate，不重发已确认正文/组。
4. stale manifest声称“没提交”，SQLite却有引用：以SQLite为准。manifest不能授权删共享内容。
5. UNKNOWN请求保留candidate/outbox诊断，不盲目send或假设消息不存在；无法确认的未知孤儿列为人工核对项。
6. expired upload先reconcile refs/leases/fencing，再清自己的candidate/temp anchors；不能把owner任务到期等同Content无人使用。
7. source已删而full hash未保存：不得随意生成READY；从可信物理range重算或保留不可复用状态，不能用part hash冒充。

Telegram发送和SQLite无法构成分布式原子事务，不能宣称Exactly Once。目标是已知结果幂等、不误删共享资源、未知结果可诊断保留、状态可恢复。只有确定失败/拒绝的请求才按现有safe retry规则重发。

## 17. 历史数据迁移与工具

结构migration不自动拉Telegram。建议新增`tools/migrate-tgdisk-content-objects.cjs`及使用说明，默认dry-run，apply要求停服和SQLite备份，分批checkpoint，报告与幂等token持久化。

### 17.1 安全顺序

1. **先包装、不合并**：每个现存Logical建立legacy Content/revision/Anchor；trusted full hash未知则`hash_status=legacy_unverified`、key为空，不参加跨用户hash复用；读取照常。
2. 旧parts有完整SHA时生成仅候选用manifestHash。相同fileUniqueId或part hash不是完整SHA证明。
3. 确认backend/channel/message角色、size与part布局。历史单片兼容合成parts；缺message/未知backend等记录单独报告，不猜测补齐。
4. 必须避免两个Content分别“拥有同一个message”并各自GC：完整同一Anchor集合可以建立同一legacy表示与多Logical refs；只部分重叠、当前与cleanup冲突的集合隔离为迁移异常，暂停其物理GC直到核对。仅相同file_id但不同message代表独立Anchor，不能机械删除其中一套。
5. 用户/管理员主动backfill时通过固定revision逐片读取，顺序计算完整SHA；优先现有cache，限并发/速率；在目标仍未变更的短事务写verified key。
6. 多legacy Content同key时，验证真实字节/物理健康后选择canonical；所有Logical refs在短事务重绑，旧Anchor等待read/recovery leases后清理。合并的是内容，owner/share/collab/review不变。
7. pendingRemoteCleanup/history、tombstone、0B对象分别处理；绝不因为待清理snapshot含某Anchor就执行删除。

新JSON→SQLite导入应继续保持现有用户身份映射、用户名冲突安全处理、分片缓存冲突保留现值、source备份和整次apply事务，之后增量legacy包装。已经迁移的文件重复执行不得生成第二个Content、重复refs或重复清理。

`change-tgdisk-channel-id.cjs`和诊断采集工具要认识新表与Anchor定位；沿用现有参数/停服要求，不仅改Logical投影。未verified历史Content也须可继续定位旧Chat并修复。

### 17.2 迁移验收报告

至少：Logical总数/有效数/tombstone数、已绑定数、legacy未hash数、verified数、canonical数、Anchor数、重复/重叠Anchor异常数、refs不一致数、cleanup冲突数、各scope目录/Share/协同关系是否保持、dry-run/apply后二次dry-run差异。任何未知关系都保持原数据可读并报告，不“自动清理到没有错误”。

## 18. UI、operation progress 与错误语义

现有浏览器XHR连续上传进度、Telegram真实请求体已发送与确认字节、SSE/fallback轮询、后台任务切换保持。`server/disk-operations.js`增加Content阶段，UI不能以Logical大小伪造网络发送量。

```text
正在计算内容摘要 · 读本地 80/370 MB
正在验证文件持有证明 · 3/8
已复用共享内容 · 19个物理分片 · 正在建立文件引用
整批提交完成
```

分开计数：`logicalBytesProcessed`、`clientBytesReceived`、`telegramBytesSent`、`telegramBytesConfirmed`、`reusedBytes`、`filesReady/filesTotal`。reuse的发送字节为0；hash/PoP可显示自身进度，禁止显示虚构上传速度。

后台可按Content查看physical health/revision、refs（管理权限）、Anchor、cleanup retry；普通用户仍看自己的Logical任务。命中候选、PoP失败、hash不符、Content正在构建、Content已删除、SQL冲突、UNKNOWN远端结果有明确但不泄露其它用户的信息。复用的lease被回收时可重新preflight/上传，不能返回“用户已取消”掩盖网络失败。

整批文件只有commit后刷新列表；成功形成Content但Logical batch失败不得显示部分“上传成功文件”。恢复仅完成共享引用时也触发原有目录/列表刷新机制。前台文件目录、业务metadata来自Logical，不从Content.originalName替换。

## 19. 测试计划：真实现有基础与新增用例

本次为文档静态核验，不将建议测试写成已通过的Content功能测试。下列现有文件已读取/检索其对应实现与覆盖点，后续开发应实际重跑并补充断言。

| 现有测试 | 应保留并扩展的内容 |
| --- | --- |
| `tests/disk-repository.test.cjs`、`disk-metadata-concurrency.test.cjs` | WAL原子写/失败回滚、旧视图CAS、schema too new；新增typed refs/FK/claim竞争 |
| `tests/telegram-drive.test.cjs`、`disk-upload-staging.test.cjs` | 目录/文件冲突、批量提交、顺序分片；新增Logical allowlist与Content绑定 |
| `tests/disk-progressive-staging.test.cjs`、`telegram-progressive-push.test.cjs` | 首次落盘即推、fixed Content-Length、EOF验证、final IDs；新增整文件hash持久化释放约束 |
| `tests/disk-progressive-api.test.cjs`、`disk-progressive-api-boundaries.test.cjs`、`disk-progressive-client.test.cjs` | opt-in、鉴权/输入、SSE/XHR、legacy边界；新增mixed preflight/PoP/reuse |
| `tests/disk-progressive-faults.test.cjs`、`disk-progressive-recovery.test.cjs` | final组恢复不重发、SQL提交后崩溃、push/final UNKNOWN、manifest故障；新增candidate/lease/refs reconcile |
| `tests/telegram-upload-scheduler.test.cjs`、`telegram-upload-progress.test.cjs` | Bot/chat限制、owner公平、429 cooldown、真实body进度；新增reuse零发送与Content诊断key |
| `tests/disk-storage-regression.test.cjs`、`disk-telegram-upload-recovery.test.cjs` | 分片/Album fallback、47h57m占位、剩余片清理；新增共享Anchor保护与幂等outbox |
| `tests/disk-chunk-cache-integrity.test.cjs`、`disk-part-cache.test.cjs` | 分片hash/cache验证、range fill、多owners/清理；新增同Content多Logical与revision切换 |
| `tests/telegram-drive.test.cjs`、`disk-client.test.cjs` | 网盘上传独立封面、cache UI；新增reuse固有封面与同size replacement正文/thumbnail/进度失效 |
| `tests/disk-collaboration.test.cjs`、`disk-collaboration-persistence.test.cjs` | 范围隔离、邀请消费、路径同事务、删除保护；新增共享内容不共享权限/协同异内容replacement |
| `tests/disk-sharing.test.cjs`、`disk-api.test.cjs`、`disk-storage-regression.test.cjs` | share权限/停止、下载/api/review；新增删除A不影响B且A分享失效 |
| `tests/s3-gateway.test.cjs`、`s3-list.test.cjs`、`s3-sigv4.test.cjs`、`s3-admin.test.cjs` | 协议/ETag与Range/授权与bucket；新增Copy零TG、overwrite共享释放、0B、MD5/SHA仍正确 |
| `tests/disk-json-migration.test.cjs`、`tgdisk-channel-id.test.cjs` | JSON导入、冲突/备份/ID变更；新增Content legacy包装、重跑与GC冲突隔离 |
| `tests/features-260918-2.test.cjs`、`telegram-chat-dictionary.test.cjs` | Bot独立archive/读取、托管消息循环避免、Chat兼容及provider独立；新增Content GC不触碰非Content归档 |

建议新增独立Content测试文件（名称可按仓库风格调整）：

- `disk-content-repository`：refs与Logical同事务、跨scope同Content、多repository进程竞争、key唯一claim、lease过期/旧worker fencing、integrity/FK检查。
- `disk-content-pop`：错digest/nonce/offset/长度、过期/重放/跨session/跨user、revision变化、服务端读失败、候选信息不泄露、极小/空文件。
- `disk-content-lifecycle`：A/B共享，删A零remove，删最后一个后GC；blocked不释放、tombstone释放；目录批删；DELETE_PENDING复活；DELETING拒绝attach；repair/read/GC竞态。
- `disk-content-upload`：全命中zero send、全miss渐进首片、mixed整批成功/失败、claimed hash与真实hash不一致、finalized后full hash可恢复、发送未知保留。
- `disk-content-copy-replace`：S3同内容Copy无需getFile/send、相同大小不同内容替换、协同replacement只影响一个Logical、metadata/review/history不继承。
- `disk-content-migration`：旧JSON/SQLite/legacy parts、同Anchor/部分重叠、缺backend/history、tombstone/0B、二次执行零增量、backup恢复、在途manifest与cleanup债务交叉。

必须以instrumented fake Telegram验证**调用次数**，不能只验文件列表。安全用例断言仍有引用的Anchor从未出现在deleteMessage/deleteMessages/editMessageMedia参数中；故障用例在每个 durable boundary注入异常/重启。至少用两个独立SQLite连接/进程验证claim，而不是仅同一个JS队列。

完成单元/HTTP集成后灰度验收：同用户同内容异名、多用户本地同内容PoP、已有hash但无正文的攻击、19/21/38片首次上传、mixed多文件、Range播放拖动、Share停止、协同replacement、S3 FolderSync PUT/Copy/Delete、长时间后台上传及重启。以真实Telegram日志证明hit没有新存储消息；对外聊天发送不计入该零消息断言。

`tests/telegram-cover-regression.test.cjs`属于Telegram歌曲分享封面而非网盘独立封面上传测试，可作为外围回归保留。测试原有user/logical caption、part.logicalFileId断言需改为Content/revision归属；不能只删掉旧断言而不补新归属断言。

## 20. 分阶段实施顺序与每阶段验收

| 阶段 | 开发范围 | 放行条件 |
| --- | --- | --- |
| 0 基线固定 | 保留当前progressive改动；核对本文函数与测试；记录当前HEAD/工作区 | progressive现有回归通过，明确legacy/S3边界，业务数据备份可恢复 |
| 1 schema与resolver | v2 typed表/refs/repository、最小legacy包装及Anchor全库交叉核验、只读projection、空对象、专用事务 | 读旧文件/Share/协同/S3不变，FK/CAS与schema回退保护通过；不启跨用户复用 |
| 2 生命周期先行 | 所有delete/review/replacement/cleanup/recovery改为Content/Anchor语义，caption/thumbnail归属调整 | 任何已有refs的Anchor都不可删；fault/GC/repair/read竞争通过 |
| 3 新内容构建 | 整文件trusted hash、candidate/key claim、v3manifest、渐进上传/Album/physical caption | 首次上传连续推送保持；同key竞争/未知结果/重启可恢复；整批commit不变 |
| 4 preflight与PoP | Browser增量hash、batch候选、一次性challenge、reuselease、UI | 跨用户拒绝hash-only攻击；reuse正文0字节、存储send0次；mixed失败不伤共享Content |
| 5 S3与外围适配 | Copy refs、PUT actualSha、overwrite、APIprojection、Chat附件、频道工具/diagnostics/文档 | S3原有协议/FolderSync/隧道provider不变，Copy零新Anchor，ID兼容不扩权 |
| 6 历史hash升级 | 完善dry-run/异常报告、主动full hash backfill、canonical合并、停服备份脚本 | 最小包装已完成；Logical IDs/Share/协同保持，重复执行幂等，重叠Anchor/债务不能误删 |
| 7 灰度开启 | 先同用户引用，再跨用户PoP；cleanup先观察后执行 | 真实日志核对refs/物理消息/网络字节，回归通过，存储指标与DB一致 |

阶段2必须先于任何真正共享引用开放。不能先上线global reuse，再“随后补删除保护”。各阶段不得混用旧Logical remove和新Content refs。

灰度关闭reuse入口只阻止新增复用；已有共享Content仍必须由新resolver/lifecycle读取维护，不能切回旧直接删物理实现。恢复旧数据库只能完整停服回滚数据库/manifest/代码一致的备份，不允许旧代码对新库继续写。

## 21. 最终验收清单

- [ ] 命中同内容后不上传正文、不创建新存储消息，Logical名称/目录/metadata独立。
- [ ] 跨用户上传复用PoP一次性、绑定完整、失败不授权、不泄露来源。
- [ ] trusted整文件SHA与客户端声明一致；不同分片边界得到同key；MIME/name/owner不入key。
- [ ] shared refs、leases、key claim、物理revision在SQLite短事务内一致，网络不进事务。
- [ ] A删除/覆盖/tombstone不影响B；最后ref后的清理幂等、可恢复，DELETING不复活。
- [ ] 普通repair只接受同内容；协同异内容替换仅换Logical引用；Range固定revision。
- [ ] progressive首片增量推送、真正发送/确认进度、finalization、UNKNOWN/rollback均保留。
- [ ] mixed批量仍统一显示；rollback只清本candidate，不清命中共享Anchor。
- [ ] caption无user/path/Logical语义，真实IDs先入库，caption失败不重发正文。
- [ ] 固有thumbnail/mediaIndex分层正确，缓存权限/TTL/多owner清理及版本失效正确。
- [ ] S3 Copy无需Telegram、PUT checksum/ETag不变、0B与directory marker分开。
- [ ] Share/协同/review/Chat/隧道provider/API授权不因相同Content扩权。
- [ ] 旧JSON/SQLite/历史pendingCleanup/manifest migration幂等、可备份回退、未知信息保守报告。
- [ ] 所有关键竞态/fault/recovery用例与真实Telegram灰度调用计数通过。

本指南的最终约束是：**Logical File 管业务，Content Object 管字节身份与共享引用，Telegram Anchor 管物理持久性。**任何新功能若绕过这三层边界，尤其直接拿Logical投影删除共享messages，都不能视为本次重构完成。

## 附录 A：原草稿逐章处理记录

这里的“保留”表示保留设计结论，不表示当前代码已经实现；“已解决”仅指具体旧问题，不表示共享Content功能完成。

| 原草稿章 | 校准结果 | 本指南落点 |
| --- | --- | --- |
| 1 背景 | 保留三层拆分目标，新增工作区实际基线 | 1～3 |
| 2 演进 | 保留file_id重发→整文件PoP→共享Anchor演进；当前Copy仍是旧路径 | 1、2、13 |
| 3 PoP | 保留digest-only；补wire编码、真实viewer、lease、概率验证边界 | 6 |
| 4 Content Block | 明确弃用，不以review建立未来上传禁令 | 1、9、14 |
| 5 共享Content | 保留；当前尚无Content表/引用 | 4、7 |
| 6 不重复send | 保留hit零新消息；明确未知key S3流不属于快速hit分支 | 7、13 |
| 7 裸file_id | 保留Anchor长期持久模型，不承诺删消息后file_id永久有效 | 1、9 |
| 8 数据模型 | 重设计为真实Logical字段+typed refs/revision/Anchor；derived兼容输出 | 3、4、15 |
| 9 Physical Revision | 保留，明确与现有payload CAS完全不同 | 3、8、10 |
| 10 caption | 仍需改；当前有user/disk_space/Logical ID，但已去path | 2、11 |
| 11 两阶段caption | legacy已有，progressive final IDs已durable但caption未补全；新物理outbox | 7、11 |
| 12 caption长度 | 现仍整体slice，需关键字段预算 | 11 |
| 13 Thumbnail | 上传阶段封面已存在，改归内容/自定义分层 | 11 |
| 14 mediaIndex | 当前多为unavailable，不假设完整parser；按实际依赖拆分 | 11 |
| 15 Logical删除 | 仍需统一release，不能只改某条route | 9 |
| 16 Anchor清理 | 核准47h57m/1B策略；已有TEMP低优先级清理可复用 | 9 |
| 17 refCount | 保留关系真相；独立typed refs/FK，不靠裸计数 | 4、8 |
| 18 状态机 | 补candidate/revision/Anchor/Logical batch四种状态与legacy可读边界 | 7、8 |
| 19 复活竞态 | 保留DELETE_PENDING可取消/DELETING禁止，采用canonical key generation | 4、8 |
| 20 删除/review | reviewer直接remove是额外高危入口；全部纳入release | 9、14 |
| 21 pendingCleanup | 现混合旧覆盖/TEMP两义，迁为四类独立债务 | 9、16 |
| 22 repair | 现普通仅等size，协同则异内容replacement，必须拆语义 | 10 |
| 23 collaboration | 保留Logical授权；新增viewer与等长缓存版本牵连 | 6、10、12、14 |
| 24 S3 PUT | 已有fullSHA但丢弃；保留协议流、统一换refs | 5、13 |
| 25 S3 Copy | `{...source}`风险仍在，实际独立object-storage模块；零新Anchor | 2、13 |
| 26 History | 现有history字段不完整，不能自动猜backend/channel | 10、17 |
| 27 Range | 保留真正按需窗口流，入口换固定revision | 12 |
| 28 cache | 多owner已实现；补浏览器size-only缓存缺陷与版本失效 | 12 |
| 29 Share/协同 | 保留Logical绑定，说明Share读当前正文而非固定旧revision | 9、14 |
| 30 health | getFile不能证明Anchor存在/完整SHA，分级健康记录 | 10 |
| 31 backend/channel | 改查revision/lease/debt；规范realm+数字chat消息身份 | 4、14 |
| 32 recovery | v2恢复/UNKNOWN/SQL commit识别已存在，扩展ownership与v3，不从零实现 | 7、16 |
| 33 并发去重 | 不用永久UNIQUE所有历史行；预声明claim与未知key late竞争分开 | 4、8、13 |
| 34 mixed批次 | 明确维持全部成功后一次Logical commit；hit也需业务reservation | 6、7 |
| 35 进度 | 连续真实bytes/SSE已实现；reuse不伪造网络大小/速度 | 18 |
| 36 API物理IDs | 普通list不暴露，upload结果真实供隧道使用；兼容投影先保留 | 15 |
| 37 反向引用 | 新Content管理员查询，普通用户不看其它owner | 14、18 |
| 38 历史ManifestHash | 只候选；最小legacy包装先行、完整hash主动回填 | 5、17、20 |
| 39 三层生命周期 | 保留，并补Bot独立归档不是Content垃圾 | 4、9、14 |
| 40 牵连面 | 按当前真实模块扩展缓存版本、viewer、归档、schema工具 | 2、9～19 |
| 41 已采纳 | 所有最终产品原则保留；当前单Bot内容key不含Bot | 1、4～18 |
| 42 弃用方案 | 保留；file_id重发仅legacy/fallback，不计共享成功 | 1、2 |
| 43 执行前置 | 已完整读草稿并以本地实际文件重新校准，不实施业务 | 开头、2 |
| 44 建议prompt | 由本正式指南替代重复提示词，提供阶段/事务/测试落点 | 19～21 |
| 45 最终原则 | 保留Logical/Content/Anchor生命周期分离 | 1、21 |

## 附录 B：本轮文档核验范围

本轮完整读取原草稿，分别审计存储/迁移、上传/物理生命周期、S3/Share/协同/API/缓存/隧道外围，并进行交叉复核。正文中的当前事实来自本地实际文件，不从旧GitHub调查直接推定。Telegram硬限制补充核对官方Bot API，外部引用仅用于协议约束，不替代本地事实。

本轮未运行Content功能测试（功能尚未开发），未迁移数据库、未发Telegram业务请求、未启动上传或cleanup，也未改业务代码。第19节是后续实施需要执行的测试与验收计划。当前既有未提交progressive代码及其它工作区改动保留；本轮新增的交付文件只有本指南。
