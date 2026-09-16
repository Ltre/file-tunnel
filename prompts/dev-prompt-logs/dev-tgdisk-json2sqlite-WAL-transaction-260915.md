# Drop2Tunnel 网盘多用户持久层 SQLite WAL / 事务重构方案

> **适用目标**：Drop2Tunnel / Telegram 网盘子系统  
> **分析基线分支**：`dev/2608C-step2`  
> **分析时基线提交**：`e7b3e46b87dec2fc47582e1c008c5a40a7b62dae`  
> **目标数据库基础文件名**：`.tunnel-data/disk.sqlite`  
> **文档性质**：重构设计与执行指导，不是不可变的最终实现规范。Codex 在本地执行时必须先重新扫描当前分支实际代码、测试和运行环境；如果发现本文遗漏、代码已经变化、约束冲突或存在更优实现，应以实际代码和完整业务语义为准调整方案，并说明调整理由，不要为了机械遵守本文而引入新的问题。

---

## 1. 背景与本次重构目标

当前网盘已经不再是简单的单用户文件索引，而是包含：

- 多用户；
- `disk_space` 逻辑分区；
- 文件与目录树；
- Telegram 逻辑文件与多分片；
- 缩略图、媒体索引、文件历史；
- 分享；
- 审核 / tombstone；
- 上传与其它长任务 Operation；
- Passkey / Telegram 身份；
- 第三方 App、Access Token、Telegram Backend；
- Telegram 已上传分片的 `file_id` 复用缓存；
- 服务端 Telegram 分片临时缓存及其用户/分区归属；
- 后台跨用户、跨分区管理。

这些状态目前大量通过 `.tunnel-data` 下的多个 JSON 文件保存，而且多个 JSON 之间已经形成明显的关系型关联。附件中的讨论已经确定：**现阶段仍是测试阶段，旧网盘 JSON 数据可以全部放弃，不要求将旧 JSON 内容迁入新数据库，可以让新数据库从空状态重新开始。**

因此本次工作不应理解为：

> “把几个 JSON 文件机械搬进一个 SQLite 文件”。

更合适的目标是：

> **把网盘的权威元数据持久层正式重构为以 `disk.sqlite` 为基础的事务型数据层，使用真正支持 WAL 的 SQLite 驱动，重新明确事务边界、并发控制、数据约束、远程 Telegram 副作用与数据库提交之间的关系，同时为未来 PostgreSQL / MySQL 等服务器级数据库预留清晰的适配边界。**

本次重构的核心目标包括：

1. 消除多个共享 JSON 文件之间无法原子提交的问题；
2. 避免整份 JSON 的反复读改写和覆盖式持久化；
3. 使用数据库唯一约束、外键、事务等机制保护核心关系；
4. 支持当前少量用户并发读写；
5. 保证 Telegram、网络、FFmpeg、文件流等慢操作不占用数据库长事务；
6. 保留或重新设计现有上传失败回滚、重启恢复、Operation 状态机；
7. 尽量保持现有前端 REST API 和用户可见行为稳定；
8. 数据访问代码采用 Repository / Adapter 思维，不让 SQLite 细节扩散到业务层；
9. 未来切换到 PostgreSQL / MySQL 时，迁移工作尽量集中在数据访问层，而不是重新改写整个网盘业务；
10. 因旧数据可丢弃，优先保证新架构正确，不为兼容历史 JSON 数据结构牺牲新设计。

---

## 2. Codex 执行前必须先重新调研的事项

本文基于 `dev/2608C-step2` 在上述提交附近的代码分析，但 Codex 真正执行时应先做一次完整本地扫描。

### 2.1 先确认代码基线

执行前至少确认：

```text
git branch --show-current
git status
git rev-parse HEAD
```

目标仍应是：

```text
dev/2608C-step2
```

如果分支 HEAD 已经前进，不要回退到本文分析时的提交；应以用户当前分支最新代码为基线重新检查。

### 2.2 重新枚举所有网盘持久化状态

不要只搜索本文列出的文件名，应至少全局搜索：

```text
readJson
writeJson
.tunnel-data
telegram-drive-index.json
telegram-drive-directories.json
disk-auth.json
disk-operations.json
disk-shares.json
disk-space-usage.json
disk-spaces.json
telegram-chunk-file-ids.json
.owners.json
tg-1byte-file.id
upload-manifest.json
```

还应继续检查：

- 是否出现了本文分析后新增的 JSON；
- 是否有其它模块直接读写这些文件；
- 是否有测试直接断言这些文件存在或内容格式；
- 是否有后台页面或脚本绕过 Store / Repository 直接读文件；
- 是否有备份、清理、部署脚本直接复制或删除这些文件；
- 是否有其它系统共用 `disk-secret.key` 或相关会话签名逻辑；
- 是否存在与网盘相关但不应该迁入数据库的日志、临时文件、缓存文件。

### 2.3 不要把本文表名和目录名当成绝对要求

本文后面的 Schema、模块目录和接口名称是推荐基线。

如果 Codex 在本地代码中发现：

- 现有 API 语义更适合另一种表结构；
- 某些状态其实已经拆分；
- 某些 JSON 只是临时恢复信息而不是权威数据；
- 某个 Repository 边界会造成大量无意义重复封装；
- 某个数据库驱动不适配实际 Node / Windows / Linux 部署环境；

可以调整，但应保证本文定义的核心原则和验收目标不被破坏。

---

## 3. 当前 JSON 持久化模型及已确认问题

### 3.1 当前通用 JSON 写入并不是最原始的直接覆盖

当前 `server/disk-data.js` 中的 `writeJson()` 大体采用：

```text
写入随机临时文件
→ rename 覆盖正式文件
```

这比直接对正式 JSON 文件执行覆盖写安全，能够明显降低进程中途异常导致“半截 JSON”的概率。

因此不应把当前问题简单描述成：

> “多用户一用 JSON 就一定会把 JSON 文件写烂”。

更准确的风险是：

- 多个强关联状态不在同一个事务中；
- 业务层存在“先检查、后 await、再修改”的并发窗口；
- 部分操作需要同时修改多个集合；
- 整个数组 / 对象被重复序列化和整体替换；
- 当前的原子 rename 只能保护“单个文件替换”，不能保护跨文件一致性；
- 进程崩溃、磁盘异常时无法保证一组业务状态同时成功或同时失败；
- 未来一旦引入多个 Node 进程、cluster、worker 或多实例，进程内 Map / Promise 锁完全无法覆盖其它进程；
- 业务逻辑越来越复杂后，靠程序员手工维持关系完整性的成本会快速上升。

### 3.2 `telegram-drive-index.json` 与 `telegram-drive-directories.json`

当前 `telegram-drive.js` 启动时把两者分别加载到内存：

```text
records Map
directories Map
```

修改文件、目录、审核状态、上传 commit 等操作先改内存，然后 `persist()` 分别保存：

```text
telegram-drive-index.json
telegram-drive-directories.json
```

这两个文件显然存在强关联。

例如移动目录可能同时涉及：

```text
目录本身路径
所有子目录路径
所有子文件 folderPath
captionSyncPending
原父目录 updatedAt
目标父目录 updatedAt
```

在 JSON 模型下，这些变化最终仍要靠分别保存不同集合完成。

典型风险不是某一个 JSON 一定损坏，而是：

```text
文件索引已经写入新状态
↓
进程在目录索引落盘前退出
↓
重启后两个索引处于不同业务时刻
```

数据库事务更适合表达：

```text
这一组变化全部成功
或
这一组变化全部回滚
```

### 3.3 `disk-auth.json`

当前该文件包含的内容至少涉及：

```text
users
apps
backends
tokens
passkeys（嵌在 user 中）
```

其风险尤其值得注意，因为部分逻辑本身带有异步操作。

例如 App 保存大致存在这样的业务形态：

```text
检查 app_id 是否存在
↓
await scrypt(...)
↓
创建或更新 App
↓
撤销旧 token
↓
保存整个 disk-auth.json
```

如果两个并发请求在 `await` 前都观察到“App 不存在”，单 Node 事件循环并不能自动保证整个业务检查和写入是一个不可分割操作。

类似问题也可能存在于：

- Passkey 注册；
- Passkey counter 更新；
- 用户首次创建；
- Backend 创建；
- Token 签发；
- App revision 与 token 作废。

数据库的：

```text
UNIQUE
FOREIGN KEY
短事务
```

比依赖多个 JavaScript 数组查找更适合保护这些关系。

### 3.4 `disk-operations.json`

当前 Operation：

- 整体加载进 `Map`；
- 创建任务时保存；
- 普通进度更新存在约 500ms debounce；
- terminal 状态立即保存；
- 重启时把未完成任务改为 `SERVER_RESTARTED` / failed；
- 每次持久化仍是整个 retained operation 列表。

