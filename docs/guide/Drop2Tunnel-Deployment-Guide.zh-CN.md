# Drop2Tunnel 服务部署者指南

> 适用基线：`Ltre/file-tunnel` 的 `dev/2608A-NEWCODE` 分支，核对至 `4af5873`（2026-08-12）。
> 本手册面向负责安装、升级、反向代理、数据备份、Telegram Bot、权限与故障排查的服务器维护者。

---

## 1. 项目定位

Drop2Tunnel（即时传输隧道）是一个以浏览器为客户端、Node.js 为协调服务的多设备传输与协作系统。

它提供：

- 5 位隧道暗号、二维码和链接加入；
- 文本、富文本、文件、文件夹、合辑传输；
- WebRTC P2P 文件传输；
- P2P 不可用时的 Socket.IO Relay 降级；
- 多设备缓存供源和大文件多源分段拉取；
- 浏览器 IndexedDB 本地缓存；
- PWA 安装和 Android 系统分享入口；
- Telegram Bot 中转与 `file_id` 兜底恢复；
- Telegram 备注中的 SNS 链接识别与按需下载；
- 浏览器发送的文本/备注中的 SNS 链接识别与按需下载；
- 协同编辑、富文本版本历史和冲突处理；
- 图片、视频、音频预览及后台音乐队列；
- 会话资源管理器、备份/导入、文件系统句柄挂载；
- 隧道创建者和默认权限控制；
- 管理后台、TOTP 登录和 Telegram 配置页。
- 13 种界面语言及 Telegram Bot 交互翻译；
- 面向 Android Chrome 与 VPN 场景的“增强局域网 P2P”授权引导。

Drop2Tunnel 不是传统“文件全部上传到中心服务器”的网盘。浏览器缓存和在线设备副本是主要数据来源，Node.js 服务器主要负责会话协调、信令、元数据同步、Socket.IO 中继、基础设施元数据持久化及可选 Telegram 恢复。

---

## 2. 架构与数据边界

### 2.1 浏览器端

每台设备以 IndexedDB 为主要持久化层，独立保存：

- 已加入隧道；
- 传输记录；
- 文件缓存副本；
- 协同编辑内容；
- PWA 分享待处理队列；
- 已关注设备；
- 本机目录/文件句柄挂载；
- 音乐队列的持久化副本；
- 设备备注和富文本离线草稿。

当前代码已经提供统一的 `CacheStore` 接口以及 IndexedDB、内存临时态和 OPFS 驱动。需要特别注意：接收侧 OPFS 分块写入当前被明确关闭，避免串行 OPFS 写入阻塞 P2P 热路径；现行接收流程仍以内存聚合后写入 IndexedDB Blob 为主。不要因为仓库中存在 `OpfsCacheDriver` 就把 OPFS 当成当前默认缓存后端。

因此，同一条文件记录在不同设备上可能处于不同状态：

- 已有完整缓存；
- 只有本机文件系统句柄；
- 只有元数据，等待从别的设备恢复；
- 可从 Telegram `file_id` 兜底恢复；
- 完全没有当前可用的数据来源。

### 2.2 Node.js 服务端

服务端负责：

- Express 静态页面和 API；
- Socket.IO 会话、设备、消息与信令；
- WebRTC SDP/ICE 协商；
- P2P 文件供源发现与负载选择；
- P2P 不可用时的 Socket.IO 分块中继；
- 当前会话的内存历史窗口；
- 短码、隧道备注、设备访问记录、隧道所有者和权限持久化；
- 管理员 TOTP 会话；
- Telegram Bot Webhook、绑定状态、文件索引及临时文件；
- `yt-dlp` 调用、SNS cookies 读取、SNS 媒体临时文件登记；
- 动态 PWA Manifest；
- 记录详情深链和辅助页面。

### 2.3 服务端会持久化什么

`.tunnel-data/` 中可能包含：

- `infra.sqlite`：隧道短码、备注、所有者、默认权限、设备访问记录；
- `telegram-bot.json`：Bot Token、Webhook Secret、文件大小限制、备份 Chat/Channel；
- `telegram-chat-tunnels.json`：Telegram Chat 与隧道的绑定关系；
- Telegram 文件索引及临时文件；
- SNS 平台 cookies，例如 `yt-cookies.txt`、`twitter-cookies.txt`；
- SNS 媒体下载过程中的临时工作目录；
- 管理员 TOTP 加密配置和会话签名密钥；
- 从旧版本迁移而来的短码数据。

### 2.4 服务端不会替代什么

服务端不是完整文件仓库，也不是可靠的永久消息数据库：

- 大文件主体通常保存在浏览器缓存或本机文件系统；
- 服务端历史窗口主要用于在线同步，不应当作唯一备份；
- Telegram 下载到服务端的二进制通常只是临时文件，完成交付后会清理；
- SNS 媒体通过 `yt-dlp` 下载到服务端后，会登记为 server asset 并交付给客户端缓存，不应被视为永久媒体库；
- 浏览器清除站点数据会删除该设备的本地缓存；
- 服务器重启后，在线客户端会重新参与历史和供源同步，但不能替代客户端备份。

---

## 3. 当前实现的重要限制

