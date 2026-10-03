# Drop2Tunnel：逻辑文件内容复用与共享 Content Object 重构指南（WEBGPT 分支校准版）

> 文档性质：**基于 WEBGPT 临时分支当前代码重新校准后的设计/实施前置指南**
>
> 当前校准分支：`dev/2609-s5-disk-chunks-progressive-push-WEBGPT`
>
> 当前代码基线：`{{WEBGPT_BASELINE_SHA}}`（生成本文档前该分支最新 HEAD；本文档提交本身不计入该基线）
>
> 原始草稿：`prompts/dev-prompt-logs/[draft]dev-shared-content-object-design-guide-261003.md`
>
> 原始草稿的代码调查基线：`dev/2609-s5-disk-chunks-progressive-push@09ad7a56e28ec066054deaf7e7d8dffbeb789971`
>
> **本文档已重新对照 WEBGPT 分支当前代码。后续如果该分支继续发生较大变动，真正实施前仍应先核对最新 HEAD；但不要再把旧草稿中的 09ad7a56… 代码状态当成当前事实。**

---

## 0. WEBGPT 分支当前代码事实与本设计的关系

这部分是相对原始草稿最重要的校准。共享 Content Object 尚未实现，但 WEBGPT 分支的 Telegram 上传链路已经发生了较大变化，后续开发必须在这些现有能力之上改造，而不是回退或重做。

### 0.1 当前已经存在的渐进式上传基础

WEBGPT 分支已经具备：

- `server/growing-file-readable.js`：Telegram reader 只读取已经真正写入 staging 的字节，追上写入点后等待增长，不提前 EOF；
- `server/telegram-drive.js`：分片在 Browser PUT 尚未结束时即创建 `receiving` chunk，并维护 `writtenBytes/sourceComplete`；
- `server/telegram-multipart.js`：支持 `streamFactory` 的增长源，同时保持精确 Content-Length；
- `server/disk-api.js`：浏览器每次落盘进度会唤醒 Telegram pipeline；
- Telegram 物理分片当前先独立 `sendDocument` 获取临时 `file_id/message_id`；
- 全部分片确认后，再以这些 `file_id` 生成最终 `sendMediaGroup`；
- final Message[] 持久化后才清理临时消息；
- cleanup 失败可以保留为后续清理债务；
- Telegram scheduler 当前已有全局/目标级并发、启动 pacing 和 429 `retry_after` 冷却；
- 上传 Operation 重启后先进入 `recovering`，再由 staging recovery 判断残留状态；
- Browser → Node 和 Node → Telegram 的连续进度、速度、当前文件/分片及最终媒体组进度已经进入居中 Loading UI。

**共享 Content Object 重构必须复用这些能力。** 正常首次上传仍走上述渐进式 physical creation；只有命中已有 READY Content Object 并通过 PoP 的逻辑文件，才绕过正文上传和 Telegram physical creation。

### 0.2 当前仍然是“Logical File 直接拥有 physical”的部分

当前 `server/telegram-drive.js` 在 commit 时仍直接把以下 physical 字段写入 Logical File：

- `channelId/backendId`；
- 顶层 `fileId/fileUniqueId/messageId/mediaGroupId`；
- `parts[]`；
- `thumbnail`；
- `mediaIndex`；
- `fileIdHistory`；
- `pendingRemoteCleanup`；
- `captionWarning/captionSyncPending`。

这正是共享 Content Object 要拆开的核心。

### 0.3 当前数据库仍是 schema v1，physical parts 仍属于 file

`server/disk-repository.js` 当前：

- schema version 仍为 1；
- `TABLES` 里没有 Content Object 表；
- `disk_file_parts(scope,file_id,part_index,...)` 外键直接指向 `disk_files`；
- repository 已经具备 SQLite WAL、短事务、`BEGIN IMMEDIATE` 和 revision/CAS 风格的持久化能力。

因此共享 Content Object 需要真正的数据迁移，而不是只在 Logical File payload 里再塞一个 `contentId` 就结束。

建议方向是引入 Content Object 主记录及 Content Part 物理记录，并让 Logical File 只持有 `contentId`。具体采用新的规范表还是沿用 generic payload + 专用 part table，应在实现时结合 repository 现状确定，但 physical part 的 source of truth 不应继续是 `disk_file_parts → disk_files`。

### 0.4 当前分片 file_id cache 已天然跨用户

`server/disk-chunk-file-cache.js` 当前 key 实际为：

```text
backendKey(baseUrl + token)
+ sha256
+ size
```

没有 ownerId / diskSpace，因此在当前共享 Bot 前提下，分片级 file_id cache 已天然允许跨用户命中。

共享 Content Object 不应破坏这一既有能力。未来它可以继续作为：

- 首次创建新 Content Object 时的 physical part 优化；
- physical repair 时的分片级复用；
- Content Object 整体 MISS 时的次级去重。

### 0.5 当前 S3/Object Storage Copy 仍会重新创建 Telegram messages

`server/object-storage.js` 当前同 backend Copy 的实际路径仍是：

```text
source.file.parts[]
→ reuseFileId
→ getFile 校验
→ telegram.uploadPhysical()
→ 新 Telegram Message[]
→ store.putCopiedObject()
```

因此“同 Content Object 的 Copy 退化为 O(1) Logical reference”仍是共享模型需要完成的真实改造点。

如果实施时本分支又发生变化，应重新核对这一条，而不要只按本文档函数名机械修改。

### 0.6 当前删除仍会直接删除 Logical File 对应的 Telegram physical

`server/object-storage.js::deleteFile()` 当前会先处理 `pendingRemoteCleanup`，再直接调用：

