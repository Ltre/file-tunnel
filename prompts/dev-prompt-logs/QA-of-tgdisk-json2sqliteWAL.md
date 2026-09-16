问：

    看到网盘多用户共同读写到`.tunnel-data`目录的文件最少有这些：telegram-chunk-file-ids.json、telegram-drive-directories.json、telegram-drive-index.json、disk-space-usage.json、disk-shares.json、disk-operations.json、disk-auth.json、telegram-part-cache/.owners.json 。如果有多用户的情况下，产生脏数据的风险很大吧？
    评估一下改成SQLite WAL/事务 的数据处理方式，并从现有的这些json文件迁移数据到数据库，还有前后台一些牵连到的功能的修改。




答：



我按你指定的 **`dev/2608C-step2`** 看了当前实现。结论是：**这批网盘元数据值得迁到真正的 SQLite WAL + 事务，而且现在迁比继续往 JSON 上堆功能更合适。** 但需要纠正一点：在当前“单 Node 进程”前提下，多用户并不等于这些 JSON 马上就会随机写坏；目前 `writeJson()` 已经是“随机临时文件写完后再 rename”，所以单个 JSON 出现半截内容的概率不高。真正的问题是**跨文件一致性、业务并发、崩溃恢复、整文件反复重写，以及将来一旦出现双进程/cluster 就会非常危险**。

### 当前风险到底在哪里

`telegram-drive.js` 启动时把 `telegram-drive-index.json` 和 `telegram-drive-directories.json` 整体读入两个 `Map`，之后每次文件移动、改名、目录操作、上传 commit、审核等操作，都会把**整个文件索引和整个目录索引分别重新写一遍**。更关键的是 `persist()` 是先写 index，再写 directories，两者不是一个原子事务：如果两次写入之间进程退出、磁盘满或者异常，就可能出现“文件已经移动，目录状态却还是旧的”这类跨文件不一致。

而且网盘一次上传最终 commit 本身会同时涉及目录补齐、逻辑文件、Telegram parts、thumbnail、metadata/mediaIndex 等一整组状态，现在最后仍归结成对 JSON 集合的整体持久化。

当前 `disk-api.js` 已经意识到并发问题，所以专门维护了：

```text
[userId, diskSpace] → Promise mutation queue
```

来串行化“同一个逻辑网盘”的修改；这能缓解单进程中的业务竞争，但它属于应用层锁，并不能提供真正的数据事务，也不能解决多个数据文件之间的原子性。

另外，你列出的并不是全部。这个分支至少还存在 `disk-spaces.json`：它记录有哪些 `disk_space`，非默认分区实际会进入 `.tunnel-data/disk-spaces/<sha256(disk_space)>/`，里面又各自拥有自己的 `telegram-drive-index.json` 和 `telegram-drive-directories.json`。`disk-space-usage.json` 则另外维护 `appId + userId + diskSpace` 的使用关系。

因此我会这样评价现状：

| 当前数据                                         | 风险/性质                                     | SQLite 迁移优先级 |
| -------------------------------------------- | ----------------------------------------- | -----------: |
| `telegram-drive-index.json`                  | 核心文件元数据，写频繁，包含 parts/mediaIndex/backend 等 |       **最高** |
| `telegram-drive-directories.json`            | 与文件索引必须保持一致，移动/删除目录会批量修改                  |       **最高** |
| `disk-auth.json`                             | 用户、Passkey、App、Backend、Token 都在一个文件       |       **最高** |
| `disk-shares.json`                           | 分享主体及文件/目录快照，需要一致性                        |            高 |
| `disk-operations.json`                       | 高频状态更新，当前还有 500ms debounce                |            高 |
| `disk-spaces.json` / `disk-space-usage.json` | 分区发现、来源 App、用户分区关系                        |            高 |
| `telegram-chunk-file-ids.json`               | Telegram `file_id` 复用缓存，可重建但并发写多          |            中 |
| `telegram-part-cache/.owners.json`           | 物理缓存归属关系，不是核心数据但多请求会更新                    |            中 |