部署前应明确以下边界：

| 项目 | 当前限制 |
|---|---:|
| 内存会话数量 | 1000 |
| 每个会话设备数量 | 10 |
| 空会话内存保留时间 | 约 2 小时 |
| 服务端历史消息窗口 | 1000 条 |
| 服务端历史元数据窗口 | 16 MiB |
| 单个文件资产最大值 | 1 GiB |
| 协同编辑单个资源最大值 | 20 MiB |
| 单会话协同编辑资源数 | 100 |
| 单次目录遍历发布 | 500 个文件 |
| 小文件直接消息阈值 | 512 KiB |
| 多源下载阈值 | 大于 10 MiB |
| 同时完整下载 | 3 |
| 同时多源下载 | 2 |
| 客户端同时下载总数 | 4 |
| 同时上传 | 2 |
| 服务端单接收端活跃文件 | 5 |
| 服务端单接收端活跃大文件 | 3 |

此外：

- 当前没有真正持久化已接收分片的完整断点续传协议；
- 当前没有应用层端到端加密；
- 当前接收侧 OPFS 写入未启用，浏览器仍可能在大文件合并和 IndexedDB 落库阶段产生内存压力；
- File System Access API 主要依赖安全上下文中的 Chromium 浏览器；
- 摄像头、麦克风、PWA、系统分享和多数高级能力需要 HTTPS；
- 文件传输主 DataChannel 当前使用内置公共 STUN 列表；`tunnel.config.json` 中的 `rtc` 配置主要供语音、摄像头和通话媒体控制器使用；
- 没有 TURN 时，严格 NAT 或部分运营商网络可能无法建立直连，只能退回 Socket.IO Relay。

---

## 4. 服务器要求

### 4.1 基础环境

建议使用：

- Linux 服务器；
- 当前仍受支持的 Node.js LTS；
- Node.js 至少 18，因为服务端会使用现代 Web/Fetch 能力；
- npm；
- 包含 `yt-dlp-ejs` 的 `yt-dlp`，最好再附加安装deno，用于识别和下载 Telegram 备注中的 YouTube、YT Music、TikTok、Facebook、Instagram、Threads、LINE、Twitter/X 等 SNS 链接；
- `ffmpeg`，用于 `yt-dlp` 合并音视频轨、转封装和处理部分平台媒体；
- Nginx 或其他支持 WebSocket 的反向代理；
- HTTPS 证书；
- 可写的项目目录或可写的 `.tunnel-data/`；
- 足够的磁盘空间用于 SQLite、日志和 Telegram 临时文件。
- 额外预留 SNS 媒体下载临时空间；下载大视频时，峰值可能高于最终文件大小。

### 4.2 安装 yt-dlp 和 ffmpeg

Debian / Ubuntu 示例：

```bash
sudo apt update
sudo apt install -y ffmpeg python3 python3-pip
python3 -m pip install --user -U "yt-dlp[default]"
```

`yt-dlp[default]` 会同时安装 YouTube 完整解析所需的 `yt-dlp-ejs`。只安装裸 `yt-dlp` 时，元数据可能仍能读取，但下载阶段可能因签名挑战无法解析而失败。官方独立版 `yt-dlp`/`yt-dlp.exe` 已内置该组件。项目默认使用 Node.js 执行 EJS；该功能需要 Node.js 22 或更新版本。网络无法访问 GitHub Release 时尤其应优先使用本地 `yt-dlp-ejs`，不要只依赖远程组件下载。详见 [yt-dlp EJS 官方说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)。

如果使用 systemd 运行服务，确认运行用户的 `PATH` 中能找到 `yt-dlp`。也可以显式指定：

```ini
Environment=YT_DLP_BIN=/home/drop2tunnel/.local/bin/yt-dlp
```

Windows Server 可安装：

- Node.js 官方 MSI；
- `ffmpeg` 官方构建或包管理器版本，并加入 `PATH`；
- 官方 `yt-dlp.exe`，或执行 `py -m pip install --upgrade "yt-dlp[default]"` 后将 Python 脚本目录加入 `PATH`。

安装后应以运行 Node.js 服务的同一账号验证一次真实格式解析：

```bash
yt-dlp --verbose --simulate --no-playlist --js-runtimes node "<实际可访问的 YouTube 视频 URL>"
```

输出中不应出现 `Failed to download challenge solver lib script` 或 `Signature solving failed`。修改依赖或 `PATH` 后，需要重启 Node.js 服务进程。

验证：

```bash
yt-dlp --version
ffmpeg -version
```

### 4.3 网络端口

建议的生产结构：

```text
Internet
   │
   ▼
Nginx :443
   │ HTTPS / WebSocket
   ▼
Node.js :3000 或 :8080
```

仓库当前 `tunnel.config.json` 示例使用端口 `80`。Linux 普通用户通常不能直接监听 1024 以下端口，因此生产环境建议把 Node.js 改为 `3000` 或 `8080`，由 Nginx 监听 80/443。

---

## 5. 获取代码与安装依赖

```bash
git clone https://github.com/Ltre/file-tunnel.git
cd file-tunnel
git checkout dev/2608A-NEWCODE
npm ci
```

如果仓库依赖发生变化，升级后应重新执行：

