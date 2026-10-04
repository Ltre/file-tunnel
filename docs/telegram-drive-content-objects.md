# Telegram 网盘共享 Content Object

最初实现于 2026-10-03，基于 `dev/2609-s5-disk-chunks-progressive-push` 的 `e9dc545dea735fe93d2129ed22109d26c80c418f`。本说明于 2026-10-04 对照 `dev/2609-s6-disk-shared-content-object` 的 `282d9d274ebd52156906d43a13eda6a6c24c4520` 复核。

本文说明当前实现与部署方式。设计依据为 [实施指南](../prompts/dev-prompt-logs/dev-shared-content-object-implementation-guide-261003.md)。传统 JSON API 见 [网盘 API](adapter/telegram-disk-api.md)，S3 协议见 [S3 对接文档](telegram-drive-s3-compatible.md)，两套接口的鉴权和响应格式仍独立。

## 1. 三层资源及权限

| 层 | 保存内容 | 生命周期 |
|---|---|---|
| Logical File | 用户、分区、文件名、目录、MIME、metadata、分享、协同、审核 | 一个用户可见的文件；按现有权限访问 |
| Content Object | 完整二进制身份、大小、健康状态、当前物理 revision | 可以被多个 Logical File 引用 |
| Telegram Anchor / revision | 正文分片、封面消息、实际 channel/message/file IDs | 仅由 Content 清理队列管理 |

Content Key 为 `sha256:v1:<字节数>:<64 位小写完整 SHA-256>`。不包含文件名、MIME、用户、目录、时间、权限、分片边界或 Bot。分片哈希和 `file_unique_id` 都不能代替整文件 SHA。没有 content block。

读取先检查 Logical 的权限，再投影当前物理 revision。相同 Content 不赋予查看其他用户文件、分享或协同项目的权限。公开列表不提供 Content ID、来源用户、Telegram IDs 或 PoP 的预期 digest；已鉴权的旧上传结果保留隧道适配器需要的来源字段。

Content Key 的格式与存储边界分离：当前只在同一 Bot / API 地址的可访问后端中复用。不同 Bot 不通过裸 `file_id` 互相引用；也不提供跨账号 S3 Copy。后台配置 UUID 不充当 Anchor 的物理身份。

## 2. 浏览器上传与持有证明

1. Worker 以 1 MiB Blob slice 增量计算完整 SHA，不把大文件整体读入内存。
2. `/content/preflight` 返回 `miss`、`wait`、`reuse` 或 `proof`。
3. 同一实际用户已授权持有该 Content 时，可以获得一次性 reuse ticket；协同访问者使用实际 `diskViewerId`，不能借 owner 身份跳过跨用户证明。
4. 跨用户命中时，服务器生成 32 Byte nonce 和最多 8 个分散、不重叠的 64 KiB 样本范围；小文件覆盖全部字节。客户端只提交 digest，不上传样本正文。
5. 证明通过后创建正常上传任务，但命中文件不发送正文、不重新调用 `sendDocument` 或 `sendMediaGroup`，直接使用已有固有封面。批内相同内容只构建一次。
6. MISS 沿用渐进式 staging、独立 writer/reader、调度器和最终 Album。Node 验证实际完整 SHA/size，先持久化结果，再释放源暂存。
7. 混合批次所有文件就绪后，在一个短事务里提交 Logical、引用和 batch commit 标记。命中文件不会提前出现在目录中。

digest wire 格式：

```text
SHA256(UTF8("Drop2Tunnel-PoP-v1\0") || nonce[32] || uint64be(offset) || uint32be(size) || sampleBytes)
```

ticket 绑定实际 viewer、登录 Cookie/Bearer 的指纹、目标 owner、分区、协同授权代次、应用、目标文件名/目录/MIME、大小和 hash。有效期 15 分钟；消费一次后不能换目标、重放或借用其他会话。服务器保存预期 digest，但不返回它。协同成员被踢出后重新加入会得到新的授权代次，旧证明及旧上传任务不能借重新加入的关系提交；同一事务写入引用前还会读取当前协同记录，检查成员、代次和授权目录/文件范围。

候选的 `getFile` 检查不等价于确认 Telegram message 存在。抽样 PoP 也不是对“持有每个字节”的数学保证，仍存在内容存在性线索。每 viewer 最多 200 个有效 claim/challenge，preflight/proof 每分钟最多 200 次请求；不要把 hash 查询作为匿名下载接口。

