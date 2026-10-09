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

## 261006-2：静态开放管理、分区间操作与网盘交互补全

### 调查与边界

- 旧版上传、未建立已验证 Shared Content 哈希的逻辑文件，不能靠“上传本地文件查找相同正文”发现；同名也不等于同正文。这两项验收现象符合已有 Content Object 设计，未按文件名强行合并历史正文或伪造哈希关系。
- 分区名可以合法包含中文；浏览器 HTTP header 不接受非 ISO-8859-1 字符。问题在 `DiskClient` 把原始分区名写入 `X-Disk-Space`，不是目录名称校验。改为通过编码的 `disk_space` 查询参数传递，服务器保留旧 header 兼容。
- 静态签名原本可读取但缺少直观的管理入口及写入保护。独立签名与父目录签名必须分别管理：停用父目录时，不撤销已独立开放的子项；单独子项的缓存期限覆盖父目录默认值。

### 实际修改

- 前台增加“已开放静态资源”列表、点击定位及短暂高亮；直接或经已开放目录继承开放的图标显示蓝色 `S`。当前目录自身有静态签名时显示右下角蓝色管理按钮；单项菜单提供静态设置、有效期调整、复制链接和停止开放。已继承父目录开放的子项明确提示应先停止父目录开放。目录缓存期限采用父作用域默认值，独立子项期限优先；服务端响应的 max-age 不超过签名剩余有效期。
- 服务端在文件/目录改名、移动、删除、审核删除、协同修复替换和 S3 对象覆盖/删除入口检查有效静态签名；涉及已开放子项的父目录同样受保护。停止直接开放仅撤销目标项签名，保留独立子项签名。
- 分享/协同转存改用现有树形目录选择器，可按分区选择任意层级目标，并可新建多级目录或所选目录的子目录。前台分区管理按钮移到选择器左侧并统一样式；账号信息仅显示头像图标与名称，完整 ID 放在 title；S3 只读参数可点击全选并复制。
- 新增跨分区复制/移动浮层与服务端短事务；复制建立新 Logical File 并复用同一 Content Object，移动在目标成功写入后撤除来源。保留目录结构，目标重名或静态/协同保护冲突时回滚，不重新发送 Telegram 正文。当前目录新建成功后定位并约一秒高亮。宽屏隧道目标选择 dialog 改为视口居中，保留窄屏滚动约束。

### 验证与剩余实机检查

- 测试新增跨分区同 Content 复制/移动、中文分区查询、冲突保留源、静态文件/目录写保护、父子独立开放与缓存优先级、前端非 ASCII 分区编码。旧隔离 UI 测试桩补齐新函数；管理员测试 fixture 避免 OS 随机分配 Fetch 禁用端口导致偶发失败。
- 完整 `node --test --test-reporter=dot --test-concurrency=4 --test-timeout=120000 tests/*.test.cjs` 退出码 0；相关 JS `node --check` 与 `git diff --check` 通过。未连接真实 Telegram、S3 客户端或移动设备；静态链接撤销不能清除浏览器在撤销前已按 HTTP 缓存头保留的内容。

## 261008：分区管理、协同挂载与启动反馈；中断任务恢复

### 恢复依据与基线

- 完整复核 `[261008-1]` 原始需求、Agent 中断记录、分区/挂载实施指南、PWA 加载指南和 FolderSync 两种失败记录，并逐项与当前代码、未跟踪模块和测试核对。当前分支仍为 `dev/2609-s6-disk-shared-content-object`；实际 HEAD `b4a67237c8e0035482f353c5221d664326d571d7`，相对中断参考 `f20ab05e2f832cfbf8e1bfe748c7a81a4e6fd28d` 只增加了 `prompts/dev-prompt-logs/dev-2609.md` 的提交。该文件原有独立工作区修改保持不动；其余既有未提交/未跟踪产物全部保留、审查并继续整合。未切分支、暂存或提交。
- 中断时已形成分区、挂载、工坊和 PWA 模块，但存在集成缺口：旧测试仍期望未知分区返回空列表；Native/Foreign 跨界 Copy 的前端/后端尚未贯通；挂载搜索与选择权限边界、S3 探测及分区复刻的用户反馈未闭合。不能将 Agent 的“已完成”陈述直接当作验收结论。