```bash
npm ci
```

不要把 `node_modules` 从其他系统直接复制到生产服务器。

### 5.1 构建发布版

仓库提供 `tools/deploy` 下的发布工具，用于压缩前端静态资源、生成内容哈希文件名、更新 Service Worker 应用壳，并按环境生成 `dist`。

直接构建某个 profile：

```bash
node tools/deploy/build.mjs --profile txsl --out dist --source-branch dev/2608A-NEWCODE
node tools/deploy/verify.mjs --dist dist --profile txsl
```

推荐通过独立部署工作树构建。默认是演练模式，不提交、不推送：

```bash
tools/deploy/release.sh --source dev/2608A-NEWCODE --profile txsl
tools/deploy/release.sh --source dev/2608A-NEWCODE --profile txhk
tools/deploy/release.sh --source dev/2608A-NEWCODE --profile alyhk
```

需要生成部署分支提交时追加 `--commit`；只有明确需要推送时才再追加 `--push`。脚本会拒绝从脏工作树发布，并在 `.deploy-worktrees/<deployBranch>/` 中构建和校验，不切换当前开发工作树。

现有 profile：

| Profile | Node.js 监听 | 反向代理 | 默认域名 |
|---|---:|---|---|
| `txsl` | 80 | 无，Node.js 直出 | `tun.miku.us` |
| `txhk` | 4000 | Nginx | `tun-txhk.miku.us` |
| `alyhk` | 4000 | Nginx | `tun-alyhk.miku.us` |

输出目录位于：

```text
.deploy-worktrees/deploy-<profile>/dist
```

远端同步脚本使用 rsync，默认不删除目标目录中发布包没有的额外文件。详情见 `tools/deploy/README.zh-cn.md`。

---

## 6. 基础配置

编辑项目根目录的 `tunnel.config.json`。下面是包含可选 RTC 媒体配置的完整示例；不需要自定义媒体 ICE 时可省略 `rtc`：

```json
{
  "debugLogsEnabled": false,
  "serverPort": 80,
  "ffmpegLocation": {
    "txsl": "C:\\GreenApps\\ffmpeg\\bin",
    "txhk": null,
    "alyhk": null
  },
  "rtc": {
    "replaceDefaultIceServers": false,
    "iceServers": [
      {
        "urls": "stun:stun.example.com:3478"
      }
    ],
    "turnServers": [
      {
        "urls": [
          "turn:turn.example.com:3478?transport=udp",
          "turns:turn.example.com:5349?transport=tcp"
        ],
        "username": "drop2tunnel",
        "credential": "replace-with-a-strong-secret"
      }
    ]
  }
}
```

字段说明：

- `debugLogsEnabled`：是否启用较详细的历史调试日志；
- `serverPort`：Node.js Web/API/Socket.IO 共用端口；
- `ffmpegLocation`：可写字符串，也可按 `deployment.profile` 配置路径；值为空或 profile 未命中时由 `PATH` 查找；
- `rtc.iceServers`：附加 STUN；
- `rtc.turnServers`：附加 TURN；
- `rtc.replaceDefaultIceServers`：为 `true` 时不再附加内置公共 STUN。

构建工具会在发布产物中补充 `deployment.profile`、域名、构建 ID、源分支和源提交。`rtc` 当前主要供语音、摄像头和通话媒体控制器读取；文件 DataChannel 仍使用 `app.js` 内置 ICE 配置，不要误以为只改这里就能改变文件链路。TURN 凭据属于敏感配置，不要提交到公开仓库。

### 6.1 CORS/Origin 限制

服务端读取环境变量 `ALLOWED_ORIGINS`。生产环境不要长期使用默认的 `*`。

例如：

```bash
export ALLOWED_ORIGINS="https://tunnel.example.com,https://tunnel-alt.example.com"
```

使用 systemd 时应把它写入服务配置。

---

## 7. 首次启动和本机验证

```bash
npm start
```

或：

```bash
node server.js
```

检查监听：

```bash
ss -lntp | grep 3000
```

本机访问：

```text
http://127.0.0.1:3000/
```

基本检查：

```bash
curl -I http://127.0.0.1:3000/
curl http://127.0.0.1:3000/runtime-config.js
curl http://127.0.0.1:3000/manifest.webmanifest
```

启动成功后，控制台应显示 Web/API、Socket.IO 监听端口和 CORS 配置。

---

## 8. 使用 systemd 托管

先创建独立用户：

```bash
sudo useradd --system --home /opt/drop2tunnel --shell /usr/sbin/nologin drop2tunnel
sudo mkdir -p /opt/drop2tunnel
sudo chown -R drop2tunnel:drop2tunnel /opt/drop2tunnel
```

将项目放到 `/opt/drop2tunnel/file-tunnel`，确保运行用户可以写入：

```text
/opt/drop2tunnel/file-tunnel/.tunnel-data/
```

创建 `/etc/systemd/system/drop2tunnel.service`：

```ini
[Unit]
Description=Drop2Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=drop2tunnel
Group=drop2tunnel
WorkingDirectory=/opt/drop2tunnel/file-tunnel
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=ALLOWED_ORIGINS=https://tunnel.example.com
NoNewPrivileges=true
PrivateTmp=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now drop2tunnel
sudo systemctl status drop2tunnel
```