```text
telegram.remove(backendOf(file), file)
```

然后才：

```text
store.remove(...)
```

`server/disk-telegram.js::remove()` 当前按约 47h57m 的内部阈值选择：

- 较新的 message：`deleteMessage`；
- 超过阈值或 Telegram 拒绝 delete：`editMessageMedia` 替换为 1 Byte placeholder。

共享 Content Object 后必须把“什么时候可以调用 `telegram.remove`”上移到 Content Object 引用生命周期层：只有最后一个 Logical reference 被释放并成功进入物理清理状态时才能调用。

底层 `telegram.remove()` 本身仍然可以作为 Content Object physical cleanup primitive 使用。

### 0.7 当前 caption 仍然是 Logical/User 语义

`server/disk-telegram.js::diskCaption()` 当前仍包含：

- `user_id`；
- `disk_space`；
- 当前 `name`；
- `channel_id`；
- `logical_file_id`；
- part/original_size；
- Telegram file/message/album IDs。

`syncCaption()` 也仍然按 Logical File 重新同步这些字段。

因此共享 Content Object 后，caption 的改造仍然是实质工作：

- 删除 Logical/User 级 caption sync；
- 保留 physical finalize / repair caption；
- 增加 `content_object_id` 与 `physical_revision`；
- 将 `name/mime_type` 固化为 Content Object 首次创建时的 original metadata。

### 0.8 当前 Loading UI 已有真实双链路进度，复用路径必须增加“非网络阶段”

`client/disk-ui.js::formatDiskUploadLoading()` 已经能展示：

- Browser → Server 有效字节/百分比/速度；
- 当前文件和分片；
- Server → Telegram 有效字节/百分比/速度；
- 分片确认；
- 正文 100% 后的最终媒体组进度。

因此 Content Object HIT + PoP 成功时，不能伪造上述网络字节。应在现有 Operation/Loading 体系中增加独立的 dedupe/PoP/reference 阶段，例如：

```text
已找到可复用内容
  - 正在验证文件持有证明

已验证已有 Content Object
  - 19个现有物理分片
  - 正在建立逻辑文件引用
```

并保证正常 MISS 上传继续沿用当前双链路进度。

---

## 1. 背景与最终目标

当前网盘已经具备 Telegram 物理分片级的 `file_id` 复用能力。最初的新需求是进一步支持**完整逻辑文件内容复用**，包括跨用户复用：当用户准备上传一个系统内已经存在的相同文件时，不再重新上传全部分片。

讨论最终将目标从“省掉一次文件上传”提升为“把逻辑文件与物理内容彻底拆层”：

```text
Logical File
    ↓
Content Object
    ↓
Telegram Physical Parts / Anchor Messages
```

一个 Content Object 可以同时被多个用户、多个目录、多个不同文件名的 Logical File 引用。

最终预期收益：

- 相同内容无需重复 Browser → Node 上传；
- 相同内容无需重复 Node → Telegram 上传；
- 命中共享 Content Object 后，不再重新执行 `sendDocument` / `sendMediaGroup`；
- Telegram 不再为每次逻辑文件复用创建一套重复 messages；
- S3 Copy、普通网盘复制、未来“保存到我的网盘”等能力可退化为 Logical Reference 创建；
- Logical File 生命周期、Content Object 生命周期、Telegram Anchor 生命周期互相解耦。

---

# 2. 方案演进

## 2.1 第一阶段设想：收集旧分片 `file_id`，重新 `sendDocument/sendMediaGroup`

最初方案：

```text
找到相同逻辑文件
    ↓
收集 source.parts[].fileId
    ↓
sendDocument / sendMediaGroup
    ↓
Telegram 返回新的 Message[]
    ↓
保存新的 file_id / message_id
    ↓
创建新的 Logical File
```

例如 19 个分片：

```text
旧 Content：19 个 file_id
    ↓
sendMediaGroup 10
sendMediaGroup 9
    ↓
19 条新 Telegram Message
    ↓
新 Logical File
```

### 优点

- 与现有架构接近；
- 当前 S3/Object Storage Copy 已有类似 `reuseFileId` 路径；
- 每个 Logical File 仍拥有自己独立的一套 Telegram messages；
- 删除和回滚语义简单；
- 可以快速作为过渡方案。

### 缺点

它只实现“上传流量去重”，没有实现“物理存储去重”。

```text
A：19 条 Telegram messages
B：19 条
C：19 条
D：19 条
...
```

仍会产生：

- Telegram API 调用；
- 限流与重试；
- 新 Message[] 的确认与持久化；
- rollback/cleanup；
- Telegram channel 中越来越多的重复 messages。

此外，如果纯 `file_id` 重发路径仍受 `MAX_TELEGRAM_BATCH_SIZE` 之类的字节限制，它还会被不必要地拆成小批次；对于只发送 JSON + `file_id` 的场景，真正需要遵守的主要是 Telegram 的 media group item 数量限制，而不是正文总字节数。

### 最终结论

**降级为过渡/fallback，不再作为最终主方案。**

---

## 2.2 中间方案：整文件 Content Key + PoP

为了在 Browser 上传正文前就发现“这个完整文件已存在”，必须有整文件内容身份。

### Content Key

最终确认 Content Key 只描述二进制内容本身：

```text
contentKey =
    schemaVersion
    + contentSha256
    + fileSize
```

例如：

```text
sha256:v1:370123456:ab12cd34...
```

#### 参与 Content Key

- 完整文件 SHA-256；
- 文件总大小；
- hash/schema 版本。

#### 明确不参与 Content Key