### 分区身份、复刻、删除与恢复

- 新 `server/disk-partitions.js` 与 SQLite `partitions` 记录把稳定分区 ID、不可变 `scopeKey`、可改显示名分离；旧分区按用户原 scope 迁入，默认分区底层仍为 `''` 且不可删除，同用户名称冲突被拒绝。齿轮紧邻网盘刷新按钮，整合个人显示偏好、当前分区设置、S3 参数及新建/重命名/复刻/删除。
- 复刻仅提交可用 Native 目录、Logical File 与共享 Content 引用，跳过审核不可用项、Mount、协同授权、分享、静态签名、S3 凭证和历史任务。新增影响预览和双重确认；复刻/删除均先返回可轮询的任务 ID，页面显示 Loading/任务进度。复刻的目标分区及引用、删除的原生数据与 Mount 指针均在 SQLite 短事务内原子变更；不发送 Telegram 正文。复刻提交前重新读取源快照，防止预览到执行之间的数据变动；同名并发只有一个任务成功。
- 删除前检查活跃协同、任务、Content 租约和目录可写性；任务本身从二次检查排除，分区内静态签名随删除一起撤销。已删除分区的 `/operations` 仍可供原任务轮询，普通数据路由继续拒绝访问。S3 凭证在数据库删除成功后退休，避免事务失败却提前停用完好的分区；退休失败会在完成结果中标明待清理。常规删除失败后回到 ACTIVE 以保留文件并允许重试；进程中断遗留 `DELETING` 时，只有持久化删除任务已失败/取消且无活跃任务，用户才可从设置面板显式恢复原分区访问。复刻完成后的使用记录/租约清理异常不伪装为“分区未创建”。
- `tests/disk-partitions.test.cjs` 覆盖旧 scope、默认分区保护、跨用户隔离、共享引用、并发同名复刻、删除任务完成后轮询、中断恢复、S3/静态/分享撤销和数据库完整性。原 `tests/disk-api.test.cjs:183` 的空列表断言已按新的分区隔离契约改为 404。

### 协同 Mount、作用域与跨界 Copy

- 新独立 `collaboration_mounts` 持久化记录和 `/mounts` API；挂载可放在本人任意原生目录、同一协同可多次挂载，Mount 不持有 Content 引用、不把外来内容混入 Native 树。稳定分区身份与挂载位置独立；改名、移动、递归删除只处理本地指针。原生文件/目录/Mount 的同名约束在 SQLite 层原子拒绝，S3 目录标记删除也不会修剪仍挂有 Mount 的 Native 父目录。
- 协同授权引入实际 viewer/editor 权限与版本重验；旧有效成员按 editor 兼容。撤销、降权、目录审核变化后，旧 Mount 的读取、搜索和写入不再沿用失效缓存。被撤销的入口仍显示“访问已失效”并可移除；协同页限制面包屑、`path` 与 `file_id` 在受邀根内，viewer 隐藏写入操作；从 Mount 返回本人的网盘时保留触发入口上下文。
- `/cross-scope/copy` 在 SQLite 写入事务中重验来源、目标两侧授权、角色、分区、路径、审核及 Content 引用；Native↔Foreign、Foreign A↔B 只做显式 Copy，来源保持不变，跨界 Move 拒绝。Native→Foreign 的菜单/挂载拖放和 Foreign→Foreign 的协同页操作均已接入；拖放只把有 editor 授权的 Mount 视为目标，并在弹层期间锁定来源分区。Native 跨分区原有 Copy/Move 仍独立保留。跨实例 Share 撤销后读取会重新核验 SQLite，不延续旧实例缓存。
- “所有文件”只保留当前本人分区 Native 搜索；独立的“附加已挂载的协同内容”仅追加当前有权访问的外来结果，带来源标签和 mountId 导航。搜索词/选项变化立即撤下旧结果；失败不能继续点击旧 foreign 结果；打开时再解析 Mount 授权。挂载搜索有查询/结果上限与截断提示。

