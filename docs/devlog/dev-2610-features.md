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

## 261004-1：共享 Content Object 中断续作与整体收尾

### 恢复基线与核对结论

- 当前分支为 `dev/2609-s6-disk-shared-content-object`，HEAD 为 `282d9d274ebd52156906d43a13eda6a6c24c4520`。对照原始实施指南、交接文档、执行日志以及 HEAD 相对 `e9dc545dea735fe93d2129ed22109d26c80c418f` 的 49 个文件差异核对；上一轮 Content 核心已经进入 HEAD，本轮没有重复实现 schema、上传或生命周期。
- 开始时工作区仅有用户的 `prompts/dev-prompt-logs/dev-2609.md` 改动；本轮没有覆盖、整理或清理该文件。旧日志中的“最新授权补丁未测”和“完整 suite 尚未重跑”是实际中断点，早期 618/621/625 的数字不能用作最终验收。
- 指南中的 Logical / Content / revision-Anchor 分层、整批提交、PoP、渐进上传、S3、协同、caption outbox、历史包装与清理等主路径在 HEAD 中已经落地。本轮重点复核授权和物理清理边界，补缺口并重新全套回归。

### 发现的根因与实际修复

- **PoP 缓存归属**：样本从 Telegram 回源时此前会给尚未证明持有内容的 viewer 登记分片缓存 owner。取样读取改为不登记；正常授权的文件读取仍登记。异步 Telegram 健康检查和逐样本读取结束后再查会话/应用授权，失效时不签发证明并释放 lease。创建上传任务前也拦截已退出登录的旧 Cookie。
- **0 Byte 快速复用**：空 Content 没有 Telegram 消息，原健康检查会构造无效空分片并误标损坏。保留同 Bot/backend 边界，但跳过对不存在的物理消息调用 `telegram.check`；0 Byte 重用仍不创建消息。
- **历史频道别名**：旧 `@public` 与数字 Chat ID 可指向同一条 Telegram 消息，而旧 Anchor 键只比较原始字符串。GC 现按最新 Chat 字典比较同 message ID 的真实标识；确认重叠或未解析的可疑重叠写入清理债务错误并暂缓删除，claim 在进入 DELETING、撤除 canonical key 之前隔离。发送前和完成确认时再次防护；无关 message ID 的清理仍可继续。频道使用检测识别已确认的 public/数字别名；按 message ID 建 SQLite 索引避免每次清理全表扫描。未知映射不猜 chat_id，需要管理员确认。
- **S3 长请求授权**：SigV4 请求入站验证后，凭据可能在耗时 PUT/Copy 期间被停用或轮换。实际写入前重新读取凭据和 Bucket 映射；完整 SHA 快速附着、普通流最终提交、Copy 和零字节元数据路径均执行检查。S3 凭据 JSON 与 Content SQLite 不是同一事务，跨进程恰好在最后检查后撤销仍有极短竞态，不宣称严格原子撤销。0 Byte S3 PUT 原本已走元数据专用路径，回归测试固定“不调用 Telegram、无 Anchor”的行为。
- **灰度与进度**：加入 `DR2T_CONTENT_REUSE_MODE=all|owner|off` 和 `DR2T_CONTENT_CLEANUP_MODE=execute|observe`，默认保持 `all/execute`。`owner` 只开放同用户 preflight 快速命中，`off` 不发新的快速复用证明；两者不禁完整正文验真后的 canonical 归并，也不改变现有共享引用的读取/生命周期。`observe` 暂停 typed Content 清理 claim，不停上传、读取或 caption。客户端 PoP 按样本回显 `0/N` 到 `N/N`，不把本地摘要计算伪作网络上传字节。
- 更新共享 Content 说明和迁移工具说明，补齐后台详情 API、撤销/协同授权、浏览器降级、别名清理隔离、灰度开关及迁移报告字段。传统网盘 API 和 S3 文档仍各自描述原协议，没有混写。

### 指南验收与测试