MISS 的 key claim 在 SQLite 中互斥，另一个上传者等待；claim 过期后可由新 token 接管。浏览器 Worker 初始化或计算失败时退回普通正文上传；非安全上下文缺少 WebCrypto 时释放 PoP ticket，并以普通正文上传完成跨用户文件，不能跳过证明直接复用。取消请求仍按取消处理，不当作 Worker 降级。PoP 样本回源失败不授权，也退回实际正文上传。无完整 SHA 的普通流仍可在 EOF 后竞争 canonical，可能产生只属于本候选的重复消息并进行补偿。

计算完整 SHA 时，客户端单独报告本地 `hashedBytes` / `hashTotalBytes`；这些字节不是浏览器到服务器的网络上传量。会话退出登录会持久撤销当前网盘 Cookie 指纹；带旧 Cookie 的 preflight、proof、已创建任务的最终引用写入均会被拒绝。外部应用的引用写入在同一 SQL 事务中重查 token 是否有效、应用是否启用以及 token/app revision 是否匹配。此处是 Content 上传授权栅栏，不改变其它网盘接口的会话策略。

实现采用轻量持久化 claim/proof，名称预约和 operation 在现有 `POST /uploads` 创建；preflight 本身不预先创建 operation。最终名称冲突、路径、协同权限及 SQLite 写冲突仍在上传创建/提交处重新检查。该实现没有另造一套独立上传 API 或后台任务系统。

## 3. 持久化和事务

`disk.sqlite` schema v2 的新增表：

| 表 | 作用 |
|---|---|
| `disk_contents` | Content、可信 hash、状态、当前 revision、健康信息、首次排障名称 |
| `disk_content_keys` | 当前 canonical key → Content，支持删除旧 generation 后重新上传 |
| `disk_content_revisions` | 完整物理投影，ACTIVE / RETIRED / CLEANED |
| `disk_content_anchors` | `telegram:<chat>:<message>` 的物理消息身份及角色 |
| `disk_content_parts` | 分片顺序、offset/size 和明确选定的 Anchor |
| `disk_content_refs` | `(scope, logical_file_id)` 的权威绑定和 logicalContentVersion |
| `disk_content_leases` | proof/reuse/read/caption 等在途保护，固定 revision |
| `disk_content_claims` | MISS 的 key 预约、token、viewer 和到期时间 |
| `disk_content_pop_challenges` | 一次性证明、会话/目标绑定、服务器 digest |
| `disk_content_batches` | 已提交批次和结果 Logical IDs，处理重复 finish/重启 |
| `disk_content_cleanup` | 清理 outbox、claim token、重试时间和错误 |
| `disk_content_caption_jobs` | 最终物理 caption 的独立补注及重试 |
| `disk_content_legacy_history` | 无法验证的旧 fileIdHistory，保守隔离留作审计 |
| `disk_content_revoked_sessions` | 已退出网盘的 Cookie 指纹和原到期时间，阻止旧证明及在途任务继续附着 |

`disk_files` 的物理字段由引用投影得出，不再作为第二套权威数据。旧 `disk_file_parts` 表保留作兼容历史，不为新 Content 写入 Logical 专属分片。

构建中的正文、TEMP/FINAL/UNKNOWN 消息、可信 SHA、candidate ID、claim token 和 reuse lease 持久化在 v3 上传 manifest；Content 的 READY 行在整批提交事务内形成。repair 的物理构建也先完成于事务外，再用 CAS 切换 revision。构建状态没有与 READY 混用。

写事务使用 `BEGIN IMMEDIATE`，只包含 SQL 和内存记录变更；禁止异步 work、Telegram await、整文件 hashing、FFmpeg 或等待浏览器。上传数分钟不会持续占用 SQLite 写锁。多用户引用变更、名称唯一性、cleanup claim、最终会话及协同授权检查和 fencing 由数据库保护；现有 Telegram 调度器仍是进程内调度，不因此获得多 Node 实例运行所有业务队列的保证。

## 4. 删除、覆盖、repair 和恢复