- 文件名；
- 目录；
- MIME；
- 创建时间；
- 修改时间；
- 访问时间；
- 权限；
- 所有者；
- userId；
- diskSpace；
- metadata；
- sourceAppId；
- 上传时间；
- Telegram `file_id`；
- Telegram `message_id`；
- Telegram channel；
- Logical File ID；
- review 状态。

目前已经确认 Bot 为多用户共用，而且目前不会存在第二个 Bot，所以 **Bot fingerprint 也不进入 Content Key**。

如果未来出现多个 Bot，应在 Content Object 的 physical representation 层处理，而不是改变内容身份。

---

# 3. 跨用户复用必须有 Proof of Possession（PoP）

不能只相信客户端声明：

```text
contentSha256 = H
size = N
```

否则用户只要知道私人文件的 hash，就可能让系统把自己并不持有的内容关联进自己的网盘。

因此跨用户 Content Object 复用必须经过 PoP。

## 3.1 最终接受的 PoP 方式

服务器和客户端**不交换样本正文**，只交换挑战参数和 digest。

```text
客户端：
计算整个本地文件 contentSha256 + size
    ↓
preflight

服务器：
命中候选 Content Object
    ↓
生成一次性 challenge
    ↓
随机若干 offset + length + nonce

服务器：
从已有 Telegram Content Object 读取相同 range
计算 digest

客户端：
File.slice(offset, offset + length)
计算 digest
    ↓
只提交 digest

服务器：
逐项比较
    ↓
全部一致
    ↓
PoP verified
```

### 推荐 digest

不要只做：

```text
SHA256(sampleBytes)
```

而建议：

```text
SHA256(
    "Drop2Tunnel-PoP-v1"
    || nonce
    || offset
    || length
    || sampleBytes
)
```

### challenge 至少绑定

```text
challengeId
userId / session
contentKey
fileSize
nonce
offset/length 集合
expiresAt
consumed/usedAt
```

要求：

- offset 由服务器随机产生；
- challenge 一次性；
- 短时有效；
- 客户端不能自己选 offset；
- 不向客户端暴露候选来源的 owner、Logical ID、目录、message_id 等信息。

讨论建议值：

- 6～8 个尽量分散且不重叠的 range；
- 每个约 32～64KiB；
- 最终参数由 Codex 根据本地最新实现重新权衡。

---

# 4. 被明确否决的 Content Block / Denylist

曾提出过：

```text
contentKey → blocked=true
```

即某内容一旦因为审核被删除，以后任何人上传相同内容都禁止。

**最终明确否决。**

原因：

- 审核业务不能污染纯文件上传；
- 被删内容以后仍允许原用户或其它用户重新上传；
- 用户轻微改变文件内容即可产生新 hash，内容级阻断收益有限。

可以支持的是后台反向查询：

```text
Content Object
    ↓
所有引用该内容的 Logical File IDs
```

管理员未来可以显式批量执行：

```text
content unavailable
```

或：

```text
content delete
```

但这只是作用于当前 Logical references，不形成“以后禁止该内容再次上传”的 Content Block。

---

# 5. 最终主方案：共享 Content Object

最终决定采用：

```text
                 ┌─ Logical A
                 ├─ Logical B
Content Object ──┼─ Logical C
                 └─ Logical D
        ↓
Telegram Physical Parts
        ↓
Telegram Anchor Messages
```

## 第一次上传

```text
Browser → Node
    ↓
Node → Telegram
    ↓
创建 Telegram physical parts
    ↓
创建 Content Object C1
    ↓
Logical A → C1
```

## 其它用户上传完全相同内容

```text
contentKey 命中
    ↓
PoP
    ↓
PoP verified
    ↓
不上传正文
不 sendDocument
不 sendMediaGroup
    ↓
创建新的 Logical B
    ↓
Logical B → C1
```

A/B/C 可以拥有不同的：

- 文件名；
- 目录；
- MIME；
- metadata；
- owner；
- 权限；
- sourceAppId；
- review 状态；

但共同引用同一个 Content Object。

---

# 6. 为什么最终不再为每次复用调用 sendDocument/sendMediaGroup

如果每次复用都重新发送 `file_id`：

```text
旧 19 个 file_id
→ sendMediaGroup 10 + 9
→ 新 19 条 Telegram messages
```

虽然避免了 370MB 正文上传，但 Telegram messages 仍不断重复。

共享 Content Object 后：

```text
物理内容始终只有一套 anchor messages
A/B/C/D 只是 SQLite 中多个 Logical references
```

因此最终方案是真正的物理存储去重。

---

# 7. 明确不采用“裸 file_id、无 message anchor”模型

虽然 Telegram Bot API 支持复用 `file_id`，但不能把“原 message 全删后 `file_id` 永久有效”当成 Drop2Tunnel 的长期存储契约。

因此最终要求：

> **只要 Content Object 还有任何 Logical File 引用，就必须保留承载其 physical parts 的 Telegram anchor messages。**

---

# 8. 数据模型拆分

## 8.1 LogicalFile

Logical File 只保存用户/业务语义：

```text
LogicalFile {
    id
    ownerId
    diskSpace

    name
    folderPath
    mime

    metadata
    sourceAppId

    createdAt
    updatedAt

    reviewStatus
    reviewUpdatedAt

    contentId

    customThumbnail?
    ...
}
```

Telegram physical parts 不应继续作为 Logical File 的 source of truth。

## 8.2 ContentObject

```text
ContentObject {
    id

    contentSha256
    size

    originalName
    originalMimeType

    physicalRevision

    backendId
    channelId

    parts[]

    thumbnail?
    mediaIndex?

    state

    createdAt

    lastCheckedAt
    repairedAt
    healthStatus
    lastPhysicalError

    cleanupState
    cleanupAttempts
    cleanupError
}
```

