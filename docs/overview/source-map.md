# 源码、开发日志与 Prompt 对照索引

> **源码基线 Commit**：`4502065e4a4a1415d9b7c1a9f7a314f4167ff0cd`  
> **文档更新时间**：`2026-11-21`

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

按 261013-1/2、261014-1/2/3、261015-1/2、261016-1、261017-1/2 顺序阅读 `docs/devlog/dev-2610-features.md`，区分“实际修改/测试”和“讨论但未开发”（例如 261014-1 的 Cloudflare R2 缓存讨论）。`prompts/ideas/streaming-console-QA-261016.md` 与多版 UI 原型是早期规划材料，本身不能证明功能已经交付；但串流控制台核心后来已在当前分支合入，实际实现入口见第 18 节及 [streaming-console.md](./streaming-console.md)。

## 17. 2026-10-17—19 最新已合入变化的路径索引

| 需求/行为 | 当前源码 | 实际回归与开发日志 |
|---|---|---|
| 旧成员旧码证明、二维码凭据 `j1.`、重新加入身份 | `server/tunnel-access.js`、`server.js`、`app.js` | `features-261017-3/4`、`features-261018-1`、`features-261019-1` |
| 媒体候选截图/Clip 删除、压缩缓存归属、真实尾帧和密集工作片段复用 | `server/media-library/service.js`、`cache.js`、`processing.js`、`client/media-library.js/.css` | `features-261017-3/4`、`media-library-ui-261013-2` |
| 按会话收藏到 `clips/shots`，稳定重试目录 | `server/media-library/service.js`、`disk-adapter.js`、`database.js` | `features-261018-1` |
| 网盘分区显示名、预览最小化/底栏恢复 | `server/disk-api.js`、`client/disk-management.js`、`client/disk-ui.js/.css` | `features-261017-3/4`、`disk-preview-history` |
| 浏览器渐进上传发起端心跳与 5 分钟失联 | `client/disk-client.js`、`server/disk-api.js`、`server/disk-operations.js` | `features-261017-4`、`disk-progressive-api/client` |
| 传输记录复制文本/文件名、DropZone 单行、输入框 1—4 行 | `app.js`、`pages/index.html`、`client/index.css`、`client/i18n.js` / `i18n-catalog.js` | `features-261017-3/4`、`features-261018-1`、`features-261019-1` |
| YouTube 自定义手写格式、服务器本地限流来源和任务创建反馈 | `pages/youtube-premium-dl.html`、`server/youtube-premium.js`、`server.js` | `features-261019-1` |
| SNS/YouTube 成品**服务端直传**、旧待办迁移与目标幂等 | `server/download-task-source.js`（本轮唯一新增 server 源文件）、`server/disk-api.js`、`server/disk-pending-saves.js`、`client/disk-pending-save.js`、`client/disk-ui.js`、两类抓取页 | `features-261019-2.test.cjs`、`features-261019-2-client.test.cjs` |

以上回归文件均位于 `tests/`，完整开发记录在 `docs/devlog/dev-2610-features.md` 261017-3 至 261019-2。仓库根目录新增 `AGENTS.md`，属于协作约定而非新增业务端点。

**范围界限**：`prompts/ideas/streaming-console-phase1-guide-261019.md`、`streaming-console-phase2-guide-261019.md`、`streaming-console-QA-261016.md` 及相应 UI 原型是原始规划/验收材料；串流控制台核心已在后续当前分支代码中实现，见第 18 节与 [streaming-console.md](./streaming-console.md)。这些材料超出当前 `server/streaming-*.js`、`client/streaming-*.js` 的构想仍属于计划，不能反向扩大已交付范围。

## 18. 2026-10-20—11-06 当前源码新增导航