例如 `disk-auth.json` 现在也是启动时整份装入内存；新用户、Passkey、App、Backend、Token 都在一个对象中修改后整体保存。特别是其中不少流程存在 `await`，数据库的 UNIQUE 约束和事务会比目前依赖 JS 检查可靠很多。

`disk-operations.json` 也非常适合进数据库。现在全部 Job 放在一个 Map 中，普通进度修改最多延迟 500ms 再整体写 JSON，terminal 状态才立即落盘。

---

## 我建议单独建立真正的 `disk.sqlite`

不要直接拿项目现在已有的 `infra.sqlite` 来承载这套数据。

虽然项目已经依赖 `sql.js`，而且有 `infra.sqlite`，但现在的 `infra-store.js` 实际是：

```text
启动
→ 把整个 SQLite 文件读入 sql.js 内存数据库

修改
→ 修改内存 DB

保存
→ db.export()
→ 整个 SQLite 文件重新写回磁盘
```

也就是说它**不是真正的 SQLite 文件连接，更没有 WAL 带来的并发/事务持久化模型**。

所以这次不要把网盘数据再塞进现有 `sql.js`。

我更推荐：

```text
.tunnel-data/
    disk.sqlite
    disk.sqlite-wal
    disk.sqlite-shm
```

使用真正的 SQLite driver。

对于你这个项目现在大量同步 Store API 的写法，**`better-sqlite3` 很合适**：它直接支持事务，官方项目也明确推荐 WAL；同步 API反而比较容易替换现在大量同步 `Map + writeJson()` 的代码。([GitHub][1])

Node 现在虽然已经内置 `node:sqlite`，但截至当前官方文档仍标记为 Release Candidate，而且你的 `package.json` 没有锁死 Node 版本，所以我不会为了省一个依赖就现在强行改用它。([Node.js][2])

初始化建议：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

你这里并不是高并发互联网服务，优先保证可靠性即可。WAL 可以让读与写同时进行，但 SQLite 仍然一次只有一个 writer，这对你的单机少用户场景正合适。([SQLite][3])

---

## 数据结构不建议一次重构得太激进

我**不建议这次顺便把现在的 `folderPath` 体系全部重写成 parent_id 树形数据库**。那会把“JSON → SQLite”变成一次巨型架构重构，风险反而更高。

第一阶段应该尽量保持现在 Store 的语义，只把持久层替换掉。

例如：

```text
disk_spaces
disk_space_usage

drive_directories
drive_files
drive_file_parts

disk_users
disk_passkeys
disk_apps
disk_backends
disk_access_tokens

disk_shares
disk_share_files
disk_share_directories

disk_operations

telegram_chunk_file_ids
telegram_part_cache_owners
```

`drive_files` 继续保存：

```text
id
owner_id
disk_space
folder_path
name
mime_type
size
backend_id
source_app_id
review_status
created_at
updated_at
...
metadata_json
media_index_json
```

而原来文件里面真正具有关系意义的：

```text
parts[]
```

拆到：

```text
drive_file_parts
```

例如：

```text
file_id
part_index
telegram_file_id
file_unique_id
message_id
message_date
media_group_id
offset
size
sha256
```

这样一个逻辑文件及其 50 个 Telegram 分片，可以在**同一个事务**中落库。

`metadata`、`mediaIndex` 这类目前没必要查询内部字段的复杂对象，第一版继续作为 JSON TEXT 保存即可，不需要为了“用了数据库”而强行全部拆列。

---

## 最重要的变化是事务边界

例如现在“移动目录”会同时：

```text
修改目录路径
修改所有子目录路径
修改下面所有文件 folderPath
设置 captionSyncPending
touch 原父目录
touch 新父目录
```

这些现在是改完 Map 后再写两份 JSON。

迁移后应该变成：

```text
BEGIN IMMEDIATE

UPDATE drive_directories ...
UPDATE drive_files ...
UPDATE parent timestamps ...

COMMIT
```

其中任何一步失败：

```text
ROLLBACK
```

不会再出现一半新、一半旧。

同样，分享创建应当：

```text
share
+ share_files
+ share_directories
```

一次事务提交。当前 `disk-shares.json` 是一个共享数组整体保存。

Auth 里的：