### `originalName`

仅表示 Content Object 第一次形成时的原始上传名称。

以后 Logical A/B/C 使用不同名称，都不修改它。

### `originalMimeType`

仅表示第一次形成 Content Object 时记录的 MIME。

MIME 不参与 Content Key。

## 8.3 ContentObject.parts[]

建议至少保存：

```text
partIndex
partCount
offset
size
sha256

telegramFileId
telegramFileUniqueId
telegramMessageId
telegramMessageDate
telegramMediaGroupId
telegramMediaType
```

---

# 9. Physical Revision

接受增加：

```text
physicalRevision
```

例如：

```text
Content C1
physicalRevision = 1
```

以后如果发生：

- Telegram message 被误删；
- `file_id` 失效；
- 分片损坏；
- physical repair；
- 重新上传；
- 重新分片；
- 物理迁移；

但内容仍完全相同，则：

```text
contentObjectId 不变
contentSha256 不变
physicalRevision: 1 → 2
```

`physicalRevision` 不参与 Content Key。

---

# 10. Telegram Caption：保留，但彻底改为 Content Physical Metadata

> **WEBGPT 当前事实：** 当前 `diskCaption()` 仍是 user/diskSpace/logicalFileId 语义，且 `syncCaption()` 仍按 Logical File 更新。这里不是抽象建议，而是现行代码明确需要迁移的路径。迁移后应把“Logical metadata caption sync”和“Content physical caption finalize/repair”拆成两个完全不同的生命周期；前者删除，后者保留。

共享 Content Object 后，不是完全删除 caption，而是：

```text
废弃 Logical/User 级 caption
保留 Content Object / Physical Part 级 caption
```

推荐正文分片 caption：

```text
Drop2Tunnel Content
content_object_id: C123
physical_revision: 1
part: 22/45
name: 原始上传文件名.mp4
mime_type: video/mp4
original_size: 892345678
message_id: 123456
file_id: BQACAg...
file_unique_id: AgAD...
```

`media_group_id` 保留在数据库；caption 空间允许时可以额外写入。

## 10.1 必须删除的旧字段

共享后不得再写：

```text
user_id
owner
owner_username
disk_space
logical_file_id
folder_path
当前 Logical File name
source_app_id
review_status
```

因为同一 Telegram message 可能同时服务多个用户和多个 Logical File。

## 10.2 Caption 字段语义

- `content_object_id`：同一个 Content Object 的所有分片一致；
- `physical_revision`：物理实现代次；
- `part`：例如 `22/45`；
- `original_size`：整个 Content Object 的总大小；
- `name`：第一次形成 Content Object 时的原始文件名；
- `mime_type`：首次形成 Content Object 时的原始 MIME；
- `file_id`：当前 physical part 的实际 Telegram `file_id`；
- `file_unique_id`：建议数据库和 caption 都保存；
- `message_id`：必须保留，尤其 Album 内 message 在 Telegram UI 中不一定方便直接定位。

---

# 11. Caption 仍需要两阶段 finalize

首次发送之前已经知道：

```text
contentObjectId
physicalRevision
originalName
originalMimeType
partIndex
partCount
originalSize
```

但不知道：

```text
file_id
file_unique_id
message_id
media_group_id
```

因此仍需要：

```text
sendDocument / sendMediaGroup
    ↓
发送初始 physical caption
    ↓
Telegram 返回 Message[]
    ↓
持久化真实 IDs
    ↓
editMessageCaption
    ↓
补齐最终 physical caption
```

所以最终原则是：

```text
删除 Logical File 级 caption sync
保留 Content Object physical caption finalize / repair sync
```

Logical rename/move/metadata/review/share/collaboration 以后都不再修改 Telegram caption。

只有：

```text
首次 physical 上传
physical finalize
physical repair
physical migration
thumbnail physical change
```

才允许修改 physical caption。

---

# 12. Caption 长度处理

不能简单继续：

```js
fields.join('\n').slice(0, 1024)
```

否则长文件名 + 长 `file_id` 可能导致关键字段被截断。

必须保证至少：

```text
content_object_id
physical_revision
part
message_id
file_id
```

永远完整。

建议逐字段预算长度，对 `name`、`mime_type` 等低优先级字段单独限长。

---

# 13. Thumbnail

## 内容固有 thumbnail

例如：

- 音频内嵌 APIC；
- 视频自动截图；
- 基于内容确定性产生的封面；

属于：

```text
ContentObject.thumbnail
```

多个 Logical File 共享。

只有 Content Object 最后一个引用释放后才允许物理清理。

## 用户自定义 thumbnail

如果以后允许用户为 Logical File 自定义封面：

```text
LogicalFile.customThumbnail
```

不能污染 Content Object。

Content thumbnail caption 同样必须改为 Content Object 物理语义，不再带 user/logical 信息。

---

# 14. mediaIndex

需要 Codex 基于本地最新 schema 拆分。

如果描述：

```text
时长
音轨
视频轨
编码信息
关键帧
媒体内部结构
```

属于 Content Object。

如果描述：

```text
用户标签
展示偏好
手工设置
```

仍属于 Logical File。

不能机械把整个 `mediaIndex` 一次性搬走。

---

# 15. Logical File 删除逻辑必须重构

> **WEBGPT 当前事实：** `server/object-storage.js::deleteFile()` 仍会直接 `telegram.remove(file)` 后再删除 Logical record；`pendingRemoteCleanup` 也仍挂在 Logical File 上。共享后必须先把删除入口改造成 release reference，再由 Content cleanup worker 决定是否调用现有 `telegram.remove()` primitive。

