# 独立设备主页、设备直连动作与定向隧道

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 模块定位

Drop2Tunnel 的“设备”不只存在于某个隧道的在线设备列表中。当前系统还保留一套以稳定 `deviceId` 为核心的独立设备主页和跨隧道定向交互能力。

主要实现：

- `pages/device.html`
- `client/device-camera.js`
- `app.js`
- `server.js`

历史来源主要包括：

- `docs/devlog/dev-260625-multi-relay-step3.md`
- `docs/devlog/dev-260625-multi-relay-step4.md`
- 2026-06-26 以后设备资料、联系人、跨隧道呼叫相关提交。

这一模块的初衷是：用户认识的是“某台设备”，而不是永远记住某个隧道。设备主页因此提供从设备身份直接进入语音、对讲、摄像头和定向隧道的入口。

## 2. 独立设备 URL

服务端提供：

- `/device/:deviceId`
- `/device.html`
- `GET /api/devices/:deviceId`

设备主页不会展示该设备文件内容，只展示建立连接和识别设备需要的资料。

当前页面会读取并显示：

- 在线状态；
- 活跃状态；
- 设备名称；
- Device ID；
- 设备型号；
- 内网 IP；
- 外网 IP；
- 首次访问时间；
- 最后访问时间；
- User-Agent / 浏览器信息；
- 设备主页 URL / QR。

页面有明确提示：设备主页只展示连接所需基础资料，不存储或展示设备中的文件内容。

## 3. 设备主页 UI

主要操作：

- `☎ 语音通话`
- `📢 对讲机`
- `📷 打开对方的摄像头`
- `◉ 共享我的摄像头`
- `⇄ 开始隧道传输`
- `复制设备链接`
- `返回首页`

QR 指向设备主页本身，而不是某个当前隧道。

因此设备主页和“隧道二维码”必须区分：

- 隧道 QR：加入一个 session；
- 设备 QR：识别并打开某个 device profile。

## 4. Profile Device 注册

独立设备页没有完整启动功能首页的隧道运行时，但仍需要能接收定向邀请。

页面建立 Socket.IO 后会发送：

`register-profile-device`

服务端把该页面注册到目标 `deviceId` 的可达 socket 集合中。

这允许即使目标用户停留在独立设备页，也能收到：

- 定向隧道邀请；
- 摄像头请求；
- 对应 ACK / signaling。

不要把这种 profile socket 误当成“已经加入某个隧道”。

## 5. 定向隧道池

设备页使用本地：

`directTunnelPool`

按目标 `deviceId` 保存一个可复用的 session ID。

目标是让 A 与 B 多次点击“开始隧道传输”时，可以倾向复用两台设备已经建立的直接隧道，而不是每次制造一个完全新会话。

如果不存在合法 session ID，则生成一个新的 UUID 并写入 localStorage。

这只是发起设备本地的映射，不是服务器端全局联系人数据库。

## 6. 发起定向隧道

`startTunnelTransfer()` 大致流程：

1. 读取目标 device profile；
2. 阻止向自己发起；
3. 从 `directTunnelPool` 获取或创建 sessionId；
4. 生成 `invitationId`；
5. 生成带有：
   - `open=1`
   - `invite=<invitationId>`
   - `from=<deviceId>`
   - URL hash sessionId
   的功能首页链接；
6. 发送 `device-tunnel-invite`；
7. 如果目标在线并收到，提示邀请已推送；
8. 如果目标离线，则放入本机待发送队列；
9. 发起方随后进入对应隧道。

## 7. 离线邀请队列

本地键：

`deviceTunnelInviteQueue`

设计原因是目标设备可能当前不在线。

发起方不会因为即时投递失败就直接丢弃邀请，而是保存最近待发送邀请；完整功能首页连接 Socket 后会继续处理 pending invite。

该队列属于浏览器本地状态，不是保证离线消息永久送达的服务器消息系统。

## 8. 邀请接收与 Claim

设备页可能同时开多个 Tab。为了避免同一个邀请同时在多个 Tab 弹窗，页面使用：

`deviceTunnelInviteClaim:<invitationId>`

做本地 claim，包含 owner page ID 和过期时间。

当前 claim TTL 约 10 分钟。

接收流程：

1. 收到 `device-tunnel-invite`；
2. 尝试 claim；
3. 当前页面可交互时显示“传输隧道邀请”；
4. 不可见时优先尝试系统 Notification；
5. 用户选择进入或暂不进入；
6. 发送 `device-tunnel-invite-ack`；
7. 接受后打开邀请 URL。

因此不能简单删除 claim 逻辑，否则多标签页会产生重复确认。

## 9. 语音通话入口

设备主页的“语音通话”没有在 standalone page 内直接完整运行联系人呼叫状态机。

当前做法：

- 获取与目标设备对应的 direct tunnel session；
- 跳转功能首页；
- URL 携带：
  - `open=1`
  - `from`
  - `call=<targetDeviceId>`
  - `callName=<targetName>`
  - session hash。

功能首页初始化完整 MediaController 后，再继续联系人语音呼叫。

这是有意的架构边界：独立 profile 页负责导航和轻量连接，不复制一套完整媒体运行时。

## 10. 对讲机入口

与语音类似，设备主页通过 URL 参数：

- `intercom=<targetDeviceId>`
- `intercomName=<targetName>`

跳回功能首页，再由主应用发起定向对讲。

## 11. 摄像头直连

摄像头是例外：独立设备页通过 `client/device-camera.js` 提供轻量 `DeviceCameraBridge`，可以直接处理：

- 打开对方摄像头；
- 共享我的摄像头。

服务端事件：

- `device-camera-request`
- `device-camera-response`
- `device-camera-signal`
- `device-camera-stop`

request mode：

- `open-remote`
- `share-mine`

signaling kind：

- offer；
- answer；
- ice。

这条链路和主应用的 tunnel camera broadcast 不是同一个状态机，修改时不要把两者强行合并。

## 12. 联系人与 Follow

设备 profile 体系后来又发展出本地联系人：

- Follow / Unfollow；
- `contacts` IndexedDB；
- 联系人资料；
- 跨隧道语音；
- 对讲入口；
- last seen。

联系人身份仍以 deviceId 为核心。

联系人数据当前主要是浏览器本地资料；服务端在线可达性来自 `deviceSockets` / profile registration。

## 13. 历史演进

### 2026-06-25

设备名称从普通列表文本演进为可打开 profile；开始有：

- Profile modal；
- Follow；
- Contacts；
- 跨隧道 Contact Call。

### 2026-06-25 Step 4

进一步形成：

- `/device/:deviceId`；
- profile QR；
- 大型快捷操作；
- direct tunnel invite；
- offline pending invite。

### 后续

又增加：

- 设备摄像头桥；
- 更完整 contact call 状态机；
- notification；
- remote preview。

因此当前“设备能力”跨越多个模块，但独立设备页是它们的导航聚合点。

## 14. 修改时的边界

后续 Agent 应特别避免：

- 把 device profile URL 当成 session URL；
- 把 profile socket 误判为已加入隧道；
- 为独立页面再复制一套联系人语音状态机；
- 删除 `directTunnelPool` 后导致每次发起都制造新隧道；
- 让多 Tab 同时处理同一 invite；
- 把离线本地 pending queue 描述成服务端可靠离线消息；
- 把 device camera bridge 与 tunnel camera broadcast 混为一条链路。