```text
创建/更新 app
撤销旧 token
创建 backend
签发 access token
更新 lastUsedAt
```

也应根据业务组成短事务。

---

## 但 Telegram 网络调用绝对不能包进 SQLite 长事务

这个非常重要。

不要这样：

```text
BEGIN

上传 Telegram 20 分钟
等待 API
重试
等待限流

INSERT ...
COMMIT
```

否则一个上传任务会霸占 writer。

正确方式仍然保留你现在的 Operation/Queue 思路：

```text
DB：
创建 operation / upload 状态
COMMIT

        ↓

Telegram 网络操作
（数据库无长事务）

        ↓

Telegram 全部成功

        ↓

BEGIN IMMEDIATE

创建 directories
创建 drive_file
写入 drive_file_parts
写 thumbnail
更新 operation

COMMIT
```

如果最后 DB commit 失败，继续走现在已经存在的 Telegram 上传回滚/恢复机制。

当前代码其实已经有这个结构雏形：Telegram 全部分片上传完成后进入 `index-write`，才调用 `commit()` 写逻辑文件。

所以 SQLite 化以后，不需要推翻上传架构。

---

## 现有 `mutate()` 不建议直接删

很多人换成 SQLite 后会认为：

> 有事务了，那 JS 的 mutation lock 可以删了。

这里不完全对。

SQLite 事务负责的是：

> **数据一致性**

而现在的 `mutate([userId,diskSpace])` 还承担：

> **业务动作串行化**

比如：

```text
A 正在移动目录
B 同时删除这个目录

A 正在上传到目录
B 同时改名

Telegram caption 更新还没结束
另一操作又修改同一个对象
```

这种涉及远程 Telegram API 的长业务流程，单靠数据库事务解决不了。

所以第一阶段应该：

```text
保留 mutate()
+
SQLite transaction
```

等整个数据层稳定后，再判断哪些锁可以缩小粒度。

---

## `.owners.json` 怎么处理

`.tunnel-data/telegram-part-cache` 里的真正缓存：

```text
*.part
*.tmp
```

**不要放数据库。**

继续留文件系统。

SQLite 只保存：

```text
telegram_part_cache_owners
```

类似：

```text
cache_key
user_id
disk_space

PRIMARY KEY(cache_key,user_id,disk_space)
```

目前 `.owners.json` 正是在记录一个缓存块可能属于多个 `userId + diskSpace`。

这样以后：

```sql
DELETE FROM telegram_part_cache_owners
WHERE user_id = ? AND disk_space = ?
```

比读改写整个 `.owners.json` 干净很多。

缓存文件本身仍按现有逻辑清理。

---

# JSON → SQLite 迁移我建议做一次离线迁移，不要 dual-write

你这个系统用户少、单机，没有必要为了“零停机”做复杂双写。

比较稳的是：

```text
停止服务

↓
备份 .tunnel-data

↓
migrate-disk-json-to-sqlite.js --dry-run

↓
检查

↓
migrate-disk-json-to-sqlite.js --apply

↓
完整校验

↓
启动新版本
```

迁移工具需要认识两种 Store：

```text
默认 disk_space
.tunnel-data/
    telegram-drive-index.json
    telegram-drive-directories.json
```

以及：

```text
非默认 disk_space
disk-spaces.json
        ↓
sha256(disk_space)
        ↓
.tunnel-data/disk-spaces/<hash>/
    telegram-drive-index.json
    telegram-drive-directories.json
```

这个结构就是当前 `createDiskSpaces()` 的实现。

迁移完成以后：

```text
schema_migrations
```

记录类似：

```text
disk_json_v1_to_sqlite_v1
```

并把旧文件改成：

```text
telegram-drive-index.json.migrated.bak
...
```

**不要马上删除。**

但从这一刻开始必须规定：

> `disk.sqlite` 是唯一 Source of Truth。

不要出现：

```text
有时读 SQLite
有时 fallback JSON
两边继续双写
```

这种模式最终反而最容易产生脏数据。

---

## 迁移时至少要做这些校验

例如对每个逻辑文件检查：

```text
ownerId 存在
partIndex 连续
partCount 一致
Σ part.size == file.size
目录存在
file.id 唯一
Telegram message/file ID 保留
thumbnail 保留
metadata/mediaIndex 完整
```