### 其余界面与兼容性

- 静态资源蓝色 `S` 角标现只显示在**直接设置**开放的文件/目录；父目录继承仍能访问，但子项不再显示角标。当前目录默认缓存期限更新、持久化、重新打开回显和个体覆盖均按独立签名检查。窄屏底栏按钮显示 `S`，宽屏保留完整文案。协同管理浮层按网盘可视窗口限制宽度/位置，监听视口变化并在关闭时清理；分区切换会关闭旧分区浮层，异步列表响应不得污染新分区。
- 网页工坊文件树接受系统文件/目录拖放，先完整枚举来源层级与合计大小，超过 20 层或 100MB、名称冲突时拒绝，再读取/保存；不将失败导入留在草稿树。PWA 启动层仅用 Resource Timing/PerformanceObserver 和现有初始化阶段观测资源，不劫持 fetch/XHR/Socket、也不改 Service Worker；就绪后清除遮罩、定时器、监听器和观察器，失败资源不计入已完成数。
- FolderSync：签名 `HEAD /S3API` 从 501 改为成功探测；S3 错误按 REST-XML `<Error>` 返回，并补充请求资源/ID。当前接入说明以 `/S3API` 根地址为优先；Bucket 后缀在开启 Path-style 的客户端可能被重复拼接，不能从缺少 HTTP 报文的 App 栈断言其唯一失败原因。保留 S3 V1/V2 列表、对象操作及传统网盘 API 兼容。

### 测试、风险及待实机验证

- 对原始条目逐项核对：一-1 分区齿轮/身份/复刻/删除由分区 HTTP+SQLite 测试覆盖；一-2 协同 Mount、权限、跨界 Copy、搜索由 Mount/协同/Copy 集成与 UI VM 测试覆盖；二-1 直接静态角标、二-7 缓存期限由静态资源测试覆盖；二-2 工坊外部拖放和二-3 PWA 观察由 VM 测试覆盖；二-4 窄屏 `S`、二-5/6 协同面板边界及视觉样式只通过 CSS/DOM 检查，仍需实际视口视觉验收；二-8 统一 Copy/Move 的原生分区路径有回归测试；二-9 多分区静态/协同定位按分区 ID 切换并有代码及定向测试；二-10 S3 服务端签名探测/XML 通过模拟请求，FolderSync App 仍待灰度真机验证。
- 新增/扩展分区、Mount 拓扑和导航、权限角色、跨 Scope Copy、分享撤销、静态设置、工坊拖放、PWA 观察、S3 探测/XML 的单元与 HTTP 集成测试；关键隔离测试使用独立临时 SQLite/WAL 与模拟 Telegram。最终全量测试、语法/差异检查结果见本节收尾记录。中途一次全量失败只因 `tests/disk-move-feedback.test.cjs` 的旧 VM 桩仍调用已合并选择器，已改为当前 API 后重跑通过。
- 当前环境未连接灰度/正式环境的 FolderSync 真机、真实 Telegram、Android 拖放设备，也未实测 PWA 冷启动/缓存命中/慢网的真实首屏。S3 第二种失败日志只有 App 栈，没有最终请求路径、HTTP 状态与响应体，因此不能宣称两种连接方式均已真机验收。PWA 层虽位于 body 首位，仍在大段 head CSS 和外部样式之后，首字节/样式阻塞时间不受此纯观测层控制。大分区事务的提交阶段仍同步占用单个 Node 事件循环，页面显示阶段性进度而非每个 Logical File 的精确百分比；不要把 UI 阶段值解读为连续字节进度。
- 收尾验证：`node --test --test-reporter=dot --test-concurrency=4 --test-timeout=120000 tests/*.test.cjs` 最终退出码 **0**；分区专项 7/7、Native/Mount/协同/PWA/S3 定向 23/23 通过；17 个受影响业务 JS/CJS 文件及新增服务端/前端模块 `node --check` 通过。任务文件 `git diff --check` 通过；独立的 `prompts/dev-prompt-logs/dev-2609.md` 原有尾随空格不在本次修改范围，未改动。所有测试均使用隔离夹具/模拟上游，不代表公网或手机端验收。