- 完整执行 `node --test --test-concurrency=4 --test-timeout=120000 tests/*.test.cjs`：**642 tests、642 pass、0 fail、0 skipped、0 cancelled**。包含 Content、迁移、共享 GC、PoP、渐进上传、S3、协同、Share、旧网盘、隧道及部署回归。历史频道别名索引补充后又定向重跑 Content/迁移 **21/21**。
- 本轮 12 个改动的 JS/CJS 脚本 `node --check` 通过；本任务差异 `git diff --check` 通过。用户 prompt 文件自身有既存空白告警，检查时明确排除且未改写。
- 首次完整测试在 Windows 沙箱内因 `spawn EPERM` 未能启动任何测试文件；按工具权限流程在沙箱外重新运行并得到上述真实通过结果。该启动权限问题不等于应用业务的 EPERM。
- 自动回归证实模拟 Telegram 调用次数与共享 Anchor 防误删；本轮未访问真实 Telegram、未对生产库迁移、未在 FolderSync 实机或公网代理灰度上传。指南的真实频道 19/21/38 片、断网/重启及实际限流/吞吐验收仍需部署后按运维文档执行；不能将模拟通过声称为真实网络验收。
- 本轮没有执行 `git add`、`git commit`；仅保留当前分支工作区修改。

## 261004：底部协同邀请入口与 HAR 删除后秒传排查

> 以下是上一轮的调查记录，不再代表当前删除策略。该轮虽观察到旧 generation 后来已清理，但没有解决零引用待删除正文被反复重传重新激活的问题；2026-10-05 的补充修复与当前行为见下一节。

### 基线与改动

- 基于 `dev/2609-s6-disk-shared-content-object`、HEAD `9c5b7a792635e0d68fd0effd90ac6bac93037062`。开始时只有用户的 `prompts/dev-prompt-logs/dev-2609.md` 未提交改动，保留该文件；未提交、未暂存。
- `client/disk-ui.js` 的当前目录/空白处菜单新增 `邀请协同`，复用现有 `inviteDiskCollaboration()`、一次性邀请 API 和链接对话框。没有选择项目时，右下角 `#telegramDriveBottomMenuBtn` 打开这个菜单；空白处右键/双指菜单也保持一致。邀请目标取菜单打开时的目录，根目录使用空路径，不受之后目录变化影响。已选项目仍沿用现有项目菜单。
- 更新目录菜单回归及浏览器 fixture 的菜单预期；补充 Content 生命周期回归和 `docs/telegram-drive-content-objects.md` 的删除后复用、清理周期与审计残留说明。本轮没有修改 Content 删除策略或强行清理实际数据。

### 实际数据库证据与根因

- 通过 Node 内置 SQLite 的 `readOnly: true` 连接查询本地 `.tunnel-data/disk.sqlite`，对 `D:/Downloads/tun.miku.us.har`（1,510,740 Byte）计算完整 SHA/大小 key，跨所有 scope/账号查询引用，并额外检查同名历史未验证 Content；不读取或输出 HAR 请求正文、登录凭据、PoP nonce/digest。
- 原 verified Content `e9703739-4450-4bdc-bc0c-38aa4f82eb49` 已是 `DELETED`、清理任务 `COMPLETED`。16:06:19 的上传又建立了新的 `958ee380-1fed-4b65-84b4-fbf8fb3fea46`，说明此前删除确实清理了旧 generation，并非一直复用同一条隐藏数据。
- 16:07:14 删除后，16:07:42 再上传，相隔约 28 秒；16:08:12 删除后，16:09:45 再上传，相隔约 93 秒。两次任务的 `reusedBytes=14,244,386`、Telegram 发送/确认字节为 0。当前实现最后引用释放后设置 60 秒宽限，清理 worker 每分钟检查一次；worker 尚未 claim 的 `DELETE_PENDING` 仍允许健康验证和持有证明后复用，重新附着恢复 `READY`。所以超过 60 秒但尚未轮到清理的重传也可能秒传，并不是删除后一定立即停止复用。
- 调查过程中，运行中的服务处理了 17:34:38 的新删除：该 Content 一度为 `DELETE_PENDING`、0 引用、0 lease；清理在 17:35:59 claim，17:36:26 已观察到 `DELETED`/`COMPLETED`。本轮工具仅只读观察，没有主动执行 Telegram 删除、触发清理或改库。
- 最后核对时间为 **2026-10-04 17:39:37（Asia/Singapore）**：完整 key 对应的 canonical 行不存在；2 条 verified Content 和 3 条同名 legacy Content 全部 `DELETED`，全部 0 引用、0 有效租约、0 未清理 Anchor、0 未完成清理任务。没有发现其它账号/分区遗留的可复用 Content。保留的已删除审计行不能命中 preflight；分片缓存或旧 chunk file_id 映射也不等于存活的 Content canonical 引用。
- 通常空闲且无保护租约时，最后引用删除后约 60～120 秒开始清理；proof/read/caption 等有效租约、队列或网络重试可延长时间。重传重新建立引用会重新保护正文。此次有现场证据支持宽限期/清理时序结论，不需要删除审计表或绕过共享 Anchor 保护。