问题包括：

- 高频进度更新导致整体 JSON 重写；
- 多任务越多，单次写放大越明显；
- Operation 与实际文件 commit 无法天然组成同一事务；
- 未来增加更多任务类型后结构会越来越复杂。

数据库化后应改为：

```text
UPDATE disk_operations
SET ...
WHERE operation_id = ?
```

而不是反复写整个任务集合。

### 3.5 `disk-shares.json`

当前一条 Share 同时保存：

```text
share id
token
ownerId
diskSpace
title
files[]
directories[]
createdAt
stoppedAt
```

一个分享实际已经是明显的“一对多”关系：

```text
share
├─ N 个 file snapshot
└─ N 个 directory snapshot
```

创建分享时需要从当前目录树和文件状态生成完整快照，因此更适合：

```text
disk_shares
disk_share_files
disk_share_directories
```

在一次短事务中创建。

### 3.6 `disk-space-usage.json` 与 `disk-spaces.json`

用户最初列出的文件之外，当前 `disk-api.js` 还存在：

```text
disk-spaces.json
```

当前非默认 `disk_space` 会映射到：

```text
.tunnel-data/disk-spaces/<sha256(disk_space)>/
```

并在其中建立各自的：

```text
telegram-drive-index.json
telegram-drive-directories.json
telegram-drive-staging/
```

同时：

```text
disk-space-usage.json
```

记录：

```text
appId
userId
diskSpace
createdAt
lastUsedAt
```

这使持久化关系进一步分散。

重构后可以优先考虑让所有逻辑分区共享：

```text
.tunnel-data/disk.sqlite
```

并在核心表中明确包含：

```text
user_id
disk_space
```

而不是继续用“每个 disk_space 一个物理 JSON 数据目录”的方式隔离元数据。

是否保留某些按 `disk_space` 分开的**临时文件目录**，可由 Codex根据上传 staging 和清理逻辑再决定；逻辑元数据则建议统一。

### 3.7 `telegram-chunk-file-ids.json`

该文件本质上是：

> 已上传 Telegram 物理分片内容 → 可复用 Telegram `file_id`

的缓存映射。

当前 Key 包含：

```text
backend fingerprint
sha256
size
```

Value 包含：

```text
fileId
fileUniqueId
size
updatedAt
```

它属于缓存型状态，不像文件索引那样是绝对权威数据，但共享写入仍适合数据库：

```text
telegram_chunk_file_ids
```

这能够避免整个 `entries` 对象反复写回。

如果重构后 Backend 本身具有稳定 `backend_id`，可以评估是否直接使用：

```text
backend_id + sha256 + size
```

作为逻辑唯一键，而不是继续在业务层用 token 生成 fingerprint。是否这样改应结合 Backend 去重语义与现有测试确认。

### 3.8 `telegram-part-cache/.owners.json`

`telegram-part-cache` 里的：

```text
*.part
*.tmp
```

是实际缓存字节，**不建议放进 SQLite BLOB**。

当前 `.owners.json` 只是记录某个缓存 key 被哪些：

```text
userId + diskSpace
```

使用。

因此建议：

```text
实际缓存文件      → 继续留文件系统
缓存归属元数据    → SQLite
```

例如：

```text
telegram_part_cache_owners
```

唯一键可以是：

```text
cache_key + user_id + disk_space
```

需要特别注意：数据库事务不能把“删除磁盘缓存文件”和“DELETE 数据库 owner 行”变成真正的跨资源 ACID 事务。

但这类缓存本身不是权威数据，因此可采用：

- 幂等删除；
- 失败重试；
- orphan reconciliation；
- 启动 / prune 时清理不一致项；

而不是为了缓存元数据引入复杂的分布式事务。

### 3.9 其它应由 Codex 继续盘点的状态

当前代码中至少还可见：

```text
tg-1byte-file.id
```

用于按 Telegram Bot 缓存“1 Byte 删除占位文件”的 `file_id`。

它同样属于共享可变缓存，建议纳入本次盘点，可能适合：

```text
telegram_placeholders
```

但最终是否迁移，应以本地代码的完整调用链为准。

另一方面：

```text
telegram-drive-staging/<uploadId>/upload-manifest.json
```

与上述共享 JSON 性质不同。

这种每个上传任务独立的 manifest：

- 与对应临时二进制分片强绑定；
- 主要用于崩溃恢复；
- 不存在所有用户共同改同一个 manifest 的典型模式。

因此：

> **本次目标不是“消灭所有 JSON 文件”。**

应区分：

### 应优先数据库化

```text
共享
可变
权威
存在强关系
需要事务
需要唯一约束
```

### 可以继续留在文件系统

```text
日志
临时二进制
单任务 staging manifest
缓存实体
schema marker
密钥文件
可重建派生数据
```

Codex 应在执行时逐一分类，而不是看到 `.json` 就机械搬进数据库。

---

## 4. SQLite WAL 是否适合当前少量用户并发

对于当前预期：

```text
单机 Node 服务
少量用户
读远多于写
目录/文件元数据写事务很短
大量真正耗时工作发生在 Telegram / 网络 / 文件 IO
```

SQLite WAL 是合理候选。

需要理解其并发模型：

```text
多个 reader 可以并发
reader 与 writer 在 WAL 下通常可以并行
同一时刻仍只有一个真正 writer
多个短 writer 依次获得写锁
```

这对当前场景通常足够。

例如：

```text
用户 A：列目录
用户 B：读取视频文件元数据
用户 C：查看分享
用户 D：提交一次文件 rename
用户 E：更新一个 Operation 进度
```

只要数据库事务本身足够短，通常不需要为了“少量用户并发”直接引入 PostgreSQL。

真正需要警惕的是：

```text
BEGIN
↓
等待 Telegram 30 秒
↓
429 再等 20 秒
↓
上传 500MB
↓
COMMIT
```

这种长事务。

这是本次设计中明确禁止的。

如果未来系统发展为：

```text
多个服务实例
持续高频并发写
跨主机部署
数据库文件放网络文件系统
```

则应重新评估 PostgreSQL / MySQL 等服务器级数据库，而不是无限扩展 SQLite。

---

## 5. 数据库基础文件与 SQLite 初始化建议

基础文件初定：

```text
.tunnel-data/disk.sqlite
```

WAL 模式运行时还可能出现：

```text
.tunnel-data/disk.sqlite-wal
.tunnel-data/disk.sqlite-shm
```

它们属于正常 SQLite WAL 组成部分。

建议由 SQLite Adapter 在打开数据库时统一初始化并校验类似能力：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

`busy_timeout = 5000` 只是合理起点，并非不可调整的常量。

`PRAGMA synchronous` 不建议本文写死。

可以在以下候选之间根据目标机器、磁盘、可靠性要求和压力测试决定：

```text
FULL
NORMAL
```

如果当前更重视元数据耐久性，可以优先评估 `FULL`；如果实际测试发现写频率较高且可接受 WAL 在极端掉电下的耐久权衡，也可以评估 `NORMAL`。

Codex 应把这一项作为 SQLite Adapter 配置，而不是散落到业务代码。

还应考虑：

- WAL checkpoint 策略；
- graceful shutdown 时是否主动 checkpoint；
- WAL 体积监控；
- 避免长时间 read transaction 导致 checkpoint starvation；
- 数据库必须使用本机文件系统，不应把 WAL SQLite 文件放在不合适的网络文件系统上。

---

## 6. 不要直接复用现有 `infra.sqlite` 的 `sql.js` 持久化方式

当前项目已经存在：

```text
server/infra-store.js
infra.sqlite
sql.js
```

但它当前大体属于：

```text
启动时：
整个 infra.sqlite 读进 sql.js 内存数据库

运行时：
修改内存 DB

持久化：
db.export()
→ 整个数据库重新写成一个文件
```

这不是本次需要的“真实文件连接 + WAL + 多连接/事务语义”。

因此本次网盘数据层：

- 可以借鉴 `infra-store.js` 的 schema migration 思路；
- 不建议直接把网盘数据继续塞到该 sql.js 实例；
- 不应因为文件后缀已经叫 `.sqlite` 就认为现有实现已经满足 WAL 目标。

---

## 7. SQLite Driver 选择：应设置能力要求，不应把某个库写死到业务层

当前 `package.json` 只有：

```text
sql.js
```

本次应引入真正的 SQLite driver。

候选之一是：

```text
better-sqlite3
```

其优势包括：

- 真正文件型 SQLite；
- transaction 支持直接；
- prepared statement 使用简单；
- 与当前很多同步 Store 方法比较接近；
- WAL 配置直接。

但它是 native addon，因此 Codex 执行前应确认：