旧模型：

```text
删除 Logical File
    ↓
telegram.remove(file)
    ↓
删除 Logical record
```

共享后必须变成：

```text
删除 Logical File
    ↓
事务内解除 Logical → Content reference
    ↓
检查 Content 仍有多少 committed references
    ↓
> 0
    → 不碰 Telegram

== 0
    → Content READY → DELETE_PENDING
    ↓
事务提交
    ↓
异步 Telegram physical cleanup
```

---

# 16. Telegram Anchor 的最终清理

只有 Content Object 没有任何 Logical reference 时，才允许删除其 Telegram anchor messages。

现有删除策略的基本语义可继续：

```text
仍处于 deleteMessage 时间窗口
    ↓
deleteMessage

超过时间窗口 / Telegram 拒绝 delete
    ↓
editMessageMedia
    ↓
替换成 1 Byte placeholder
```

具体阈值必须由 Codex 以本地最新代码为准重新核对，不能直接机械使用讨论时 GitHub 版本里的数值。

---

# 17. RefCount 不能成为唯一 Source of Truth

> **WEBGPT 当前事实：** 当前 SQLite schema v1 没有 Content/Object reference 表，`disk_file_parts` 直接外键到 `disk_files`。本项必须通过真实 schema migration 落地，不能只在 JSON payload 中维护一个容易漂移的 refCount。

可以缓存：

```text
content_objects.refCount
```

但 physical delete 不能只信这个裸整数。

真正关系应来自：

```text
disk_files.content_id
    ↓
disk_contents.id
```

删除前在事务中确认真实引用数量。

避免：

```text
Logical 创建成功但 refCount +1 失败
```

或：

```text
Logical 删除成功但 refCount -1 失败
```

造成物理内容误删。

Telegram 网络请求不能放在 SQLite 长事务中。

---

# 18. Content Object 状态机

建议至少：

```text
CREATING
READY
DELETE_PENDING
DELETING
BROKEN
```

根据本地最新 repair/migration 代码，Codex 可进一步增加：

```text
REPAIRING
MIGRATING
```

等。

---

# 19. 删除与复活竞态

例如：

```text
C1 最后一个引用被删除
READY → DELETE_PENDING
```

同时另一个用户上传同样内容并通过 PoP。

不能出现：

```text
D → C1
同时 cleanup worker 删除 C1 anchor messages
```

建议：

### READY

允许复用。

### DELETE_PENDING

如果 physical cleanup 尚未真正开始，可以在事务内取消删除：

```text
DELETE_PENDING → READY
```

然后建立新的 Logical reference。

### DELETING

禁止复用，重新创建新的 Content Object。

---

# 20. 普通删除、目录递归删除、Review Delete

都必须统一走：

```text
release Logical reference
```

而不是：

```text
telegram.remove(logicalFile)
```

例如目录中：

```text
A → C1
B → C1
C → C2
```

删除目录后：

```text
C1 一次释放两个 references
C2 释放一个 reference
```

只有归零的 Content Object 才进入 physical cleanup。

Review delete/tombstone 同理。

审核仍属于 Logical File 业务，不形成 Content Block。

---

# 21. pendingRemoteCleanup 必须迁出 Logical File

如果：

```text
A → C1
B → C1
A overwrite → C2
```

不能让 A 自己携带：

```text
pendingRemoteCleanup = C1
```

否则后台可能误删 B 仍在使用的 C1。

physical cleanup debt 必须归属 Content Object：

```text
cleanupState
cleanupAttempts
lastCleanupError
nextCleanupAt
```

---

# 22. Repair 必须区分两种语义

## Physical Repair：内容相同

```text
C1 contentSha256 不变
physical representation 损坏
```

允许：

```text
重新上传相同内容
    ↓
生成新的 physical representation
    ↓
physicalRevision + 1
    ↓
原子切换 C1.parts
    ↓
所有 A/B/C 一起恢复
    ↓
清理旧 physical representation
```

## Logical Replacement：内容变化

```text
Logical A → C1
用户换成不同内容
```

必须：

```text
创建/命中 C2
A → C2
release C1
B 仍 → C1
```

不能原地修改共享 C1。

内部必须明确区分类似：

```text
repairContentObject()
replaceLogicalContent()
```

的语义。

---

# 23. Collaboration Replace

Collaboration 仍然必须绑定 Logical File，而不是 Content Object。

不同用户因为引用了相同 Content Object，绝不能自动共享协同关系。

但是协同正文替换会触发：

```text
Logical A: C1 → C2
```

因此必须成为重点回归测试路径。

---

# 24. S3 PUT / Overwrite

S3 overwrite：

```text
Logical L → C1
PUT 新正文
    ↓
创建/命中 C2
    ↓
事务：
L.contentId = C2
release C1
```

Logical ID 可以继续保持不变。

---

# 25. S3 Copy

> **WEBGPT 当前事实：** 当前同 backend S3/Object Storage Copy 仍通过 `reuseFileId → getFile → telegram.uploadPhysical() → putCopiedObject()` 重新创建 Telegram messages。共享 Content Object 后，同一 Content Object 的内部 Copy 应优先降为纯 Logical reference 创建。

共享 Content Object 后，本系统内部 Copy 可从：

```text
source.parts
→ reuseFileId
→ sendDocument/sendMediaGroup
→ 新 Telegram messages
→ putCopiedObject
```

简化成：

```text
Source Logical → C1
    ↓
创建 Target Logical
    ↓
Target Logical → C1
```

无需 Telegram API。

关于 `putCopiedObject()`：

