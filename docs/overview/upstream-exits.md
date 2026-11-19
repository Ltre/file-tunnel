# 上游网络出口管理、Trojan 节点与任务级路由

> **源码基线 Commit**：`1da33930cfb0f7022114825e2cb300ce18ff4eae`
> **文档更新时间**：2026-11-19

## 1. 模块定位

上游出口管理控制的是 **Drop2Tunnel 服务端访问外部平台时使用的网络出口**，不是用户浏览器/手机的系统 VPN，也不改变浏览器 WebRTC 的 ICE 路由。

核心目标是：按服务管理可用出口节点；任务可指定初始出口；在任务尚未取得有效内容前按允许候选尝试；一旦取得有效内容即锁定，后续请求沿用同一节点，避免元数据解析和实际下载走不同地区。

主要实现：

- `server/upstream-exits.js`：配置、任务上下文、候选选择、锁定、sing-box 生命周期和 fetch 路由；
- `server/upstream-exit-routes.js`：管理员页面/API 路由；
- `client/upstream-exits.js/.css`：后台节点与服务策略界面；
- `client/upstream-exit-select.js`：SNS/YouTube 任务出口选择和路由记录展示；
- `pages/upstream-exits.html`：后台管理页；
- `tools/sing-box/**`：原生 sing-box 运行文件及校验清单。

## 2. 服务分类

| 服务 | 域名范围 |
|---|---|
| `telegram` | telegram.org、t.me、telegram.me |
| `youtube` | youtube.com、youtu.be、googlevideo.com、ytimg.com、ggpht.com |
| `twitter` | x.com、twitter.com、twimg.com |
| `facebook` | facebook.com、fb.watch、fbcdn.net |
| `line` | line.me、line-apps.com |
| `instagram` | instagram.com、cdninstagram.com、threads.net、threads.com |
| `tiktok` | tiktok.com、tiktokcdn.com、tiktokv.com |
| `bilibili` | bilibili.com、b23.tv、bilivideo.com、hdslb.com |
| `netease` | 163.com、126.net、163cn.tv、163cn.link |
| `other` | 以上未匹配的外部域名 |

Threads 当前归入 `instagram` 服务策略。未配置某服务策略时，原有网络请求路径保持不变。

## 3. 节点与服务策略

### Trojan 节点

节点包含名称、服务器地址、端口、Trojan 密码、TLS SNI、是否验证 Trojan 服务端证书、备注和 revision。节点以独立 ID 管理，服务器地址/端口相同不代表是同一个节点。

密码只保存在服务端配置中；公开 API 只返回 `hasPassword`，不返回密码。节点保存与删除各自独立，不会因为保存配置就启动 sing-box。

### 每个服务独立的出口策略

服务策略包含：

- `defaultExit`：默认节点或 `direct`；
- `enabledNodes`：明确允许参与候选轮换的节点 ID；
- `order`：候选顺序；
- `mode`：`ordered` 或 `random`；
- `includeDirect`：是否允许本机直连参与候选。

**候选启用必须明确勾选。** 仅有旧版本保存的节点排序，不会自动视为用户同意启用所有节点。未勾选的节点不会进入候选；新建节点也不会自动加入所有服务的候选列表。

默认出口或任务指定出口是首个尝试项。后续候选只从该服务明确启用的节点和允许的 direct 项中选择。顺序模式按配置顺序尝试；随机模式只打乱允许候选，不会引入未勾选节点。

## 4. 任务级选择与锁定

SNS 和 YouTube Premium 页面在格式解析表单中提供“网络出口”选择：

- 留空：使用该服务默认出口；
- 选择“本机直连”：本任务以 direct 为首选；
- 选择某个节点：本任务以该节点为首选；
- 任务列表可展开“查看使用的网络出口记录”，查看初始尝试、候选结果和最终采用出口。

格式解析请求通过 `networkTicket` 把任务上下文传递到后续下载。实际任务通过 `runTask()` 建立独立 AsyncLocalStorage 上下文，最终状态记录为 `networkRoute`。

锁定规则：

1. 缓存命中不代表当前出口已被验证，也不会仅因读取缓存就锁定；
2. 辅助元数据不满足业务校验时，不锁定出口；
3. 第一个通过业务校验的实际内容成功返回后，记录成功节点并锁定；
4. 锁定后同一任务后续请求失败，不再切换到其它节点；
5. 新任务按自己的服务默认值或任务指定值重新开始；
6. 已锁定任务所用节点若被删除，任务失败并提示原节点不存在，不自动改用另一个节点。