- 当前实际 Node 版本；
- Windows 开发环境；
- Linux 部署环境；
- 是否还有其它架构 / Termux / arm 环境需要安装；
- CI / deploy build 是否能正确安装或获得预编译产物。

Node 自带的：

```text
node:sqlite
```

也可以作为候选，但应根据项目最低 Node 版本、当前 API 稳定性和部署要求决定。

### 驱动选择的真正硬要求

无论最终选择哪一个库，都应满足：

```text
真实 on-disk SQLite
WAL
prepared statements
事务
busy timeout / writer contention 处理
foreign_keys
可靠 close
backup/checkpoint 能力
```

### 不应形成这样的依赖

```text
disk-api.js
    ↓
better-sqlite3.prepare(...)

telegram-drive.js
    ↓
db.pragma(...)

disk-auth.js
    ↓
BEGIN IMMEDIATE
```

这会让未来迁 PostgreSQL 时仍然需要大面积重写。

---

## 8. 目标架构：Domain / Service → Repository → Database Adapter

建议方向：

```text
HTTP / Router
        ↓
Domain / Service
        ↓
Repository / Store Contract
        ↓
Database Adapter
        ├─ SQLite implementation
        └─ 未来 PostgreSQL / MySQL implementation
```

示意目录可以是：

```text
server/
  disk-db/
    index.js
    adapter.js

    sqlite/
      index.js
      connection.js
      migrations/
      repositories/

    repositories/
      contracts-or-facade.js

  disk-service/
    ...
```

最终目录不要求严格照抄，重点是分层边界。

### 8.1 业务层不应该知道 SQLite

业务层应该表达：

```text
获取文件
列目录
移动目录
提交上传结果
创建分享
停止分享
创建 Operation
完成 Operation
创建 / 更新 App
签发 Token
注册缓存 owner
```

而不是表达：

```text
SELECT
INSERT
UPDATE
PRAGMA
BEGIN IMMEDIATE
sqlite_master
```

### 8.2 不要把 Adapter 只做成一个 `query(sql)` 包装器

如果业务层到处写：

```js
db.query('SELECT ...')
db.exec('UPDATE ...')
```

即使 `db` 名字叫 Adapter，本质上仍然和 SQL 方言绑定。

更合适的是 Repository 语义：

```text
files.get(...)
files.list(...)
files.updateMetadata(...)
drive.moveFile(...)
drive.moveDirectory(...)
drive.commitUploadedFile(...)
operations.create(...)
operations.update(...)
shares.createSnapshot(...)
auth.saveApp(...)
auth.issueToken(...)
```

### 8.3 原子业务操作应尽量封装在 Repository 内部

例如：

```text
moveDirectoryAtomic(...)
commitUploadAtomic(...)
saveAppAndRevokeTokensAtomic(...)
createShareSnapshotAtomic(...)
```

由 SQLite Repository 内部决定：

```text
BEGIN IMMEDIATE
...
COMMIT
```

未来 PostgreSQL Repository 可以用自己的 transaction 实现。

这样有两个好处：

1. Service 不需要知道具体数据库事务语法；
2. 更难不小心把 Telegram 网络 `await` 塞进数据库事务。

---

## 9. 为未来 PostgreSQL / MySQL 做准备时，一个容易忽略的问题：同步 API

当前很多 Store API 是同步调用。

如果本次直接把它们全部固化成：

```text
better-sqlite3 同步 Repository API
```

将来 PostgreSQL 客户端几乎必然是异步 Promise API，到时上层调用链可能需要再次大改。

因此建议 Codex评估：

> 是否趁本次大重构，把新的持久层边界设计成 Promise-compatible / async-friendly。

例如 Service 面向：

```js
await repo.files.get(...)
await repo.drive.moveDirectory(...)
await repo.operations.update(...)
```

即便 SQLite 内部实际同步执行，也可以由 facade 返回 Promise-compatible 结果。

不过这会扩大现有代码改动面，因此不是强制要求。

Codex 应在本地统计：

- `store.get/list/update/...` 的调用规模；
- 改成 async 后需要修改多少路由；
- 是否会引发大量风险；
- 是否可以通过 facade 分阶段完成。

### 9.1 不建议让“未来数据库兼容”导致 SQLite 长事务跨 `await`

如果采用 `better-sqlite3`，不要写：

```text
BEGIN
await someService()
COMMIT
```

尤其不要让事务 callback 内出现任意远程操作。

一个更稳妥的思路是：

> Service 可以 async，但一次数据库原子操作封装为一个 Repository 方法；Repository 内部同步完成 SQLite transaction。

未来 PostgreSQL Adapter 再用 PostgreSQL 自己的 async transaction 实现同一个 Repository 语义。

---

## 10. 数据库 Schema：建议逻辑模型

下面是建议基线，不要求 Codex机械使用相同表名或每个字段。

---

## 10.1 Schema 版本

建议：

```text
schema_migrations
```

例如：

```text
version
name
applied_at
```

即使旧 JSON 不迁移，从 SQLite v1 开始以后仍然一定会有 v2、v3。

不要因为这次“从空库开始”就省掉 migration framework。

---

## 10.2 用户与认证

候选：

```text
disk_users
disk_passkeys
disk_apps
disk_backends
disk_access_tokens
```

### `disk_users`

可包含：

```text
id
telegram_id
provider
name
username
created_at
```

建议数据库层保护适合的唯一关系，例如：

```text
provider + telegram_id
username
```

但应结合当前 Telegram / Passkey 多 Provider 语义确认。

### `disk_passkeys`

可包含：

```text
credential_id
user_id
public_key
counter
transports_json
rp_id
created_at
```

`credential_id` 应具备唯一约束。

### `disk_apps`

可包含：

```text
app_id
secret_hash
passkey_origin
enabled
remark
revision
created_at
last_used_at
last_issued_at
```

当前已有 `revision` 语义，用来让旧 Token 失效，重构时应保留这一业务行为。

### `disk_backends`

可包含：

```text
id
fingerprint
encrypted_token
channel_id
base_url
created_at
```

Telegram Bot Token 不应因为迁数据库而改成明文保存。

### `disk_access_tokens`

可包含：

```text
token_hash
app_id
app_revision
backend_id
encrypted_credentials
expires_at
created_at
```

Access Token 本体仍建议只存 hash。

### WebAuthn pending flow

当前短期 Passkey challenge 使用内存 `Map`。

这种几分钟失效的流程：

```text
不一定需要持久化
```

除非本次重构同时要求服务重启后继续 Passkey flow，否则保持内存态通常更简单。

---

## 10.3 `disk-secret.key`

当前 `disk-auth` 不只依赖 JSON，还依赖：

```text
disk-secret.key
```

它承担加解密 / session key 等作用。

它不是普通共享 JSON，因此不建议为了“数据库化”直接塞进 `disk.sqlite`。

建议：

```text
disk.sqlite       → 密文和业务数据
disk-secret.key   → 独立密钥材料，权限受控
```

Codex 应先搜索该 key 的全部调用点，再决定：

- 是否原样保留；
- 是否改为环境变量 / Secret Manager；
- 是否需要支持 key rotation。

由于本次旧 Auth 数据可以丢弃，理论上可以重新初始化 Auth；但**不要未经分析自动删除 `disk-secret.key`**，因为它可能还参与会话签名，删除会影响已有 cookie/session。

---

## 10.4 Disk Space

候选：

```text
disk_spaces
disk_space_usage
```

### `disk_spaces`

主要用于保留显式创建过的逻辑空间，即使里面暂时没有文件也可以被发现。

### `disk_space_usage`

候选唯一关系：

```text
app_id + user_id + disk_space
```

字段：

```text
created_at
last_used_at
```

当前代码大约一小时才刷新一次 `lastUsedAt`，目的是避免高频落盘。

数据库化后仍可以保留类似节流策略，不需要每一个普通请求都写一次 `last_used_at`。

### Resource Scope

核心网盘资源仍建议以：

```text
user_id + disk_space
```

作为逻辑作用域。

`app_id` 更适合作为：

- 调用来源；
- Auth 上下文；
- usage / provenance；

不要轻易把 `app_id` 重新变成文件资源的物理 namespace，除非 Codex检查当前需求后确认业务已经改变。

---

## 10.5 目录

最小兼容方案：

```text
drive_directories
```

候选字段：

```text
user_id
disk_space
path
source_app_id
review_status
review_updated_at
deleted_at
created_at
updated_at
```

唯一约束至少要保护：

```text
user_id + disk_space + path
```

### 是否应该趁这次改成 `parent_id` 树

这是一个需要 Codex本地评估的架构决策，本文不写死。

#### 方案 A：继续 path-based

优点：

- 与当前 `folderPath` / API 契合；
- 改动较小；
- move tree 可以在一次事务里批量 rewrite path；
- 更容易保留现有前端行为。

缺点：