| 已合入能力 | 最新代码入口 | 主要证据 |
|---|---|---|
| 串流节目身份、播放时钟、邀请、订阅、封面 | `server/streaming-console.js`、`streaming-http.js`、`streaming-covers.js`、`client/streaming-console.js/.css`、`streaming-player.js` | [streaming-console.md](./streaming-console.md)、`tests/streaming-console*.test.cjs`、`docs/devlog/dev-2610-streaming-console.md` |
| 串流网盘/隧道/本机媒体与 Range | `server/streaming-sources.js`、`streaming-disk.js`、`streaming-tunnels.js`、`streaming-peers.js`、`streaming-buffer.js`；`client/streaming-peers.js`、`streaming-cache.js`、`streaming-app-adapter.js` | `tests/streaming-*.test.cjs`、`streaming-*.browser.cjs` |
| 系统数据 FULL/CORE 备份 | `server/data-backup.js`、`client/data-backup.js/.css`、`data-backup-i18n.js`、`pages/system-backup.html` | [system-backup.md](./system-backup.md)、`tests/data-backup-261027*.test.cjs` |
| UI 主题、路由/宽屏与公共扫码 | `client/themes.css`、`themes-legacy.css`、`themes-blamen.css`、`themes-lusns.css`、`theme-preference.js`、`tunnel-entry.js/.css`、`tunnel-landing.css`、`tunnel-code-scanner.js`、`pages/tunnel-entry.html` | [pwa-ui/themes.md](./pwa-ui/themes.md)、`docs/devlog/dev-2610-UI261026.md`、`tests/theme*.browser.cjs` |
| 管理员隧道/设备权限与日志 | `server/tunnel-permissions.js`、`process-diagnostics.js`、`request-rate-limit.js`、`client/admin-overview.js/.css`、`admin-tunnel-permissions.js`、`browser-logs.js/.css`、`pages/admin-tunnels.html`、`admin-tunnel-permissions.html` | [admin-security-deployment.md](./admin-security-deployment.md)、`tests/tunnel-permissions-261103.test.cjs` |
| 隧道 Markdown 版本与 SNS 图文 | `server/markdown-records.js`、`sns-post-markdown.js`、`twitter-post-media.js`、`twitter-post-browser.js`；`client/tunnel-markdown.js`、`sns-post-markdown.js`、`sns-post-i18n.js` | [transfer-cache.md](./transfer-cache.md)、[download-transcode.md](./download-transcode.md) |
| 网盘保存位置/幂等回执 | `server/disk-task-save-receipts.js`、`client/disk-saved-location.js/.css`、`disk-pending-save.js`、`server/disk-pending-saves.js` | [telegram-drive.md](./telegram-drive.md) |
| 网页创建者编辑凭据与延后同步 | `server/web-zip-credentials.js`、`web-zip-sync.js`、`client/web-workshop.js` | [web-workshop.md](./web-workshop.md)、`tests/web-zip-*-261106-*.test.cjs` |
| SNS 下载草稿与文件名 | `client/download-form-tabs.js/.css`、`server/download-file-name.js`、`pages/sns-dl.html`、`youtube-premium-dl.html` | [download-transcode.md](./download-transcode.md) |

补充资料：`docs/devlog/dev-2610-streaming-console.md`、`docs/devlog/dev-2610-UI261026.md`、`docs/devlog/dev-2611.md`；2026-10-27 的禁止 TLS 方案、部分外部产品计划和用户尚未执行的后续事项仍不得从 Prompt 当作已合入实现。**不读取其它分支来替换此分支的代码事实。**

## 19. 2026-11-07—10 当前源码新增导航

| 已合入能力 | 当前代码入口 | 主要证据 |
|---|---|---|
| 管理员下载表单云端快照 | `server/admin-form-cache.js`、`server.js`、`client/download-form-tabs.js`、`pages/sns-dl.html`、`pages/youtube-premium-dl.html` | [admin-security-deployment.md](./admin-security-deployment.md)、[download-transcode.md](./download-transcode.md)、`tests/admin-form-cache-261109.*` |
| 16 语言启动包和按需语言 | `client/i18n-catalog.js`、`i18n-bootstrap.js`、`client/i18n/*.json`、`client/i18n.js`、`tools/build-i18n-packs.cjs`、`tools/frontend-i18n-audit.js` | [pwa-ui/localization.md](./pwa-ui/localization.md)、`tests/i18n-*.{test,browser}.cjs`、`tests/sw-language-update-261109.browser.cjs` |
| P2P attempt 放弃协议（历史阶段，已在 11-16 撤回）、信令独立限流和 Relay 诊断 | `client/file-assets.js`、`server/file-assets.js`、`server.js` | [transfer-cache.md](./transfer-cache.md)、`tests/p2p-connection-regression.test.cjs`、`p2p-live-261108.browser.cjs`、`relay-diagnostics-261109.test.cjs` |
| 批量转发逐条结果和持久确认 | `app.js`、`server.js` | `tests/bulk-forward-261108.test.cjs`、`forward-confirmation-261108.test.cjs`、`forward-results-261108.browser.cjs`、`persisted-forward-261108.test.cjs` |
| 资源盘点与缓存清理安全 | `app.js`、`client/file-assets.js` | `tests/cache-safety-261107.test.cjs`、`diagnostics/memory-inventory-261107.browser.cjs` |
| 网盘分区默认名、待转存预检和进度流上限 | `server/disk-partitions.js`、`client/disk-ui.js`、`client/disk-pending-save.js`、`client/disk-client.js` | [telegram-drive.md](./telegram-drive.md)、`tests/pending-save-preflight-261108.browser.cjs`、`disk-partitions.test.cjs`、`disk-client.test.cjs` |
| 备份完成前远端分段复核 | `server/data-backup.js`、`client/data-backup.js` | [system-backup.md](./system-backup.md)、`tests/backup-261107.test.cjs` |
| 网页 ZIP 来源证明/离线源访问 | `server/web-zip-credentials.js`、`web-zip-sync.js`、`server.js` | [web-workshop.md](./web-workshop.md)、`tests/web-zip-*-26110*.test.cjs` |
| FFmpeg 时间戳进度、磁链 Relay ACK | `server/video-transcode.js`、`pages/video-transcode.html`、`pages/downloader.html` | [download-transcode.md](./download-transcode.md)、[magnet-download.md](./transfer-cache/magnet-download.md)、`tests/transcode-progress-261108.test.cjs`、`magnet-download-261108.browser.cjs` |
| 控制中心通知/账号入口、IME 输入和 Telegram OIDC 返回页 | `app.js`、`client/notification-center.js`、`client/tunnel-entry.js`、`server.js` | [pwa-ui.md](./pwa-ui.md)、`tests/control-center-261107.browser.cjs`、`telegram-app-return-261109.browser.cjs` |