查看日志：

```bash
journalctl -u drop2tunnel -f
```

---

## 9. Nginx 反向代理

示例站点配置：

```nginx
server {
    listen 80;
    server_name tunnel.example.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tunnel.example.com;

    ssl_certificate     /etc/letsencrypt/live/tunnel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.example.com/privkey.pem;

    client_max_body_size 1g;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 9.1 为什么必须正确代理 WebSocket

Socket.IO 用于：

- 会话加入；
- 在线设备状态；
- WebRTC 信令；
- 文本和历史元数据；
- Socket.IO 文件 Relay；
- Telegram 记录广播；
- 权限和设备邀请；
- 协同编辑；
- 语音、摄像头和对讲机信令。

如果 Nginx 没有转发 `Upgrade` 和 `Connection`，页面可能能打开，但设备无法正常连接或只能反复重连。

---

## 10. HTTPS 与安全上下文

生产环境应强制 HTTPS。以下能力依赖安全上下文：

- PWA 安装；
- Android Share Target；
- Service Worker；
- 摄像头和麦克风；
- File System Access API；
- 持久化本机目录/文件句柄；
- 更可靠的剪贴板能力。

`http://localhost` 在浏览器中通常被视为安全上下文，但局域网 IP 的普通 HTTP 并不等价于 localhost。

---

## 11. 首次配置管理员 TOTP

管理入口：

```text
https://tunnel.example.com/admin
```

认证入口：

```text
https://tunnel.example.com/admin-auth
```

首次 TOTP 初始化只允许来自私网、回环地址或本机可信链路的请求。初始化页面可填写自定义 issuer，建议使用能区分服务器的名称，例如“首尔 Drop2Tunnel 管理后台”。推荐两种方式。

### 11.1 在服务器局域网内访问

通过服务器私网地址打开：

```text
http://192.168.x.x:3000/admin-auth
```

### 11.2 使用 SSH 隧道

```bash
ssh -L 8080:127.0.0.1:3000 user@server
```

本机浏览器打开：

```text
http://127.0.0.1:8080/admin-auth
```

按照页面提示：

1. 使用支持 TOTP 的身份验证器扫描二维码；
2. 输入 6 位验证码；
3. 完成首次绑定；
4. 后续通过 `/admin` 或 `/tgbot` 登录。

管理员会话默认有效期约 14 天，并使用 HttpOnly、SameSite=Strict Cookie；HTTPS 下还会加入 Secure。

### 11.3 管理员认证数据

管理员认证相关数据位于 `.tunnel-data/`，包括：

- 加密的 TOTP Secret；
- 会话签名密钥。

丢失这些文件后，现有管理员登录和 TOTP 配置可能失效。泄露这些文件则可能危及管理权限。

---

## 12. Telegram Bot 部署

登录管理员后访问：

```text
https://tunnel.example.com/tgbot
```

可配置：

- Telegram Bot Token；
- 单文件最大值；
- 私有备份 Chat/Channel ID。

保存后服务端会：

- 调用 `getMe` 验证 Token；
- 自动生成 Webhook Secret；
- 按当前域名注册 Webhook；
- 注册 `/tunnel` 和 `/leave_tunnel` 命令；
- 将敏感配置保存到 `.tunnel-data/telegram-bot.json`。

### 12.1 Telegram Webhook 条件

必须满足：

- 外部可以访问有效 HTTPS 域名；
- 证书有效；
- Nginx 正确转发原始 Host 和 `X-Forwarded-Proto`；
- Telegram 能访问：
  `https://你的域名/api/telegram/webhook/<secret>`。

### 12.2 备份 Chat/Channel

“Telegram 文件防失联检测及修复”需要配置备份目标。

操作要求：

1. 创建私有群组或频道；
2. 将 Bot 加入；
3. 赋予发送文件权限；
4. 获取 Chat/Channel ID；
5. 在 `/tgbot` 写入 `backupChatId`。

修复流程不会凭空恢复文件。系统会先尝试：

1. 本机浏览器缓存；
2. 本机文件系统句柄；
3. 在线设备副本；
4. 获得文件字节后再上传到备份 Chat/Channel，换取新的 `file_id`。

### 12.3 Telegram 数据文件

需要重点备份：

```text
.tunnel-data/telegram-bot.json
.tunnel-data/telegram-chat-tunnels.json
.tunnel-data/telegram-assets/
```

其中 `telegram-assets/` 可能同时包含轻量索引和临时二进制。不要把这个目录放在自动清空的临时分区。

### 12.4 SNS 媒体链接下载

当 Telegram 文本、单文件 caption 或 album caption 中包含 SNS 链接时，服务端会异步扫描全部 URL，并用 `yt-dlp` 读取元数据。用户在传输记录详情页的“SNS媒体文件”区域点击“获取文件内容”后，服务端才开始下载完整媒体。

当前行为：

