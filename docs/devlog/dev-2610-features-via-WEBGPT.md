# 261003-1 WEB-GPT 开发记录

分支：`dev/2609-s5-disk-chunks-progressive-push-WEBGPT`

## 任务

1. 修复网页工坊点击“🔗 原记录”后错误关闭/取消最小化状态的问题。
2. 按 `prompts/dev-prompt-logs/dev-tgdisk-chunks-progressive-push-refactor-261003.md` 重构 Telegram 网盘分片上传，使 Browser → Node 与 Node → Telegram 都能连续、渐进地推进，并保留失败补救、回滚和恢复语义。
3. 不修改 S3 协议层、对象存储 API、隧道传输协议等无关业务。

## 根因

### 网页工坊

`client/web-workshop.js` 的 source action 直接执行：

`if(presentationMode!=='minimized') close()`

因此从展开态点击“原记录”会走真正的关闭逻辑。原记录按钮本应只负责跳转传输记录，并保持网页工坊处于可恢复的最小化状态。

### Browser → Node 进度

浏览器分片 PUT 使用普通 fetch，页面主要依赖约 2.4 秒的 operation 轮询；服务端虽然会在 request data 到达时更新 operation，但 UI 端缺少浏览器原生 upload progress，因此视觉上仍容易表现为整片跳动。

### Node → Telegram 推送

旧 `receivePart()` 只有在一个 Content-Range 分片完整接收后才创建 `chunks.push(status:'queued')`，Telegram pipeline 看不到正在增长的 part。与此同时 `nextPipelineBatch()` 最多取两片，并在只到一片且浏览器未 finish 时额外等待 350ms，进一步放大“整片后才开始 Telegram”的延迟。

旧 Telegram 队列还是一个全局 Promise tail，实际只有 1 个远端 work in-flight。

## 实际修改

### 1. 网页工坊原记录

- source action 不再调用 `close()`。
- 展开状态点击原记录时只执行 `minimize()`，随后调用 `focusMessage(sourceMessageId)`。
- 新增 `tests/web-workshop-source-navigation.test.cjs` 锁定“原记录不得关闭网页工坊”的约束。

### 2. Growing staging reader

新增 `server/growing-file-readable.js`。

- reader 只读取 `writtenBytes` 以内已经真正落盘的内容。
- 追上写入点且 `sourceComplete=false` 时等待 waiter，不 busy-loop、不 EOF。
- 支持 AbortSignal 和 source error。
- 最终严格校验实际读取字节数等于声明 part size。

`server/telegram-drive.js` 调整为 part PUT 一开始就创建 `receiving` chunk，并在每次 filesystem write callback 成功后更新：

- `writtenBytes`
- growth waiter
- Browser → Node progress

完整请求结束并通过精确长度校验后设置 `sourceComplete=true` 与 SHA-256。

### 3. Telegram multipart 渐进读取

`server/telegram-multipart.js` 的 file source 增加 `streamFactory`。

Content-Length 仍按预先知道的 part size 精确计算，不改成 chunked transfer。multipart generator 对每个文件严格校验输出字节数，源中断时不能伪造完整 EOF。

### 4. 单分片临时上传与最终 media group

浏览器网盘 pipeline 不再等待“两片一组”，receiving part 只要已有落盘字节即可立即排队。

每个 chunk 先独立 `sendDocument`：

- Telegram 流与 Browser request 不直接 pipe；
- Telegram 慢时形成 staging backlog；
- Browser 只由显式 queue/backpressure 限制；
- 有效 `file_id/message_id` 返回后仍等待 sourceComplete，之后才写 push_confirmed 并删除 staging。

全部 chunk confirmed 后：

- 单 part：直接保留临时 sendDocument 消息作为最终 part；
- 多 part：用临时 file_id 按 2–10 项 `sendMediaGroup` 形成最终消息；
- 11 part 使用 9+2，避免单项尾组；
- 最终 Message[] 先写 recovery manifest；
- 再尝试删除临时消息；
- cleanup 失败不回滚可读文件，转入 `pendingRemoteCleanup` 后台继续处理。

### 5. Scheduler / 429

旧全局串行 `telegramUploadTail` 改为 scheduler：

- 全局 in-flight：4；
- 同 bot/channel：最多 2；
- 同目标启动 pacing：约 900ms；
- 时间槽在调度阶段预留，避免两个并发 work 同时读旧时间戳后一起起跑；
- 429 的 `retry_after` 回馈到目标级冷却窗口；
- 冷却期间该目标并发降为 1。

保留原有原则：