> **如果本地最新版本仍存在通过 `...source` 直接把源 Logical Record 完整展开到目标记录的行为，则跨用户复用不能机械沿用，应改成字段 allowlist / 显式构造。**
>
> 如果本地已经解决，则无需重复修改。

这是条件性检查项，不能把 GitHub 旧版本观察结果当成本地最新事实。

---

# 26. fileIdHistory / Physical History

共享后，Telegram physical 历史属于 Content Object：

```text
ContentObject.physicalHistory
```

例如：

```text
C1 revision 1
C1 revision 2
```

Logical A 从：

```text
C1 → C2
```

则是 Logical content version 关系；如果产品需要，可另建：

```text
LogicalFile.contentHistory
```

两者不能混用。

---

# 27. 下载 / Stream / Range

HTTP Range、Telegram Range download、逐片 SHA 校验等能力可以尽量保留。

入口改成：

```text
LogicalFile.contentId
    ↓
ContentObject.parts
    ↓
Telegram
```

而不是继续直接从 Logical File 读取 `parts/fileId/channelId/backendId`。

---

# 28. Part Cache

当前 part cache 已具备同一个缓存 item 注册多个 owner scope 的能力，这与共享 Content Object 相容。

必须确认：

```text
A 清理自己的缓存
```

不能删除 B 仍需要的共享缓存。

如果本地最新代码仍有 remaining owners 机制，应复用并补测试。

---

# 29. Share 与 Collaboration 的业务边界

Share 继续：

```text
Share → Logical File → Content Object
```

不能改成：

```text
Share → Content Object
```

因为 A 删除自己的 Logical A 后，A 的分享应该失效，即使 B 仍引用同一 Content Object。

Collaboration 同理，必须绑定 Logical File。

---

# 30. Content Health / Check

以下 physical 状态应搬到 Content Object：

```text
Telegram file_id 是否还能 getFile
anchor message 是否存在
part hash 是否正确
physical representation 是否完整
```

建议：

```text
lastCheckedAt
healthStatus
lastPhysicalError
repairedAt
```

如果 C1 物理损坏，则 A/B/C 都实际受影响。

---

# 31. Backend / Channel 归属

`backendId`、`channelId` 属于 Content Object 的 physical representation。

Logical File 不应继续承担“Telegram 存在哪里”的物理语义。

如果本地最新代码仍有：

```text
hasChannel(channelId)
```

通过扫描 Logical File 判断 channel 是否在使用，需要改为检查 Content Object。

---

# 32. Upload Recovery / Rollback

> **WEBGPT 当前事实：** 现有 upload manifest 已经包含渐进分片所需的 `writtenBytes/sourceComplete`、临时 remote、`finalized`、`pendingCleanupParts/pendingRollbackParts` 等语义，Operation 也已有 `recovering`。共享 Content Object 应把这些现有恢复能力从“最终提交 Logical physical”升级为“创建/恢复 pending Content Object candidate”，而不是另造一套平行上传状态机。

上传 staging 和 recovery 应围绕“未完成的 Content Object candidate”建模：

```text
upload staging
    ↓
pending Content Object candidate
    ↓
Telegram messages confirmed
    ↓
Content Object READY
    ↓
Logical references commit
```

如果 Telegram 已完成但数据库 commit 失败，且 Content Object 没有 committed references，可以 cleanup。

如果已经存在 references，recovery 绝不能删除 physical anchors。

现有：

```text
pendingRollbackParts
recoveredUploads
cleanupExpiredUploads
```

等逻辑必须在 Codex 本地最新代码上重新审计。

---

# 33. 并发去重竞态

A/B 同时首次上传同样内容：

```text
A → H → MISS
B → H → MISS
```

不能各自产生一套 physical Content Object。

建议数据库约束：

```text
UNIQUE(contentSha256, size)
```

配合：

```text
CREATING
```

例如：

```text
A INSERT H → CREATING
B INSERT → conflict
```

B 等待 CREATING 完成，然后仍需 PoP 才能引用 READY Content Object。

**READY 不等于跨用户直接可用。PoP 仍然是必要条件。**

---

# 34. Mixed Upload

一次上传 8 个文件：

```text
1 → Content hit
2 → normal upload
3 → Content hit
4 → normal upload
...
```

每个文件必须独立走：

```text
preflight
candidate
PoP
reuse_verified
reference_commit
```

或：

```text
normal_upload
```

不能要求整个 batch 全部命中才复用。

现有“整批成功后统一 commit / 失败回滚”是否继续保留，由 Codex 基于本地最新上传事务重新判断。

---

# 35. Progress UI

> **WEBGPT 当前事实：** 居中 Loading 已经有真实 Browser → Server、Server → Telegram、当前文件/分片、分片确认和 final media group 多行状态。Content reuse 只需要在现有 Operation/UI 模型上增加 PoP/reference 专用 phase；不得回退成简单的一行进度，也不得把逻辑复用量伪装成网络发送量。

如果 370MB 文件命中共享 Content Object：

实际没有发生：

```text
Browser → Node 370MB
Node → Telegram 370MB
```

所以不能伪造：

```text
服务器 → Telegram · 370/370MB · 100% · 500GB/s
```

建议显示：

```text
已找到可复用内容
  - 正在验证文件持有证明

已验证已有 Content Object
  - 19个现有物理分片
  - 正在建立逻辑文件引用
```

内部可以把 370MB 计入逻辑处理统计，但不能称为网络上传字节。

---

# 36. API 暴露 Telegram Physical IDs

如果当前 API 仍公开：

```text
telegramFileId
telegramFileUniqueId
telegramMessageId
telegramChatId
telegramPartFileIds
```

共享 Content Object 后，不同用户会得到相同 physical IDs，形成跨用户关联标识。