- 目录移动需要修改后代 path；
- 数据库内部树关系不够规范化。

#### 方案 B：stable directory id + parent_id

优点：

- 移动目录理论上只需改 parent；
- 关系模型更自然；
- 为未来更复杂目录能力留空间。

缺点：

- 当前大量接口使用 path；
- 路径计算、递归查询、breadcrumb、搜索都需要调整；
- 容易把“持久层事务重构”扩大成“整个目录模型重写”。

本次核心目标是：

```text
事务与多用户一致性
```

不是强制重做目录算法。

因此除非 Codex确认 parent_id 能明显降低整体复杂度，否则可以优先保留 path 语义，在后续版本再单独优化。

---

## 10.6 文件

候选：

```text
drive_files
```

可包含：

```text
id
user_id
disk_space
folder_path
name
mime_type
size

backend_id
channel_id

source_app_id

metadata_json
media_index_json

review_status
review_updated_at
deleted_at

caption_sync_pending
caption_warning

last_checked_at
repaired_at

created_at
updated_at

version（可选）
```

复杂但当前不需要按内部字段查询的对象，例如：

```text
metadata
mediaIndex
```

可以先以 JSON TEXT 形式保留。

重点不是“数据库中绝对不能有 JSON”，而是：

> 不要继续让整个业务实体集合都成为一个 JSON 文件。

---

## 10.7 文件名与目录名冲突约束

当前代码存在类似：

```text
同一目录下：
文件不能和目录重名
文件之间不能重名
目录之间不能重名
```

如果使用：

```text
drive_files
drive_directories
```

两张独立表，那么普通 UNIQUE 只能分别保证：

```text
file-file
directory-directory
```

不能天然保证：

```text
file-directory
```

同名冲突。

这里建议 Codex重点评估两种方案：

### 方案 A：Repository 事务内统一检查

在创建 / rename / move 前：

```text
同一个 transaction 中检查两个表
→ 再写入
```

并结合当前同 scope mutation lock。

### 方案 B：额外建立统一 namespace / entry 表

例如概念：

```text
drive_entries
    user_id
    disk_space
    parent_path / parent_id
    name
    kind
    entity_id
```

由它提供：

```text
UNIQUE(user_id, disk_space, parent, name)
```

这样数据库本身可以防止 file / directory 同名。

由于旧数据无需兼容，方案 B 值得评估；但如果会造成大量冗余和复杂 FK，也不要为了理论纯度强行采用。

---

## 10.8 Telegram 文件分片

强烈建议把当前文件对象中的：

```text
parts[]
```

拆成：

```text
drive_file_parts
```

候选字段：

```text
file_id
part_index
part_count

telegram_file_id
telegram_file_unique_id

message_id
message_date
media_group_id
media_type

offset
size
sha256

original_size
```

候选约束：

```text
PRIMARY / UNIQUE(file_id, part_index)
part_index > 0
size >= 0
```

一个逻辑文件所有 part 的插入应与逻辑文件最终 commit 组成一个短事务。

---

## 10.9 Thumbnail

当前文件可能包含独立 Telegram thumbnail。

可评估：

```text
drive_file_thumbnails
```

一对一保存：

```text
file_id
telegram_file_id
telegram_file_unique_id
message_id
message_date
media_type
size
mime_type
```

也可以直接放 `drive_files` 若字段很少。

以实际代码查询模式决定，不必为了拆表而拆表。

---

## 10.10 `fileIdHistory`

修复文件时当前会保存历史 Telegram 文件实体。

可以：

```text
drive_file_history
```

也可以暂时：

```text
file_id_history_json
```

如果历史记录只用于极少数修复 / 诊断流程，JSON TEXT 可能已经足够。

如果后续需要查询每一次历史实体，则拆表更合适。

Codex 应根据真实用途决定。

---

## 10.11 分享

建议：

```text
disk_shares
disk_share_files
disk_share_directories
```

`disk_shares`：

```text
id
token
owner_id
disk_space
title
created_at
stopped_at
```

`disk_share_files`：

```text
share_id
file_id
snapshot_name
relative_folder_path
```

`disk_share_directories`：

```text
share_id
relative_path
```

`token` 需要 UNIQUE。

创建整个 Share snapshot 应在一次短 transaction 中完成。

但 Share 创建 transaction 内不要做 Telegram 网络访问。

---

## 10.12 Operation

建议：

```text
disk_operations
```

字段可覆盖：

```text
operation_id
user_id
disk_space
device_id
type

status
phase
title
message

percent
last_measured_percent
processed_bytes
total_bytes

upload_id
folder_path

cancel_requested

error_code
error_message
error_details_json
result_json

created_at
updated_at
started_at
finished_at
```

### 高频进度更新

即使换数据库，也不代表每一个字节进度事件都要立即 `UPDATE`。

可以继续保留：

```text
节流
合并
debounce
```

但现在只更新一行，不再写整个 operation 列表。

### 重启处理

当前语义：

```text
服务重启后
所有非 terminal job
→ failed / interrupted / SERVER_RESTARTED
```

可以在数据库初始化完成后用一次事务处理。

如果某些上传任务未来具备真正 resume/recovery 能力，可再针对特定 type 细化，不必本次一刀切。

---

## 10.13 Telegram Chunk `file_id` Cache

建议：

```text
telegram_chunk_file_ids
```

候选：

```text
backend_id / backend_key
sha256
size

telegram_file_id
telegram_file_unique_id
updated_at
```

唯一约束：

```text
backend + sha256 + size
```

这张表是缓存，可以支持过期清理，不需要像 drive file 一样永久保留。

---

## 10.14 Part Cache Owner

建议：

```text
telegram_part_cache_owners
```

候选：

```text
cache_key
user_id
disk_space
created_at / last_used_at
```

唯一：

```text
cache_key + user_id + disk_space
```

实际：

```text
telegram-part-cache/*.part
```

仍保留文件系统。

---

## 10.15 Telegram 1-Byte Placeholder

当前：

```text
tg-1byte-file.id
```

可以评估迁为：

```text
telegram_placeholders
```

候选：

```text
backend_key / backend_id
telegram_file_id
updated_at
```

实际：

```text
tg-1byte-placeholder.bin
```

仍然可以是普通文件。

---

## 11. 外键与删除行为不要机械使用 CASCADE

数据库化后很容易产生这样的冲动：

```text
所有关联表都 ON DELETE CASCADE
```

这在当前网盘未必正确。

例如：

### 文件删除 / 审核删除

当前存在 tombstone / `reviewStatus = deleted` 语义：

```text
保留逻辑占位
清除 Telegram 实体引用
```

这意味着很多时候：

```text
不是 DELETE drive_files
```

而是更新状态。

### App 删除

当前 App 删除会撤销 Token，但 Backend / 已有文件需要继续保持存储连续性。

因此：

```text
app 删除
≠
删除所有 backend
≠
删除所有 file
```

### Share

Share 保存的是 snapshot，但访问文件时仍会检查当前文件是否 active。

因此表之间：

```text
CASCADE
RESTRICT
SET NULL
soft delete
```

必须按真实业务语义逐个决定。

---

## 12. 事务边界设计

核心原则：

> **一个 transaction 应只覆盖需要原子成立的本地数据库状态，而且尽量在毫秒级完成。**

---

## 12.1 创建目录

事务内：

```text
验证目标 parent / path
验证名称冲突
插入目录
touch parent
```

提交。

---

## 12.2 rename / move 文件

事务内：

```text
加载当前 file
验证 destination
验证 file / directory 名称冲突
更新 folder_path / name
设置 caption_sync_pending
touch old parent
touch new parent
```

提交。

事务外：

```text
Telegram editMessageCaption / syncCaption
```

如果 Telegram caption 更新失败：

```text
保留 caption_sync_pending
后台 retry
```

不要为了等待 Telegram 而不提交文件 move。

---

## 12.3 move directory

事务内：

```text
验证 source
验证 destination
防止 cycle
验证名称冲突
验证 max depth
更新目录树
更新所有后代 file folder_path
设置相关 file caption_sync_pending
touch old parent
touch destination
```

全部成功再 COMMIT。

任何 SQL 失败：

```text
ROLLBACK
```

然后事务外异步同步 Telegram captions。

---

## 12.4 创建 Share

事务内：

```text
验证选择项
读取需要的 snapshot
验证 review status
插入 disk_shares
插入 share files
插入 share directories
```

提交。

不要出现：

```text
share 主记录已经存在
但只写了一半 files
```

---

## 12.5 App 更新

例如 `saveApp`：

事务前可以先做昂贵但不依赖数据库锁的：

```text
scrypt(app_secret)
URL validation
```

然后短事务：

```text
再次检查当前 app 状态 / revision
insert or update app
revision + 1
撤销该 app 的旧 access tokens
```

