# 管理后台、安全边界与部署

> **源码基线 Commit**：`10ebe1000b9bd57097f90e51337a251ba17734f3`  
> **文档更新时间**：`2026-10-17`

## 1. 管理后台定位

管理后台不是普通隧道成员 UI，而是服务器运营/诊断入口。

主要页面：

- `/admin`
- `/admin-auth`
- `/data-usage`
- `/disk-management`
- `/telegram-content`
- `/tgbot`
- `/sns-cookies`
- `/sns-dl`
- `/youtube-premium-dl`
- `/video-transcode`
- `/vclient`

`pages/admin.html` 当前至少聚合：

- Telegram Bot 配置；
- SNS cookies；
- SNS 下载；
- YouTube Premium；
- 视频转码；
- Telegram 网盘用户/内容审核；
- `.tunnel-data` 空间；
- Telegram Bot 内容管理；
- 隧道列表；
- VClient 状态；
- magnet 等运维入口。

## 2. 管理员认证

实现：

`server/admin-auth.js`

### 2.1 TOTP

首次 setup：

- 生成 Base32 secret；
- 生成 `otpauth://totp/...` URI；
- pending secret 约 10 分钟；
- 用户输入验证码确认；
- 成功后才持久化。

算法：

- HMAC-SHA1；
- 6 digits；
- 30 秒周期；
- 验证允许有限 drift。

历史需求允许配置 issuer / account 备注，便于 Google Authenticator / 其它 Authenticator 区分服务器。

### 2.2 Secret at rest

持久 marker：

`.tunnel-data/.gauth-admin.json`

当前不是把 TOTP secret 明文直接存配置，而是使用 session/signing key 派生/加密相关材料。

管理 session key：

`.tunnel-data/.admin-session.key`

这些文件属于敏感配置：

- 不入 Git；
- 权限应收紧；
- 备份时要一起考虑，否则恢复后管理员登录可能失效。

### 2.3 Admin session

Cookie：

`tunnel_admin_session`

默认 TTL：

30 天。升级前已签发的会话仍按原到期时间失效，重新登录后使用新的有效期。

API 未认证返回 401 JSON；页面未认证跳转到：

`/admin-auth?next=...`

后续新增后台 API 应统一使用 `adminAuth.requireAuth`，不能只因为“页面本身要登录”就让 API 裸奔。

## 3. 后台隧道列表

后台读取：

- 服务器持久审计；
- 浏览器本地历史（admin 页面也可能有 IndexedDB/localStorage）；

再合并呈现。

能力包括：

- session ID / short code / remark；
- 设备数量、历史等统计；
- 进入隧道；
- 复制链接；
- 删除；
- VClient toggle。

历史需求明确后台要显示隧道备注，而不是只显示短码/UUID。

## 4. `.tunnel-data` 空间占用

页面：

`/data-usage`

服务端：

`server/data-usage.js`

用途：

- 浏览 `.tunnel-data` 目录树；
- 查看文件/目录 size；
- 帮助发现下载缓存、网盘分片缓存、转码输出等磁盘膨胀。

此页是观察工具，不应把所有大文件都当垃圾。

### 4.1 网盘分片缓存专区

后来在该页增加：

- user；
- disk space；
- scope；
- part cache overview；
- clear。

清理调用网盘 admin API，应尊重正在读取/inflight 缓存。

## 5. 网盘后台

`/disk-management`

主要：

- users/apps/spaces tree；
- storage overview；
- storage contents；
- review；
- preview；
- part cache。

详见 [telegram-drive.md](./telegram-drive.md)。

## 6. Telegram 内容后台

`/telegram-content`

需要同时考虑：

- Telegram webhook updates；
- 本地 archive；
- storage chat filter；
- 管理权限；
- Bot 最大可授予权限。

详见 [telegram-bot-content.md](./telegram-bot-content.md)。

## 7. 下载/转码后台资源控制

服务器下载和转码会消耗：

- CPU；
- 网络；
- 磁盘；
- FFmpeg process；
- yt-dlp process。

因此多个“按钮显示条件”实际上是服务器保护：

- 完整长视频不显示音轨修正版；
- music-only 不显示音轨修正版；
- transcode 使用显式任务 queue；
- cache 可清理；
- task 可 cancel；
- 来源 task 只允许服务器验证过的 file path。

不能为了 UI 方便把任意 path/command 从浏览器直接传给 FFmpeg。

## 8. 外部依赖

项目依赖：

- ffmpeg；
- ffprobe；
- yt-dlp；
- 可选 Node/native/browser API；
- Telegram Bot API；
- WebRTC ICE；
- Cloudflare/Nginx 等部署层。

历史上专门增加 external dependency audit，因为以下问题都曾表现得像业务 Bug：