- 明确 pre-connect 失败可以有限安全重试；
- 请求已可能被 Telegram 接受但响应结果不确定时，不盲目重发；
- growing source 的安全重试先等待该 part 完整落盘，再从 offset 0 重建 request。

### 6. 连续进度 UI

`client/disk-client.js`：

- 浏览器支持 XMLHttpRequest 时用 `xhr.upload.onprogress` 连续报告分片 PUT；
- 本地实时 client progress 合并到同一远端 operation，不覆盖 Telegram 远端 phase；
- 显示当前 file/part 与 Browser → Node EMA 速度。

`server/disk-api.js`：

- 每次服务端落盘进度都会 wake Telegram pipeline；
- Telegram 有效连接发送字节继续来自 Undici bodyChunkSent 观察器；
- 增加 Telegram EMA 速度和当前 file/part 字段。

`client/disk-ui.js`：

- 保留“浏览器 → 服务器”和“服务器 → Telegram”两条链路；
- 增加速度与分片位置；
- 移除普通用户可见的独立“Telegram 已确认”字节行，confirmed 状态仍保留在内部事务数据中。

### 7. Backpressure 与恢复

`pendingBytes` 在渐进模式下统计当前已落盘、尚未完成远端处理的 staging 字节，不把浏览器未来尚未发送的字节算入 backlog。

重启时：

- 有 uploadId 的未终态上传先进入 `recovering`；
- staging recovery scan 先判断是否有 manifest 并执行已知远端残留回滚/清理；
- 没有恢复材料，或第一阶段安全清理完成后，再标记 `SERVER_RESTARTED`；
- 浏览器只发送了部分 part 时不伪造自动续传，仍按设计文档的第一阶段策略失败/补救；resumeOffset 属于后续协议扩展。

## 测试与验收

新增/扩展：

- `tests/web-workshop-source-navigation.test.cjs`
  - 原记录只最小化，不允许调用 close。
- `tests/disk-upload-staging.test.cjs`
  - receivePart 未结束时即创建 receiving chunk；
  - 已落盘前三字节可被 growing reader 读取；
  - reader 追上后等待后续增长而不 EOF；
  - source complete 后尾部完整 drain。
- `tests/telegram-upload-progress.test.cjs`
  - multipart 在 source 未完成时即可产出首批文件正文；
  - 增长源补齐后最终 body 长度严格等于 Content-Length。
- `tests/disk-telegram-upload-recovery.test.cjs`
  - 11 临时 part 最终化为 9+2；
  - finalization 只使用 file_id，不重新上传正文；
  - 部分最终组成功、后续失败时，已创建最终消息进入统一回滚清单。
- `tests/disk-operations-recovery.test.cjs`
  - 上传 operation 重启先进入 recovering；
  - recovery scan 后再决定 SERVER_RESTARTED；
  - 非上传 operation 保留原来的直接中断语义。

已对本任务所有修改/新增 JS/CJS 文件做 V8 语法解析检查，均通过。当前执行环境只有 GitHub connector，没有仓库 checkout/Node runtime，因此本会话内无法实际执行 Node test runner；相关测试文件已提交，需在正常仓库工作区执行下列回归：

```bash
node --test tests/web-workshop-source-navigation.test.cjs
node --test tests/disk-upload-staging.test.cjs
node --test tests/telegram-upload-progress.test.cjs
node --test tests/disk-telegram-upload-recovery.test.cjs
node --test tests/disk-operations-recovery.test.cjs
node --test tests/disk-api.test.cjs
```

同时建议用真实浏览器 + fake/真实 Telegram 做一轮 370MB 文件灰度，重点核验：

- 第一个 20MB part 尚未完整上传到 Node 时，Telegram request 已出现有效文件字节；
- Telegram 限速时 Browser → Node 不会自动降到相同速度，除非显式 staging backpressure 触发；
- 两条进度都连续增长；
- 所有 final media group 正常落库后临时消息被清理；
- 人工制造 cleanup 失败时文件仍可读取，后台 cleanup debt 保留。

## 范围

本次没有修改 `server/s3/*`、`server/object-storage.js`、隧道传输/WebRTC/Socket.IO 链路。S3 和传统网盘 API 可继续复用既有核心能力；本次浏览器渐进上传路径的协议变化记录在 `docs/adapter/telegram-disk-api.md` 与 `docs/overview/telegram-drive.md`。


## 2026-10-03 补充：居中 Loading 上传明细修正

此前实现只把 Browser → Node / Node → Telegram 字段拼进 `stages.join(' · ')`，仍是一整行，既没有文档要求的空行和缩进，也缺少当前文件大小、分片子状态和最终媒体组进度。

本次继续在同一 WEBGPT 临时分支修正：