对目录检查：

```text
owner + diskSpace + path 唯一
父级关系有效
```

对 Auth 检查：

```text
user id 唯一
username 唯一
passkey credential id 唯一
app_id 唯一
token hash 唯一
backend id 唯一
```

如果有任意冲突，**迁移脚本停止，不要自作主张丢数据。**

---

# 前端牵连其实可以控制得很小

这是这次改造一个很大的优势。

如果继续保留当前这些 Store 方法和 REST API 的输入输出：

```text
store.list()
store.get()
store.moveFile()
store.moveDirectory()
auth.users()
auth.apps()
operations.list()
shares.list()
...
```

那么 `app.js` 里的网盘前端基本不用知道后台已经从 JSON 换成 SQLite。

后台网盘管理页目前也是通过：

```text
/api/telegram/disk-admin/storage-overview
/api/telegram/disk-admin/storage-contents
/api/telegram/disk-admin/reviews
/api/telegram/disk-admin/part-cache
```

取数据，并没有直接读取 JSON。

管理端 JS 也是只消费这些 API。

所以理想情况下：

> **用户前台 UI 基本零修改，后台页面也基本零修改。**

真正变化集中在服务端持久层。

---

## 后端实际牵连范围会比较大

核心会涉及：

```text
server/disk-data.js
server/telegram-drive.js
server/disk-auth.js
server/disk-operations.js
server/disk-shares.js
server/disk-chunk-file-cache.js
server/disk-part-cache.js
server/disk-api.js
server.js
```

其中最合适的做法不是让这些模块到处直接写 SQL，而是增加：

```text
server/disk-db.js
```

统一负责：

```text
连接数据库
PRAGMA
schema migration
prepared statements
transaction
close/checkpoint
```

然后把 Store API 保持住。

例如：

```text
createTelegramDriveStore(...)
```

仍然返回现在差不多的 API。

这样现有的 `disk-api.js` 和大量测试不用整体推翻。

当前分支已经有相当多网盘测试，包括 API、客户端、目录、分享、缓存、存储回归等，所以数据层替换以后这些都应该继续作为回归基础。

特别是现有测试已经验证了“重启后从持久化索引恢复并重新拼出完整 Telegram 分片文件”，迁 SQLite 后这个测试必须继续成立，只是底层不再读取 JSON。

---

## 还有一个很容易漏掉的地方：备份

进入 WAL 后，一个正在运行中的 SQLite 数据库实际上可能同时存在：

```text
disk.sqlite
disk.sqlite-wal
disk.sqlite-shm
```

SQLite 官方明确说明，WAL 是数据库持久状态的一部分，运行时不能简单只复制主 `.sqlite` 文件，否则可能漏掉已经 commit 但尚未 checkpoint 的事务。([SQLite][3])

所以以后如果项目里有任何：

```text
直接 zip .tunnel-data
直接 cp disk.sqlite
```

作为备份的逻辑，都要改成 SQLite backup/checkpoint 后再备份，而不能只复制主文件。

你刚新增的 `.tunnel-data` 空间查看页面倒不用特殊处理，只是以后会看到：

```text
disk.sqlite
disk.sqlite-wal
disk.sqlite-shm
```

属于正常现象。

---

# 我的结论

**我支持现在就把这批网盘 JSON 元数据迁成真正 SQLite WAL。**

但我不会把理由简单说成“多人同时用 JSON 一定会写坏”。当前单 Node 进程 + 内存共享 Store + 同步临时文件 rename，已经规避了一部分最低级的损坏问题；而且 `disk-api.js` 还专门做了 per-user/per-space mutation queue。

真正促使现在迁移的是：

> **网盘已经从一个简单文件索引发展成了包含多用户、多分区、目录树、分片、分享、Auth、Operation、审核、缓存归属、第三方 App 的关系型数据系统。**

继续用多个 JSON 文件维持这些关系，之后每增加一个功能，都要自己重新实现一次数据库早就解决的：

```text
事务
唯一约束
外键
并发
索引
原子提交
崩溃恢复
```