### 测试

- `node --test --test-timeout=120000 tests/disk-directory-actions.test.cjs tests/disk-content.test.cjs tests/disk-content-api.test.cjs tests/disk-collaboration.test.cjs`：**38/38 通过**。覆盖当前/根目录邀请目标、目录切换后目标绑定、宽限期复用、重新附着保护、清理后索引失效，以及现有 PoP、跨用户共享和协同权限回归。
- `node --check client/disk-ui.js` 和 `node --check tests/support/disk-directory-menu-fixture.cjs` 通过。新增生命周期测试使用独立临时数据库，不操作真实网盘或真实 Telegram；未执行浏览器 fixture 的实机触摸验收。
- 本轮差异 `git diff --check` 通过；用户 prompt 的既有改动不纳入本轮检查或改写。

## 261005：修复全量删除后频道正文残留与再次内容复用

### 现场证据与根因

- 基于 `dev/2609-s6-disk-shared-content-object`、HEAD `9c5b7a792635e0d68fd0effd90ac6bac93037062` 的当前工作区继续修改，保留上一轮的协同菜单成果及用户 prompt 改动；未暂存、未提交。
- 只读查询本地 `disk.sqlite` 的全部分区/账号引用、Content、租约、清理任务和 operation，并对照本地诊断日志。没有读出 HAR 正文、凭据、PoP nonce/digest，也没有修改实际数据库或调用真实 Telegram 清理。
- 2026-10-05 15:30:42（Asia/Singapore）建立的四个 verified Content 分别对应 `tun.miku.us-3.har`、`tun.miku.us-2.har`、`tun.miku.us.har`、`tun-test.miku.us.har`。15:32:34 删除根目录的四份，15:32:44 删除 `tun` 内最后三份，15:33:13 又整批复用；任务 `reusedBytes=14,244,386`、Telegram 发送字节为 0。核对时仅剩这次重传新建的四个 Logical 引用，没有其它账号隐藏副本或有效 lease；四个旧清理任务仍 PENDING、attempts=0。
- 故障链路是：最后引用删除 → DELETE_PENDING 仍保留 canonical 且允许新 PoP/完整正文归并 → 清理 worker 尚未执行时，重传附着恢复 READY → 原清理跳过。普通删除只取消引用，任务立即完成，不主动运行对应 Content 的清理。反复重传可以持续阻止频道清理。上一轮把宽限期作为解释，没有纠正这一实际产品故障。

### 生命周期与删除链路修改

