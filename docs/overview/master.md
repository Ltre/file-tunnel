# Drop2Tunnel 功能与需求总览

> 本目录用于给后续开发者和 AI 提供“可追溯的项目事实”。它不仅描述现在有什么功能，还说明这些功能为什么存在、经历过哪些调整、当前代码如何实现，以及哪些历史方案已经被替代。

## 1. 文档基线

本套总览首次建立于长期维护分支 `dev/doc-overview`，首轮完整扫描基于：

- 源码分支：`dev/2609-s1`
- 源码 Commit：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`
- 源码提交时间：`2026-09-25T02:07:27Z`
- 首轮整理日期：2026-09-26

精确增量锚点见 [VERSION.md](./VERSION.md)。

## 2. 产品总定位

Drop2Tunnel 是一个自托管、浏览器优先的跨设备“隧道”协作与传输系统。它已经从网页端即时传输工具扩展为多层系统：

- 隧道路由、设备发现、多设备历史与权限；
- 文本、富文本、文件、合辑、目录；
- IndexedDB/OPFS/File System Access 与 P2P/Relay/Telegram/VClient 多来源恢复；
- 文件预览、后台音乐、摄像头、群语音、对讲、联系人通话、远程预览；
- Telegram Bot、Telegram 内容管理、Telegram 虚拟网盘；
- Passkey/OIDC、第三方网盘 API、分享和审核；
- SNS、YouTube Premium、音轨修复、FFmpeg 转码；
- 网页 ZIP / 网页工坊；
- Light Transfer 光媒；
- VClient 常驻缓存节点；
- PWA / Service Worker / 移动工作区；
- 管理后台、安全、构建和部署。

后续修改任何子系统，都不应只读单个 UI 文件。大量功能通过 `app.js`、`server.js`、`client/*`、`server/*`、Service Worker、IndexedDB、Socket.IO 与外部服务交叉。

## 3. 建议阅读顺序

如果 AI 第一次接手项目：

1. 本 `master.md`；
2. [architecture.md](./architecture.md)；
3. [source-map.md](./source-map.md)；
4. 当前任务所属模块文档；
5. [tests-and-regressions.md](./tests-and-regressions.md)；
6. 对应历史时间线；
7. 再阅读具体源码 / Prompt / Devlog。

## 4. 模块导航

### 核心架构与隧道

- [architecture.md](./architecture.md) — 运行架构、数据边界、前后端职责、当前与未来设计边界。
- [tunnel-core.md](./tunnel-core.md) — 隧道、短码、设备、历史同步、权限、路由、联系人、Nearby、通知。

### 文件传输、缓存与媒体

- [transfer-cache.md](./transfer-cache.md) — 传输记录、文件资产、P2P、Relay、多源恢复、浏览器缓存、文件句柄、备份/导入、资源管理器。
- [media-player-realtime.md](./media-player-realtime.md) — 图片/视频/音频预览、音乐播放器、摄像头、语音、对讲、联系人呼叫、远程预览。
- [light-transfer.md](./light-transfer.md) — D2L1 光学二维码文件协议、残片、网络加速、完整性与完成写入。

### Telegram

- [telegram-bot-content.md](./telegram-bot-content.md) — Telegram Bot、中转、Webhook、指定目标转发、后台 Chat/成员管理。
- [telegram-drive.md](./telegram-drive.md) — Telegram 虚拟网盘、身份、目录/文件、分片、上传恢复、Range、缓存、分享、审核、第三方 API、未来 SQLite/S3 边界。

### 内容生产与下载处理

- [web-workshop.md](./web-workshop.md) — 网页工坊、`.html.zip`、草稿、编辑权限、Service Worker Runtime、发布与资源导入。
- [download-transcode.md](./download-transcode.md) — SNS、YouTube Premium、metadata、Telegram 转发、音轨修复、视频转码。

### 平台与运维

- [pwa-ui.md](./pwa-ui.md) — PWA、Service Worker、主题、宽屏三栏、移动 workspace、Overlay、全局 UI 状态。
- [admin-security-deployment.md](./admin-security-deployment.md) — 管理后台、TOTP、Secrets、数据占用、Nginx/CDN、构建部署。
- [vclient.md](./vclient.md) — VClient 常驻缓存节点、控制面、资产供源、服务器 Shell 推送。
- [tests-and-regressions.md](./tests-and-regressions.md) — 自动测试、人工验收、失败版本和故障注入原则。

### 调研导航

- [source-map.md](./source-map.md) — 当前源码、Tests、Devlog、Prompt、Idea 的模块级对照索引。
- [history/README.md](./history/README.md) — 历史时间线入口。

## 5. 信息来源优先级

### 5.1 当前实现事实

优先读取：

- `app.js`
- `server.js`
- `client/*.js` / `client/*.css`
- `server/*.js`
- `pages/*.html`
- `service-worker.js`
- `vclient/*`
- `scripts/*`
- `tests/*`

源码用于确认“现在真实执行什么”。

### 5.2 需求初衷与演进

重点读取：

- `prompts/dev-prompt-logs/*`
- `docs/devlog/*`
- `prompts/ideas/*`
- Git Log。

Prompt 往往同时包含：原始需求、人工复现、Codex 处理说明、用户下一轮反例。必须按时间判断后者是否覆盖前者。

### 5.3 README / 旧 Overview

`README.md`、`docs/other/PROJECT_OVERVIEW.md` 等可帮助理解早期产品定位，但其版本早于当前基线，不能单独作为当前事实。

## 6. “当前能力”与“计划”的写法

本目录刻意区分：

- **当前源码已有**；
- **历史上有过但已废弃**；
- **Prompt 已提出但尚未进入源码基线**；
- **未来架构设计**。

例如：

- 网盘当前仍是多 JSON 持久化；
- `disk.sqlite` WAL/Adapter 是未来重构设计；
- S3 Compatible API 是未来设计；
- 260925 后协同网盘目录/文件邀请等需求未包含在 `b422e...` 源码基线。

后续更新时，功能真正合入源码后再把它从“计划”移动到“当前实现”。

## 7. 维护原则

1. **保留需求初衷**：不只写按钮，还解释为什么存在。
2. **记录 UI 细节**：稳定 DOM、位置、PC/移动差异、浮层、手势、history。
3. **记录执行链路**：UI → 浏览器状态 → Socket/API → server queue → remote service。
4. **记录数据所有权**：IndexedDB、OPFS、File Handle、Node、`.tunnel-data`、Telegram、VClient。
5. **记录失败路径**：取消、离线、刷新、重启、缓存丢失、远端失败、旧版本。
6. **标明历史方案**：已废弃方案不能和现状混写。
7. **保留高风险回归**：history、Range、SW、P2P、existing Web ZIP update、网盘上传 recovery 等。
8. **避免名字推断**：无法从源码/日志/Prompt 支持的结论标记待核实。
9. **重视人工验收**：下一轮用户实测可推翻上一轮“已修复”。
10. **更新 VERSION**：每次把最新代码合进 `dev/doc-overview` 后，先从旧锚点做增量调研。

## 8. 本轮首轮扫描范围

首轮建立时已经：

- 枚举仓库顶层、`server`、`client`、`pages`、`tests`、`scripts`、`vclient`、`docs`、`prompts`；
- 读取并结构化分析 `app.js`、`server.js` 与主要大型子模块；
- 扫描 HTTP route、Socket event、核心 function/DOM 入口；
- 阅读主要 Devlog，尤其 `dev-2607A`、`dev-2607B`、`dev-2608B`、`dev-2608C`；
- 阅读早期 `prompts-master.md` 和当前 `dev-2609.md`；
- 对照至少数百条 Git ancestor commit，识别稳定点、WRONGCODE、DEBUG、待测与人工验收；
- 枚举测试体系；
- 对未来 SQLite WAL、S3、Light Transfer、Web ZIP 等专门设计资料建立入口。

“首轮完整”表示已经建立全模块导航与主要行为/历史边界，不表示以后无需读源码。本文档体系的目的正是让后续增量更新不再从零开始。