## 261009：分享取消、协同入口、网盘布局与网页草稿另存为

### 基线与调查结论

- 分支 `dev/2609-s7-disk-partition-collaboration-mount`，基线 HEAD `f555812762fafcf4624e837c28d18ae1349ffff8`；在当前代码上修改，保留 `prompts/dev-prompt-logs/dev-2609.md` 的独立改动，没有暂存、提交或推送。
- 分享页浏览器取消及服务端响应断开原本已有处理，但共享分片缓存的生产者没有接收取消信号；消费者离开后仍填充缓存，因此可能继续发生 Telegram 回源流量。播放器取消旧 Range 后保留缓存填充是原有播放策略，需要与分享下载的取消分开处理。
- 挂载与普通项目未固定隐藏复选框所在列，导致无复选框项目向左挤；网格自动行被受限容器高度压缩，文本溢出到下一行。底栏采用绝对位置及固定预留宽度，窄屏静态按钮变成 `S` 后仍保留原宽度空隙。分区设置同时存在卡片及内层滚动，新建输入框与弹窗重命名的用途不清楚。

### 分享下载取消（需求 1）

- 分片缓存生产者拥有独立 AbortController；分享下载显式启用无人使用时取消策略，响应断开后移除本请求的读者、停止未被其它读者使用的上游、关闭流并删除未完成临时文件。下一次请求等待取消清理结束后重新建立缓存，不复用已取消的生产者。
- 将生产者信号传给 Telegram `readPart()` 和本地 Bot API 文件流；取消后不再进入下一分片或网络重试。捕获后端解析期间已断开的响应，避免重新开启无消费者读取。共享 `getFile` 地址查询不因单个消费者取消而破坏其它请求；查询返回后检查取消，不再开启正文下载。
- 其它读者仍在使用同一窗口时不停止共享下载；混合播放器读取时保留既有后台填充策略。本次取消范围明确限于分享下载，不改变 S3、普通网盘播放器及缓存复用策略。取消不能追回已经进入网络缓冲的少量在途字节；本机 HTTP 验证取消后字节计数停止增长。

### 协同列表、挂载与搜索（需求 2、6、7、8、9）

- 协同项目入口占满每行操作按钮之外的宽度，允许名称换行，整行按钮等高；我创建的项目采用绿色边界，受邀项目采用蓝色边界。所有者红色 `×` 取消协同；受邀项目提供橙色“挂载到网盘”和红色 `×` 退出协同。确认文案说明授权和已有挂载的影响，成功后更新列表，原文件不被删除。
- 新增浏览器身份认证的 `POST /collaborations/:collaborationId/leave`：只能退出当前登录用户本人的成员关系，移除角色并增加成员版本；旧挂载因失去授权而不可访问。取消本人项目沿用所有者 API，并通过单次请求分区参数定位所属分区，不改变当前浏览分区。
- 受邀入口文案为 `受邀加入 · {名称} · 📁/📄`，不追加来源分区。挂载入口与挂载搜索结果共用全屏协同 iframe，保留 `mount_id`、目录路径及文件 ID；红色关闭按钮只关闭协同层，原网盘目录、搜索等状态保留。
- 挂载成功切换到目标分区及原生目录，滚动定位新挂载项，边框与背景高亮约 1 秒。普通列表、挂载及受邀搜索统一使用固定复选框、图标、信息和菜单列；挂载名称与来源说明在列表视图完整换行。