这样可以避免：

```text
先检查
await scrypt
状态已经改变
仍按旧快照覆盖
```

---

## 12.6 Token 签发

可以：

```text
事务外生成随机 token
事务外完成纯 CPU / crypto 准备
```

短事务中：

```text
确认 app 仍 enabled 且 revision 匹配
get-or-create backend
删除 / 清理过期 token（是否同步做由性能决定）
insert token hash
update app lastIssuedAt / lastUsedAt
```

---

## 12.7 Passkey verify

WebAuthn cryptographic verification在 transaction 外完成。

验证成功后短事务：

```text
再次确认 credential / username 唯一
创建 / 更新 user
插入 passkey
或更新 passkey counter
```

不要把 WebAuthn 验证过程放在 SQLite transaction 中等待。

---

## 12.8 Operation

普通进度：

```text
UPDATE 一行
```

terminal：

```text
UPDATE status / result / finished_at
```

如果某个本地数据库 commit 需要与 Operation 完成状态绝对一致，可以在同一个短事务中更新。

---

## 13. 最重要的规则：Telegram 网络调用绝对不要包含在 SQLite 长事务中

禁止：

```text
BEGIN

调用 sendMediaGroup
等待 30 秒
429 retry
等待 20 秒
继续上传
editMessageCaption
等待网络

COMMIT
```

这样会造成：

- writer 长时间被占；
- 其它用户写请求积压；
- `SQLITE_BUSY` 风险；
- WAL 增长；
- 崩溃恢复更困难。

---

## 14. 推荐采用 Saga / 补偿事务思路处理 Telegram 远程副作用

SQLite transaction 无法和 Telegram API 构成真正分布式事务。

因此应明确采用类似：

```text
本地状态
→ 远程副作用
→ 本地最终确认
→ 失败时补偿 / recovery
```

---

## 14.1 上传示例

### Phase A：创建本地任务

短事务：

```text
创建 Operation / upload intent
必要时记录 logical target / reservation
COMMIT
```

### Phase B：客户端上传临时分片

```text
浏览器 → staging 文件
```

不需要长期数据库事务。

### Phase C：Telegram 上传

```text
Telegram API
重试
429 wait
multipart upload
thumbnail upload
```

全部 transaction 外执行。

### Phase D：最终逻辑文件 Commit

Telegram 成功后：

```text
BEGIN

确保目录存在
再次验证名称冲突
INSERT drive_file
INSERT drive_file_parts
INSERT thumbnail
UPDATE Operation completed

COMMIT
```

### Phase E：数据库 finalization 失败

如果 Telegram 已成功，但 DB commit 失败：

```text
不要假装任务成功
记录 recovery 所需信息
尝试删除刚上传到 Telegram 的远程消息
删除失败则进入后台补偿队列
```

当前项目已经存在：

- upload manifest；
- restart cleanup；
- Telegram remove；
- recovery backlog；

这些机制应优先复用 / 重构，而不是推倒重来。

---

## 14.2 不要把 recovery 信息只存在易丢内存中

如果远程 Telegram 已经产生副作用，但数据库 final commit 尚未完成，则至少要有一种崩溃后还能恢复的信息来源。

当前：

```text
telegram-drive-staging/<uploadId>/upload-manifest.json
```

就是一种有价值的“DB 之外恢复线索”。

因此本次即使数据库化，也不应不加分析就删掉 staging manifest。

可以选择：

### 方案 A

继续保留独立 upload manifest。

### 方案 B

把 upload session / remote parts 也持久化到：

```text
disk_upload_sessions
disk_upload_parts
```

但仍保留最小文件恢复标记。

哪一种更好应由 Codex结合当前上传恢复测试决定。

---

## 15. 当前 `mutate()` 不建议因为有 SQLite 就直接删除

当前 `disk-api.js` 有大致：

```text
[userId, diskSpace] → Promise mutation queue
```

它的作用并不只是“防 JSON 写坏”。

它还承担：

> 同一个逻辑网盘中的长业务动作串行化。

例如：

```text
A 正在 move directory
B 同时 delete directory

A 正在上传到目标目录
B 同时 rename 同路径

A 已更新本地状态
正在同步 Telegram caption
B 又修改同一对象
```

SQLite transaction 主要负责：

```text
本地数据库一致性
```

但不能自动解决：

```text
跨多个 transaction
+
Telegram remote side effects
+
业务状态机
```

因此第一阶段更稳妥的是：

```text
保留 / 重构 mutate keyed mutex
+
使用 SQLite transaction
```

但要重新审查 lock 粒度。

---

## 16. 为未来多实例准备：把业务锁和数据库适配器分开

当前 `mutate()` 是进程内锁。

未来如果：

```text
Node 实例 A
Node 实例 B
```

同时访问 PostgreSQL，那么：

```text
A 的 Map mutex
```

根本看不到：

```text
B 的 Map mutex
```

因此建议架构上不要把：

```text
Mutation Coordinator
```

和：

```text
Database Adapter
```

混成一个东西。

概念上可以是：

```text
MutationCoordinator
  ├─ 当前：LocalKeyedMutex
  └─ 未来：
       PostgreSQL advisory lock
       Redis lock
       DB row lock
       optimistic concurrency
       ...
```

这样当前 SQLite 单实例继续使用简单本地锁。

未来扩容时，再替换协调器实现。

---

## 17. 可选：使用 version 做 Optimistic Concurrency

对于特别容易发生“读取旧对象后更新”的核心表，可以评估：

```text
version INTEGER
```

更新：

```text
UPDATE ...
SET ..., version = version + 1
WHERE id = ? AND version = ?
```

如果 affected rows = 0：

```text
说明状态已经被别人修改
→ 重新读取 / 返回冲突
```

这不是当前 SQLite 必须项，但它：

- 对未来 PostgreSQL 很友好；
- 能明确避免 stale write；
- 可减少对大粒度锁的依赖。

可以优先评估：

```text
drive_files
disk_apps
```

是否有实际需要。

---

## 18. 媒体播放与 Range 请求不要持有长 read transaction

网盘播放器会不断：

```text
查询文件元数据
查询 parts
读取 Telegram / cache
长时间向浏览器流式输出
```

正确结构应是：

```text
短查询：
SELECT file + parts
↓
立即结束 DB statement / transaction
↓
使用内存 snapshot
↓
开始 Telegram / 文件缓存流
↓
几分钟甚至几十分钟播放
```

不要：

```text
打开 read transaction
↓
拿 DB cursor
↓
一边迭代 DB 一边给浏览器播放视频
```

否则可能：

- 长 read transaction；
- WAL checkpoint 受阻；
- WAL 文件持续增长。

---

## 19. 哪些东西仍然应该留在文件系统

数据库化不等于把所有数据都变成 SQLite BLOB。

建议继续文件化：

### Telegram part cache

```text
telegram-part-cache/*.part
telegram-part-cache/*.tmp
```

### 上传 staging

```text
telegram-drive-staging/<uploadId>/...
```

### 真实上传临时分片

不要塞进 DB。

### 日志

例如：

```text
disk upload log
Telegram request log
```

继续普通日志文件。

### Secret Key

```text
disk-secret.key
```

保持独立密钥材料。

### 1 Byte placeholder binary

```text
tg-1byte-placeholder.bin
```

可以继续普通文件。

数据库只负责：

```text
关系元数据
状态机
索引
约束
归属
```

而不是媒体字节本身。

---

## 20. 从旧 JSON 数据重新开始：本次不做 JSON → SQLite 数据迁移

用户已经明确：

> 当前仍是测试阶段，现有网盘 JSON 数据可以放弃。

因此本次不需要开发复杂的：

```text
migrate-disk-json-to-sqlite
```

也不需要：

```text
dual write JSON + SQLite
```

更不要：

```text
启动时先读 SQLite
失败自动 fallback 老 JSON
```

否则会重新制造两个 Source of Truth。

### 20.1 新版本目标

```text
如果 disk.sqlite 不存在
→ 初始化空 schema
→ 网盘从空数据开始
```

此后：

```text
disk.sqlite
```

成为新的网盘权威元数据源。

### 20.2 不要直接 `rm -rf .tunnel-data`

`.tunnel-data` 里还有其它子系统数据。

即使网盘 JSON 可以全部丢弃，也只能针对确认属于网盘 legacy state 的文件做清理。

不要删除：

```text
infra.sqlite
SNS / YouTube 数据
其它模块缓存
其它非网盘状态
```

### 20.3 Legacy JSON 的处理方式

可以选择：

```text
停止读取
停止写入
保留原文件不管
```

或者提供明确的开发清理脚本：

```text
scripts/reset-disk-state...
```

只删除已确认属于网盘的旧文件。

不建议程序启动时静默删除未知文件。

### 20.4 数据重置后的预期影响