而 SQLite WAL 正好适合你目前的**单服务器、用户不多、但数据关系越来越复杂**这个规模。

如果让我按 `dev/2608C-step2` 真正执行这项改造，我会采用：

**`better-sqlite3 + disk.sqlite + WAL + 保留现有 Store/API 接口 + 一次性离线 JSON 迁移 + 旧 JSON 只留备份不再双写`。**

这是改动范围和长期收益之间最稳的一条路线。

[1]: https://github.com/WiseLibs/better-sqlite3?utm_source=chatgpt.com "GitHub - WiseLibs/better-sqlite3: The fastest and simplest library for SQLite3 in Node.js. · GitHub"
[2]: https://nodejs.org/api/sqlite.html?utm_source=chatgpt.com "SQLite | Node.js v26.8.2 Documentation"
[3]: https://www.sqlite.org/wal.html?utm_source=chatgpt.com "Write-Ahead Logging"







问：





    你上面提到的很多方面我基本同意。
    我还看到很多个JSON文件之间存在强关联，那我觉得即便大重构完成了，迁移数据也是个大难题。反正现在也是测试阶段，这些json数据可以不要，可以从头再来，安心按SQLite WAL/事务  重构。对于你提到telegram网络调用绝对不能包进sqlite长事务，这个我同意，你可以考虑在程序层面来解决，你也提过现在代码里已经存在telegram上传回滚/恢复机制。

    我还有一个要确认，sqlite确认真的可以支持少量用户并发读写对吧？
    
    
    
    
    




答：








可以，**你这个项目目前设想的“少量用户并发读写”完全在 SQLite 的舒适区间内**。

SQLite 的并发模型不是“很多 writer 真正同时写”，而是：

* 可以有多个并发 reader；
* 在 WAL 模式下，**reader 和 writer 可以同时工作**；
* 同一时刻只有一个 writer 真正提交写事务，其他写请求会排队等待。SQLite 官方也明确说明，低写并发、单机应用是非常典型且合适的使用场景。([SQLite][1])

这和你的网盘场景很匹配。比如同时出现：

```text
用户 A：浏览目录
用户 B：播放视频，查询文件/part 信息
用户 C：查看分享
用户 D：上传文件，正在写 operation
用户 E：移动目录
```

其中大量操作其实都是读。WAL 下这些读取通常不会因为另一个用户正在做短事务写入而被阻塞。写操作则类似：

```text
A 写入 operation
↓
commit

B 移动文件
↓
commit

C 更新分享
↓
commit
```

只要每个数据库写事务都控制在**毫秒级的短事务**，SQLite 会自动让这些 writer 依次执行。官方的说法也是：SQLite 一次只有一个 writer，但一般写事务很短，所以多个 writer 排队执行通常并不是问题。([SQLite][2])

你这里最关键的原则就是刚才已经确认的：

> **Telegram、FFmpeg、文件上传、网络下载等慢操作一律放在 SQLite 事务外面。**

比如上传应该是：

```text
INSERT operation = running
COMMIT

↓
上传 Telegram
↓
等待 Telegram
↓
可能 429 重试
↓
网络操作全部结束

BEGIN IMMEDIATE

INSERT drive_file
INSERT drive_file_parts
INSERT thumbnail
UPDATE operation = completed

COMMIT
```

而不是：

```text
BEGIN
↓
等 Telegram 几十秒甚至几分钟
↓
COMMIT
```

这样 SQLite 的 writer lock 实际只占用非常短的时间。

对于目录移动这种操作，即使一次影响几十或几百条记录：

```sql
BEGIN IMMEDIATE;

UPDATE drive_directories ...;
UPDATE drive_files ...;
UPDATE ...;

COMMIT;
```

一般也很快。

而且事务给你的收益非常大：其他连接只能看到**完整提交后的状态**，不会看到移动了一半的目录树。SQLite 不会让 reader 看到某个 writer 尚未提交的中间状态。([SQLite][3])

### 你这种规模离 SQLite 的瓶颈还很远

如果是：

```text
几十个用户
大量文件列表查询
偶尔上传
偶尔改名/移动/删除
播放器持续读取文件元数据
Operation 状态持续更新
```