各服务策略互相独立，并发任务通过独立上下文和配置快照隔离。复制下载表单时会清除旧分析结果中的 `networkTicket/networkRoute`，新草稿不会继承上一任务已锁定的出口。

## 5. 接入边界

- 普通 HTTP 请求通过 Undici `ProxyAgent` 使用本地 sing-box HTTP 代理。
- yt-dlp 通过命令行 `--proxy` 接入，不依赖 shell 的 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 环境变量。
- SNS 帖子网页/媒体读取通过 `publicProxy` 接入任务上下文。
- Telegram Bot API 与网盘远程操作通过 `wrapService('telegram', ...)` 接入 Telegram 服务策略；流式读取在响应流结束前保持运行时租约。
- Telegram 读取请求和其它明确的内容读取路径可在尚未锁定时按候选尝试；上传、发布、删除等有副作用的写入操作**不会自动重放**，避免重复副作用。
- Telegram 包装器只对实际远程方法建立异步上下文；本地同步校验、guard、访问器、Symbol 和 `this` 语义保持原样。

## 6. sing-box 运行时

- 项目随附官方 sing-box **1.14.4** Windows x64 与 Linux x64 运行文件、许可证及 SHA-256 manifest；没有随附 macOS/ARM 版本。
- 只有任务实际选择 Trojan 节点时才按需启动 sing-box；本地 HTTP 代理绑定 loopback 临时端口，不对局域网开放。
- 相同配置快照的并发任务共享运行进程，按引用计数管理；最后一个任务结束后空闲约 30 秒自动停止。运行中配置更新使用新快照，不强行切换正在执行的任务。
- Trojan TLS 始终启用；`verifyTls` 仅控制是否验证 Trojan 服务端证书。它不是关闭目标 HTTPS 校验的开关。TLS SNI 可以与连接地址不同，以适配不终止 TLS 的 TCP 中转。
- sing-box 本机代理只服务 Node/yt-dlp 的服务端出站请求，不会修改用户设备的系统代理、浏览器代理或 WebRTC ICE 路由。

## 7. 管理页面与接口

管理页：`/upstream-exits`。页面/API 均要求管理员 Session：

- `GET /api/upstream-exits`：读取节点、服务策略及运行状态；
- `POST /api/upstream-exits/nodes`、`PUT/DELETE /api/upstream-exits/nodes/:id`：节点管理；
- `PUT /api/upstream-exits/services/:id`：独立保存服务策略；
- `POST /api/upstream-exits/test`：指定出口测试网页；
- `POST /api/upstream-exits/confirm`：用户主动确认出口 IP。

Trojan 节点列表位于左侧，右侧显示所选节点窄表单；上游服务也按左侧服务标签、右侧单服务表单组织。节点和每个服务都有独立保存操作；Trojan 区域默认折叠。

出口 IP/网页测试由用户点击触发，固定使用指定出口，不自动轮换；不做后台 IP 轮询、地区推断或自动节点排序。

## 8. 配置、日志与部署

- 配置文件：`.tunnel-data/upstream-exits.json`，目录/文件按最小权限创建，文件权限为 0600。
- 运行时文件：`.tunnel-data/upstream-runtime/`。
- API 不返回节点密码；日志对节点密码、Bot token、Cookie、URL 用户凭据及敏感查询参数脱敏。
- 项目最低 Node 版本为 **22.16.0**；Undici 固定为 **7.30.2**。
- `tools/deploy/build.mjs` 复制 sing-box 文件，`tools/deploy/verify.mjs` 检查新增页面路由和发布资源。

## 9. 测试与限制

相关测试：

- `tests/upstream-exits-261114.test.cjs`
- `tests/upstream-native-261114.test.cjs`
- `tests/upstream-cache-261114.test.cjs`
- `tests/upstream-candidates-261119.test.cjs`
- `tests/disk-admin-download-261118.test.cjs`
- `tests/sns-media-route-261117.browser.cjs`
- `tests/sns-bilibili-261117.test.cjs`

开发日志记录 Node 22.16.0 相关单元/集成批次 112/112、系统 Chrome 35/35 和隔离 Trojan TLS 夹具验证。它们不是所有服务/所有真实账号的全量验收。

Linux sing-box 原生执行尚未验证；没有 macOS/ARM 二进制；未逐一使用真实用户凭据验证所有上游服务。真实手机、用户实际代理网络和现场出口可用性仍需用户环境验收。