- 删除文件/目录、S3 DELETE、审核 tombstone 先取消 Logical 引用。其他引用仍存在时不删除或替换共享消息；blocked 记录继续持有引用。
- 最后一个引用释放后，Content 进入 DELETE_PENDING，默认等待 60 秒并检查有效 leases。尚未被 worker claim 的对象可以被合法附着重新激活；DELETING 对象禁止再附着，并撤除旧 canonical key。
- worker 通过 token claim outbox，再次检查实际 Anchor 是否被当前引用、旧 revision reader 或隔离异常保护。失败记录退避重试；失效 worker 不能完成新 claim 的状态。
- 托管频道删除或改 ID 前的占用检查还覆盖所有未 CLEANED 的物理 revision、有效 reader lease、未完成清理债务及在途上传；仅查看当前 Logical 列表会漏掉已经解除引用、但仍待清理的消息。
- 清理用途分为 `temporary-upload`、`retired-revision`、`unreferenced-content`、`abandoned-candidate`、`legacy-debt` 和 `failed-repair`。TEMP 清理不得包含有效最终消息；混合批次失败只补偿本批独立产生的消息，命中 Anchor 不进入回滚集合。
- 沿用 47 小时 57 分钟删除窗口及超过窗口的 1 Byte placeholder。占位文案用 Content 的首次排障名称，不使用任一当前 Logical 的改名。
- 普通 repair 要求实际完整 SHA/size 与原 Content 相同，切换物理 revision 后所有引用共同恢复。旧读者的 lease 固定旧 revision，释放前不清理旧物理。
- 协同 replacement 可以换内容，只改变该 Logical 的绑定，并递增 logicalContentVersion；其他引用保留原 Content。提交检查 contentId、Logical version 和 physical revision 的 CAS。
- 已确认最终消息、已提交 SQL batch、以及 response 丢失的 UNKNOWN 都保留既有恢复语义。重启先检查 durable commit 标记，不重复建引用；reuse 的过期 lease可凭已证明 manifest 重建，但不能复活 DELETING。明确 SHA/size 不符按失败回滚，不能当作 finalization 恢复成功。

caption 只保留 Content / revision / part / 实际消息定位信息和首次排障名。Logical 改名、移动、分享、协同、审核不再编辑共享 caption。最终 IDs 先保存，再由 caption outbox 补注；补注失败不会重新上传正文。

## 5. 读取、缓存、封面及外围功能

Range、分享下载、S3 GET/HEAD、封面与普通下载使用同一物理投影。实际读取固定 revision 并续租；已撤销分享/协同仍需在上游等待后重新检查授权。删除某个 Logical 后，其分享不能因为其他用户还持有 Content 而继续读取。

固有 thumbnail 归 Content revision，命中直接复用，不因某个 Logical 删除而移除。当前没有可信容器 parser，任意客户端 `mediaIndex` ranges/offsets 不当作已验证共享索引；返回 `mode: unavailable`。未新增 HLS 转码、content block 或用户自定义封面系统。

浏览器完整正文、thumbnail 和播放进度按 Logical ID + logicalContentVersion 判断有效。异内容 replacement 即使大小相同也失效；同内容物理 repair、改名和移动保留有效缓存。文件列表的绿色对勾仍只表示当前 Logical 版本已完整缓存。

服务器分片缓存仍是按物理分片共享的窗口缓存，默认 2 天。清理用户/分区缓存时先重建共享片的全部已知 owner，避免删掉其他范围仍拥有的缓存。分享页浏览器缓存 7 天、provider/P2P/隧道缓存优先和 Chat 字典回源兼容保持原链路。

## 6. S3 边界

CopyObject 在凭据授权的同用户、同 Bot 范围内建立引用，不新建正文或封面消息。跨 Bot 仍通过实际读取/上传。覆盖保持原 Logical 的权限，并只切目标引用；受协同保护的目标仍拒绝覆盖/删除。

合法完整 SHA 声明命中候选的 PUT 仍接收、暂存并验证全部 HTTP 正文及 MD5，真实摘要正确且候选健康后才附着，命中时零新消息。声明不是持有证明，FolderSync 不会因此省略 PUT 正文；候选已损坏时从刚验证的暂存正文构建新候选。无完整 SHA 或 UNSIGNED-PAYLOAD 保留现有逐片上传，到 EOF 才 canonicalize，可能产生候选补偿消息。

S3 PUT 成功仍在 Telegram 确认和索引提交之后同步返回；SigV4、ETag、Range、错误 XML、Bucket 映射不改成 JSON/SSE 协议。0 Byte 普通对象引用空 Content，不发 Telegram；目录 marker 仍是目录 metadata，没有 Content。

长时间 PUT 和 Copy 在写入前会重新读取 S3 凭据，检查停用、轮换及 Bucket 映射变更。凭据存于独立 JSON 文件，Content 引用存于 SQLite；两者不能构成同一个原子事务，因此跨进程撤销恰好发生在最后一次检查与提交之间时仍有极短竞态。

