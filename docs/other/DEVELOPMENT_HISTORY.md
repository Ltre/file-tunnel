# Drop2Tunnel 开发历史

> 当前开发基线：`dev/2608A-NEWCODE`，核对至 `4af5873`（2026-08-12）。
> 本文按功能阶段整理，不把临时调试提交等同于正式稳定版本；精确差异应以 Git 提交、标签和对应 devlog 为准。

## 1. 早期版本

### 1.0.0（2026-06-21）

初始可用版本建立了项目的基本形态：

- 浏览器加入同一会话并交换文本、文件和富文本；
- Socket.IO 负责在线状态、消息和 WebRTC 信令；
- WebRTC DataChannel 负责设备间文件传输；
- IndexedDB 保存本机消息、文件和编辑器数据；
- 二维码和 URL hash 用于加入会话。

### 1.1.0（2026-06-21）

- 修复协同编辑在部分浏览器中的 `IDBKeyRange` 兼容问题；
- 加强 PeerConnection 状态检查、ICE 重启和连接复用；
- 补充基础错误处理与版本回溯说明。

## 2. 2606C 至 2607A：产品能力扩展

这一阶段从“简单文件传输页”发展为完整的多设备隧道应用，主要包括：

- 5 位隧道短码、隧道备注、路由页和隧道切换；
- 单文件、拆分多条和多文件合辑；
- 图片、视频、音频预览以及全屏手势；
- 合辑宫格、相邻文件切换和跨记录媒体浏览；
- 本地滚动锚点、传输记录深链和单条记录详情；
- 汉堡菜单、记录备注、跨隧道转发和删除优化；
- 会话资源管理器、最小化胶囊、引用定位和垃圾清理；
- 元数据备份、含完整文件数据备份及导入锚点策略；
- File System Access API 文件/目录句柄、外部文件状态和安全副本；
- 富文本直接编辑、版本历史、双栏 Diff 与离线冲突处理；
- 隧道所有者、管理员和默认权限；
- 音频预览、后台音乐队列、Media Session、收藏与文件定位；
- Telegram Bot 中转、相册合辑、备注同步、`/tunnel` 与 `/leave_tunnel`；
- 管理后台 TOTP、管理员 Cookie、高风险 API 鉴权；
- 简体中文、繁体中文、英语、日语、法语、俄语、西班牙语、意大利语、韩语、马来语、印尼语、越南语和泰语。

## 3. 1.7.0 至 1.7.4：权限、收藏、SNS 与部署工具

### 1.7.0（2026-07-07）

- 完成跨隧道转发、文件预览层级和记录详情；
- 加入富文本版本历史、冲突处理和隧道权限；
- 将文件夹、目录同步、资源管理器和备份工具集中到设置页；
- 建立客户端与服务端多语言框架。

### 1.7.1 至 1.7.3

- 扩充静态、动态和 Telegram 交互文本的翻译目录；
- 将“记录收藏”和“单文件收藏”分离；
- 合辑成员可独立收藏，音乐播放器收藏归入单文件收藏；
- 资源管理器增加“已收藏”和 Telegram 渠道筛选；
- 识别 Telegram 文本、单文件 caption 和 album caption 中的 SNS URL；
- 增加 `/sns-cookies` 管理页，YouTube 与 YT Music 共用 `yt-cookies.txt`。

### 1.7.4：可控构建与部署

- 引入 `tools/deploy/build.mjs` 和 `verify.mjs`；
- 前端 JS/CSS 生成内容哈希文件名并压缩；
- Service Worker、运行配置、PWA Manifest 和构建元数据随 profile 生成；
- 提供 `txsl`、`txhk`、`alyhk` 三套部署 profile；
- `release.sh` 使用独立 worktree 构建部署分支；
- `deploy-remote.sh` 使用不带 `--delete` 的 rsync 同步发布目录。

## 4. 1.7.8 至 1.7.11：SNS 媒体获取与 YT Music

### 1.7.8：多源传输基线

- 大文件可从多个在线供源设备按范围拉取；
- 收发任务按队列和并发上限调度；
- 修复重复上传、分片进度归零和缓存完成后 UI 不更新等问题；
- 增加 P2P、multi-source P2P 和 Socket.IO Relay 路由日志。

### 1.7.9：浏览器与 Telegram 统一的 SNS 获取

- 浏览器直接发送含 YouTube/YT Music 等链接的文本或备注，也会进入 SNS 元数据扫描；
- 传输记录显示 `◉SNS`，详情页按媒体项提供“获取文件内容”；
- 生成的 SNS 文件记录关联原始链接记录，且不会递归显示获取入口；
- 普通 YouTube 优先 H.264、最高 1080p，再按可用编码降级；
- YT Music 只下载音频，并按接近 256K、128K 的实际码率选择 AAC/M4A；
- 写入曲名、艺术家、专辑、年份和来源 URL，裁剪封面黑边并嵌入 M4A；
- 文件名整理为“艺术家 - 曲名.m4a”；
- 服务端增加获取任务队列、幂等控制、进度和 server asset 交付。

