# 源码、开发日志与 Prompt 对照索引

> 目的：后续 AI 遇到一个功能时，先知道应该读哪些“当前代码”和哪些“历史需求”，而不是全仓库盲搜一个关键词后凭局部结果判断。

## 1. 总入口

### 当前代码事实

- `server.js`：服务端总编排、HTTP、Socket、Telegram/SNS 大量集成。
- `app.js`：功能首页前端总编排，隧道、历史、传输、预览、播放器、协同、设备。
- `pages/index.html`：路由页 + 功能首页 DOM。
- `pages/index.html` + `client/index.css`：首页 DOM、已外置的主要样式和响应式布局；模块专用样式在其它 `client/*.css`。
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
- `server/tunnel-access.js`
- `server/private-key-file.js`
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

- `server.js` 中 `/api/magnets*`，`server/infra-store.js` 持久磁链登记（`magnets`/分享/下载事件）
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
- `server/disk-collaboration.js`
- `server/disk-telegram.js`
- `server/disk-part-cache.js`
- `server/disk-chunk-file-cache.js`

客户端：

- `client/disk-ui.js`
- `client/disk-client.js`
- `client/disk-collaboration.js`
- `client/disk-tunnel-adapter.js`
- `client/disk-share.js`
- `client/disk-management.js`
- `client/telegram-drive-cache.js`
- `pages/disk-collaboration.html`

### 历史资料

`docs/devlog/dev-2608C-features.md`：

- 17：初始网盘；
- 18：Passkey / third-party API；
- 19-22：tasks / multi-select / share / admin / multipart；
- 23-39：pipeline / Range / cache / recovery / UI / JSON 并发。

`docs/devlog/dev-2609-features.md`：

- 52：下载转码复用、网页 ZIP 资源导入、网盘拖放；
- 53：网盘文件/目录协同初版、平板三栏、转码输出后缀、Web ZIP manifest/fullscreen；
- 54：协同邀请预览/确认、窄屏管理入口、网页工坊多级路径；
- 55：网页工坊引用联动、路径边界、顶栏对齐、网盘转发去二次确认。

### 历史设计及当前落地对照

- `prompts/dev-prompt-logs/dev-tgdisk-json2sqlite-WAL-transaction-260915.md`、`QA-of-tgdisk-json2sqliteWAL.md`：当时的 SQLite 设计；当前 Repository 已落地，实际实现以 `server/disk-repository.js` 及迁移工具为准。
- `prompts/ideas/Make full use of Telegram storage 260920.md`、`QA of S3 base on Telegram Storage 260920.md`、`Telegram Drive S3-Compatible API Implementation Guide (260920).md`：历史讨论/规范；当前已有有限 S3 Gateway，支持范围以 `server/s3/*` 及 `docs/telegram-drive-s3-compatible.md` 为准。

**不要再把整个 SQLite WAL 与 S3 Gateway 标为未实现；但历史设计中超出当前代码的能力仍属于计划。**

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

继续阅读 `docs/devlog/dev-2609-features.md` 53-55，覆盖 manifest/fullscreen、目录上下文菜单、多级路径、媒体/JS/CSS/HTML 拖入、move/rename 后 HTML 引用联动等当前行为。

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
- `docs/devlog/dev-2608C-features.md` 16、24、30、32、33、39-41、46-48；`docs/devlog/dev-2609-features.md` 52；
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

## 15. 2026-09—10 新增代码与需求定位

