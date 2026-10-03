# 2026 年 10 月开发记录

## 261003-1：网页工坊原记录跳转与网盘分片渐进推送

### 范围与依据

- 分支：`dev/2609-s5-disk-chunks-progressive-push`。在当前代码上修改，不暂存、不提交；保留用户已有的 `prompts/dev-prompt-logs/dev-2609.md` 改动。
- 主要设计依据：`prompts/dev-prompt-logs/dev-tgdisk-chunks-progressive-push-refactor-261003.md`。保持 20,000,000 字节分片格式、现有逻辑文件关联、SQLite WAL 短事务与整批文件提交机制。
- 本轮只调整网页工坊原记录入口、网盘上传及进度链路；不调整代理环境变量策略，不重构隧道传输、下载缓存或 S3 协议实现。

### 问题根因与处理结论

- 草稿箱的“🔗 原记录”调用 `close()` 后跳转，关闭同时清掉了独立的最小化展示状态。改为统一的来源定位函数：展开时先最小化，已经最小化时保持状态，然后定位传输记录。保留当前界面和顶栏 `🌐` 恢复入口。
- 原上传在整个分片写完、验证并入队后才读取发送，还会等待下一片组成批次；浏览器使用 fetch PUT，缺少实际上传字节事件。两个边界造成 UI 跳跃和首片等待。
- 不能把浏览器请求直接 pipe 到 Telegram：上游重试、断线、背压会反过来锁住浏览器。采用独立磁盘 writer 与增长文件 reader；已写入多少就允许独立 reader 读取多少，追上写入位置时等待，验证完成后才允许正常 EOF。
- Telegram 不提供发送幂等键。整个请求已交付但响应丢失时，不能自动重发并声称“精确一次”；此类状态保留清单、正文和已知消息 ID，明确报告未知结果。
- 最终媒体组创建的是新消息。最终返回的 `file_id/message_id/media_group_id` 是正式索引的权威关联，不能继续保存临时消息 ID，或在未持久化最终关联时删除临时消息。

### 实际改动

#### 数据接收与增长读取

- 新增 `server/growing-file-readable.js`，支持等待增量、源完成/源失败通知、AbortSignal、reader 销毁唤醒及文件句柄关闭。
- `telegram-drive.js` 新增 opt-in `progressive` 暂存模式。首次实际写入后通知上传 runner；持续接收时更新字节，定期保存 manifest。大小、SHA-256 和完成清单验证后才公开源完成状态。
- manifest v2 保存来源状态、推送尝试/意图、临时消息、最终媒体组、清理和恢复信息；写入串行化。分片和媒体组的错误只保存脱敏摘要。
- 文件句柄关闭后才删除 staging，避免 Windows 上 writer/reader 与 unlink/rm 的竞争。

#### 推送、编组、调度与清理

- 新增 `server/disk-progressive-upload.js`：Browser→Node 与 Node→Telegram 独立推进；每个任务最多两条正在推送的分片，Node 最多 20 个活跃渐进任务。
- 每片先独立 `sendDocument`。完整来源且所有临时消息已持久化后，用 `file_id` 提交最终媒体组；分为 2～10 条，11 条拆为 9+2，21 条拆为 10+9+2，单片保留原消息。
- 新增 `server/telegram-upload-scheduler.js`：全局 4、单 Bot 4、单 Chat 2 并发，按 Chat 约每秒一条消息的成本节奏调度；429 反馈冷却并暂时降低 Chat 并发。重试等待释放执行槽，清理使用低优先级。
- 仅对明确 429、建立连接前失败、诊断证明请求体未完整交付的失败进行有界重试。重试前等待来源完整，从磁盘重新读取；完整请求的未知结果禁止盲目重发。
- 实际 socket 写入量扣除 multipart/caption 开销，持续更新当前尝试的逻辑有效文件字节。重传流量不累加进用户总大小；安全重试允许当前尝试回退。
- 最终 ID 分组确认立即持久化后才推进状态；最终 caption 仅写稳定逻辑关联，不写待清理的临时消息 ID，也不增加逐片 caption 编辑请求。
- 整批文件及待清理临时消息记录在短 SQLite 事务内一起提交；不在 Telegram 网络上传过程中持有数据库写事务。
- 临时消息在正式文件安全提交后低优先级批量清理，每批最多 100 个 ID。清理失败保留 `pendingRemoteCleanup` 并显示 warning，不能回滚已经可读取的文件；最终消息 ID 有防误删检查。
- 过期任务先中断并等待 runner，再执行其清理，避免与仍在进行的最终媒体组提交竞争。旧消息继续使用原 47 小时 57 分钟占位替换机制。

#### 前端及兼容边界

