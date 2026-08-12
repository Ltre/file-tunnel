# Drop2Tunnel 项目概述

> 当前开发基线：`dev/2608A-NEWCODE`，核对至 `4af5873`（2026-08-12）。

## 1. 项目定位

Drop2Tunnel 是一个以浏览器/PWA 为客户端、Node.js 为协调服务的多设备传输与协作系统。用户通过 5 位隧道短码、二维码或链接加入同一隧道，交换文本、富文本、文件、合辑、目录内容和实时协作数据。

它不是传统的中心化网盘：

- 文件主体优先保存在参与设备的浏览器缓存或本机文件系统；
- 在线设备既是客户端，也可以成为其他设备的文件供源；
- Node.js 服务端负责会话、信令、元数据、调度和 Relay 兜底；
- Telegram `file_id` 和 SNS server asset 是可选恢复/交付来源，不替代普通设备副本；
- 传输记录可以存在，但当前设备不一定持有文件内容。

## 2. 总体架构

```text
┌──────────────────────── 浏览器 / PWA ────────────────────────┐
│ 页面 UI、预览、音乐播放器、协同编辑、资源管理器、设置         │
│ IndexedDB（消息、文件 Blob、队列、会话、备注、挂载句柄）       │
│ CacheStore（Memory / IndexedDB Blob / OPFS 驱动抽象）          │
│ File System Access API（可选外部文件/目录只读来源）             │
└───────────────┬───────────────────────────────┬───────────────┘
                │ WebRTC DataChannel            │ Socket.IO
                │ P2P / multi-source P2P        │ 信令、元数据、Relay
                ▼                               ▼
       ┌────────────────┐              ┌────────────────────────┐
       │ 其他在线浏览器  │              │ Node.js / Express       │
       │ 缓存或句柄供源  │              │ Socket.IO 协调服务      │
       └────────────────┘              │ SQLite 基础设施元数据   │
                                       │ 管理后台 / TOTP         │
                                       │ Telegram / SNS 适配     │
                                       └───────────┬────────────┘
                                                   │
                                 ┌─────────────────┴──────────────┐
                                 │ Telegram Bot API / yt-dlp      │
                                 │ ffmpeg / SNS cookies           │
                                 └────────────────────────────────┘
```

## 3. 核心数据模型

### 3.1 隧道与设备

- 隧道内部使用会话 ID，对用户提供 5 位短码；
- 隧道可设置备注、创建者、管理员和默认权限；
- 设备有持久化设备 ID、名称、网络信息、关注状态和本地备注；
- 设备备注只由设置者显示，并可同步给被备注设备作为不可见备份。

### 3.2 传输记录

记录类型包括：

- 文本；
- 富文本；
- 单文件；
- 多文件合辑。

记录可以包含备注、收藏状态、来源设备、时间戳、跨隧道来源、Telegram/SNS 来源和文件列表。单条记录可生成深链，进入指定隧道后等待历史加载并定位锚点。

### 3.3 文件状态

同一文件在不同设备上可以分别处于：

- 浏览器完整缓存；
- 本机原文件句柄有效，但没有浏览器副本；
- 正在拉取或只有部分分片；
- 只有元数据；
- 可从在线设备恢复；
- 可从 Telegram `file_id` 或 server asset 兜底恢复；
- 暂无任何可用来源。

记录收藏与单文件收藏相互独立。合辑成员、单文件记录和音乐播放器中的具体音频使用单文件收藏；整条文本、文件或合辑记录使用记录收藏。

## 4. 文件缓存与来源

### 4.1 当前主要缓存层

浏览器以 IndexedDB 为主要持久化层。`client/cache-store.js` 提供统一接口：

```text
CacheStore
  ├─ MemoryTempDriver
  ├─ IndexedDbBlobDriver
  └─ OpfsCacheDriver
```

当前接收侧 `OPFS_RECEIVE_WRITE_ENABLED` 为 `false`。也就是说，OPFS 能力探测、Worker 和驱动已存在，但接收分片仍主要在内存聚合后写入 IndexedDB Blob，避免串行 OPFS 写入拖慢 P2P 热路径。未来启用 OPFS 前，需要重新验证吞吐、内存、崩溃恢复和 Safari/Firefox 兼容性。

### 4.2 外部文件句柄

支持 File System Access API 时，大于等于 30MiB 且通过句柄选择的文件可绑定本机原文件：

- UI 以 `💾` / “外部文件”标识；
- 有效句柄可以直接预览、下载并向远端供源；
- 句柄有效且无浏览器副本时，不显示“释放空间”或“还原文件”；
- 文件移动、改名、删除或权限撤销后，状态回退到普通恢复流程；
- 安全副本在确认其他设备拥有完整副本前可阻止释放，降低唯一来源丢失风险。