- `server/disk-content-repository.js`：在解除最后引用的同一短事务中撤掉 canonical key；`find()`、legacy 物理匹配及完整 SHA 归并仅接受 READY 且确有引用的对象。零引用 DELETE_PENDING 不再作为新上传候选，不重新签发 proof/verified-input lease。同内容完整重传建立新 generation，旧清理只撤自己的 key。
- 显式文件/目录删除、审核 tombstone 设置零宽限，立即具备清理资格。已有读者、caption 或删除前已取得的合法上传租约继续保护正文；仅合法在途附着允许恢复对象，并以 INSERT OR IGNORE 防止覆盖新 generation 的索引。覆盖/历史合并仍保留原 60 秒补偿宽限，但也立即停止新的发现。
- `server/object-storage.js` 与 `server/disk-api.js`：共享删除取消 Logical 引用后，立即尝试该 Content 的持久化清理任务；清理 worker 可按 Content ID 定向处理，使用 Promise 串行协调并保留原 Telegram 调度及 Anchor guard。无引用且无租约时，任务等待本次远端删除/占位尝试结束，不再仅等待下一分钟定时检查。
- 有租约、observe 模式、网络/权限失败或异常隔离时，Logical 删除仍生效，任务返回 `TELEGRAM_CONTENT_CLEANUP_PENDING`，客户端任务详情明确显示正文待清理；outbox 保留重试。批量删除不会因为首个远端失败而跳过后续文件。新增 cleanup start/complete/pending 诊断事件。
- 审核删除提前保存 Content IDs，再执行会清空原对象字段的 tombstone，防止清理目标丢失。`server/disk-content-proof.js` 将获取 proof lease 纳入降级处理，异步验证期间最后引用已被删除时返回 MISS；S3 候选消失的竞争使用尚未消费的原正文回退普通上传。

### 兼容范围与文档

- 共享正文仍有引用时不能误删；原 47 小时 57 分钟删除/过期占位、reader lease、CAS/fencing、混合批次整批提交、协同删除保护、历史别名隔离和失败补偿均保留。不修改代理控制、上传分片策略、P2P/provider、隧道缓存或网页工坊。
- S3 DELETE 复用同一个删除服务；SigV4、PUT/GET/Copy、XML 响应及 Bucket 映射不变。传统网盘 API 说明同步更新删除语义、remoteCleanup 结果与 warning；共享 Content 说明删除后新的复用禁用及在途保护边界。
- 数据库无需 schema 迁移。旧版本留下的零引用 pending key 即使还在表中，新查询也不会命中；下次创建同 hash generation 会清理该旧 key。已重新上传且确有引用的当前文件没有被强制删除。运行中的 Node 必须重启才加载本次代码；旧程序不能因磁盘文件改动自动采用新策略。

### 测试与检查

- 新增/强化回归覆盖：真实 `createDiskTelegram.remove()` 适配器发出全部 deleteMessage（注入模拟 HTTP 上游）；批删后全部 preflight MISS；跨账号最后引用清理；首个失败不跳过后续且重试完成；在途读租约仅延迟清理并明确回显；新旧 generation 的 key 隔离；迟到 PoP 不签发证明；单文件及目录审核最后引用清理。
- 定向 API 回归 **23/23** 通过。初次测试的 1 个失败来自新测试误读公共上传结果中的内部 parts，改为读取权威 store 投影后通过；另一次沙箱中 `spawn EPERM` 在测试启动前发生，按权限流程重新运行通过，未将其当作应用故障。
- 完整执行 `node --test --test-concurrency=4 --test-timeout=120000 tests/*.test.cjs`：**647 tests、647 pass、0 fail、0 skipped、0 cancelled**。覆盖 Content、PoP、GC/recovery、SQLite/migration、S3、协同、Share、原网盘及隧道回归。
- 本轮及保留的相关 JS/CJS 语法检查通过；任务文件的 `git diff --check` 通过。所有自动删除测试使用独立临时数据库与模拟 Telegram 上游，未宣称真实公网删除验收；真实数据库只读调查，没有后台强制清除有效当前引用。

## 261005：后台 Content Object 删除跟踪与跨账号引用查询

### 问题与实现边界

- 在 `dev/2609-s6-disk-shared-content-object` 当前代码基础上修改。开始时 HEAD 为 `29177fdef3ea1e369af4d9f6db2583a593d14592`，收尾时 HEAD 为 `0f451553134c644269a504bf845bb8e8220b1804`（期间用户仅更新 prompt）；未提交、未暂存，不改写用户 prompt。
- 后台已有 Content 列表和详情 API，但 `/disk-management` 没有对应查询界面；不能直接按指定文件定位所有账号、分区的共享引用，也不能便捷核对 DELETING 的远端失败、重试和租约。不能用“频道消息仍在”或“审计行仍在”直接推断正文仍可复用。
- 此次只增加管理员诊断与位置导航，不修改 Content 生命周期、清理 worker、PoP、上传、S3、协同或隧道传输，不主动验证、合并、下载或清理 Telegram 文件；无需 schema 迁移。