### 1.7.10 至 1.7.11

- 兼容 YouTube JS challenge remote components；
- 支持按部署 profile 配置 `ffmpegLocation`；
- 修复 Windows Server 下 Node.js/yt-dlp 无法从交互式终端 PATH 找到 ffmpeg 的问题；
- Telegram 超过 20MB 的云端 Bot API 文件在下载前拦截，并附官方说明。

## 5. 1.7.12：功能整合基线

`0b8e4e18b84a035586a17977de76c7c701945995` 被用作后续 P2P 回归的重要稳定对照基线。该阶段还完成：

- PWA `/share` 与 `/share/` 入口兼容；
- 多文件 Share Target 队列和“发送处理中”占位；
- 多文件拖放及目录拖放过滤；
- 合辑“还原所有文件”；
- 传输进度抽屉的任务摘要、折叠和拖动；
- admin 隧道列表显示短码；
- Telegram/SNS 历史元数据与文件内容解耦，避免单个 server asset 阻塞后续记录；
- 成功拉取 Telegram/SNS 文件的浏览器立即成为普通文件供源。

## 6. 1.7.13 至 1.7.27：传输稳定性集中调试

2026 年 7 月中旬至 8 月上旬，开发重点集中在多设备、多文件、代理/VPN 和大文件场景。主要问题和修复包括：

- P2P 建链过早降级、DataChannel 背压和缓冲区灌满；
- 多源分片与完整传输并发导致进度回退、重复上传和范围不匹配；
- P2P 已到 100% 但完成确认竞态触发 Relay 重传；
- 上传/下载进度残留、多个相同进度条和页面资源耗尽；
- 网络切换后请求状态、供源状态和本机缓存状态不一致；
- Socket.IO Relay 长任务阻塞后续小文件；
- Service Worker 缓存旧版文件导致客户端混跑不同传输协议；
- SDP/ICE 信令错投、重复 offer、错误 ICE restart 和 heartbeat/retry 风暴；
- 多网卡、mDNS、VPN/代理环境下 host candidate 可达性差异；
- 资源管理器扫描和高频进度渲染造成移动端卡顿。

这一阶段的结论不是“增加等待时间就能解决 P2P”。稳定性依赖候选是否被浏览器暴露、selected candidate pair、DataChannel 完成确认、客户端版本一致性和 Relay 兜底。两份测试矩阵记录在：

- `docs/other/TECH_CHALLENGES_OF_TRANSMISSION (260810, stable-1.7.12).md`
- `docs/other/TECH_CHALLENGES_OF_TRANSMISSION (260811, stable-1.7.27).md`

## 7. 1.7.28 / 2608A：增强局域网 P2P 与经验沉淀

2026-08-12 的当前开发基线加入：

- 设置页“增强局域网 P2P”入口；
- Android Chrome 与 VPN/代理并用时，由用户明确授予摄像头和麦克风站点权限；
- 媒体轨道只短暂启动并立即停止，不上传音视频；
- HTTPS 页面在检测到同局域网设备或实际走 Relay 后，显示一次非阻塞引导；
- 客户端/服务端关联调试日志和 P2P 回归测试继续保留；
- 将代理、权限、mDNS、Local Network Access、STUN/TURN/Relay/OPFS 的边界整理到 `docs/other/P2P_TRANSMISSION_NOTES-260812.md`。

## 8. 当前实现边界

- 文件主要由浏览器缓存、外部文件句柄和在线设备副本提供，服务端不是永久网盘；
- 接收侧 OPFS 写入当前关闭，主要仍以内存聚合和 IndexedDB Blob 落库；
- 没有完整的持久化分片断点续传协议；
- 没有应用层端到端加密；
- 没有 TURN 时，部分 NAT、VPN 或浏览器隐私策略只能走 Socket.IO Relay；
- “增强局域网 P2P”提高特定 Android Chrome/VPN 场景成功率，但不是强制直连开关；
- 第三方 SNS 获取依赖服务器网络、cookies、`yt-dlp`、ffmpeg 和平台策略。

## 9. 查阅精确变更

- `docs/devlog/dev-2607A-features.md`：2607A 大量产品功能和回归修复；
- `docs/devlog/dev-2607B-features.md`：2607B 传输、SNS 和调试记录；
- `docs/other/P2P_TRANSMISSION_NOTES-260812.md`：P2P、代理和浏览器权限经验；
- Git 提交和标签：精确代码版本的唯一依据。
