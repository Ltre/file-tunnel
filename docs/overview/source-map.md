# 源码、开发日志与 Prompt 对照索引

> 目的：后续 AI 遇到一个功能时，先知道应该读哪些“当前代码”和哪些“历史需求”，而不是全仓库盲搜一个关键词后凭局部结果判断。

## 1. 总入口

### 当前代码事实

- `server.js`：服务端总编排、HTTP、Socket、Telegram/SNS 大量集成。
- `app.js`：功能首页前端总编排，隧道、历史、传输、预览、播放器、协同、设备。
- `pages/index.html`：路由页 + 功能首页 DOM。
- `pages/index.html` 内联样式 + `client/*.css`：主 UI、模块 UI 与 responsive 样式。
- `service-worker.js`：PWA app shell + Web ZIP Runtime。

### 历史入口

- `prompts/dev-prompt-logs/prompts-master.md`：早期核心需求和架构意图。
- `docs/other/DEVELOPMENT_HISTORY.md`：旧开发历史。
- `docs/other/PROJECT_OVERVIEW.md`：旧整体概览，可能滞后。
- `README.md`：产品说明，但其内容早于本套 Overview 当前源码锚点，只能作为历史/使用概览。

## 2. 隧道、历史、设备与权限

### 当前源码

- `app.js`
- `server.js`
- `server/infra-store.js`
- `client/notification-center.js`

重点搜索：

- `join-session`
- `join-by-short-code`
- `session-history`
- `history-reconcile`
- `session-permissions`
- `session-admins`
- `session-remark`
- `device-remark`
- `device-tunnel-invite`
- `nearby-presence`

### 独立设备页补充

- `pages/device.html`
- `client/device-camera.js`
- [tunnel-core/device-direct.md](./tunnel-core/device-direct.md)

### 历史资料

- `prompts-master.md`：最初 session/history/editor/camera/voice/folder/nearby 等意图；
- `docs/devlog/dev-2607A-features.md`：短码、备注、移动 workspace、权限、附近设备、富文本版本；
- `docs/devlog/dev-2608C-features.md`：server audit、admin、remote preview、notification。

## 3. 文件传输 / P2P / Relay / Cache

### 当前源码

- `app.js`
- `client/file-assets.js`
- `client/cache-store.js`
- `client/cache-store-worker.js`
- `server/file-assets.js`
- `server/infra-store.js`

### 关键 tests

- `tests/p2p-connection-regression.test.cjs`
- `tests/file-asset-audit-isolation.test.cjs`
- `tests/history-startup-regression.test.cjs`

### 历史资料

- `docs/devlog/dev-2607B-features.md`
- `docs/other/P2P_TRANSMISSION_NOTES-260812.md`
- `docs/other/TECH_CHALLENGES_OF_TRANSMISSION*.md`
- `docs/devlog/dev-260713-file-transfer-strategy (based on v1.7.8 only).md`
- `prompts/ideas/multi-server-relay-overview.md`

这些文档中的失败尝试非常重要，尤其 LAN-only、ICE restart、候选改写、多源 completion race。

## 3.1 Magnet / 独立下载器

### 当前源码

- `server.js` 中 `/api/magnets*` 与 registry
- `pages/downloader.html`
- `pages/downloadList.html`
- `app.js` 中 `shareFileMagnet*`

### 详细文档

- [transfer-cache/magnet-download.md](./transfer-cache/magnet-download.md)

### 历史资料

- `docs/devlog/dev-260625-multi-relay*.md`
- `docs/devlog/dev-260628-features.md`

## 4. 文件预览 / 音乐播放器

### 当前源码

主要仍在 `app.js`：

搜索：

- `openFilePreview`
- `mediaFullscreen`
- `musicPlayer`
- `queueOrder`
- `MediaSession`
- `poster`
- `history`

### 历史资料

`docs/devlog/dev-2607A-features.md` 的 2026-07-02 ~ 07-04 大量章节。

Git Log 中 2026-07-02 ~ 07-04 多个 commit 直接记录：

- 未播放音频首次封面；
- 队尾回首；
- queue drawer；
- 队列刷新恢复；
- history。

## 5. 实时摄像头 / Voice / Intercom / Call / Remote preview

### 当前源码

- `client/media.js`
- `server/media-session.js`
- `app.js`

### 历史资料

- `prompts-master.md`：camera / multi-user voice / intercom 原始需求；
- `docs/devlog/dev-2608B-features.md`：设备摄像头；
- `docs/devlog/dev-2608C-features.md` 11-15：全局语音、远程预览、控制面板、剪贴板；
- 16：联系人语音增强。

## 6. Telegram Bot / Content

### 当前源码

- `server.js`
- `server/telegram-content-manager.js`
- `client/telegram-content.js`
- `pages/tgbot.html`
- `pages/telegram-content.html`
- `client/telegram-target-forward.js`

### 历史资料

- `docs/devlog/dev-2607A-features.md`：Bot tunnel mode / remarks / file-id repair；
- `docs/devlog/dev-2608B-features.md`：Telegram 转发/封面/Webhook；
- `docs/devlog/dev-2608C-features.md` 43-48：指定目标、内容管理、Chat 管理；
- `docs/other/TGBOT_LOCAL_API_FAQ.md`：Bot API 特殊环境。