- 分片 PUT 使用 XHR `upload.progress`；约 250ms 更新实际浏览器发送量及速率。新增鉴权 SSE `/uploads/:uploadId/progress`，读取内存任务快照，仍保留既有轮询兜底。
- UI 分别显示两条进度、速度、当前文件/分片和最终编组阶段；隐藏独立“Telegram 已确认字节”行。文件发送 100% 不等于任务完成，索引提交前总任务不伪装 completed。
- 服务端失败立即显示终态并中断当前 PUT/队列等待；内部中止不再伪装成用户取消。迟到事件不能覆盖较新的任务状态。
- SSE 终态自动结束，浏览器断开释放 timer；用户、分区、协同授权范围隔离。补齐协同中间件对进度路由的识别。
- 浏览器显式请求 `progressive:true`。未请求该模式的传统 API 和现有 S3 流水线继续使用旧上传路径；相关格式、接口、全批提交和 Range 下载保持兼容。
- Service Worker 缓存版本更新为 v78，相关版本断言同步更新。

### 异常恢复及资源代价

- 完整落盘且未发送的来源经大小和 SHA 校验后可继续上传；已经确认的临时消息只恢复编组，不重传正文；已确认最终组只补剩余组；所有最终关联已保存但正文已删时可补交索引。
- SQLite 已成功提交但 manifest 尚未清理、operation 尚未 completed 的崩溃窗口，通过逻辑文件 ID 和最终分片关联核对后补记完成，不重复提交或发消息。
- 仍有部分浏览器来源的任务报告 `UPLOAD_SOURCE_INTERRUPTED` 并保留记录，本轮不增加浏览器 offset 续传协议；未知完整发送结果暂停，不能自动推定成功。
- 如果已收到有效 Telegram Message，但本地 awaiting-response/确认持久化失败，仍保留已知 ID 与正文，不盲重发；这种磁盘故障边界可能需要人工核对。
- 待发送队列的 5 片/100 MB 是背压阈值，不是 staging 总磁盘上限。为可靠重试，已确认临时分片正文保留到该逻辑文件最终关联持久化；单个大文件的 staging 峰值可能接近文件大小。
- 本轮测试使用本机 HTTP 与模拟 Telegram，不向真实频道发送测试消息。正式网络、代理、Cloudflare 和真实 Telegram 的吞吐/限速仍需部署后灰度验收。

### 验证记录

- 真实 HTTP 时序测试：浏览器只写 5 MB/20 MB 且未结束请求时，Telegram 接收端已经取得正文增量；同时断言服务器接收字节与实际连接发送字节持续变化。
- 覆盖分片完整性、提前 EOF/超长、writer 错误、取消、reader 关闭、manifest 写失败、临时/最终消息恢复、分组 1/10/11/21、429 安全重试、未知结果禁重发以及最终 ID 防误删。
- 覆盖整批提交、重启补交索引、SSE 生命周期与身份/协同隔离、20 任务限额、旧上传 API、S3、SQLite 和封面回归。
- 最终组合验收：38 个测试文件，**280/280 通过**，无失败、跳过或取消；详见下方 261003-2 续作记录。31 个已改/新增 JavaScript/CJS 文件的 `node --check` 全部通过，本任务代码、文档及测试的 `git diff --check` 通过。

## 261003-2：中断恢复、缺口补齐与整体验收

### 恢复依据及实际中断点

- 结合 `prompts/dev-prompt-logs/interrupt-agent-logs/ir-261003-1.log`、上下文和当前相对 HEAD 的差异核对原需求。保留已有代码，不重新实现增长流、manifest v2、最终编组或前端进度。
- 中断时核心上传、网页工坊来源跳转、前端及两份 API 文档已落地；最终组合测试、故障测试细节、调度公平性后的复核和完整验收记录尚未收尾。
- 本轮发现 `disk-progressive-faults.test.cjs` 的 rename 故障注入回调读取尚未初始化的 `const upload`，导致创建请求提前失败、测试超时。修复测试初始化后，真实故障补偿断言才得以执行，不能把中断前生成的文件视为已通过验收。
- 用户已有的 `prompts/dev-prompt-logs/dev-2609.md` 和续作期间外部更新的 prompt 会话记录均保留，未修改或清理。

### 续作补修