### API 与一致性

- 新增 `server/disk-content-admin.js`，封装短 SQLite 只读快照；列表和详情沿用管理员 API，添加状态筛选、分页、全局状态计数和实际 cleanup mode。清理任务显示 purpose/state、尝试次数、领取时间、下次检查时间及原始错误，详情包含已完成任务和有效租约。
- 新增 `GET /api/telegram/disk-admin/content-reference-files`，支持文件名的字面子串或 Logical ID；文件查询默认每页 30 条、状态列表每页 50 条，单页上限 100；详情仍返回该 Content 在全部账号、全部 scope 下的完整引用。
- 每个引用返回公开用户识别信息、完整路径、Logical ID、文件大小及管理页目录链接。仅从用户 payload 提取 name/username/Telegram ID/provider，不导出 Passkey、公钥、密钥、PoP challenge 或租约 token。审核删除占位不再计作活动引用。
- 查询均使用参数绑定与 `Cache-Control: no-store`；未知状态、非法分页或空关键字明确报错。保留旧无参数 Content 全列表行为。检查确认 `disk_content_refs` 对 Logical File 有复合外键及 ON DELETE CASCADE；不为了模拟不合法孤立引用而放宽约束。

### 页面交互

- `/disk-management` 新增“同 Content Object 文件引用查询”和“Content Object 删除跟踪”。默认分别标示 DELETING / DELETE_PENDING，可筛选、翻页及手动刷新；observe 模式明确显示远端清理暂停。
- 文件行增加“查询同内容引用”；搜索结果先区分同名不同位置，选择后按账号/分区分组显示全部引用卡片。详情展示清理任务、有效在途租约，以及可展开的历史 revision/Anchor 物理消息定位信息；零引用明确提示不能靠审计行判断可复用。
- “打开所在目录 ↗”使用新 Tab 打开 `/disk-management?user_id=...&disk_space=...&path=...&file_id=...`，恢复目标账号/分区/目录并高亮文件约 3 秒。管理员查看其它账号仍走后台，不切换前台身份或绕过协同访问范围；会话过期后的重新登录保留这些位置参数。
- 卡片、状态色、路径、按钮间距与页面原风格一致；窄屏 CSS 使用单列、换行及局部表格滚动。目录异步请求迟到的结果或错误不覆盖当前已切换目录。

### 验证与收尾

- 新增 `tests/disk-content-admin.test.cjs` 和独立临时 SQLite fixture：覆盖管理员权限、普通用户不可访问、状态分页、错误/租约展示、跨账号与跨分区引用、准确目录读取、中文/日文/`&` 路径编码、审核占位、凭据不泄漏、参数校验及旧接口兼容；断言查询不调用 Telegram、不改变清理状态。
- 完整回归 `node --test --test-concurrency=4 --test-timeout=120000 tests/*.test.cjs`：**650/650 通过，0 fail、0 skipped、0 cancelled**。收尾增强目录链接读取断言后，新增定向测试 **3/3 通过**；一次沙箱 `spawn EPERM` 发生在测试启动前，按权限流程重新运行成功。JS/CJS 语法检查通过。
- 使用 computer-use 在隔离 fixture 实际打开后台：验证文件搜索、三个跨账号/分区引用、DELETING 筛选、失败详情、新 Tab 对应目录及目标文件；截图核对卡片、状态与按钮布局，控制台无 error/warn。IAB 视口覆盖没有实际改变窗口宽度，因此未将该操作记为移动端实机验收；窄屏适配按 CSS 检查，仍需实际设备确认。
- 没有访问或修改真实网盘数据库，也未调用真实 Telegram。测试服务器与临时数据库关闭清理，测试页面关闭，保留可重复使用的测试 fixture；共享 Content 文档同步补充 API 参数及后台操作说明。

## 261006：网盘检索、转存、分区 S3 与静态资源；FolderSync 表单核对

### 根因与设计判断