- 识别阶段不下载完整媒体；
- 支持多个 URL 和列表 URL；
- 下载成功后登记为 server asset，并生成普通文件传输记录；
- 客户端通过 `/api/server-assets/:assetId` 拉取文件，接口支持 HTTP Range；
- YouTube 视频优先选择 H.264、最高不超过 1080p；无 H.264 时降级到 AV1 或其他视频轨；
- YT Music 只选择音频轨；
- 音频优先选择 AAC/M4A 且码率接近 256K，其次接近 128K，再逐级降级。

YT Music 获取完成后还会整理曲名、艺术家、专辑、年份和来源 URL，裁剪封面两侧黑边，并将方形封面和元数据写入 M4A；文件名采用“艺术家 - 曲名.m4a”。普通 YouTube 链接按视频处理，不会一律转成音频。

YouTube / YT Music 默认使用随官方 `yt-dlp` 或 `yt-dlp[default]` 安装的本地 `yt-dlp-ejs`，不再为每次解析依赖 GitHub。元数据解析默认最多等待 90 秒，可按服务器网络情况调整：

```bash
SOCIAL_YTDLP_TIMEOUT_MS=90000
```

只有本地 EJS 不可用且服务器能稳定访问 GitHub 时，才启用远程组件：

```bash
SOCIAL_YTDLP_REMOTE_COMPONENTS=ejs:github
```

### 12.5 SNS Cookies 配置

管理员登录后访问：

```text
https://tunnel.example.com/sns-cookies
```

可配置：

- YouTube / YT Music：`.tunnel-data/yt-cookies.txt`；
- TikTok：`.tunnel-data/tiktok-cookies.txt`；
- Facebook：`.tunnel-data/facebook-cookies.txt`；
- Instagram：`.tunnel-data/instagram-cookies.txt`；
- Threads：`.tunnel-data/thread-cookies.txt`；
- LINE：`.tunnel-data/line-cookies.txt`；
- Twitter：`.tunnel-data/twitter-cookies.txt`；
- X：`.tunnel-data/x-cookies.txt`。

#### 12.5.1 在管理页手动配置

1. 使用浏览器登录管理页，并打开 `/sns-cookies`。
2. 在对应平台粘贴 Netscape cookies.txt 内容；YouTube 和 YT Music 共用同一个输入框。
3. YouTube Cookie 必须包含登录态及 HttpOnly Cookie。只通过 `document.cookie` 导出的内容不完整，不能用于 yt-dlp。
4. 点击“保存”，确认状态中显示的文件大小符合预期，再用一条 YouTube 链接验证“解析”和“获取文件内容”。

YouTube 会轮换仍在浏览器中使用的账号 Cookie。如果选择手动导出，yt-dlp 官方建议在新的无痕窗口登录 YouTube，在同一标签打开 `https://www.youtube.com/robots.txt`，导出后立即关闭该无痕窗口，避免该会话继续被浏览器轮换。

#### 12.5.2 浏览器自动同步扩展（Drop2Tunnel SNS Cookie Sync）

仓库内置管理员专用扩展：

```text
tools/auto-sync-sns-cookies/chrome
tools/auto-sync-sns-cookies/firefox-windows
tools/auto-sync-sns-cookies/firefox-android
```

修改公共 JS/HTML 后，先生成两个 Firefox 包中的公共文件：

```bash
npm run build:sns-cookie-extension
```

从旧版根目录安装方式迁移到 `chrome/` 前，应先在旧扩展中导出 Base64 配置，再在新扩展中导入；加载路径改变后 Chrome 可能分配新的扩展 ID，本地设置不会自动继承。三种浏览器包之间也通过该 Base64 完成服务器配置迁移。

服务端升级并重启后，按以下步骤配置：

1. 分别进入每台 Drop2Tunnel 服务器的 `/sns-cookies`，在“浏览器自动同步 SNS Cookie”区域生成各自的同步密钥。
2. Chrome：在 `chrome://extensions` 启用开发者模式，加载 `tools/auto-sync-sns-cookies/chrome`。
3. Firefox Windows 临时调试：在 `about:debugging#/runtime/this-firefox` 选择“临时载入附加组件”，打开 `firefox-windows/manifest.json`；长期使用需通过 Mozilla AMO 签名 XPI。
4. Firefox Android 临时调试：使用 ADB 与 `web-ext run --target=firefox-android --source-dir tools/auto-sync-sns-cookies/firefox-android`；长期使用需安装签名 XPI。
5. 打开扩展，点击 `+`，填写服务器地址和对应同步密钥；重复操作即可添加多台服务器。三个版本都会按服务器 Origin 动态申请访问权限。
6. 勾选“启用自动同步”并保存，然后点击“立即同步”。扩展会读取 YouTube / YT Music、TikTok、Facebook、Instagram、Threads、LINE、Twitter 和 X 的 Cookie，并批量同步到全部已配置服务器。
7. 分别回到各服务器的 `/sns-cookies` 点击“刷新”，检查各平台 Cookie 的更新时间和大小。

扩展读取的域名与 `/sns-cookies` 中的平台一一对应：YouTube / YT Music 使用 `youtube.com`，TikTok 使用 `tiktok.com`，Facebook 使用 `facebook.com`，Instagram 使用 `instagram.com`，Threads 使用 `threads.com`、旧域名 `threads.net` 及其可能复用的 `instagram.com` 登录态，LINE 使用 `line.me`，Twitter / X 使用 `twitter.com` 和 `x.com`。未登录或没有可用 Cookie 的平台会被跳过，服务器中该平台原有的 Cookie 文件保持不变。