- SQLite / 数据迁移：`server/disk-repository.js`、`tools/migrate-tgdisk-json-to-sqlite.cjs`、`tools/change-tgdisk-channel-id.cjs`；`docs/devlog/dev-2609-features.md` 60—66。
- S3：`server/s3/*`、`server/object-storage.js`、`client/s3-management.js`、`pages/s3-management.html`；权威协议描述 `docs/telegram-drive-s3-compatible.md`；2609 Devlog 66、76、80，2610 Devlog 261006、261008。
- 渐进上传：`server/disk-progressive-upload.js`、`server/growing-file-readable.js`、`server/telegram-upload-scheduler.js`、`server/telegram-upload-progress.js`；`docs/devlog/dev-2610-features.md` 261003。
- 共享 Content：`server/disk-content-repository.js`、`server/disk-content-proof.js`、`server/disk-content-admin.js`、`client/disk-content-hash-worker.js`；权威专项说明 `docs/telegram-drive-content-objects.md`；261004—261006。
- 分区/协同 Mount/文件处理：`server/disk-partitions.js`、`server/disk-collaboration-mounts.js`、`server/disk-mounted-namespace.js`、`server/disk-trash.js`、`server/disk-folder-uploads.js`、`server/disk-pending-saves.js`、`server/disk-account-sessions.js`；对应 `client/disk-mount-ui.js`、`disk-trash-ui.js`、`disk-file-editor.js`、`disk-folder-upload.js`、`disk-pending-save.js`、`disk-copy-picker.js`、`disk-import-picker.js`；261008—261012。
- Telegram Chat 字典：`server/telegram-chat-dictionary.js`、`client/telegram-chat-dictionary.js`、`docs/setup/telegram-chat-dictionary.md`；2609 Devlog 74—75。
- PWA/网页工坊：`app.js`、`service-worker.js`、`client/cache-store.js`、`client/web-workshop.js`、`client/vendor/web-markdown/*`；2609 Devlog 56—59/80、2610 Devlog 261012。
- 安全/部署：`package-lock.json`、`tools/repair-engineio-security.cjs`、`tools/deploy/build.mjs`、`tools/deploy/verify.mjs`；2609 Devlog 2026-10-01。
- 实际缺陷排查参考 `prompts/dev-prompt-logs/dev-2610.md`、261009 系列实施指南、261012 视频处理指南；这些 Prompt 仅提供需求和验证线索，未合入代码的部分不得当现状。

## 16. 2026-10-13—17 业务代码及回归定位

### 独立媒体子系统

- 代码：`server/media-library/index.js`、`service.js`、`database.js`、`cache.js`、`processing.js`、`disk-adapter.js`、`routes.js`、`clip-name.js`；`pages/media-library.html`、`client/media-library.js/.css`。
- 横向资源：`server/media-section-quality.js`、`client/media-task-link.js`、`server/object-storage.js` 的保存进度回调。
- 说明：[media-library.md](./media-library.md)、`docs/media-library.md`、`docs/devlog/dev-2610-features.md` 261013-1 至 261017-2。
- 回归：`tests/media-library.test.cjs`、`media-library-api.test.cjs`、`media-library-ui-261013-2.test.cjs`、`media-processing.test.cjs`、`features-261017-2.test.cjs` 及相关 browser fixture。

### 隧道成员、磁链、后台和下载

- 会话签名：`server/tunnel-access.js`、`server/private-key-file.js`、`app.js` / `server.js`；短码轮换、已登记成员、磁链文件范围见 `tunnel-core.md`、`transfer-cache/magnet-download.md`。
- 后台布局：`server/admin-layout.js`、`pages/admin-layout.html`、`client/admin-layout.js/.css`；设备/磁链拆页使用 `pages/admin-devices.html`、`pages/admin-magnets.html`、`client/admin-records.js/.css`。
- 转发与缓存：`server/telegram-forward-jobs.js`、`server/task-auto-cache.js`、`client/telegram-target-forward.js/.css`、`client/audio-track-repair.js/.css`。
- 网盘上传重名：`client/disk-upload-names.js`；定位/账号/分区：`client/disk-ui.js`、`client/disk-directory-picker.js`。
- 首页样式外置：`client/index.css`、`pages/index.html`、`tools/deploy/build.mjs`、`service-worker.js`。

### 开发日志与需求归属

按 261013-1/2、261014-1/2/3、261015-1/2、261016-1、261017-1/2 顺序阅读 `docs/devlog/dev-2610-features.md`，区分“实际修改/测试”“讨论但未开发”（例如 261014-1 的 Cloudflare R2 缓存讨论）及只有规划图的 `prompts/ideas/streaming-console-QA-261016.md`。**串流控制台多版原型图不是已实现的独立串流子系统。**