- yt-dlp JS challenge；
- ffmpeg path；
- cookies；
- Telegram network；
- ICE；
- proxy。

服务端错误日志要给出 dependency / stage，但必须 redact：

- Bot token；
- cookies；
- app secret；
- Authorization；
- webhook secret。

## 9. 代理环境

开发脚本当前可设置：

- `DR2T_PROXY`
- `DR2T_ALL_PROXY`
- yt-dlp invocation。

项目历史环境中代理/VPN 经常存在，所以：

- Node outbound HTTP；
- yt-dlp；
- WebRTC；

可能有不同代理语义。

“网站能打开”不能推出“WebRTC P2P 能通”。

## 10. Nginx / Cloudflare

早期开发曾考虑：

- HTTP 与 Socket.IO 不同域名；
- 端口 3333；
- Node 直接 80/443。

后来收敛：

- 生产前由 Nginx 占 80/443；
- Node 监听内部端口（历史常用 3000）；
- Nginx reverse proxy；
- Socket.IO 可与 HTTP 共用域名/443；
- Cloudflare 可以代理 WebSocket。

最终部署参数仍以当前 deployment guide /环境配置为准，不要把早期 Prompt 的 3333 方案重新写回代码。

## 11. 动态 Runtime Config

页面通过：

`/runtime-config.js`

获取运行时服务器信息。

这样前端构建产物不需要把 production hostname 写死。

`buildSocketServerUrl()` 会结合当前页面地址和 runtime config 选择 Socket URL。

## 12. 部署构建工具

目录：

`tools/deploy/`

主要：

- `build.mjs`
- `verify.mjs`
- profile/template 等。

build 做：

- reset output；
- copy static；
- JS minify/bundle；
- CSS minify；
- HTML minify；
- script asset hash/name；
- page references rewrite；
- generated config；
- service worker build；
- manifest。

verify 做：

- manifest/files existence；
- HTML refs；
- static references；
- JavaScript syntax 等。

因此生产部署不要只 `cp app.js`，否则可能绕过 hashed assets / SW 配套逻辑。

## 13. Service Worker 部署

部署特别要保证：

- SW URL 不被长缓存；
- 新 app shell 资源真实存在；
- precache 引用不 404；
- CDN 不覆盖 no-store；
- runtime-config 不过期。

历史上“代码已经改好但生产仍复现”多次最终是 cache/version 混跑。

## 14. Windows 与 Linux

项目长期同时在 Windows 开发和 Linux 服务器运行。

高风险差异：

- path separator；
- rename/open handle；
- EXDEV；
- executable path；
- `py -m yt_dlp` vs `python3 -m yt_dlp`；
- ffmpeg discovery；
- native module 安装；
- file mode。

代码中对 hard link/rename 等已有 fallback，重构时不要假设 POSIX 唯一环境。

## 15. 文件权限和 Secret

至少这些数据是敏感的：

- TOTP secret；
- admin session key；
- disk-secret.key；
- Telegram Bot Token；
- SNS/YouTube cookies；
- third-party app secret/token；
- VClient control token。

原则：

- 不返回给无关浏览器；
- 不写普通 debug log；
- 不跟随 repo commit；
- backup 需要安全存储；
- 删除/rotation 要考虑现有加密数据。

## 16. 请求与输入安全

### 16.1 File path

服务器来自客户端的 filename/path 必须 clean/normalize，防：

- `../` traversal；
- absolute path；
- control chars；
- overwrite arbitrary files。

### 16.2 Shell

转码/yt-dlp 参数不能允许客户端提交完整 shell。

`video-transcode` 使用 schema/token interpolation + `shell:false`。

### 16.3 URL

SNS URL、Telegram target、callback origin、OIDC origin 都需要专门 normalize/allowlist，不能只检查“字符串以 http 开头”。

## 17. Rate limit / Abuse

公开部署场景应关注：

- App auth token；
- passkey options；
- login；
- SNS parse；
- Telegram；
- file upload；
- short code brute force。

当前部分路由已经有 express-rate-limit 或内部 throttle；后续 public commercialization 不能把测试环境宽松设置直接上线。

## 18. 数据备份

项目数据不是一个文件：

- infra.sqlite；
- 网盘 JSON；
- secrets；
- SNS/YouTube tasks/caches；
- VClient data（可能另主机）；
- browser IndexedDB 不在服务器备份里；
- Telegram remote 不在本机。

未来网盘迁 WAL 后，不能运行时只复制 `disk.sqlite` 主文件；应使用 SQLite backup/checkpoint 能力。

## 19. 运维诊断原则

当出现“功能失败”时按层排：