扩展的自动触发规则：

- 默认每 15 分钟检查一次；
- 任一受支持平台的 Cookie 发生变化后延迟约 1 分钟同步，避免页面加载期间反复写入；
- 任一受支持 SNS 页面久未打开后再次打开，会在页面稳定数秒后同步；
- Cookie 内容未变化且刚同步过时不会重复上传；
- 未检测到某个平台的 Cookie 或可识别登录态时会跳过该平台，客户端不会在批量请求中携带它，服务端也不会覆盖其已有 Cookie。

每台服务器的同步接口使用各自独立的 Bearer 密钥，不复用管理会话 Cookie。服务端只在 `.tunnel-data/.sns-cookie-sync.json` 中保存密钥哈希，原始密钥仅在管理页生成当次显示并保存在扩展本地存储中。怀疑某台服务器的密钥泄露时，应在该服务器的 `/sns-cookies` 立即撤销或重新生成。从扩展列表删除服务器只会停止同步并撤销扩展对该 Origin 的访问权限，不会自动撤销服务端密钥。

#### 12.5.3 安全与故障排查

这些 Cookie 可能包含完整登录态。建议：

- 只使用专用低权限账号导出；
- 限制 `.tunnel-data` 文件权限；
- 不写入 `tunnel.config.json`；
- 不提交到 Git；
- 不把同步密钥、Cookie 内容写入日志或聊天记录；
- 公网服务器必须使用 HTTPS；HTTP 只适合可信局域网内的临时调试；
- 不再使用时撤销同步密钥并卸载扩展。

常见错误：

- `youtube-login-cookie-missing`：当前浏览器中没有可识别的 YouTube 登录态，扩展不会覆盖服务器文件；
- `<platform>-login-cookie-missing`：该平台 Cookie 中没有服务端可识别的登录态，整批请求会被拒绝且不会写入任何平台；
- `<platform>-cookie-domain-missing`：上传内容中没有该平台对应域名的 Cookie，整批请求会被拒绝；
- `sns-cookie-sync-auth-invalid`：扩展中的同步密钥已被撤销或重新生成；
- 经过反向代理后持续返回 401：确认代理没有剥离扩展请求的 `Authorization: Bearer ...` 请求头；
- YouTube 仍提示登录验证：先确认扩展读取的是已登录账号所在的浏览器 Profile，再检查服务器出口 IP 是否触发 YouTube 风控；
- 手动导出内容明显偏小：换用能够导出 HttpOnly Cookie 的工具，并以 Netscape 格式重新导出。Firefox 的 Cookie-Editor 通常比只能读取页面 Cookie 的脚本更完整。

### 12.6 Telegram 云端 Bot API 的 20MB 下载边界

Telegram Bot API 的 `getFile` 云端下载接口当前只能下载不超过 20MB 的文件。代码会在收到 update 时优先读取 `file_size`，对超过 20MB 的文件直接拦截并向用户附上 Telegram 官方说明，避免下载完整文件后才失败。`telegram-bot.json` 中更大的业务上限不能突破这一官方接口限制。

---

## 13. PWA 和多域名 Manifest

`manifest.hosts.json` 支持按访问 Host 返回不同的：

- PWA 名称；
- 短名称；
- 描述；
- 图标；
-主题色；
- Share Target 配置。

添加新域名时，可复制 `default` 项：

```json
{
  "tunnel.example.com": {
    "name": "Drop2Tunnel",
    "short_name": "Drop2Tunnel",
    "description": "在同一个传输隧道中的设备间发送文件、消息和协同内容。",
    "start_url": "/?pwa=1",
    "scope": "/",
    "display": "standalone",
    "background_color": "#f4f6fb",
    "theme_color": "#4f5ec2",
    "icons": [
      {
        "src": "/tunnel-icon.svg",
        "sizes": "any",
        "type": "image/svg+xml",
        "purpose": "any maskable"
      }
    ],
    "share_target": {
      "action": "/share/",
      "method": "POST",
      "enctype": "multipart/form-data",
      "params": {
        "title": "title",
        "text": "text",
        "url": "url",
        "files": [
          {
            "name": "shared_file",
            "accept": ["*/*"]
          }
        ]
      }
    }
  }
}
```

修改 Service Worker、Manifest 或前端资源后，旧 PWA 可能仍持有缓存。用户可使用页面中的“强制刷新”，或清理该站点缓存后重新打开。

当前 Service Worker 同时处理 `/share` 与 `/share/`，GET 会跳转到分享入口，POST 会把系统 Share Target 文件写入 IndexedDB 队列后再进入隧道。反向代理和 CDN 不应把这两个路径改写成 404，也不应缓存 POST 响应。

---

## 14. 隧道所有者与权限

当前默认权限包括：

- 读取传输记录；
- 发送文本；
- 发送富文本；
- 发送文件；
- 删除记录；
- 协同编辑；
- 全局对讲机发声；
- 群语音通话。

权限会同时作用于：