### 4.3 服务端来源

- Telegram 文件先尝试普通在线设备，必要时再使用 `file_id`；
- Telegram 云端 Bot API `getFile` 的 20MB 限制会在接收 update 时提前拦截；
- SNS 媒体由服务端按需下载并登记为 server asset；
- 客户端成功获取后立即缓存，并成为后续普通供源；
- 服务端临时资产不是永久网盘，部署者必须监控磁盘和清理策略。

## 5. 传输链路

### 5.1 选择顺序

文件恢复大致遵循：

1. 使用本机完整缓存或有效外部文件句柄；
2. 向服务端查询在线供源；
3. 尝试 WebRTC DataChannel P2P；
4. 大于 10MiB 的文件可使用多源范围拉取；
5. P2P 失败后降级到 Socket.IO Relay；
6. 普通供源不可用时，再尝试 Telegram 或 SNS 服务端来源。

### 5.2 当前调度参数

客户端主要限制：

- 完整下载并发 3；
- 多源下载并发 2；
- 下载总并发 4；
- 上传并发 2；
- 多源范围 2MiB，最多并行 4 个范围；
- 64KiB P2P/Relay 分块；
- 1MiB 及以下文件具有小文件优先级；
- P2P 首次等待 1500ms，文件 DataChannel 等待 5000ms；
- 多源 watchdog 3000ms，停滞判定 12000ms。

服务端按接收端和大文件数量限制活跃分配，并追踪供源负载、请求状态和 Relay 生命周期。参数不是越大越快：过高并发会放大 WebRTC 协商、IndexedDB、主线程 GC 和移动设备内存压力。

### 5.3 P2P 与代理/VPN

同一 Wi-Fi 不保证一定得到 `host ↔ host`。Android Chrome、VPN、mDNS、多网卡和不同 Origin 的权限状态都可能改变 ICE candidate 集合。

当前产品提供“增强局域网 P2P”：用户明确授权摄像头和麦克风后，媒体轨道立即停止、不上传音视频；持久化权限可能改善特定 Android Chrome/VPN 环境中的局域网候选暴露。该功能只提高成功率，原有 P2P 到 Socket.IO Relay 的兜底保持不变。

详细结论见 `docs/other/P2P_TRANSMISSION_NOTES-260812.md`。

## 6. 用户功能

### 6.1 文件与预览

- 文件选择器和多文件拖放；
- 合辑或拆分多条发送；
- Android PWA Share Target；
- 图片、视频、音频预览和全屏手势；
- 合辑宫格、跨文件导航、还原全部和 ZIP 下载；
- 缓存释放、恢复、下载、磁力链接分享和跨隧道转发；
- 文件、目录句柄挂载和目录同步。

### 6.2 消息与协作

- 文本、富文本和协同编辑；
- 富文本版本历史、双栏 Diff、离线草稿与冲突处理；
- 记录备注、锚点链接、详情浮层和收藏；
- 设备邀请、关注、备注与附近发现；
- 剪贴板共享、摄像头、语音聊天和对讲机。

### 6.3 媒体体验

- 视频和音频封面缓存；
- 音频临时试听和后台播放队列；
- Media Session 系统通知控制；
- 队列持久化、拖动排序、滑动删除、自动补充当前隧道音频；
- 歌曲收藏、分享、下载和定位原文件。

### 6.4 资源与备份

- 会话资源管理器、搜索、来源筛选、引用定位和最小化；
- 记录收藏/单文件收藏筛选；
- 元数据备份与含全部文件数据备份；
- 按原时间锚点或当前隧道尾部导入；
- 垃圾缓存扫描和清理。

## 7. Telegram 与 SNS

### 7.1 Telegram Bot

- `/tunnel <5位短码>` 进入固定隧道中转模式；
- `/leave_tunnel` 退出；
- 未绑定时暂存内容并提示输入短码；
- 文本、富文本、单文件和 album 合辑；
- 单文件/album caption 写入传输记录备注；
- 保存 Bot Token 后自动生成 webhook secret、注册 webhook 和命令；
- `file_id` 防失联检测、备份 Chat/Channel 和修复入口。

### 7.2 SNS 获取

浏览器或 Telegram 发送的正文/备注可识别 YouTube、YT Music、TikTok、Facebook、Instagram、Threads、LINE、Twitter/X 等链接。识别阶段只读取元数据；用户在记录详情页点击“获取文件内容”后才开始完整下载。