1. UI 是否旧版本；
2. Service Worker / CDN cache；
3. API status；
4. Node logs；
5. external dependency；
6. proxy/DNS；
7. remote provider；
8. local browser storage。

不要看到一个最终 toast 就直接改业务逻辑。

## 20. 文档入口

- `docs/guide/Drop2Tunnel-Deployment-Guide.zh-CN.md`
- `docs/guide/Drop2Tunnel-User-Manual.zh-CN.md`
- `docs/other/TECH_CHALLENGES_OF_TRANSMISSION*.md`
- `prompts/ideas/security-overview-260629.md`
- `prompts/dev-prompt-logs/deploy-tools-260709.md`

旧文档可能滞后，执行部署前仍要对照当前 `tools/deploy`。

## 21. 新运行基线、网盘管理、安全与运维工具

当前 `package.json` 要求 **Node >=24.15**，因为网盘 SQLite 使用 Node 内置 `node:sqlite`，不是靠更老 Node 的 `sql.js` 自动兼容。部署时须核对实际执行服务进程的 Node 版本，而非只看 CLI 的另一个 Node 安装。

网盘用户数据在 `disk.sqlite` WAL；S3 Access Key 的 AES-256-GCM 密文/密钥分别在 `s3-credentials.json`、`s3-secret.key`；Chat 字典单独 JSON；上传 staging 和媒体缓存仍是物理目录。在线备份应采用 SQLite 的在线备份，迁移前确认所有实例停服和密钥保存。

独立 S3 API 凭据管理页 `/s3-management` 与 `/api/admin/s3-credentials` 受管理员 Session 保护，写入校验 Origin/Fetch Metadata；Secret 仅在创建/轮换时展示。后台 Content Object 提供安全的内容引用/清理诊断和文件/目录搜索；上传哈希查找只能定位已验证 Content，不能把同名当作相同正文。

2026-10-01 锁文件将 Engine.IO 升至修补后的 **6.6.11**；`npm ci` 审计及相关协议升级测试在对应开发记录中通过。新增 `tools/repair-engineio-security.cjs`，默认只读检查旧部署；正式修补要求显式停服务、`--apply --service-stopped` 和目标端口，先在隔离环境验证、备份后定向替换，失败自动回滚并支持手动恢复。工具**不会**自行停启生产服务，必须重启所有 Node 进程使补丁生效；使用说明见 `tools/repair-engineio-security.md`。

网盘故障诊断由 `tools/collect-tgdisk-diagnostics.cjs` 收集现有轮转日志与 SQLite 任务状态，支持按时间/任务过滤，导出前脱敏；目录请求还提供 `Server-Timing` 和 `X-Disk-Request-Id`。发布构建已补齐新增网盘模块/Markdown 依赖/Worker 等资源并强化 verify，生产发布仍须以当前构建产物实际验证，不把历史一次通过当作以后每次构建必然通过。

## 22. 2026-10-13—15：后台工作台、独立磁链页与认证私钥安全

- 后台增加独立布局 `/admin` → 内部 `/admin/home`，以及 `/admin/devices`、`/admin/magnets`；`pages/admin-layout.html`、`client/admin-layout.js/.css` 负责白名单导航与 iframe，`pages/admin-devices.html`、`pages/admin-magnets.html` 由 `client/admin-records.js/.css` 呈现。服务端注册 `server/admin-layout.js`，仍须后台 Session，不能允许任意 URL 当后台 iframe 目标。前端业务页仍有直接打开时的认证要求，不靠嵌入布局获得授权。
- 旧版磁链登记仅在内存，改为 `infra.sqlite` 中 `magnets`、`magnet_shares`、`magnet_downloads` 的持久数据及索引；同资源重复分享保留历史事件，文件当前离线只表示暂无供源。管理员可查看分享设备、时间、触发下载次数，但**点击下载不代表操作系统确已保存**。显式删除隧道撤销链接，不能恢复此前已丢失的未持久磁链 ID。
- `server/private-key-file.js` 通过排他创建防止双实例首次启动竞态覆盖认证签名密钥。已存在空密钥或无法解密的配置**失败关闭**，不能当成初次未配置重新绑定。重复同名但不同 Path 的 Cookie 逐条验签，不能被无效项遮盖有效会话；30 天管理会话本身未改。
- 新增 `server/tunnel-access.js` 的稳定会话签名密钥 `.tunnel-access.key` 和登记账本 `.tunnel-access-members`；两者是持久授权资料，迁移/备份时应一并保留。换短码不撤销已登记用户，不把原短码恢复成公开永久通行凭据。
- 媒体收藏后台的 `media-library.sqlite` 和其缓存目录有独立授权与清理范围，不得错误并入 `disk.sqlite`、`infra.sqlite` 的备份或清理流程。参见 [media-library.md](./media-library.md)。