- 客户端按钮和提示；
- 服务端关键事件校验；
- 历史快照和实时记录下发。

没有读取权限的设备不会收到历史快照、实时记录或历史广播。

旧隧道升级后，如尚无所有者，首个实际进入的设备可能被登记为隧道创建者。升级前应先做好数据库备份，并明确由哪台设备首次进入旧隧道。

---

## 15. 数据备份

### 15.1 服务器必须备份的内容

最低限度：

```text
.tunnel-data/
tunnel.config.json
manifest.hosts.json
```

推荐在停止服务后备份：

```bash
sudo systemctl stop drop2tunnel

tar -czf drop2tunnel-server-backup-$(date +%F-%H%M%S).tar.gz \
  .tunnel-data \
  tunnel.config.json \
  manifest.hosts.json

sudo systemctl start drop2tunnel
```

### 15.2 为什么只备份服务器还不够

服务器备份不等于文件和传输历史的完整备份。文件主体通常位于各浏览器 IndexedDB 或本机文件系统。

重要隧道还应在客户端使用：

- “备份/导入”；
- 元数据备份；
- 含全部数据备份。

元数据备份只保存记录和来源信息；恢复文件时仍可能需要原隧道在线设备。含全部数据备份会更大，但可把当前已有文件缓存一起导出。

---

## 16. 升级流程

推荐流程：

```bash
cd /opt/drop2tunnel/file-tunnel

sudo systemctl stop drop2tunnel

tar -czf ../drop2tunnel-before-upgrade-$(date +%F-%H%M%S).tar.gz \
  .tunnel-data tunnel.config.json manifest.hosts.json

git status
git fetch --all --tags
git checkout dev/2608A-NEWCODE
git pull --ff-only
npm ci

node --check server.js
node --check app.js
node --check server/infra-store.js
node --check server/media-session.js
node --check client/file-assets.js
node tests/p2p-connection-regression.test.cjs

sudo systemctl start drop2tunnel
sudo systemctl status drop2tunnel
```

升级后检查：

1. 首页和路由页；
2. 两台设备加入同一隧道；
3. Socket.IO 在线状态；
4. 小文件和大文件传输；
5. P2P 失败时 Relay；
6. 管理后台；
7. Telegram Webhook；
8. SNS cookies 页面；
9. `yt-dlp` / `ffmpeg` 是否可用；
10. 隧道权限；
11. PWA 强制刷新；
12. `.tunnel-data/infra.sqlite` 是否正常更新。

SQLite 表结构由程序启动时自动迁移，但不能替代升级前备份。

---

## 17. 日志与监控

### 17.1 systemd 日志

```bash
journalctl -u drop2tunnel --since today
journalctl -u drop2tunnel -f
```

### 17.2 Nginx 日志

