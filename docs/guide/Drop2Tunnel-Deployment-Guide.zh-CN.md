# Drop2Tunnel 服务部署者指南

> 适用基线：`Ltre/file-tunnel` 的 `dev/2607A-NEWCODE` 分支及 Alpha-1.6.5 前后的当前实现。  
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
- 协同编辑、富文本版本历史和冲突处理；
- 图片、视频、音频预览及后台音乐队列；
- 会话资源管理器、备份/导入、文件系统句柄挂载；
- 隧道创建者和默认权限控制；
- 管理后台、TOTP 登录和 Telegram 配置页。

Drop2Tunnel 不是传统“文件全部上传到中心服务器”的网盘。浏览器缓存和在线设备副本是主要数据来源，Node.js 服务器主要负责会话协调、信令、元数据同步、Socket.IO 中继、基础设施元数据持久化及可选 Telegram 恢复。

---

## 2. 架构与数据边界

### 2.1 浏览器端

每台设备在 IndexedDB 中独立保存：

- 已加入隧道；
- 传输记录；
- 文件缓存副本；
- 协同编辑内容；
- PWA 分享待处理队列；
- 已关注设备；
- 本机目录/文件句柄挂载；
- 音乐队列的持久化副本；
- 设备备注和富文本离线草稿。

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
- 动态 PWA Manifest；
- 记录详情深链和辅助页面。

### 2.3 服务端会持久化什么

`.tunnel-data/` 中可能包含：

- `infra.sqlite`：隧道短码、备注、所有者、默认权限、设备访问记录；
- `telegram-bot.json`：Bot Token、Webhook Secret、文件大小限制、备份 Chat/Channel；
- `telegram-chat-tunnels.json`：Telegram Chat 与隧道的绑定关系；
- Telegram 文件索引及临时文件；
- 管理员 TOTP 加密配置和会话签名密钥；
- 从旧版本迁移而来的短码数据。

### 2.4 服务端不会替代什么

服务端不是完整文件仓库，也不是可靠的永久消息数据库：

- 大文件主体通常保存在浏览器缓存或本机文件系统；
- 服务端历史窗口主要用于在线同步，不应当作唯一备份；
- Telegram 下载到服务端的二进制通常只是临时文件，完成交付后会清理；
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
| 同时多源下载 | 4 |
| 同时上传 | 2 |

此外：

- 当前没有真正持久化已接收分片的完整断点续传协议；
- 当前没有应用层端到端加密；
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
- Nginx 或其他支持 WebSocket 的反向代理；
- HTTPS 证书；
- 可写的项目目录或可写的 `.tunnel-data/`；
- 足够的磁盘空间用于 SQLite、日志和 Telegram 临时文件。

### 4.2 网络端口

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
git checkout dev/2607A-NEWCODE
npm ci
```

如果仓库依赖发生变化，升级后应重新执行：

```bash
npm ci
```

不要把 `node_modules` 从其他系统直接复制到生产服务器。

---

## 6. 基础配置

编辑项目根目录的 `tunnel.config.json`。

推荐生产示例：

```json
{
  "debugLogsEnabled": false,
  "serverPort": 3000,
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
- `rtc.iceServers`：附加 STUN；
- `rtc.turnServers`：附加 TURN；
- `rtc.replaceDefaultIceServers`：为 `true` 时不再附加内置公共 STUN。

注意：TURN 凭据属于敏感配置。不要把生产凭据提交到公开仓库。

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

首次 TOTP 初始化只允许来自私网、回环地址或本机可信链路的请求。推荐两种方式。

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
git checkout dev/2607A-NEWCODE
git pull --ff-only
npm ci

node --check server.js
node --check app.js
node --check server/infra-store.js
node --check server/media-session.js

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
8. 隧道权限；
9. PWA 强制刷新；
10. `.tunnel-data/infra.sqlite` 是否正常更新。

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
- Socket.IO 断连；
- 内存和磁盘占用；
- Relay 流量；
- Nginx 499/502/504；
- WebSocket Upgrade 是否成功；
- 服务端临时 Telegram 文件是否异常堆积。

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
2. 确认公共 STUN 未被阻断；
3. 为媒体配置 TURN；
4. 检查 Socket.IO Relay 是否正常；
5. 观察是否只是直连失败但 Relay 成功。

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

### 18.7 Windows 出现 `EPERM rename ... infra.sqlite.tmp`

当前代码已对 Windows 的 `EPERM`、`EACCES`、`EBUSY` 增加复制回退和重试，但仍应检查：

- 杀毒软件是否锁定 `.tunnel-data`；
- 项目目录是否位于同步盘；
- 运行用户是否有写权限；
- 是否有多个 Node 实例同时使用同一个数据目录。

### 18.8 PWA 一直显示旧界面

让用户：

1. 点击应用内“强制刷新”；
2. 完全关闭 PWA；
3. 重新打开；
4. 仍无效时清理该站点缓存并重新安装 PWA。

### 18.9 文件记录存在但无法恢复

这通常表示只有元数据，没有可用文件源。

检查：

- 是否有持有缓存的设备在线；
- 原发送设备的文件句柄是否仍有效；
- 文件是否被移动、改名或删除；
- Telegram `file_id` 是否仍有效；
- 服务器 Telegram 索引是否存在；
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
- [ ] PWA 可安装；
- [ ] Android 系统分享可进入应用；
- [ ] Telegram Webhook 已验证；
- [ ] 备份 Chat/Channel 已验证；
- [ ] 隧道权限服务端校验已验证；
- [ ] 升级和回滚流程已演练；
- [ ] 已向用户说明缓存、恢复来源和非 E2EE 边界。