- 复用 `file_id` 的 `getFile` 校验原本在 scheduler 之外，可产生多任务请求突发。现纳入统一调度；只读校验允许对 429、网络/无效响应及服务端临时错误有界安全重试，并在等待时释放槽位。有副作用的消息发送仍不盲重试未知结果。
- 公平调度以各任务最近调度序号选择最长等待的 eligible owner，覆盖 20 个任务持续补入和不断新增 owner 的情况；清理仍保持低优先级，完成/离队 owner 释放状态。
- 最终完成回调合并先到的临时清理警告与封面警告，防止后台清理和 operation 完成的竞争丢掉其中一条提示。
- 未知发送结果在保留原始错误码及 causeCode 的同时返回 `errorDetails.requestOutcomeUnknown=true`；任务及前端明确提示恢复资料已保留、需先核对频道，不能仅显示一般连接失败并诱导立即重复上传。
- 验证过期渐进任务先中断并等待 runner，再清理；修正维护回调误用局部 `pipelineWake` 的作用域问题，使用 `coreUpload.pipelineWake`。新增回归同时要求无维护错误警告，防止任务终态“看似正确”却遗漏后台异常。
- 补齐分片实时发送诊断字段、最终组请求 details 的 manifest 传递；正文进度不逐事件刷磁盘，仍由 writer checkpoint 和关键状态转换落盘。
- 传统 API 与 S3 文档分别说明 opt-in 边界、SSE、两段进度、最终 ID、恢复限制和磁盘占用代价，S3 未切换协议或流水线。

### 原始需求验收对照

| 原始要求 | 验收结果与证据 |
|---|---|
| 原记录定位不关闭工坊或清掉最小化入口 | VM 行为测试覆盖来源定位、保持 minimized、顶栏入口、重复定位、恢复以及不额外操作历史记录 |
| 浏览器上传字节连续更新 | XHR 实际 progress 事件、250ms 更新及速率测试通过，不依赖整片 PUT 返回 |
| 首片接收时即增量推送 Telegram | 真实本机 HTTP：20 MB 首片仅落盘 5 MB、来源尚未完成时，上游已获得正文且两段字节已变化 |
| 两段独立，慢上游不直接锁住浏览器 | 独立 disk reader/writer 测试；慢 Telegram reader 时浏览器仍完整落盘，发送和确认字节不混算 |
| 失败、重试、恢复和清理可靠 | 覆盖断流、源损坏、manifest 写失败、取消、过期、429、20 任务公平/容量限制、未知结果禁重发、部分最终组恢复、SQL 已提交补记终态及清理失败 |
| 整批提交和最终分片关联 | 未全部完成前不显示新增文件；最终 media group 返回 IDs 才进入索引，临时消息清理防止删除最终 IDs |
| 不破坏外围业务 | 旧传统上传、S3 四组协议/管理、协同授权/持久化、SQLite 并发、封面、工坊及 PWA/发布构建回归通过；代理控制策略未修改 |

### 最终测试及清理

- 最终组合运行使用 `node --test --test-concurrency=4`，共 **38 文件、280 tests、280 pass、0 fail、0 skipped、0 cancelled**。
- 文件范围：六个 `disk-progressive-*`、`telegram-progressive-push`、scheduler/progress、旧上传与暂存、Telegram 文件及封面、disk-client/move/preview/API/repository/metadata/storage、协同两组、S3 四组、2608B/260917/260918/260921/260927 功能回归、PWA、发布构建和 260922-1 工坊回归。
- 最初组合启动在沙箱内被 Windows `spawn EPERM` 拦截；申请执行权限后重跑通过。该启动权限错误不归因为业务上传 EPERM。
- 31 个改动或新增脚本语法检查通过；本任务文件 diff whitespace 检查通过。用户 prompt 会话记录自身的空白告警不改写。
- 临时组合测试输出 `.npm-cache/progressive-final-261003-test.log` 已清理；未留下临时业务代码、未发送真实 Telegram 消息、未暂存或提交。
- 真实频道/代理/公网体验尚未实机验收，不声称模拟测试能保证具体吞吐。建议部署后分别测单大文件、多个小文件、并行上传及实际断网，核对首次推送时机、两段连续进度、最终 Album 和恢复提示。

### 参考