```bash
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

### 17.3 应重点监控

- Node.js 是否反复重启；
- `.tunnel-data` 是否可写；
- `infra.sqlite` 保存错误；
- Telegram API/Webhook 错误；
- yt-dlp / ffmpeg 执行错误；
- SNS media 临时目录异常增长；
- Socket.IO 断连；
- 内存和磁盘占用；
- Relay 流量；
- Nginx 499/502/504；
- WebSocket Upgrade 是否成功；
- 服务端临时 Telegram 文件是否异常堆积。
- 服务端临时 SNS 媒体文件是否异常堆积。

### 17.4 关联客户端和服务端调试日志

仅在排障期间开启：

```json
{
  "debugLogsEnabled": true
}
```

重启服务后，客户端会通过 Socket.IO 上报经过采样和长度限制的诊断事件。管理员通过 TOTP 登录后可查询：

```text
/api/debug-logs?source=client&deviceId=<设备ID>&limit=2000
/api/debug-logs?source=server&sessionId=<隧道ID>&limit=2000
```

接口上限为 2000 条；如果配置了 `DEBUG_LOG_TOKEN`，还必须携带匹配的 `x-debug-log-token` 请求头。排障结束后应关闭详细日志，避免额外内存和网络开销。

---

## 18. 常见故障

### 18.1 启动时报端口被占用

```text
EADDRINUSE
```

检查：

```bash
ss -lntp | grep :3000
```

修改 `tunnel.config.json` 的 `serverPort`，或停止冲突服务。

### 18.2 普通用户无法监听 80 端口

将 Node.js 端口改为 3000/8080，再由 Nginx 监听 80/443。不要为了监听 80 长期使用 root 运行 Node.js。

### 18.3 页面能打开，但设备一直离线

检查：

- Nginx WebSocket Upgrade；
- `/socket.io/` 是否被缓存或拦截；
- `ALLOWED_ORIGINS` 是否包含实际域名；
- 代理/CDN 是否允许 WebSocket；
- 浏览器控制台和服务端 Socket 日志。

### 18.4 P2P 经常失败

P2P 受 NAT、防火墙、运营商网络影响。

处理顺序：

1. 确认双方 WebRTC 可用；
2. 核对浏览器控制台中的 ICE candidate、selected candidate pair 和 DataChannel 状态；
3. 排除 PWA/Service Worker 混用旧版静态资源；
4. 确认公共 STUN 未被阻断；
5. 检查 VPN/代理是否改变 WebRTC 候选或隐藏局域网 host candidate；
6. 检查 Socket.IO Relay 是否正常；
7. 观察是否只是直连失败但 Relay 成功。

在 Android Chrome 与 VPN/代理并用时，站点媒体权限可能改变 WebRTC 对局域网地址的暴露。当前设置页提供“增强局域网 P2P”：用户明确操作后短暂申请摄像头和麦克风权限，随即停止所有媒体轨道，不上传音视频。页面在 HTTPS、存在在线设备且检测到同局域网候选或 Relay 后也可能显示一次非阻塞引导。该能力只能提高成功率，不能保证 P2P，更不能替代 Relay 兜底。完整经验见 `docs/other/P2P_TRANSMISSION_NOTES-260812.md`。

### 18.5 管理员首次配置提示不允许

首次 TOTP 初始化只允许私网/本机请求。使用 SSH 端口转发访问 `127.0.0.1`，不要直接从公网浏览器初始化。

### 18.6 Telegram 配置保存成功但收不到内容

检查：

- 域名是否为公网 HTTPS；
- Bot Token 是否正确；
- Webhook 是否能从 Telegram 访问；
- Nginx 是否保留 Host 和协议；
- Bot 是否被封禁或没有文件权限；
- Chat/Channel ID 是否正确；
- 最大文件限制；
- 服务端日志中的 Telegram API 错误。

### 18.7 SNS 链接解析失败

检查：

- `yt-dlp --version` 是否可执行；
- `ffmpeg -version` 是否可执行；
- 是否配置了对应平台 cookies；
- 服务器是否能访问目标 SNS 平台；
- YouTube 是否需要 remote components；
- 日志中是否有 challenge、403、cookies 失效或地区限制。

对于 YouTube challenge 相关警告，默认已启用 `--remote-components ejs:github`。如果服务器无法访问 GitHub，仍可能解析失败。

### 18.8 Windows 出现 `EPERM rename ... infra.sqlite.tmp`

当前代码已对 Windows 的 `EPERM`、`EACCES`、`EBUSY` 增加复制回退和重试，但仍应检查：

- 杀毒软件是否锁定 `.tunnel-data`；
- 项目目录是否位于同步盘；
- 运行用户是否有写权限；
- 是否有多个 Node 实例同时使用同一个数据目录。

### 18.9 PWA 一直显示旧界面

让用户：

1. 点击应用内“强制刷新”；
2. 完全关闭 PWA；
3. 重新打开；
4. 仍无效时清理该站点缓存并重新安装 PWA。

### 18.10 文件记录存在但无法恢复

这通常表示只有元数据，没有可用文件源。

检查：

- 是否有持有缓存的设备在线；
- 原发送设备的文件句柄是否仍有效；
- 文件是否被移动、改名或删除；
- Telegram `file_id` 是否仍有效；
- 服务器 Telegram 索引是否存在；
- SNS 生成的 server asset 是否仍存在；
- 是否已执行“Telegram 文件防失联检测及修复”。

---

## 19. 安全建议

- 生产环境强制 HTTPS；
- 限制 `ALLOWED_ORIGINS`；
- Node.js 只监听内网端口，由 Nginx 暴露；
- 防火墙只开放必要端口；
- TOTP 初始化只通过私网或 SSH 隧道；
- 定期备份 `.tunnel-data`；
- 不要提交 Bot Token、TURN 密钥和管理员数据；
- 管理后台不要交给不受信任用户；
- 谨慎分享隧道短码和记录链接；
- Telegram 作为恢复源时，文件会进入 Telegram 基础设施；
- SNS 媒体下载会使服务端短暂或较长时间持有第三方平台媒体文件；
- 遵守第三方平台服务条款和当地法律，避免把服务端部署成公开下载器；
- 当前没有应用层端到端加密，不应把“HTTPS/WebRTC 加密传输”误认为完整 E2EE；
- 高敏感场景应额外使用受控网络、私有 TURN、访问控制和文件自身加密。

---

## 20. 部署验收清单

- [ ] Node.js 使用非 root 用户运行；
- [ ] `serverPort` 使用 3000/8080 等内部端口；
- [ ] Nginx HTTPS 正常；
- [ ] WebSocket Upgrade 正常；
- [ ] `ALLOWED_ORIGINS` 已收紧；
- [ ] `.tunnel-data` 可写并已加入备份；
- [ ] 管理员 TOTP 已配置；
- [ ] 两台设备能加入同一隧道；
- [ ] P2P 与 Relay 均做过测试；
- [ ] Android Chrome/VPN 场景已验证“增强局域网 P2P”授权提示及隐私说明；
- [ ] `debugLogsEnabled` 默认关闭，排障接口受管理员认证保护；
- [ ] PWA 可安装；
- [ ] Android 系统分享可进入应用；
- [ ] Telegram Webhook 已验证；
- [ ] `yt-dlp` 和 `ffmpeg` 已验证；
- [ ] SNS cookies 页面权限已验证；
- [ ] 备份 Chat/Channel 已验证；
- [ ] 隧道权限服务端校验已验证；
- [ ] 升级和回滚流程已演练；
- [ ] 已向用户说明缓存、恢复来源和非 E2EE 边界。