- 原后台“同 Content 引用查询”按文件名定位 Content，无法直接做普通目录/文件搜索，也不能用用户上传的二进制内容定位；删除占位移除 live ref 后没有保存原 Content ID，导致无法继续从该文件查看剩余引用。
- 分享与协同页面可读取授权范围内的资源，但缺少把资源变成当前用户独立 Logical File 的入口。复制正文会浪费 Telegram 空间；仅引用源分享又会随授权撤销失效。选用新 Logical File + 现有 Shared Content 引用，在写事务内复核来源授权与引用，并拒绝所有者转存自己的资源。
- 前台以往隐式使用默认分区，S3 管理只有管理员配置。为用户按分区启用 S3 时，需要后端再次校验分区归属、确定性 Bucket 名称及凭据一对一关系；Secret 只在创建、重新启用或轮换时显示。
- FolderSync 实际表单没有独立 Bucket 栏。其官方文档称部分 S3 兼容服务可在服务器地址附加 `/bucketname`，不能据此推断所有版本都如此。用户先前的 501/REST XML 栈与当前网关只接受 ListObjectsV2 的缺口相符，但缺少完整请求录制，不能断言真机错误已全部消失。

### 改动

- 管理员新增全账号/分区文件和目录名称搜索、上传二进制计算 SHA-256/大小并查询已验证 Content 的活动引用、文件技术信息树形/JSON 双栏；技术信息只投影公开身份字段，不输出 Passkey 等私密凭据。Logical tombstone 在释放 live ref 的同一事务中保存 `deletedContentId` 作为审计指针；旧版本中原本没记录该字段的历史占位无法倒推出原 Content。
- 网盘全盘搜索的文件/目录菜单新增“定位到所在目录”并短暂高亮。分享与协同页面新增转存入口和用户自己分区/目录选择；服务端复制目录结构与 Logical File，共享健康 Content，不重发 Telegram 正文，提交前在 SQLite 事务中复核分享或协同授权。自己所有的来源直接拒绝，撤销原授权不影响已建立的个人引用。
- 前台显示默认及命名分区，支持新建与切换；每个自己名下的分区可启用、停用或轮换 S3 凭据，Bucket 由用户 ID 和分区稳定生成。网关增加无 `list-type` 的 S3 ListObjects V1，保留 V2、SigV4 与现有对象上传链路；S3 接入指南按 FolderSync 实际表单补充地址与 Bucket 的选择规则和待真机验证边界。
- 新增批量文件/目录静态资源签名，支持 1 天、1 周、30 天、自定义秒数及永久；`/s3pub/{token}/path` 校验 HMAC、用户、分区、选中路径、过期与撤销，允许 Range 读取并按剩余签名期限设置 Cache-Control。链接与撤销列表由前台提供；签名记录持久化 SQLite，跨实例新请求读取最新撤销状态。HTML/XHTML/SVG 响应加 sandbox CSP。

### 验证与限制

- 定向测试覆盖 S3 V1/V2 签名列表、用户分区唯一凭据、静态签名范围与跨实例撤销、后台搜索/哈希/技术信息脱敏、删除后 Content 审计、分享及协同转存后的独立引用。`s3-gateway`、`s3-admin`、`s3-list`、`disk-content-admin`、`disk-static-resources` 与原网盘/分享/协同测试均通过；新增分区查询参数后同步更新依赖旧 URL 的播放器测试桩。
- FolderSync 真机与灰度域名尚未运行本地新代码，故只确认本地 SigV4 网关行为；灰度需部署后重新点击 App“测试”并按真实请求日志核对。永久签名的 HTTP max-age 以一年为单次上限；主动撤销不能删除客户端已在有效期内缓存的字节。
- 全量 `node --test --test-reporter=dot --test-concurrency=4 --test-timeout=120000 tests/*.test.cjs` 退出码 0；相关 JS 语法检查与 `git diff --check` 通过。首次全量运行暴露 4 个依赖旧 UI/URL 的测试桩断言，已同步改为验证新分区参数和新增菜单项；随后定向与全量复跑通过。未进行 FolderSync 真机或公网灰度写入验收，未使用用户附件中的 S3 Secret 发起请求。