### 分区设置、网格与底栏（需求 3、4、5、10）

- “当前分区设置”卡片右上角放置“+ 新建分区”，通过名称输入对话框创建；原输入框预填当前分区名称，右侧按钮直接重命名，不再弹第二个输入框。标题/右上关闭及底部操作区不参与内容滚动，仅中间内容区域滚动。
- 网格行使用 `max-content`，为图标、文件名和附加信息保留实际高度，间距增加至 18px、减轻默认边框并保留悬停/选中反馈。根据用户追加要求，文件名最多 **两行**，超出显示省略号，并通过 title 提供完整名称；附加信息仍可合理换行，避免与下一行重叠。
- 底栏改为按按钮实际宽度排列的 flex 布局，去除静态/协同按钮及菜单的固定右偏移；统计区独立伸缩和横向滚动，窄屏 `S` 释放的空间会用于统计区，按钮不再遮盖统计文字。多选操作区同样遵循此布局。

### 网页工坊另存为（需求 11）

- “保存”右侧新增“另存为”：命名后先完成当前编辑缓冲和保存队列，再深拷贝整个草稿的文件、目录及发布设置，建立独立草稿并切入副本编辑。清除来源文件、来源传输记录和更新发布模式，副本后续发布使用新记录，原草稿及其关联保留。
- 更新副本 manifest 的名称、创建/编辑时间，保留其它既有 manifest 属性；正文 Uint8Array 独立复制，修改副本不会污染原草稿。不修改网页工坊独立的最小化状态管理。

### 验证与限制

- 新增 `tests/features-261009.test.cjs` 覆盖最后读者取消/半成品清理/重建、共享读者取消、真实本机 HTTP 分享断开后的上游停止、整包另存为、跨分区挂载定位和请求作用域。扩展协同测试验证受邀用户不能取消所有者项目、本人退出后不可继续访问、所有者文件保留以及重新邀请可加入；保留原播放器取消 Range 后完成缓存的回归测试。
- 最终全量命令：`node --test --test-reporter=tap --test-concurrency=4 --test-timeout=120000 tests/*.test.cjs`，**702/702 通过，0 失败、0 取消、0 跳过**。修改的 JS/CJS 语法检查及任务文件 `git diff --check` 通过。早期运行遇到测试子进程 sandbox `EPERM`，在获准执行后运行成功；旧 VM 测试补齐 URL 和共用 iframe 回调桩后定向及全量通过。
- 使用 `tests/support/features-261009-fixture.cjs` 在 `127.0.0.1:3189` 提供合成内存 API，不读写用户网盘数据、不联系 Telegram。浏览器验证宽/窄视口协同行按钮、挂载全屏打开与关闭返回、跨分区挂载定位、搜索结果、重命名、设置固定操作区、窄屏底栏及两行网格；网格第二行与第一行保持 18px 间距，名称边界位于项目内部。立即修改正文后另存为，副本包含新正文且无原记录入口，原草稿仍有原记录入口。
- 内置浏览器不支持原生 prompt，视觉夹具仅在测试页面用默认输入替代 prompt；真实 Chrome 的名称输入仍需用户验收。未访问正式/灰度 Telegram 频道或 Android 真机；公网代理的取消传播及少量在途字节尚需部署后观察。临时验收服务停止、浏览器尺寸恢复；复用夹具和回归测试作为正式测试保留。

## 261009-2：网盘错误说明、回收站与网页工坊网盘导入

### 基线和根因