这不一定必然是漏洞，但必须重新确认产品需求。

Codex 应审查：

- 普通用户/API 是否真的需要 Telegram physical IDs；
- 是否仅保留 Logical ID + server asset URL；
- physical IDs 是否应该限制为管理员/诊断接口。

---

# 37. 后台反向引用查询

共享模型天然支持：

```text
Content C1
    ↑
Logical A
Logical B
Logical C
```

可按 `contentId/contentSha256` 查询所有引用该内容的 Logical File IDs。

未来管理员可批量执行 unavailable/delete。

仍然**不创建 Content Block**。

---

# 38. 历史数据迁移：logicalManifestHash 只作为过渡手段

讨论中曾提出基于现有 `parts[].sha256` 计算：

```text
logicalManifestHash = SHA256(
  "Drop2TunnelLogicalV1"
  + totalSize
  + part1.size + part1.sha256
  + part2.size + part2.sha256
  ...
)
```

优点：

- 历史文件无需重新完整下载；
- 可以快速建立候选索引。

缺点：

- 依赖分片边界；
- 同样内容用不同分片策略时 hash 不同；
- 不等价于整个文件的 `contentSha256`。

因此它只能是：

```text
历史迁移 / 候选索引 / 过渡优化
```

不能替代最终 Content Key。

具体 migration/backfill 必须由 Codex 基于本地最新数据结构重新设计。

---

# 39. 最终三层生命周期

这次重构真正的核心不是“加一个 refCount”，而是：

```text
Logical File 生命周期
        ≠
Content Object 生命周期
        ≠
Telegram Anchor 生命周期
```

### Logical File

用户业务实体：

```text
owner
name
folder
MIME
metadata
review
share
collaboration
```

### Content Object

共享内容实体：

```text
contentSha256
size
originalName
originalMimeType
physicalRevision
health
physical representation
references
```

### Telegram Anchor

物理存储：

```text
file_id
message_id
part
album
channel
caption
physical cleanup
```

---

# 40. 改造牵连面汇总

## 40.1 必须重构，否则可能误删共享数据

- 普通单文件删除；
- 目录递归删除；
- review delete / tombstone；
- S3 delete；
- S3 overwrite；
- repair；
- collaboration replace；
- Logical overwrite/replace；
- `pendingRemoteCleanup`；
- recovery cleanup；
- expired upload cleanup；
- `fileIdHistory`；
- Telegram backend/channel 归属；
- physical health；
- Telegram anchor cleanup；
- reference/refCount source of truth；
- DELETE_PENDING/DELETING 与重新复用竞态。

## 40.2 必须重新定义，否则语义错误

- `diskCaption()`；
- `diskThumbnailCaption()`；
- Logical rename caption sync；
- caption retry；
- caption warning；
- Content physical caption finalize；
- thumbnail；
- mediaIndex；
- S3 Copy；
- `putCopiedObject()`；
- `hasChannel()` 等 ownership 判断；
- upload result 对 physical IDs 的暴露；
- admin Content ↔ Logical references 查询。

## 40.3 主要保持 Logical File 业务语义

- 文件名；
- 目录；
- move；
- rename；
- Search；
- Share；
- Collaboration 权限关系；
- 用户 metadata；
- Logical review 状态；
- sourceAppId；
- Range HTTP 协议本身。

## 40.4 主要保留物理能力、改数据入口

- Telegram Range download；
- part cache；
- `getFile`；
- part SHA 校验；
- physical repair；
- placeholder 删除策略；
- Telegram request/retry 基础设施。

---

# 41. 最终采纳决策

1. 采用共享 Content Object；
2. Content Object 可被不同用户 Logical File 共同引用；
3. 命中后不重新 `sendDocument/sendMediaGroup`；
4. 跨用户复用必须 PoP；
5. PoP 只交换 digest，不交换样本正文；
6. PoP 使用服务端随机 offset/length + 一次性 nonce；
7. Content Key 不包含任何文件名、目录、MIME、时间、权限、owner 等元信息；
8. 当前共享 Bot fingerprint 不进入 Content Key；
9. 不采用 Content Block / denylist 阻止未来上传；
10. 支持按 Content Object 反查全部 Logical File；
11. Content Object 仍有 Logical refs 时绝不能删除 Telegram anchor messages；
12. 只有最后一个 Logical ref 释放后才允许 physical cleanup；
13. Content cleanup 使用数据库状态 + 异步 Telegram 网络清理；
14. 不依赖无 message anchor 的裸 `file_id` 永久有效；
15. Telegram caption 保留，但彻底移除 Logical/User 语义；
16. caption 增加 `content_object_id`；
17. caption 增加 `physical_revision`；
18. caption 保留 `part/original_size/originalName/originalMimeType/file_id/message_id`；
19. 建议 caption 也保留 `file_unique_id`；
20. Logical rename/move/metadata 不再触发 caption sync；
21. physical finalize/repair 仍可更新 Content caption；
22. Telegram physical IDs 以数据库为 source of truth，caption 只用于人工排障；
23. thumbnail/mediaIndex 按内容固有属性与用户自定义属性拆层；
24. S3 Copy 同 Content Object 时直接创建 Logical reference；
25. Share/Collaboration 继续绑定 Logical File。

---

# 42. 明确弃用 / 降级方案

## 弃用：每次逻辑复用都重新 sendMediaGroup

仅保留为过渡/fallback。

## 弃用：只保存裸 file_id，不保留 anchor messages

不能作为长期持久模型。

## 弃用：Content Block / hash denylist

不阻止未来重新上传相同内容。

## 弃用：Logical rename 后同步 Telegram caption

改名只改 Logical database state。