需要接受：

```text
旧网盘文件索引消失
旧目录结构消失
旧分享失效
旧 Operation 历史消失
旧 App / Token / Passkey 数据可能需要重建
旧 Telegram file_id cache 消失
旧 part cache owner 元数据失效
```

### 20.5 Telegram 远程旧文件不会因为 DB 重置自动消失

这一点要特别注意。

本地：

```text
telegram-drive-index.json
```

被放弃以后，之前测试阶段已经上传到 Telegram Channel 的消息仍然存在。

新 `disk.sqlite` 不再认识它们。

Codex 不要因为本地 reset 就擅自批量删除 Telegram Channel 里的历史消息。

如果用户以后想清理测试 Channel，应作为独立操作处理。

---

## 21. Browser / 前端本地缓存也需要考虑“服务器数据从零开始”

服务端 DB 清空后，浏览器可能仍保留：

```text
文件缓存
IndexedDB
Cache Storage
旧逻辑 file id
旧目录记忆
任务 id
```

需要检查现有前端数据模型。

可能需要：

- bump 网盘本地 cache schema；
- 遇到旧 file id 404 时自动淘汰；
- Auth 用户重建后隔离旧 user cache；
- 清除旧 operation references；
- 不要让“服务器已空”但“浏览器仍展示旧文件”。

具体是否需要主动清理，应由 Codex检查当前浏览器缓存实现再决定。

---

## 22. API 与前端修改原则

理想情况下：

```text
持久层大改
≠
前端 API 全部重写
```

应尽量继续保留现有对外语义，例如：

```text
list
tree
files
directories
operations
shares
reviews
part-cache
storage-overview
storage-contents
```

如果当前前端只消费 REST JSON，而不直接知道 JSON 文件位置，则前端可以基本不感知：

```text
JSON Store
→ SQLite
```

### 22.1 重点回归后台

当前后台网盘管理依赖：

```text
storage overview
用户 / 分区树
storage contents
review
part cache overview / clear
```

重构后这些数据应直接由 Repository 查询，不再通过遍历多个 JSON store 拼装。

### 22.2 Admin 跨 scope 查询和普通用户 Repository 分开

普通用户方法最好天然要求：

```text
scope = { userId, diskSpace }
```

避免漏传 scope 导致跨用户数据泄露。

后台管理则使用明确的：

```text
AdminRepository
```

做跨用户查询。

不要为了后台方便把普通 Repository 变成：

```text
userId 可选
```

---

## 23. 安全要求

### 23.1 所有动态数据使用参数化 SQL

禁止：

```text
"SELECT ... WHERE path = '" + userPath + "'"
```

必须 prepared / bound parameters。

### 23.2 Token / Bot Token 不要明文落库

保留当前：

```text
hash access token
encrypt Telegram token / credentials
```

等安全语义。

### 23.3 DB 文件权限

至少应延续当前敏感 JSON 的：

```text
0600
```

级别保护思想。

具体文件 mode 根据目标系统支持情况实现。

### 23.4 不要在日志中输出

```text
Bot Token
App Secret
Access Token
完整 encryptedCredentials 解密结果
Passkey private/sensitive material
```

数据库异常日志也不要把 bind params 无过滤全部打印。

---

## 24. 索引建议

根据当前查询模式可先评估：

```text
drive_files(user_id, disk_space, folder_path)
drive_files(user_id, disk_space, folder_path, name)

drive_directories(user_id, disk_space, path)

drive_file_parts(file_id, part_index)

disk_operations(user_id, disk_space, created_at)
disk_operations(status, updated_at)

disk_shares(owner_id, disk_space, created_at)
disk_shares(token)

disk_space_usage(user_id, disk_space)
disk_space_usage(app_id, user_id, disk_space)

disk_access_tokens(expires_at)
disk_access_tokens(app_id)

telegram_chunk_file_ids(backend_id/key, sha256, size)

telegram_part_cache_owners(user_id, disk_space)
telegram_part_cache_owners(cache_key)
```

最终以 `EXPLAIN QUERY PLAN` 和真实数据量调整。

不要因为“可能以后有用”一次创建大量无依据索引。

---

## 25. 数据库连接与事件循环

如果最终选择 `better-sqlite3`：

- SQL 调用是同步的；
- 普通短查询很适合；
- 大型查询、无索引扫描、巨型 transaction 会阻塞 Node event loop。

因此要确保：

```text
事务短
查询有索引
不要 SELECT 巨量数据后再 JS 全表过滤
不要把视频 bytes 放 DB
不要在 transaction 内做网络
```

后台如果需要 10 万条文件管理，应：

```text
分页
按条件查询
```

而不是一次加载整个数据库。

---

## 26. WAL / Backup / Restore

进入 WAL 后，运行时可能存在：

```text
disk.sqlite
disk.sqlite-wal
disk.sqlite-shm
```

不要在数据库活跃时简单：

```text
cp disk.sqlite backup.sqlite
```

并假定得到了一致快照。

推荐使用所选 driver / SQLite 提供的：

```text
backup API
VACUUM INTO
受控 checkpoint + backup
```

之一。

具体方式由最终 driver 决定。

### 26.1 `.tunnel-data` 空间查看页

当前后台已经有查看 `.tunnel-data` 空间占用的功能。

以后看到：

```text
disk.sqlite-wal
```

占用空间并不一定代表异常。

如果 WAL 异常增长，应排查：

- 长 read transaction；
- checkpoint starvation；
- 大型 transaction；
- checkpoint 策略。

不要在 UI 中简单把 `-wal` 当垃圾文件删除。

---

## 27. 推荐代码模块拆分

可以考虑：

```text
server/disk-db/
  index.js

  adapters/
    sqlite/
      connection.js
      migrations/
      repositories/
        auth.js
        drive.js
        operations.js
        shares.js
        telegram-cache.js

  repositories/
    index.js
```

或者：

```text
server/disk-data/
  adapter.js
  sqlite-adapter.js
  auth-repository.js
  drive-repository.js
  ...
```

名称不是重点。

重点是：

```text
SQLite SQL
PRAGMA
SQLite transaction mode
prepared statements
row mapping
```

全部限制在 Data / Adapter 层。

---

## 28. 当前核心文件预计牵连范围

至少应检查：

```text
server/disk-data.js
server/telegram-drive.js
server/disk-auth.js
server/disk-operations.js
server/disk-shares.js
server/disk-chunk-file-cache.js
server/disk-part-cache.js
server/disk-api.js
server/disk-telegram.js
server.js
package.json
package-lock.json
```

还应检查：

```text
client/disk-management.js
pages/disk-management.html
其它网盘前端代码
所有 disk tests
部署脚本
备份脚本
.gitignore
```

不代表以上文件全部必须修改。

如果 REST API 保持兼容，很多前端文件可能只需要回归测试而无需改代码。

---

## 29. 建议的分阶段实施顺序

### Phase 0：盘点与设计冻结

完成：

```text
所有 drive JSON / 文件持久化点 inventory
所有 readJson/writeJson 调用点 inventory
API 调用链
Store 调用链
当前 tests
运行 Node / OS / deploy 约束
```

输出一份简短本地分析后再动手。

---

### Phase 1：建立数据库基础层

新增：

```text
disk.sqlite 打开
SQLite adapter
migration runner
schema v1
WAL / foreign_keys / busy_timeout
close / health / backup 基础能力
```

此阶段先不要大面积改业务。

---

### Phase 2：Auth Repository

优先改：

```text
disk-auth.json
```

因为它有：

- UNIQUE 需求；
- async crypto race；
- App / Token / Backend 强关系。

完成：

```text
users
passkeys
apps
backends
tokens
```

测试通过再继续。

---

### Phase 3：Drive 核心索引

重构：

```text
telegram-drive-index.json
telegram-drive-directories.json
disk-spaces.json
disk-space-usage.json
```

目标：

```text
files
directories
parts
thumbnail
space usage
```

都进入 `disk.sqlite`。

保留现有：

```text
staging file
upload manifest
```

直到上传恢复机制稳定。

---

### Phase 4：Operation / Share

替换：

```text
disk-operations.json
disk-shares.json
```

同时把原有：

```text
500ms operation debounce
restart interrupted handling
share snapshot
```

迁入新结构。

---

### Phase 5：Telegram Cache Metadata

替换：

```text
telegram-chunk-file-ids.json
telegram-part-cache/.owners.json
tg-1byte-file.id（如最终确认适合）
```

实际缓存 bytes 继续文件系统。

---

### Phase 6：Remote Side Effect / Recovery 加固

重点覆盖：

```text
Telegram upload 成功、DB commit 失败
DB commit 成功、caption sync 失败
删除 Telegram 部分成功、部分失败
server restart
upload staging recovery
cancel race
```