- `#diskLoadingDetail` 改为 `white-space: pre-wrap` + 左对齐，实际保留换行与空行。
- 上传任务标题统一为 `上传N个文件：首个文件名`。
- 目录行后固定空一行。
- 单文件 Browser → Node 显示总字节、百分比、速度以及“正在上传第 N 个分片，共 M 个”。
- 多文件 Browser → Node 额外显示当前第 N 个文件及该文件大小，再显示该文件当前分片。
- Telegram 区块同样显示有效逻辑字节、百分比、速度、当前文件/分片。
- 分片发送过程中显示“正在推送第 N 个分片到TG”；Telegram 返回成功并写入 push-confirmed 后显示“第 N 个分片推送已确认”。
- 正文达到 100% 后不视为 completed；进入 `telegram-finalize` 时继续显示“X 个分片均已推送”和“正在提交最终媒体组 · i/n”。
- 最终媒体组进度由 `disk-telegram.js` 按整个上传任务累计，而不是每个逻辑文件单独从 1 重新计数。
- operation 增加 uploadFiles / fileSize / partCount / telegramFinalGroupIndex 等仅用于准确 UI 展示的状态字段。
- 新增 `tests/disk-loading-upload-detail.test.cjs`，锁定换行、缩进、单/多文件层级和 finalization 文案。


## 2026-10-03：Browser → Server 真实进度与共享 Content Object 第一阶段

### Browser → Server 真实进度

此前居中 Loading 的 Browser → Server 字节与速度被客户端 XHR `upload.onprogress` 覆盖。该事件主要表示浏览器已经把多少请求体交给网络栈/代理缓冲，并不等于 Node 已经收到并写入 staging，因此会出现几十 MB/s 的虚高速，以及浏览器事件与服务端实际落盘错位的问题。

本次修正：

- 服务端 `receivePart()` 写入回调中的实际字节成为用户可见 Browser → Server 进度事实源；
- Browser → Server 速度在 Node 侧基于实际接收字节时间差计算 EMA；
- 客户端 XHR 只负责请求传输/取消，不再用 `upload.onprogress` 覆盖服务端实收字节与速度；
- operation 增加 SSE 实时快照，活跃上传无需等待 2.4 秒 polling 才看到变化；
- SSE 以约 80ms 为最小 UI 推送间隔，避免每个 filesystem chunk 都产生一条事件；
- polling 继续作为不支持/拦截 SSE 的代理环境回退。
- 新增 `tests/disk-browser-server-progress.test.cjs` 锁定上述语义。

### 共享 Content Object：第一阶段基础设施

依据 `prompts/dev-prompt-logs/[WEBGPT]dev-shared-content-object-design-guide-261003.md` 开始实施第一阶段。

本阶段只建立新所有权模型的安全基础，不提前切换删除/PoP/S3 Copy：

- SQLite schema 升级到 v2；
- 新增全局 `disk_contents` 与独立 `disk_content_parts`；
- Content parts 通过 `(scope, content_id)` 复合外键指向 Content Object；
- 新增 `server/disk-content-store.js`；
- 提供 Content Object get/put/remove、legacy resolve、manifest identity；
- 新上传在现有 Logical physical commit 成功后，额外创建 READY Content Object 并给 Logical File 写入 `contentId`；
- 当前仍保留 Logical File 原有 `parts/fileId/channelId/backendId` 作为兼容 source of truth；
- 因此这一阶段尚未改变现有删除语义，不会因为多个 Logical File 共享 Content Object 而提前删除 Telegram anchor；
- `manifestSha256` 仅作为当前分片结构的迁移/候选身份，不替代未来的完整文件 `contentSha256`；
- 新增 `tests/disk-content-object-foundation.test.cjs`。

下一阶段应先把下载/check 等读取路径接入 Content resolver，再切换 release-reference/delete 语义；PoP 和真正跨用户 HIT 复用应在所有权/删除模型稳定后启用。


### Content Object 第一阶段继续：读取兼容层

- 网盘 `check/download/stream` 开始通过 `resolveContent()` 获取 physical representation；
- 带 `contentId` 的新文件优先使用 Content Object 的 `backendId/channelId/parts/thumbnail/mediaIndex`；
- 历史文件或 Content Object 不可用时自动退回原 Logical physical；
- 用户可见文件名、MIME、目录等仍来自 Logical File，因此共享 physical 不会改变 Logical metadata；
- 删除、repair replacement、S3 Copy 尚未切换到共享引用语义；
- schema 提升到 v3，用于修复早期 v2 `disk_content_parts` 若缺少 scope 复合外键的兼容迁移。