SQLite 没什么问题。

甚至几十个连接同时读也不是重点问题；SQLite 官方说法是可以存在多个同时进行的 read transaction。真正需要关注的是**同时持续写入的数量和每次写事务持续多久**。([SQLite][2])

如果未来变成：

```text
数百/数千活跃用户
大量用户持续不断高频 UPDATE
多个服务实例共同写一个数据库
```

那时候 PostgreSQL/MySQL 才更合适。

但 Drop2Tunnel 目前这种：

```text
单机 Node 服务
+
少量用户
+
读远多于写
+
写入可以做成短事务
```

我反而会优先选 SQLite，而不是为了理论上的并发上限直接上 MySQL/PostgreSQL。

### 建议再加两个配置

除了：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

建议还有：

```sql
PRAGMA busy_timeout = 5000;
```

意思是如果刚好另一个短事务正在写，不要立刻报：

```text
SQLITE_BUSY
```

而是允许等待最多 5 秒。

另外可以采用：

```sql
BEGIN IMMEDIATE;
```

处理明确的写事务。这样在事务一开始就确定是否能获得 writer 权限，而不是先读了一堆数据，到中途 UPDATE 时才发现 writer 被别人占了。

---

另外你现在说：

> JSON 数据可以不要，从头开始。

这实际上会让这次重构**简单非常多**。

我赞成直接放弃：

```text
JSON → SQLite migration
```

这条复杂兼容路线。

也就是说新版本启动后：

```text
旧 JSON 不导入
↓
初始化 disk.sqlite
↓
网盘用户、目录、文件索引、App、分享、Operation 等全部重新开始
```

这样就可以大胆按数据库正确模型设计，不需要为了兼容过去 JSON 的奇怪数据结构，把新的 schema 也绑死。

甚至 `disk-spaces/<hash>/telegram-drive-index.json` 这种“每个分区一套数据目录”的结构也可以直接废掉，统一变成：

```text
disk.sqlite

user_id
disk_space
```

作为每张业务表的作用域字段。

例如：

```text
drive_files
    user_id
    disk_space
    ...

drive_directories
    user_id
    disk_space
    ...
```

这会比现在“一堆目录 + 一堆 JSON”干净很多。

所以这次我会建议你把它定义成：

> **不是“把 JSON 换成 SQLite 文件”，而是把整个网盘元数据层正式重构成 SQLite WAL 的事务型持久层。**

旧 JSON 数据既然可以全部丢弃，就没有必要为了兼容它们牺牲数据库设计。这是现在做这次大重构的最好时机。

[1]: https://www.sqlite.org/wal.html?utm_source=chatgpt.com "Write-Ahead Logging"
[2]: https://www.sqlite.org/lang_transaction.html?utm_source=chatgpt.com "Transaction"
[3]: https://sqlite.org/isolation.html?utm_source=chatgpt.com "Isolation In SQLite"










问：





        那这样，以后有可能会扩容或换数据库。那么操作数据库的代码，你应该采用适配器思维，万一哪天我要把sqlite改成真正的服务器级数据库，就会容易迁移一点
        
        
        
        
        
        
        
        
答：






对，这里应该一开始就按“可替换数据库后端”来设计，而不是把 SQLite SQL 散落到 `disk-api.js`、`telegram-drive.js` 这些业务文件里。

我建议结构直接定成：

```text
业务层
  ↓
Repository / Store 接口
  ↓
Database Adapter
  ├─ SQLiteAdapter
  └─ 以后可加 PostgreSQLAdapter / MySQLAdapter
```

例如：

```text
server/disk-db/
    index.js
    adapter.js
    sqlite.js
    migrations/
    repositories/
        files.js
        directories.js
        auth.js
        operations.js
        shares.js
        cache.js
```

业务代码只应该知道这种接口：

```js
files.get(...)
files.list(...)
files.create(...)
files.move(...)
directories.moveTree(...)
operations.update(...)
shares.create(...)
```

而不应该知道：

```js
db.prepare('UPDATE drive_files SET ...')
PRAGMA ...
BEGIN IMMEDIATE
sqlite_master
```

这些全部封装在 SQLite Adapter 内。