## 弃用：Logical File 直接拥有 Telegram physical 生命周期

改由 Content Object 拥有。

## 弃用：refCount 裸整数作为 physical delete 唯一依据

真实 Logical→Content 关系才是 source of truth。

---

# 43. WEBGPT 分支实施前置要求

本文档已经针对生成时的 WEBGPT 分支代码重新校准，因此不再沿用原草稿中“先回到 `09ad7a56…` 重新调查”的前置流程。

真正开始开发共享 Content Object 之前仍应做一次轻量基线确认：

1. 确认当前工作分支仍是：
   `dev/2609-s5-disk-chunks-progressive-push-WEBGPT`；
2. 确认当前 HEAD 是否仍与本文档顶部的 `{{WEBGPT_BASELINE_SHA}}` 接近；
3. 如果此后又有较大提交，重点重新核对：
   - `server/disk-repository.js` schema；
   - `server/telegram-drive.js` commit/upload manifest；
   - `server/disk-api.js` upload/delete/recovery；
   - `server/disk-telegram.js` caption/remove/finalization；
   - `server/object-storage.js` S3 Copy/delete/overwrite；
   - `server/disk-chunk-file-cache.js`；
   - `client/disk-client.js` / `client/disk-ui.js` Operation 与 Loading；
   - 相关 tests。
4. 如果只是无关提交，不需要重新生成整份设计文档；
5. 如果上述核心模型已经变化，则应先更新本文档中的“WEBGPT 当前事实”，再开发。

特别注意：

- 不要重做 WEBGPT 已经完成的渐进 staging、growing reader、scheduler、临时分片→最终 media group、重启 recovering、连续 Loading 等能力；
- Content Object 重构应建立在这些能力上；
- 正常 Content MISS 的首次上传仍继续走现有 progressive physical creation；
- Content HIT + PoP verified 才绕过正文上传和 Telegram physical creation。

---

# 44. 推荐实施边界与顺序

实现时建议遵守“先建立新所有权模型，再逐步迁移入口”的顺序，避免先改删除导致旧 Logical physical 被误删。

建议依赖顺序：

```text
A. schema / repository
   ├─ Content Object
   ├─ Content parts
   └─ Logical → content reference
        ↓
B. compatibility resolver
   ├─ 旧 Logical physical 读取
   └─ 新 Content physical 读取
        ↓
C. 首次上传 commit 改造
   ├─ 现有 progressive pipeline 不变
   └─ final Telegram parts → Content Object → Logical reference
        ↓
D. download/check/thumbnail/mediaIndex 改从 Content resolve
        ↓
E. delete / overwrite / review / collaboration replacement
   └─ release/acquire reference + DELETE_PENDING
        ↓
F. physical cleanup worker
   └─ 复用现有 telegram.remove() primitive
        ↓
G. Content identity + full-file SHA + preflight
        ↓
H. PoP challenge / verify
        ↓
I. HIT reuse path
   └─ 不上传正文、不创建新 Telegram messages
        ↓
J. S3 Copy 优化为 Logical reference
        ↓
K. repair / physicalRevision / recovery
        ↓
L. caption physicalization
        ↓
M. historical backfill / lazy migration / admin reverse lookup
```

这是设计依赖顺序，不代表必须拆成完全独立的提交。开发时应在每一阶段保持旧数据可读、现有网盘/S3 API 可回归。

---

# 45. WEBGPT 版本必须补充的重点测试

除原草稿已有测试矩阵外，基于当前 WEBGPT 上传实现还必须额外验证：

### 正常首次上传不回归

- growing staging 仍能在 Browser 分片未结束时启动 Telegram；
- 临时 `sendDocument`、最终 `sendMediaGroup(file_id)`、temporary cleanup 继续正常；
- 429 scheduler / pacing 不回归；
- restart `recovering` 不回归；
- 370MB 等多分片上传继续成功；
- 居中 Loading 双链路和 final media group 状态不回归。

### Content HIT 不误走 physical pipeline

PoP verified 后：

- 不创建 staging 正文；
- 不进入 growing reader；
- 不执行临时 `sendDocument`；
- 不执行最终 `sendMediaGroup`；
- 不产生 temporary cleanup debt；
- 仅创建新的 Logical reference；
- UI 不显示伪造的 Browser/TG 字节速度。

### 引用删除不误伤现有 anchor

- A/B → C1；
- 删除 A 后，`telegram.remove()` 调用次数为 0；
- 删除 B 后，C1 才进入 DELETE_PENDING；
- cleanup worker 只清理一次 C1 physical parts；
- 47h57m 内/外两条现有 delete/placeholder primitive 都有覆盖。

### Progressive recovery 与 Content state 协同

- physical 已经上传但 Content Object 尚未 READY 时重启；
- Content READY、Logical commit 尚未完成时重启；
- Content READY 且已经有 reference 时，旧 upload recovery 绝不能回滚 anchor；
- temporary/final message cleanup debt 与 Content cleanup debt 不混淆。

---

# 46. 最终原则

最终目标不是：

```text
“相同文件少上传一次”
```

而是：

```text
Logical File
    = 用户业务引用

Content Object
    = 共享二进制内容

Telegram Anchor
    = Content Object 的物理存储
```

核心原则：

```text
Logical File 生命周期
≠
Content Object 生命周期
≠
Telegram Anchor 生命周期
```

在 WEBGPT 分支上还应再加一条：

```text
Content Object 重构
≠
重写现有 progressive Telegram upload
```

共享层应复用当前已经稳定下来的 progressive physical pipeline，并只改变“物理内容属于谁、何时创建、何时复用、何时删除”的所有权与生命周期。