确保没有因 SQLite 化破坏原本已经存在的回滚机制。

---

### Phase 7：停止 Legacy JSON 读写

全局搜索确认：

```text
核心网盘权威状态
```

不再调用旧 JSON。

注意：

```text
不要求所有 readJson/writeJson 从项目中消失
```

因为其它子系统可能仍然合理使用 JSON。

只要求：

> 本次确定迁入 `disk.sqlite` 的网盘共享权威状态，不再出现 JSON fallback / dual-write。

---

### Phase 8：前后台回归

验证：

```text
普通网盘
后台网盘管理
分享
审核
缓存管理
播放器
Range
上传
Operation
Passkey
App API
```

---

## 30. 并发测试建议

不能只跑原有单线程 happy path。

至少补充：

### 30.1 同 user + same diskSpace

并行：

```text
两个 create same filename
```

预期：

```text
一个成功
一个明确 conflict
不能出现两个重名实体
```

### 30.2 两个不同文件同时 rename 到同名

预期同上。

### 30.3 Move + Delete 同一目录

验证：

- 不出现半棵目录树；
- 一个操作获胜；
- 另一个得到稳定冲突 / not found；
- 无脏引用。

### 30.4 不同用户同时写

```text
user A / default
user B / default
```

不应互相污染。

### 30.5 同用户不同 diskSpace

资源必须隔离。

### 30.6 Auth race

两个并发：

```text
create same app_id
```

或：

```text
register same username / passkey credential
```

必须由 DB constraint / transaction 得到确定结果。

### 30.7 Operation 高频更新

多个任务同时：

```text
update progress
cancel
complete
```

不能覆盖其它任务状态。

### 30.8 Cache owner register + clear

验证 `.part` 仍在读时：

```text
clear
```

必须保持当前“busy skip”之类的安全语义。

---

## 31. 崩溃 / 故障注入测试

SQLite 的价值很大一部分来自异常情况下的确定性，因此需要主动测试。

### 31.1 Transaction 中途 throw

例如 move directory：

```text
更新一半后人为 throw
```

重启 / 查询后应该：

```text
全部保持旧状态
```

而不是半迁移。

### 31.2 Telegram upload 成功后 final DB commit 失败

模拟：

```text
Telegram 返回成功
↓
DB INSERT 报错
```

应进入：

```text
补偿删除 / recovery
```

而不是产生不可见远程垃圾且 operation 显示成功。

### 31.3 服务在上传过程中退出

重启后：

- staging manifest 能识别；
- 已上传 Telegram remote parts 能回滚或恢复；
- Operation 状态合理。

### 31.4 WAL 下读写并发

写事务运行时并发执行：

```text
list directory
get file
admin overview
```

确认不会出现不必要的全局阻塞。

---

## 32. 现有测试回归

Codex 应先扫描当前 `tests/`，优先保留已有覆盖，例如当前分支已经存在的网盘相关测试类型包括：

```text
disk-api
disk-client
disk-directory-actions
disk-sharing
disk-part-cache
disk-storage-regression
disk preview / history
近期 bug regression
```

具体文件名以执行时分支为准。

所有原有业务行为测试原则上应该继续通过。

如果某个旧测试只是断言：

```text
某 JSON 文件必须存在
```

而业务行为已经正式迁 SQLite，则应改写测试目标，而不是为了旧测试继续保留 JSON 双写。

---

## 33. 新 Repository 层测试

建议直接为数据访问层增加测试：

```text
create empty DB
apply migrations
CRUD
transaction rollback
unique constraints
foreign keys
restart reopen
multiple scopes
```

如果未来要做 PostgreSQL Adapter，这些 Repository contract tests 可以复用。

可以构建：

```text
Repository Contract Test Suite
```

然后：

```text
SQLiteAdapter
```

必须通过。

未来：

```text
PostgreSQLAdapter
```

也跑同一套 contract test。

这会真正体现“适配器思维”，而不是只在代码结构上取一个 Adapter 名字。

---

## 34. 未来数据库迁移友好的设计约束

### 34.1 ID 尽量在应用层生成

当前已经大量使用 UUID。

继续：

```text
crypto.randomUUID()
```

比依赖：

```text
SQLite autoincrement
```

更容易跨 DB。

### 34.2 Timestamp 使用统一格式

当前大量使用：

```text
Date.now()
```

即 epoch milliseconds。

如果继续采用 INTEGER ms，应在 Repository contract 中明确，不要不同表混用：

```text
seconds
milliseconds
ISO string
database timestamp
```

### 34.3 Boolean

Repository 对外使用：

```text
true / false
```

SQLite Adapter 内转换为：

```text
0 / 1
```

不要让业务层依赖 SQLite boolean 表达。

### 34.4 JSON

业务层把：

```text
metadata
mediaIndex
result
errorDetails
```

视为普通对象。

SQLite Adapter 可以：

```text
JSON.stringify
```

未来 PostgreSQL Adapter 可以：

```text
JSONB
```

业务层不要直接调用：

```text
json_extract(...)
```

除非通过 Repository 能力抽象。

### 34.5 UPSERT / RETURNING

不要让业务层依赖 SQLite：

```text
INSERT OR REPLACE
last_insert_rowid()
```

这些细节由 Adapter 隐藏。

### 34.6 Pagination

Repository 定义：

```text
limit
cursor / offset
```

具体 SQL 方言由 Adapter 实现。

---

## 35. 不建议为了“数据库无关”自行造大型 ORM

目标不是做一个通用数据库框架。

本项目更适合：

```text
稳定 Repository Contract
+
手写、可控、参数化 SQL
+
每种 DB 一个 Adapter
```

而不是：

```text
自己实现 SQL parser
自己实现 query builder
自己实现 ORM
自己实现跨数据库 migration language
```

真正值得抽象的是：

```text
业务数据访问语义
```

不是把所有 SQL 能力重新发明一遍。

---

## 36. 前台和后台牵连预估

### 前台

如果 REST contract 不变，理想情况下不需要理解 SQLite。

重点回归：

- 登录；
- 目录列表；
- 上传；
- move / rename；
- 删除；
- 分享；
-播放器；
- 缓存；
- Operation；
- 多选操作；
- 浏览器本地缓存与服务器 reset 的关系。

### 后台

重点：

- 网盘用户 / 分区树；
- storage overview；
- storage contents；
- review；
- part cache overview / clear；
- App 管理；
- 用户身份；
- 数据空间占用。

后台原来如果依赖遍历多个 Store：

```text
spaces.entries()
store.adminFiles()
```

数据库化后可以通过 admin repository 直接查询，但返回 API 格式尽量保持。

---

## 37. Observability 建议

为了未来判断 SQLite 是否真的遇到瓶颈，可增加低噪声指标：

```text
DB open / migration failure
SQLITE_BUSY count
write transaction duration
slow query threshold
WAL size
checkpoint failure
DB integrity error
```

不要每条 SQL 全量 log。

也不要把敏感参数写日志。

如果日后看到：

```text
频繁 SQLITE_BUSY
writer 等待明显
WAL 持续异常增长
Node event loop 被重查询阻塞
```

再据此决定是否需要：

```text
优化索引
缩短 transaction
降低 operation update 频率
调整 checkpoint
升级 PostgreSQL
```

不要现在凭理论提前把架构做成大型分布式数据库系统。

---

## 38. 重构后的备份要求

需要明确：

```text
disk.sqlite
```

以后会成为重要数据文件。

必须设计至少一个可靠 backup 方法。

如果使用 `better-sqlite3`，可以评估 driver backup API。

如果使用其它 driver，可以评估：

```text
SQLite online backup
VACUUM INTO
受控停机复制
```

不要把：

```text
正在运行时只复制 disk.sqlite 主文件
```

当成可靠备份。

恢复测试也应该加入：

```text
backup
→ 删除数据库
→ restore
→ 文件 / 目录 / auth / shares 可读
```

---

## 39. 本次不建议顺便做的事情

除非本地分析明确需要，否则不要因为“大重构”无限扩 scope。

例如暂不必：

```text
把所有媒体 byte 存 SQLite
把所有日志存 SQLite
重写整个播放器
重写整个 Telegram 上传协议
直接改 PostgreSQL
开发分布式锁服务
开发通用 ORM
重做全部前端 UI
迁移旧测试 JSON 数据
```

本次重点仍然是：

```text
网盘共享元数据
+
事务
+
并发一致性
+
适配器边界
```

---

## 40. 建议的最终架构示意

