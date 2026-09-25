# Drop2Tunnel 功能与需求总览

> 本目录用于给后续开发者和 AI 提供“可追溯的项目事实”。它不仅描述现在有什么功能，还应说明这些功能为什么存在、经历过哪些调整、当前代码如何实现，以及哪些历史方案已经被替代。

## 1. 文档基线

当前总览体系首次建立于 `dev/doc-overview`，初始扫描基于：

- 源码分支：`dev/2609-s1`
- 源码 Commit：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`
- 日期：2026-09-26

精确更新锚点见 [VERSION.md](./VERSION.md)。

## 2. 产品总定位

Drop2Tunnel 是一个自托管、浏览器优先的跨设备“隧道”协作与传输系统。

项目已经从最初的网页端即时传输工具逐步扩展为多个相互关联的子系统：

- 隧道路由、设备发现和多设备状态同步；
- 文本、富文本、文件、合辑和文件夹传输；
- 浏览器 IndexedDB 文件缓存、File System Access 外部句柄、P2P/Relay/Telegram 多来源恢复；
- 多媒体预览、音乐播放器、远程预览与实时音视频；
- Telegram Bot 中转、Telegram 内容管理和 Telegram 虚拟网盘；
- Passkey / Telegram 身份、第三方网盘 API、分享和后台审核；
- SNS 下载、YouTube Premium 下载、音轨修复和 FFmpeg 视频转码；
- 网页 ZIP / 网页工坊；
- VClient 缓存节点与服务器 Shell 推送；
- PWA、Service Worker、移动端三栏交互；
- 管理后台、TOTP、部署工具和运行数据管理。

因此，后续修改任何一个子系统时，都不能只看单个 UI 文件；大量功能通过 `app.js`、`server.js`、`client/*`、`server/*`、Service Worker、IndexedDB 和 Socket.IO 相互耦合。

## 3. 文档导航

本目录按“一级模块 → 必要时继续拆分子模块”的方式维护。

### 核心架构与隧道

- [architecture.md](./architecture.md) — 运行架构、数据边界、前后端职责、长期演进约束。
- [tunnel-core.md](./tunnel-core.md) — 隧道、短码、设备、历史同步、权限、路由、联系人/附近设备。

### 文件传输、缓存与媒体

- [transfer-cache.md](./transfer-cache.md) — 传输记录、文件资产、P2P、Socket.IO Relay、多源恢复、浏览器缓存、文件句柄、备份/导入。
- [media-player-realtime.md](./media-player-realtime.md) — 预览、音乐播放器、远程打开、摄像头、语音、对讲机。

### Telegram

- [telegram-bot-content.md](./telegram-bot-content.md) — Telegram Bot、中转模式、Webhook、内容管理、Chat 管理。
- [telegram-drive.md](./telegram-drive.md) — Telegram 虚拟网盘、身份、目录/文件操作、分片、缓存、分享、审核与第三方接入边界。

### 内容生产与下载处理

- [web-workshop.md](./web-workshop.md) — 网页工坊、`.html.zip`、Runtime、草稿、发布、编辑权限与隧道资源导入。
- [download-transcode.md](./download-transcode.md) — SNS 下载、YouTube Premium、Telegram 转发、音轨修复、视频转码。

### 平台与运维

- [pwa-ui.md](./pwa-ui.md) — PWA、Service Worker、主题、响应式三栏、移动控制中心、全局 UI 状态。
- [admin-security-deployment.md](./admin-security-deployment.md) — 管理后台、TOTP、敏感配置、数据占用、部署/构建。
- [vclient.md](./vclient.md) — VClient 缓存节点、控制面、服务器文件推送。
- [tests-and-regressions.md](./tests-and-regressions.md) — 测试体系、重要回归链路、人工验收的使用方式。

> 初始整理会按模块逐步补齐。任何模块文档如果尚未生成，不代表功能不存在，应继续结合源码、Git Log、`docs/devlog` 与 `prompts` 调研。

## 4. 信息来源优先级

### 4.1 当前实现事实

优先读取：

- `app.js`
- `server.js`
- `client/*.js`、`client/*.css`
- `server/*.js`
- `pages/*.html`
- `service-worker.js`
- `vclient/*`
- `scripts/*`
- `tests/*`

源码用于确认“现在真实执行什么”。

### 4.2 需求初衷与演进

重点读取：

- `prompts/dev-prompt-logs/*`
- `docs/devlog/*`
- `prompts/ideas/*`
- Git Commit message

Prompt 中经常同时包含：原始需求、人工测试复现、Codex 的处理说明、用户再次验收后的反例。整理时必须按时间顺序判断后来的结论是否覆盖前面的结论。

### 4.3 README 与旧 Overview

`README.md`、`docs/other/PROJECT_OVERVIEW.md` 等是很好的整体索引，但可能滞后于当前开发分支，不能单独作为最终事实来源。

## 5. 维护原则

1. **保留需求初衷。** 不只写“有某个按钮”，还要说明按钮解决什么问题。
2. **记录 UI 细节。** 对稳定且被明确要求的 DOM、位置、移动端/PC 差异、浮层层级、点击/长按/手势语义，应写入对应模块。
3. **记录执行链路。** 例如“点击发布”应追踪到本地缓存、Socket、服务端任务、远端 Telegram 或 FFmpeg 的完整链路。
4. **记录数据所有权。** 明确哪些数据在浏览器 IndexedDB、Node 内存、`.tunnel-data`、Telegram、VClient。
5. **记录失败路径。** 包括超时、取消、离线、刷新、重启、缓存丢失、远端删除等。
6. **标明历史方案。** 已废弃方案不能和现状混写。
7. **对高风险历史回归留痕。** 例如 history/popstate、Range 播放、Service Worker Runtime、跨设备缓存恢复等，后续改动应先读对应回归记录。
8. **避免凭名字推断。** 如果源码和日志不能支持某项行为，就标为待核实。