上述路径均来自当前分支的实际文件变更；Prompt/Devlog 可解释动机与验收边界，但不能替代这些代码入口。


## 20. 2026-11-11—19 当前源码新增导航

| 已合入能力/行为 | 当前代码入口 | 主要证据 |
|---|---|---|
| 上游服务出口与 Trojan/sing-box | `server/upstream-exits.js`、`server/upstream-exit-routes.js`、`client/upstream-exits.js/.css`、`client/upstream-exit-select.js`、`pages/upstream-exits.html`、`tools/sing-box/**` | [upstream-exits.md](./upstream-exits.md)、[admin-security-deployment.md](./admin-security-deployment.md)、`tests/upstream-*.cjs`、[用户手册第 29 章](../guide/Drop2Tunnel-User-Manual.zh-CN.md) |
| SNS/YouTube 任务出口和候选锁定 | `server.js`、`server/sns-downloader.js`、`server/youtube-premium.js`、`pages/sns-dl.html`、`pages/youtube-premium-dl.html` | [download-transcode.md](./download-transcode.md)、`tests/upstream-cache-261114.test.cjs`、`upstream-candidates-261119.test.cjs` |
| Telegram 远程操作出口适配 | `server.js`、`server/disk-telegram.js`、`server/upstream-exits.js` | [telegram-drive.md](./telegram-drive.md)、`tests/disk-admin-download-261118.test.cjs` |
| P2P attempt 放弃撤回、传输基线恢复和实际线路诊断 | `client/file-assets.js`、`server/file-assets.js`、`app.js` | [transfer-cache.md](./transfer-cache.md)、`tests/transfer-baseline-261116.test.cjs`、`file-route-diagnostics-261111.test.cjs`、`multi-source-route-261119.test.cjs` |
| 文件缓存元数据写入保护与无锚点精确回源 | `app.js`、`server.js` | `tests/cache-metadata-261111.browser.cjs`、`forwarded-server-assets-261117.test.cjs` |
| Web ZIP 同源转发副本统一同步 | `server/web-zip-sync.js`、`server.js` | [web-workshop.md](./web-workshop.md)、`tests/web-zip-copies-261117.test.cjs`、`web-zip-records-261118.browser.cjs` |
| 下载兜底、参考语言和任务列表加载 | `server/youtube-reference-language.js`、`server/download-file-name.js`、`server/sns-post-markdown.js`、`client/task-list-loading.js/.css` | [download-transcode.md](./download-transcode.md)、`tests/sns-bilibili-261117.test.cjs`、`sns-media-route-261117.browser.cjs` |
| 控制中心触摸拖动、Markdown 移动端 Back | `app.js`、`client/tunnel-markdown.js` | [pwa-ui.md](./pwa-ui.md)、`tests/control-center-drag-261118.browser.cjs`、`markdown-navigation-261116.browser.cjs` |
| 德语包与草稿多语言 | `client/i18n/de.json`、`client/i18n-catalog.js`、`client/i18n-bootstrap.js`、`server/i18n.js` | [pwa-ui/localization.md](./pwa-ui/localization.md)、`tests/requirements-261119.browser.cjs` |

以上仅索引本轮已合入的当前分支文件；历史 Prompt/Devlog 中的其它分支状态不作为本轮事实来源。