- 在 `dev/2609-s7-disk-partition-collaboration-mount`、HEAD `ce5471675a166bfc1c938d68281c5646d28dd93c` 上直接修改；未暂存、提交或推送。保留 `prompts/dev-prompt-logs/dev-2609.md` 和工作期间出现的 `dev-2610.md` 独立编辑。
- 原错误码经常被多个权限/作用域校验分支共用，前端仅用固定短文案或直接显示码，无法分辨“父目录复制进子目录”“同项目”“只读”“授权版本改变”等实际原因。后台任务的说明字段也没有完整传递给前端。
- 静态角标只标记显式开放项目，此规则正确；复制链接则须另外判断父目录继承范围，不能复用角标条件。原分区选择器的内联样式会覆盖外部装饰样式，包含背景和箭头。
- 原删除会释放 Logical File 引用并清理零引用 Telegram 正文，不能以旧删除审计实现可靠还原。新增回收站必须保留正文引用，并与 S3/管理员的永久删除语义区分。

### 逐项实现与操作边界

1. **错误提示**：新增前后端共用 `client/disk-error-messages.js`。保留 `error.message` 和错误码，API 额外返回 `userMessage`、安全 `errorDetails.reason`、请求编号；任务失败和 DiskClient 等待结果也携带说明。个人网盘、协同页、分享页共用格式化入口，兼容旧响应。分类覆盖来源/目标越界、禁止协同根操作、单文件授权、同项目、原生范围、只读、成员及授权版本、来源变化、历史内容引用缺失、重名/上传占名、静态保护、挂载范围等；授权范围内的必要路径限长输出。底层异常概括处理，不回传 SQL、堆栈、密钥或服务端路径。多项移动/删除在中断时显示当前项目、已确认完成数及后续未执行数，不自动重放整批；不承诺未确认的当前项目已回滚。
2. **完整静态链接**：原生文件/目录自身或父目录开放均显示行内及上下文菜单“复制静态链接”。复制时重新读取有效设置，优先使用个体签名，按各路径段编码非 ASCII 字符和特殊字符；目录链接保留末尾 `/`。撤销、过期、复制等待期间账号/分区切换均阻止复制。行复用签名加入继承开放状态，刷新后及时增减入口；蓝色 S 仍只表示显式开放。
3. **分区选择器和挂载光标**：移除覆盖装饰的旧内联选择器规则，统一边框、背景、箭头、焦点/悬停反馈与选项色彩；目录挂载项和挂载搜索结果在鼠标设备显示 pointer。原生下拉菜单仍由浏览器/系统绘制，不以自制下拉组件改变选择行为。
4. **分区回收站**：顶部入口位于齿轮左侧，窄屏收进汉堡。新增 `client/disk-trash-ui.js`、`server/disk-trash.js`，全屏原生 dialog 保留底层网盘状态，回收站按账号及分区隔离。删除目录保存完整目录/文件及本地挂载指针快照，可逐层浏览；仅顶级整项提供还原。还原在同步 SQLite 事务内检查原父目录和祖先、文件/目录/挂载重名、静态保护、层级及内容引用；失败保留快照且回滚局部修改。成功返回原父路径与目标 ID/path，关闭浮层并复用导航及 1 秒高亮。分区删除在预检、执行和最终事务均拦截非空回收站。
5. **生命周期**：普通浏览器网盘删除进入回收站，原文件行保留 ID/内容引用，隐藏于普通列表、搜索、S3 对象视图及管理员实体列表；使用不可由正常命名创建的内部保留名释放原名称位置。还原复用原文件 ID/Content，不发送 Telegram 正文。新增明确确认的“永久删除”才释放引用，由既有租约/清理机制处理零引用正文；其它逻辑引用存在时不删除共享消息。回收站不自动过期清除。传统第三方 API、S3 删除、管理员实体删除和审核占位删除维持原有永久删除行为；旧版本已永久删除的数据无法追溯还原。内容引用诊断显示回收站原名称/位置及保留状态，不生成误导的普通目录跳转链接。
6. **数据库升级**：schema 3→4 新增通用 `disk_trash_items` 表；升级前 `VACUUM INTO` 生成 `disk-before-trash-*.sqlite` 完整备份，原文件索引/约束和 Content 引用表保持。旧二进制不支持 schema 4，回退必须按备份恢复，不能混跑新旧服务。
7. **工坊导入**：合并为“导入”纵向菜单，保留上传/隧道入口并增加网盘入口。`client/disk-import-picker.js` 使用独立请求分区、按需展开树、多选文件及目录；切换分区清空选择并忽略过期响应，不改变主网盘浏览分区。先去除父子重复选择，保留目录层级和空目录，预检同名、合法路径、20 层及 100MB 限制；全部文件完整读取后才一次加入当前草稿，保存失败恢复原文件集合。下载期间取消始终可用，AbortSignal 传递请求，服务端 `purpose=web-import` 在最后读者取消时停止无用回源，不改变普通媒体播放器缓存策略。取消/失败不返回半包，不改变工坊最小化状态；Escape 只关闭本次选择器。菜单按按钮位置 fixed 显示，避免被窄屏横向工具栏裁切，滚动/缩放/切换视图后清除监听器。
- Service Worker 增加三个新前端模块到资源清单，并在现有 v78 Runtime 主版本下更换应用缓存后缀；网页 ZIP Runtime 协议和启动预缓存策略不变。