```text
Browser / Third-party App / Admin
                │
                ▼
         Express / Disk API
                │
                ▼
        Disk Domain Service
                │
      ┌─────────┴──────────┐
      ▼                    ▼
MutationCoordinator   Telegram Service
 Local Keyed Mutex     network / upload
      │                    │
      ▼                    │
 Repository Contract       │
      │                    │
      ▼                    │
 Database Adapter          │
      │                    │
      ▼                    │
 SQLite Adapter            │
 WAL + Transaction         │
      │                    │
      ▼                    │
 .tunnel-data/disk.sqlite  │
                           │
          ┌────────────────┘
          ▼
 Telegram Channel / Bot API

文件系统继续保存：
- upload staging
- telegram-part-cache bytes
- logs
- disk-secret.key
- temporary files
```

未来可以替换：

```text
SQLite Adapter
      ↓
PostgreSQL Adapter
```

以及：

```text
LocalKeyedMutex
      ↓
PostgreSQL advisory lock / Redis / other coordinator
```

尽量不修改：

```text
Disk Domain Service
REST contract
Telegram workflow
前端业务
```

---

## 41. Codex 实施时的决策清单

以下事项不要只按本文猜测，应结合本地代码确认后决定：

- [ ] 最终 SQLite driver：`better-sqlite3`、`node:sqlite` 或其它；
- [ ] 当前全部部署环境是否支持选定 driver；
- [ ] Repository 对外是否本次就 async 化；
- [ ] 目录内部继续 path-based 还是引入 parent_id；
- [ ] 是否需要统一 `drive_entries` 来强制 file / directory 跨类型重名约束；
- [ ] `fileIdHistory` 拆表还是 JSON TEXT；
- [ ] thumbnail 独立表还是文件表字段；
- [ ] upload session 是否进入 DB；
- [ ] upload manifest 是否继续保留为 crash recovery 辅助；
- [ ] `tg-1byte-file.id` 是否迁 DB；
- [ ] `disk-secret.key` 的最终 key management；
- [ ] `synchronous=FULL` / `NORMAL`；
- [ ] checkpoint 策略；
- [ ] operation progress 写入节流频率；
- [ ] 是否引入 version / optimistic concurrency；
- [ ] legacy JSON 只停止使用还是提供清理脚本；
- [ ] 浏览器旧缓存如何识别服务端 reset；
- [ ] 现有 disk identity cookie / session 在 auth 数据清空后的处理；
- [ ] 后台跨用户查询是否需要专门 Admin Repository；
- [ ] 现有 backup / deploy 脚本是否要适配 WAL。

任何一个决定如果和本文推荐不同，只要：

```text
实际代码支持
业务语义正确
测试覆盖
理由清楚
```

都可以采用。

---

## 42. 验收标准

重构完成后至少应满足：

### 数据源

- [ ] `.tunnel-data/disk.sqlite` 成为网盘共享权威元数据源；
- [ ] WAL 模式实际启用；
- [ ] foreign key 实际启用；
- [ ] 不存在核心网盘状态 JSON / SQLite 双写；
- [ ] 不会因为 legacy JSON 存在而自动 fallback。

### 多用户

- [ ] 不同用户数据严格隔离；
- [ ] 同用户不同 `disk_space` 严格隔离；
- [ ] 后台管理员跨 scope 查询仍正常；
- [ ] 少量用户同时读写无明显异常。

### 事务

- [ ] 文件 move / rename 具备原子性；
- [ ] 目录 move / recursive mutation 具备原子性；
- [ ] Upload final commit 具备原子性；
- [ ] Share snapshot 创建具备原子性；
- [ ] Auth 强关系更新具备原子性；
- [ ] 故障注入时不会产生“半个目录树”或“半个逻辑文件”。

### Telegram

- [ ] Telegram 网络调用不位于 SQLite 长事务中；
- [ ] 429 / 网络 retry 不占用 DB writer；
- [ ] Telegram 成功但 DB finalization 失败时存在补偿 / recovery；
- [ ] caption sync 失败仍能按现有 pending/retry 思路恢复；
- [ ] server restart 后上传残留能处理。

### Cache

- [ ] Telegram part bytes 仍然保存在文件系统；
- [ ] owner metadata 数据库化后 scoped clear 正常；
- [ ] busy reader 不被错误删除；
- [ ] orphan cache metadata / files 可安全 reconcile。

### API / UI

- [ ] 普通网盘主要 API contract 保持或有明确兼容调整；
- [ ] 播放器 / Range 不持有长 read transaction；
- [ ] 后台网盘管理正常；
- [ ] 分享正常；
- [ ] review 正常；
- [ ] part cache 管理正常；
- [ ] 数据 reset 后浏览器不会长期展示幽灵文件。

### Future Adapter

- [ ] SQLite SQL / PRAGMA 不散落在 Router / Domain；
- [ ] Repository contract 能表达核心业务；
- [ ] SQLite implementation 可以被替换；
- [ ] 不追求“零修改迁 PostgreSQL”，但迁移成本主要集中于 Adapter / Repository / Migration；
- [ ] 本地 keyed mutation lock 没有被误认为未来多实例锁。

### 测试

- [ ] 原有网盘业务测试通过；
- [ ] 新 Repository contract tests 通过；
- [ ] 新 transaction rollback tests 通过；
- [ ] 新 concurrency tests 通过；
- [ ] restart / recovery tests 通过；
- [ ] backup / restore 至少有验证路径。

---

## 43. 最终执行原则

本次重构可以比“保守替换 JSON”更彻底，因为测试数据允许放弃。

但彻底不代表盲目扩大范围。

建议 Codex遵循：

```text
先盘点
↓
确定数据边界
↓
建立 Adapter / Repository
↓
建立 disk.sqlite Schema
↓
分模块替换 JSON Store
↓
保留远程 Telegram 的 Saga / Recovery
↓
补并发与故障测试
↓
停止 Legacy JSON 读写
↓
回归前后台
```

最重要的几条原则可以归纳为：

1. **SQLite WAL 负责本地关系数据的一致性，不负责包住 Telegram 网络。**
2. **数据库 transaction 必须短。**
3. **Telegram / FFmpeg / 下载 / 上传 / 流媒体等慢操作必须在 transaction 外。**
4. **远程副作用通过 Operation + Saga + 补偿 / recovery 解决。**
5. **缓存 byte 和 staging byte 不进入 SQLite。**
6. **核心共享权威元数据从 JSON 转到 `disk.sqlite`。**
7. **旧网盘 JSON 不需要迁移，也不要继续 dual-write。**
8. **SQL 和 SQLite 特性留在 Adapter / Repository，不扩散到业务层。**
9. **继续保留必要的业务级 mutation coordinator；SQLite transaction 不能完全替代它。**
10. **未来真正扩容到多实例时，再替换 SQLite Adapter 和 Local Mutation Coordinator，而不是现在提前实现一个分布式系统。**
11. **本文是实施方向，不是阻止 Codex依据最新本地代码做更优选择的死规范。**

---

## 44. 给 Codex 的任务摘要

请在 `dev/2608C-step2` 当前最新代码基础上，对 Telegram 网盘共享持久层进行一次正式的 SQLite WAL / 事务重构。

现阶段旧网盘 JSON 数据全部可以放弃，不需要实现 JSON → SQLite 数据迁移，也不需要兼容旧数据；新数据库从空库开始，基础文件初定为：

```text
.tunnel-data/disk.sqlite
```

请先完整扫描本地代码，确认本文列出的 JSON、额外 JSON、缓存、staging、Auth、Operation、Share、后台、测试及恢复流程的实际关系，再确定最终 Schema 和驱动。

重构目标不是机械“JSON 改 SQLite”，而是建立：

```text
Domain / Service
→ Repository
→ Database Adapter
→ SQLite WAL
```

的持久层结构。

未来可能切换 PostgreSQL / MySQL，因此：

- 不要让 SQLite SQL、PRAGMA、driver API 散落到业务层；
- Repository 应表达业务数据访问语义；
- SQLite 专属能力放 Adapter；
- 不必追求换库零修改，但应尽量把未来改动限制在数据访问和 migration 层。

请重点保证：

- 文件/目录/分片/Auth/Share/Operation 等强关联数据使用短事务；
- 多用户 / 多 `disk_space` 数据隔离；
- 同名、唯一性和 FK 等约束尽可能由数据库保护；
- Telegram 网络调用不进入数据库长事务；
- 上传、删除、caption 等远程副作用继续通过程序层状态机、补偿、重试和重启恢复处理；
- 当前 `mutate()` 一类业务锁不要因为用了 SQLite 就未经分析直接删除；
- part cache 和 staging 的真实文件继续留在文件系统；
- 不要把现有 `infra.sqlite` 的 sql.js 整文件 export 模式误当成本次 WAL 实现；
- 所有现有网盘功能和前后台行为必须回归；
- 增加并发、rollback、crash/recovery 测试。

如果本地调研发现本文某项设计不适合最新代码，请优先保证实际业务正确性，选择更合理方案，并在实现记录中明确说明偏离原因与验证结果。