## 7. Telegram Drive

### 当前源码

服务端：

- `server/disk-api.js`
- `server/telegram-drive.js`
- `server/disk-auth.js`
- `server/disk-operations.js`
- `server/disk-shares.js`
- `server/disk-telegram.js`
- `server/disk-part-cache.js`
- `server/disk-chunk-file-cache.js`

客户端：

- `client/disk-ui.js`
- `client/disk-client.js`
- `client/disk-tunnel-adapter.js`
- `client/disk-share.js`
- `client/disk-management.js`
- `client/telegram-drive-cache.js`

### 历史资料

`docs/devlog/dev-2608C-features.md`：

- 17：初始网盘；
- 18：Passkey / third-party API；
- 19-22：tasks / multi-select / share / admin / multipart；
- 23-39：pipeline / Range / cache / recovery / UI / JSON 并发。

### 未来设计

- `prompts/dev-prompt-logs/dev-tgdisk-json2sqlite-WAL-transaction-260915.md`
- `prompts/dev-prompt-logs/QA-of-tgdisk-json2sqliteWAL.md`
- `prompts/ideas/Make full use of Telegram storage 260920.md`
- `prompts/ideas/QA of S3 base on Telegram Storage 260920.md`
- `prompts/ideas/Telegram Drive S3-Compatible API Implementation Guide (260920).md`

这些是计划，不代表当前实现。

## 8. 网页工坊 / Web ZIP

### 当前源码

- `client/web-workshop.js`
- `client/web-zip-runtime.js`
- `service-worker.js`
- `pages/web-zip-preview.html`
- `pages/web-workshop-guide.html`
- `app.js`

### 历史资料

`docs/devlog/dev-2608C-features.md`：

- 40：初版；
- 41：文件树 / 编辑权限 / video transcode；
- 42：虚拟 Runtime；
- 43：发布/缓存；
- 44：Runtime iframe；
- 45：existing ZIP；
- 46：external JS；
- 48-49：外链 JS/SW takeover；
- 50-52：文件名/最小化/资源导入。

### 原始 Idea

- `prompts/ideas/html-zip-exec-260911.md`

## 9. SNS / YouTube Premium / FFmpeg

### 当前源码

- `server/sns-downloader.js`
- `server/youtube-premium.js`
- `server/audio-track-repair.js`
- `server/video-transcode.js`
- 对应 pages/client cache。

### Cookie 自动同步

- `pages/sns-cookies.html`
- `tools/auto-sync-sns-cookies/**`
- [download-transcode/sns-cookie-sync.md](./download-transcode/sns-cookie-sync.md)

### 历史资料

- `docs/devlog/dev-2608B-features.md`：Premium、format、metadata、Telegram；
- `docs/devlog/dev-2608C-features.md` 16、24、30、32、33、39-41、46-48、52；
- `prompts/ideas/ffmpeg-programs-design-260910.md`。

## 10. VClient

### 当前源码

- `vclient/*`
- `server/vclient-control.js`
- `server/infra-store.js`
- `pages/vclient.html`
- `scripts/vclient-push.js`

### 历史资料

`docs/devlog/dev-2608C-features.md` 1-10，尤其：

- 独立缓存节点；
- audit；
- 大量历史导致 homepage 阻塞的失败复盘；
- server shell push。

## 11. PWA / Build / Deploy

### 当前源码

- `service-worker.js`
- `manifest.webmanifest`
- `tools/deploy/*`
- `server/browser-assets.js`
- `/runtime-config.js`

### 历史资料

- `prompts/ideas/PWA-production-overview.md`
- `prompts/dev-prompt-logs/deploy-tools-260709.md`
- `docs/guide/Drop2Tunnel-Deployment-Guide.zh-CN.md`
- `docs/devlog/dev-2608B-features.md` Build 章节。

## 11.1 Localization / i18n

### 当前源码

- `client/i18n.js`
- `client/i18n-catalog.js`
- `client/localization-runtime.js`
- `server/i18n.js`
- `tools/i18n-audit.js`
- `tools/server-i18n-audit.js`

### 详细文档

- [pwa-ui/localization.md](./pwa-ui/localization.md)

## 12. Security

### 当前源码

- `server/admin-auth.js`
- `server/disk-auth.js`
- `server/telegram-oidc.js`
- `server.js` rate limits / validators。

### 历史资料

- `prompts/ideas/security-overview-260629.md`
- `docs/other/security-overview-260629.md`（如果存在同主题历史副本则对照）。

## 13. Light Transfer

### 当前源码

- `client/light-transfer.js`
- server light-transfer routes in `server.js`
- `pages/light-file-parts.html`

### 历史资料

- `prompts/ideas/LIGHT-TRANSFER-overview-260813.md`
- `docs/devlog/dev-2608B-features.md` 4-10。

详细实现已经独立整理到 [light-transfer.md](./light-transfer.md)。

## 14. 测试与验收来源

不要只读 `tests`。

每一批需求的“最终是否真的可用”可能分散在：

1. Prompt 用户复测；
2. Devlog 验证记录；
3. Git commit 标题；
4. test file。

例如 Web ZIP 的外链 JS，自动测试第一次认为修好后，用户又发现 HTML parser 问题，直到后续 Runtime 修复才真正收敛。