### 本轮新增的需求、QA 与验收资料（不是独立实现入口）

- 上游出口需求演进：`prompts/ideas/upstream-select-proxy-261113-v1.md` 至 `v5.md`、`prompts/ideas/QA-before-upstream-select-proxy-261113.txt`。对照当前行为时以 [upstream-exits.md](./upstream-exits.md) 和实际源码为准。
- Cloudflare TURN 研究：`prompts/ideas/CloudflareTURN-261119.md`、`prompts/ideas/[QA]CloudflareTURN-261119.txt`。它们是方案与 QA 材料，不代表本轮已经接入 Cloudflare TURN。
- Web ZIP / S3 静态链接安全：`prompts/ideas/Security of webzip and S3 static links 261118.md`、`prompts/ideas/[QA]Security of webzip and S3 static links 261118.txt`。需求建议与已实现代码须逐项区分。
- 隧道传输验收基线：`docs/other/[尚未决定采用] 隧道传输链路核心验收基线 v1.0.md`、`v1.1.md` 明确尚未决定采用，不可作为当前协议的规范性依据。
- 版本对照与故障证据：`docs/devlog/version-compare-261116_1754-0de94882c998bd6d1556e80954fa3840835e0746.md`、`version-compare-261118_0555-0de94882c998bd6d1556e80954fa3840835e0746.md` 及对应 QA 文本；用于解释历史版本差异、失败证据与修复边界，最终行为仍由当前源码决定。



## 21. 2026-11-20—21 当前分支新增导航

| 已合入能力/行为 | 当前代码入口 | 主要证据/文档 |
|---|---|---|
| Trojan 节点八种格式互转、批量导入/导出和批量连通性检查 | `server/trojan-node-formats.js`、`server/upstream-exits.js`、`server/upstream-exit-routes.js`、`client/upstream-exits.js/.css`、`pages/upstream-exits.html` | [upstream-exits.md](./upstream-exits.md)、用户手册第 29.4 节、`tests/trojan-formats-261120.test.cjs`、`tests/requirements-261120.browser.cjs` |
| 浏览器日志滚动保留、错误优先和配额回收 | `client/browser-logs.js`、`client/i18n-catalog.js`、`client/i18n-bootstrap.js`、`client/i18n/*.json` | [admin-security-deployment.md](./admin-security-deployment.md)、[localization.md](./pwa-ui/localization.md)、`tests/browser-logs-rolling-261120.browser.cjs` |
| 跨隧道来源授权生命周期、目标隧道精确副本恢复和拒绝诊断 | `server.js`、`app.js`、`client/browser-logs.js` | [transfer-cache.md](./transfer-cache.md)、[tunnel-core.md](./tunnel-core.md)、`tests/forwarded-server-assets-261117.test.cjs`、`tests/source-access-feedback-261120.test.cjs`、`tests/source-access-diagnostic-261120.browser.cjs` |
| DataChannel 已排队字节排空期间的发送进度 | `client/file-assets.js` | [transfer-cache.md](./transfer-cache.md)、`tests/whole-file-progress-261116.test.cjs`、`tests/transfer-baseline-261116.test.cjs` |
| 已授权成员退出重入、短码猜测限流和强制刷新可用性 | `server.js`、`app.js`、`client/tunnel-entry.js` | [tunnel-core.md](./tunnel-core.md)、[admin-security-deployment.md](./admin-security-deployment.md)、`tests/tunnel-rejoin-rate-limit-261121.test.cjs`、`tests/tunnel-rejoin-rate-limit-261121.browser.cjs` |
| 网盘目录选择目标高亮（仅 CSS） | `client/disk-directory-picker.css` | [telegram-drive.md](./telegram-drive.md)、`prompts/resources/BUG-261120/disk-tree-selector-toggle-bug.jpg`、`tests/requirements-261120.browser.cjs` |
| 发布缓存版本及日志策略多语言 | `service-worker.js`、`client/i18n-catalog.js`、`client/i18n-bootstrap.js`、`client/i18n/*.json`、`package.json`、`package-lock.json` | [pwa-ui.md](./pwa-ui.md)、[localization.md](./pwa-ui/localization.md)、`docs/devlog/dev-2611.md` |

本轮证据文档：`docs/devlog/dev-2611.md`（261120、261120-3、261121）、`prompts/dev-prompt-logs/dev-2611.md`、`docs/guide/Drop2Tunnel-User-Manual.zh-CN.md` 第 29.4 节。Prompt/Devlog 用于解释需求与验证边界；当前行为仍以本分支源码为准。