## 7. 历史数据与运维

先停服务及自动重启，再使用 [Content 迁移工具](../tools/migrate-tgdisk-content-objects.md) 预检、备份及包装。已有 JSON 数据先用原 JSON → SQLite 工具导入。本版启动也会在 v1→v2 前创建一致性备份，但正式部署优先使用显式停服流程。

灰度开关由服务端环境变量控制：`DR2T_CONTENT_REUSE_MODE=all|owner|off`，默认 `all`；`owner` 只允许已有同用户引用时提前命中，`off` 关闭 preflight 快速复用，要求正常上传完整正文。`owner` / `off` 不禁用完整正文验真后的 canonical 归并，也不撤销已经提交的共享 refs；现有文件仍按 Content resolver 读取、repair 和删除。`DR2T_CONTENT_CLEANUP_MODE=execute|observe` 默认 `execute`；`observe` 暂停 typed Content 清理任务的实际 Telegram 删除/占位操作，便于先观察清理债务与引用状态。它不暂停普通上传、读取或 caption 补注；恢复 `execute` 后再处理积压债务。变更开关后需按部署方式重启对应服务进程。

包装不请求 Telegram、不猜完整 hash、不自动下载全库。完全相同的物理集合可建立同一个 `legacy_unverified` Content；部分重叠 Anchor 标记 `anchor_conflict`，禁止其自动物理 GC。无法归一化的 public Chat 保留原标识，禁止猜测数字 ID；用现有 Chat 字典或停服频道迁移工具确认后处理。清理时按最新 Chat 字典识别 public/数字别名；确认映射或未知映射下的同消息 ID 可疑重叠均先隔离，并在清理债务中记录原因，不因某个 Content 失去最后引用就直接删消息。旧 history 缺位置/摘要时进入隔离表，不借当前后端解释历史消息。

legacy_unverified 文件继续原权限读取，但不能通过 hash 跨用户命中。需要管理员明确触发完整读取验证，或上传/repair 一个可信副本；同内容历史对象的合并也需要显式 `merge: true`，保持 Logical IDs、权限、Share、协同及版本不变。旧物理等读租约释放后才清理。

后台管理基址 `/api/telegram/disk-admin`（沿用后台管理员身份）：

```http
GET /api/telegram/disk-admin/content-objects
GET /api/telegram/disk-admin/content-objects/<content-id>
POST /api/telegram/disk-admin/content-objects/<content-id>/verify
Content-Type: application/json

{"merge": false}
```

列表接口返回 Content 汇总、引用数、有效 lease 数以及待处理 cleanup/caption 队列。详情接口返回指定 Content、Logical 引用、各物理 revision、Anchor 和有效 lease；它是后台管理员接口，不应作为普通文件列表使用。verify 返回 202 `operation_id`；任务结果报告 `verified` / `contentId` / `merged`。`merge: true` 在完整 SHA/size 验证、同后端及 canonical 健康校验后合并。验证不在页面打开或启动时自动执行；大文件验证会产生真实回源流量。

诊断工具 `tools/collect-tgdisk-diagnostics.cjs` 继续导出实际网络日志和任务，可附加 Content 状态、引用、lease、清理的聚合计数；不导出 nonce、expected digest、凭据或物理正文。进度分别列出浏览器上传字节、Telegram 发送/确认字节、已复用字节和文件就绪数，不把复用字节计为网络流量。

schema v2 后不能直接启动旧 schema v1 程序继续写库。回退要停服恢复迁移备份，并核对迁移后新写入及远端变更；修改 schema version 或复制单独 SQLite 主文件都不是安全回退。

## 8. 验证和实机验收

自动测试覆盖完整 hash、PoP/session/grant/replay、并发 claim、共享删除与读租约、repair/replacement、混合批次原子性/失败、0 Byte、caption 重试、历史包装/合并、重复迁移、S3 及原 progressive 故障恢复。调用次数断言要求已命中路径没有新 sendDocument/sendMediaGroup。

上线还需真实 Telegram 灰度测试：同用户异名复用、跨用户 PoP、19/21/38 片首次上传、mixed 批次、Range 拖动、Share 停止、协同 replacement、FolderSync PUT/Copy/Delete、重启与断网。模拟测试不能证明公网吞吐、Telegram 权限、实际消息是否已人工删除，或上游长期稳定性。