- [Telegram sendMediaGroup](https://core.telegram.org/bots/api#sendmediagroup)：媒体组及 file_id 复用规则。
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)：消息频率与限流。
- [Undici fetch](https://github.com/nodejs/undici#undicifetchinput-init-promise)：流式请求及 duplex。

## 261003-3：共享 Content Object 实施（阶段记录，2026-10-04 暂停交接）

### 基线、范围和问题结论

- 基于 `dev/2609-s5-disk-chunks-progressive-push`、HEAD `e9dc545dea735fe93d2129ed22109d26c80c418f`，按正式 Content Object 指南开发；当前差异尚未提交或暂存。
- 旧 Logical 内直接携带 Telegram 物理关系，复用 file_id 仍会重新发送消息；直接按 Logical 删除物理消息不能安全支持跨用户共享。因此改为 Logical / Content / physical revision + Anchor 三层，而非只优化上传缓存。
- 保留整批文件全部完成后一次提交的机制。hashing、PoP 取样、Telegram 上传和 FFmpeg 不在 SQLite 写事务内；引用、版本、batch marker 和 CAS 在短事务内统一提交。
- 用户已有 `prompts/dev-prompt-logs/dev-2609.md` 改动保留；不操作真实网盘数据库、Telegram 频道或代理控制策略。

### 已落地内容

- SQLite schema v2、Content repository、完整二进制 key、canonical generation、refs、固定 revision leases、cleanup/caption outbox、claim/proof/batch 持久化；迁移前一致性备份。
- 浏览器增量 SHA Worker、跨用户持有证明、命中零正文/零新 Telegram 消息、批内相同内容共享、mixed 原子提交；MISS 继续现有渐进推送和最终 Album。
- v3 manifest 与完整 SHA/声明检查、已提交 SQL 识别、reuse lease 恢复、未知发送结果保留、失败只补偿本任务候选消息；清理不得删除共享 Anchor。
- 最后引用删除宽限、DELETING 禁附着、worker fencing、旧 revision reader 保护；同内容 repair 与异内容 replacement 分离，0 Byte 不发送 Telegram。
- S3 Copy 同账号/同 Bot 建引用；完整 SHA PUT 先验证真实正文后零消息命中；未知 hash 流仍早推，可能产生 loser 补偿，未伪装为零消息路径。
- 协同按真实 viewer 做 PoP，成员授权代次阻止踢出后重加入使用旧 ticket；最终 refs 事务再次读取 SQLite 当前授权，防止其它连接撤销后旧内存状态仍提交。
- 内容 caption 去除 Logical/owner/path 语义，最终关联由 outbox 补注，not-modified 幂等完成；Logical 改名、移动、分享及审核不编辑共享 caption。
- 浏览器正文/封面/播放进度按 Logical 版本，服务器分片缓存共享 owner 重建；Range、Share、封面与 S3 读取固定物理 revision。未引入未经验证的 mediaIndex parser 或 HLS。
- 新 Content 停服迁移工具及说明、频道迁移/JSON 迁移/诊断工具适配；后台 Content 汇总/详情、显式完整验证及可选合并 API；部署 Worker 指纹和 SW 更新。
- 新 `docs/telegram-drive-content-objects.md`；传统网盘 API、S3 文档分别补充当前协议行为。

### 实施边界和谨慎处理

- Content Key 不包含 Bot，但实际复用仍受同 Bot/API 后端权限约束；不同 backend UUID 的 canonical 竞争保守处理，不猜跨 Bot file_id 有效性。
- 轻量 claim/proof 使用现有 `/uploads` 名称预约和 operation，不另建第二套上传业务协议；claim/preflight 本身不创建任务。
- getFile 检查不等价于物理 message 一定存在；PoP 抽样不是完整持有的数学证明。未向客户端输出其它用户来源或服务端 expected digest。
- 历史包装不自动下载全库、不猜完整 SHA；精确物理集合可共享，部分重叠隔离，旧 history 缺可靠位置时留作审计。完整验证/合并需要管理员明确触发。
- 数据库短事务/typed fencing 不意味着现有所有进程内业务队列已支持多 Node 实例协调。真实 Telegram/公网和 FolderSync 尚需灰度验证。

### 中断点与测试证据

- 较早两次完整回归分别 618/618、621/621 通过；最近完整回归 626 项中 625 通过、1 项旧 caption 时序断言失败。
- 已修正该旧断言：提交前不编辑 caption，提交后消费 Content outbox，并验证六次补注及物理/Logical 字段隔离。后续 targeted 回归通过，完整 suite 尚待重跑。
- 最近可确认的 Content/协同组合为 25/25；另有 GC/存储组合 22/22 和其它边界组合通过。此前语法/whitespace 检查通过，不能代替最新补丁验证。
- 收尾正在补指南要求的账户退出/应用撤销最终 attach 验证：新增 Cookie 指纹撤销表、同 refs 事务校验会话/token/app、manifest 仅保存指纹及期限、logout 写撤销。代码已经落地，新增两项测试尚未执行成功。
- 最新 targeted 启动被 Windows 沙箱 `spawn EPERM` 阻止；三个测试文件均未执行。用户此时要求因额度先交接，未继续申请并运行测试；不把该权限阻断解释为业务失败。
- 下一轮先审查最新 session 补丁，再更新文档遗漏字段、跑完整 suite/语法检查并清理临时日志。本任务尚未最终验收，不能宣布已全部完成。
- 详尽恢复入口：[261003-3 交接文档](handoff-261003-3.md)，列有实际文件、最新未验证代码、已知测试状态、下一步命令和根部临时日志清单。