尤其是**事务也要抽象**。例如业务层可以写成概念上的：

```js
db.transaction(tx => {
    tx.directories.moveTree(...);
    tx.files.moveTree(...);
    tx.directories.touch(...);
});
```

而不是业务代码自己：

```js
db.exec('BEGIN IMMEDIATE');
...
db.exec('COMMIT');
```

因为以后 PostgreSQL 对应的事务实现完全不同。

还有一点很重要：不要为了所谓“兼容数据库”，硬造一套巨大 ORM。你这个项目没必要。更合理的是：

> **Repository 接口稳定 + SQL 留在具体 Adapter 中。**

这样既不会过度设计，也能保留 SQL 的可控性。

另外，Schema 设计时也尽量避免过度依赖 SQLite 特有能力。例如核心数据模型优先使用：

```text
TEXT
INTEGER
BLOB
NULL
普通 UNIQUE
普通 FOREIGN KEY
普通 INDEX
```

少依赖 SQLite 独有的：

```text
WITHOUT ROWID
STRICT 特殊行为
SQLite 特有 JSON 函数
特殊 PRAGMA 语义
FTS5 作为核心业务依赖
```

像 `metadata`、`mediaIndex` 可以暂时存 JSON TEXT，但业务层不要写死 `json_extract()` 查询；否则以后迁 PostgreSQL 时又会被 `jsonb` 差异绑住。

事务隔离也建议抽象成业务语义，比如：

```text
read()
write()
transaction()
```

而不是让上层依赖：

```text
BEGIN IMMEDIATE
WAL
busy_timeout
```

这些是：

```text
SQLiteAdapter
```

自己的实现细节。

甚至你以后真要扩容时，可以做到：

```text
DATABASE_DRIVER=sqlite
DATABASE_URL=.tunnel-data/disk.sqlite
```

未来切换成：

```text
DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://...
```

业务层大部分不用碰。

不过我会加一个现实边界：

**不要追求“换数据库完全零改代码”。**

SQLite → PostgreSQL 真迁移时，通常还是会涉及：

```text
自增/UUID
UPSERT
事务隔离
锁策略
分页
JSON 类型
索引
批量写
时间类型
```

目标应该是：

> 将迁移成本限制在数据库适配层、migration 和少量数据库能力差异上，而不是让整个网盘业务层跟着重写。

所以这次我会把整体原则定成：

```text
Domain / Service
    不知道 SQLite

Repository
    定义数据操作语义

DB Adapter
    处理数据库差异

SQLite Adapter
    WAL
    busy_timeout
    BEGIN IMMEDIATE
    prepared statements
    SQLite migrations
```

这样以后改 PostgreSQL，主要增加：

```text
PostgreSQL Adapter
+
PostgreSQL migrations
```

而 `disk-api.js`、Telegram 上传流程、网盘权限、分享、播放器等上层逻辑尽量不用重新设计。

这个方向我认为比直接在现有 Store 里到处塞 `better-sqlite3.prepare()` 要稳得多。





问：



    以上几条关于网盘多用户读写+事务的重构的讨论记录， 你总结下，由目前网盘多用户共同读写到.tunnel-data目录的文件（telegram-chunk-file-ids.json、telegram-drive-directories.json、telegram-drive-index.json、disk-space-usage.json、disk-shares.json、disk-operations.json、disk-auth.json、telegram-part-cache/.owners.json ）可能会遇到的问题， 要考虑采用sqlite WAL 事务 来重构的具体建议。我可以放弃所有的网盘json数据，这些都是测试阶段的，数据库可以从头再来。网盘数据的最基础文件初定为disk.sqlite。 给出详细的重构方案， 最后你把所有的内容整理到一个大文档中（markdown），太长的话就保存到文件发给我。 （注意结论不要下太死，因为我还要把你输出的文档发给codex执行任务用，因为codex在代码本地跑，应该会发现新的问题，如果你文档中某些结论写死了，可能就会影响codex的最终行为，你最好可以在文档中需要的部分引导codex再调研后选取最优解）
    
    
    
答：

    详见  prompts/dev-prompt-logs/dev-tgdisk-json2sqlite-WAL-transaction-260915.md