### 验证记录

- 新增 `tests/features-261009-2.test.cjs`，11 项专项验证真实隔离 SQLite/API：具体错误原因与敏感信息过滤、父子复制拦截、只读/路径权限、静态保护、文件/目录回收和缺失父目录/同名回滚、分区/用户隔离、独立数据库连接读取、同时还原、非空回收站阻止分区删除、挂载恢复、永久删除保留其它共享引用；另验证静态链接编码/个体优先/过期/切换竞争，导入计划及取消 signal，并验证 schema 升级前备份。
- 既有 Content 物理删除测试改为“移入回收站后明确永久删除”，保留真实 Telegram 删除适配器、零引用不复用、在途租约延迟及失败清理重试断言；未来 schema 拒绝测试随当前版本递增；旧行复用 VM 桩补齐新静态状态依赖。专项加移动反馈 16/16 通过；Service Worker 相关回归保持既有 Runtime 版本前缀，不绕过原有行为断言。
- 中途默认测试并发出现隔离夹具 SQLite I/O/out-of-memory 及一次 S3 fetch 失败，未据此修改生产网络/SQLite 策略；限制并发后无这些错误。此前回归只剩缓存名称固定断言，已修正主版本兼容。最终完整回归及语法检查结果见下方收尾记录。
- 新增/保留隔离视觉夹具 `tests/support/features-261009-2-fixture.cjs`，不读取真实账号、不连接 Telegram。HTTP 服务可访问，但 Codex 内置浏览器导航/焦点控制持续超时，本轮没有完成实际宽窄屏视觉验收，也未实测 Android、真实 Telegram 或公网代理取消；自动测试和静态样式检查不能替代这些验收。临时服务结束时关闭。
- 收尾：后台网盘管理页也接入共用说明字段；目录选择器创建任务保留失败原因。未确认 Telegram 发送结果仍优先显示“核对频道、勿重复上传”，避免新格式化入口遮盖既有恢复提示。还原父路径进一步区分“目录缺失”“被同名文件阻挡”“被管理员屏蔽/删除”；永久删除后远端清理待重试时明确显示未完成状态。
- 最终完整命令 `node --test --test-concurrency=2 --test-reporter=tap`：**713/713 通过，0 失败、0 取消、0 跳过**，退出码 0（`.npm-cache/261009-2-complete.log`）。最终 24 个修改/新增 JS/CJS 文件语法检查通过；任务文件 `git diff --check` 通过，检查时排除上述两个用户独立 prompt 编辑。分支保持不变，暂存区为空；隔离验收服务已停止，未触及真实 `.tunnel-data`。