YouTube 视频按编码、分辨率和音频码率选源。YT Music 只获取音频，并整理歌曲元数据、来源 URL、方形封面和 M4A 文件名。下载依赖部署服务器的网络、`yt-dlp`、ffmpeg 和平台 cookies。

## 8. 服务端与管理

Node.js 服务端包括：

- Express 页面、PWA Manifest、Share Target 和 Range 下载；
- Socket.IO 会话、历史、设备状态、信令、协同编辑和 Relay；
- `sql.js`/SQLite 基础设施存储；
- 管理员 TOTP、14 天 HttpOnly 管理会话和管理 API 鉴权；
- `/admin` 隧道/设备管理；
- `/tgbot` Telegram 配置；
- `/sns-cookies` 第三方平台 cookies；
- `/api/debug-logs` 关联客户端/服务端诊断日志。

`.tunnel-data/` 保存基础设施数据库、管理员密钥、Telegram 配置/索引和 SNS cookies。生产环境必须限制文件权限并备份该目录。

## 9. 构建与部署

项目支持源码直跑和 profile 构建：

- `npm start`：按 `tunnel.config.json` 启动；
- `npm run dev`：使用本地代理默认值运行 yt-dlp；
- `npm run deploy:build -- --profile txsl --out dist`：按 profile 构建 `dist`；
- `npm run deploy:verify -- --dist dist --profile txsl`：校验发布产物；
- `tools/deploy/release.sh`：在独立 worktree 中按 profile 构建部署分支；
- `txsl`：Node.js 直接监听 80；
- `txhk`、`alyhk`：Node.js 监听 4000，由 Nginx 反向代理。

构建产物包含压缩并带内容哈希的静态资源、动态 Service Worker 应用壳、运行配置、发布元数据、Nginx 和 systemd 模板。

## 10. 安全边界

- HTTPS 和 WebRTC 保护传输链路，但当前没有应用层端到端加密；
- 隧道短码、二维码、链接和记录深链都应视为访问凭据；
- CORS、速率限制、输入大小和会话设备数在服务端校验；
- 管理 API 需要 TOTP 会话，首次绑定仅允许私网/回环访问；
- Telegram Token、TOTP Secret、SNS cookies 和 TURN 凭据不得提交到公开仓库；
- SNS 下载应遵守第三方平台条款和当地法律；
- 高敏感文件应在发送前自行加密。

## 11. 仓库结构

```text
file-tunnel/
├─ app.js                         # 主客户端业务与 UI
├─ service-worker.js              # PWA 应用壳与 Share Target
├─ server.js                      # Express、Socket.IO、Telegram、SNS
├─ client/
│  ├─ file-assets.js              # 文件传输、调度、P2P/Relay
│  ├─ cache-store.js              # 缓存驱动抽象
│  ├─ cache-store-worker.js       # OPFS Worker
│  ├─ media.js                    # 实时媒体控制
│  ├─ folder-archive.js           # ZIP/目录归档
│  └─ i18n-*.js                   # 多语言目录和运行时
├─ server/
│  ├─ file-assets.js              # 供源分配与 Relay
│  ├─ infra-store.js              # SQLite 基础设施数据
│  ├─ admin-auth.js               # TOTP 与管理会话
│  └─ media-session.js            # 媒体信令
├─ pages/                         # 主页面和管理页面
├─ tools/deploy/                  # 构建、校验、profile 和远端同步
├─ tests/                         # P2P 回归测试
├─ docs/                          # 指南、开发记录和专题文档
└─ .tunnel-data/                  # 运行时敏感数据，不应提交
```

## 12. 当前限制与后续方向

- 在不破坏吞吐的前提下重新评估 OPFS 接收写入；
- 为大文件增加真正可恢复的持久化分片状态；
- 继续降低多设备、多文件时的调度风暴和主线程压力；
- 跟踪 Chrome Local Network Access 对 WebRTC candidate 的实际支持；
- 为需要强连通性的部署提供可配置的文件 DataChannel TURN；
- 完善应用层端到端加密设计；
- 继续提升 iOS/Safari、Firefox 和旧 Android WebView 的兼容性。

## 13. 相关文档

- `docs/guide/Drop2Tunnel-Deployment-Guide.zh-CN.md`：部署、升级和排障；
- `docs/guide/Drop2Tunnel-User-Manual.zh-CN.md`：普通用户操作；
- `docs/other/P2P_TRANSMISSION_NOTES-260812.md`：代理/VPN 与 P2P 专题；
- `docs/devlog/dev-2607A-features.md`、`docs/devlog/dev-2607B-features.md`：详细开发记录。
