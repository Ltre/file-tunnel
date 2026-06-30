 - 计划新增服务端中继支援，组成一块中继网。
    这样可以让所有参与隧道传输的客户端设备有更多中继节点选择，网络体验更好。
    服务器需要邀请别的服务器中继并得到同意，才能合法加入中继网（在A节点提供的admin管理页面填写被邀请成为中继节点的服务端http/https地址，假定邀请了B节点，那么在B节点提供的admin管理页会收到A的邀请，可以同意或拒绝）。
    为了最大化组建中继网，允许不直接认识的节点之间，通过认识的节点，间接形成中继关系（例如A与B形成中继关系，B与C形成中继关系，那么A和C间接形成中继关系，日后A和C之间可以直接中继，只要物理空间上允许的话）。
    每个中继节点，都运行同一套程序，提供自己的HTTP/HTTPS/WebSocket服务。
    
    
能实现，而且这个方向非常适合 file-tunnel。它本质上是把单点服务端升级为：

> **联邦式中继网 / Relay Mesh / Tunnel Federation**

但要分清楚三件事：

```text
1. 节点发现：A 通过 B 知道 C 存在。
2. 节点信任：A 是否允许 C 给自己提供中继。
3. 数据转发：客户端到底通过哪个节点传输数据。
```

最容易出问题的是第二点。**中继关系不能无条件传递信任**。A 信任 B、B 信任 C，不等于 A 自动信任 C。更稳的设计是：

> A 可以通过 B 发现 C，但 A 和 C 要真正互相中继，仍然要完成一次自动或人工确认的 peering。

---

# 1. 总体可行性判断

可以实现，建议分三阶段：

```text
阶段一：中继节点目录共享
A 可以邀请 B，B 同意后，双方互相看到对方的 relay endpoint。
客户端拿到多个 relay candidates，自行测速并选择。

阶段二：中继网联邦发现
A-B、B-C 成立后，A 可以通过 B 发现 C。
A 和 C 可发起独立 peering，成功后变成直接中继关系。

阶段三：多跳中继 / Relay Routing
如果 A 无法直接访问 C，但 A 能访问 B、B 能访问 C，可以让数据经 A→B→C 中继。
这个最复杂，建议最后做。
```

我建议你先做 **阶段一 + 阶段二的发现**，暂时不要急着做真正多跳数据转发。因为客户端能直接连接 B/C 的 HTTP/WebSocket/TURN endpoint 时，体验已经会明显改善。

---

# 2. 你要做的不是“服务器列表”，而是“节点身份系统”

每个服务端节点都应该有稳定身份：

```js
{
  nodeId: "node_7f3a...",
  name: "Singapore Relay 1",
  publicKey: "...",
  baseUrl: "https://relay-a.example.com",
  wsUrl: "wss://relay-a.example.com",
  turnUrls: [
    "turn:relay-a.example.com:3478?transport=udp",
    "turns:relay-a.example.com:5349?transport=tcp"
  ],
  region: "SG",
  capabilities: {
    signaling: true,
    socketRelay: true,
    httpRelay: true,
    turnRelay: true,
    topologyExchange: true
  },
  limits: {
    maxFileSize: 2147483648,
    maxConcurrentTransfers: 100,
    maxRelayBytesPerDay: 107374182400
  },
  createdAt,
  lastSeenAt
}
```

`nodeId` 不建议用 URL 直接当身份。URL 会变，域名会迁移，证书会换。最好第一次启动服务端时生成一对密钥：

```text
node-private-key.pem
node-public-key.pem
```

节点身份由 public key 派生：

```text
nodeId = hash(publicKey)
```

以后节点之间的邀请、确认、心跳、能力声明都要签名，防止有人伪造节点。

---

# 3. 节点邀请流程建议

你描述的流程是：

> 在 A 的 admin 管理页填写 B 的服务端地址，B 的 admin 页收到邀请，可以同意或拒绝。

这个可以实现。建议流程如下。

## 第一步：A 创建邀请

A 管理员在 A 的 admin 填：

```text
https://relay-b.example.com
```

A 后端请求：

```http
GET https://relay-b.example.com/.well-known/file-tunnel-node.json
```

B 返回：

```js
{
  nodeId,
  name,
  publicKey,
  baseUrl,
  wsUrl,
  capabilities,
  version,
  signature
}
```

A 验证格式后，在 A 侧生成邀请：

```js
{
  inviteId,
  fromNodeId: A,
  toNodeId: B,
  fromBaseUrl,
  requestedScopes: [
    "relay:use",
    "relay:provide",
    "topology:exchange"
  ],
  message: "A wants to peer with B",
  createdAt,
  expiresAt,
  signatureByA
}
```

然后 POST 到 B：

```http
POST https://relay-b.example.com/api/federation/invites
```

---

## 第二步：B 的 admin 页显示邀请

B admin 页显示：

```text
收到节点邀请

来源节点：A
地址：https://relay-a.example.com
能力：HTTP Relay / WebSocket Relay / TURN Relay
请求权限：互相使用中继、交换拓扑
风险提示：同意后对方节点可向本节点申请 relay token

[同意] [拒绝] [仅允许发现，不允许中继]
```

这个地方要允许精细权限：

```text
只交换拓扑
允许 A 使用 B 中继
允许 B 使用 A 中继
双向中继
允许传播我的节点信息
不允许传播我的节点信息
```

---

## 第三步：B 同意后回调 A

B 同意后，B 生成 peering record：

```js
{
  peerNodeId: A,
  status: "accepted",
  scopes: ["relay:use", "relay:provide", "topology:exchange"],
  acceptedAt,
  signatureByB
}
```

B 回调 A：

```http
POST https://relay-a.example.com/api/federation/peering-accepted
```

A 验证 B 签名后，双方 peering 成立。

---

# 4. “间接形成中继关系”要谨慎设计

你说：

> A 与 B 形成中继关系，B 与 C 形成中继关系，那么 A 和 C 间接形成中继关系，日后 A 和 C 之间可以直接中继，只要物理空间上允许。

这个方向可以，但不要设计成：

```text
A 信任 B
B 信任 C
所以 A 自动信任 C
```

这会带来几个问题：

```text
1. B 可以把大量陌生节点引入 A 的中继网。
2. C 可能滥用 A 的流量。
3. A 不知道 C 的真实能力和限额。
4. 节点图会无限扩散，容易变成开放代理网络。
5. 如果某节点恶意，可能制造大量邀请、扫描、SSRF、流量消耗。
```

更合理的设计是：

```text
A-B 互信
B-C 互信
B 可以向 A 推荐 C
A 看到“推荐节点 C”
A 可选择：
  - 忽略
  - 仅加入目录
  - 发起独立 peering
  - 自动 peering，但受策略限制
```

也就是说：

> **拓扑发现可以传递， relay 授权不能自动传递。**

可以做一个策略：

```js
federationPolicy: {
  acceptIntroducedNodes: false,
  autoInviteIntroducedNodes: false,
  maxIntroductionDepth: 2,
  requireManualApprovalForRelay: true
}
```

如果你后期想提高自动化，可以允许：

```text
只自动发现，不自动授权
只允许低额度试用
只允许同一 owner group 内自动 peering
只允许白名单域名自动 peering
```

---

# 5. 中继网应该分成 Control Plane 和 Data Plane

## Control Plane：控制平面

负责：

```text
节点邀请
节点同意/拒绝
节点心跳
能力同步
拓扑交换
限额同步
relay token 签发
故障上报
路由候选生成
```

HTTP API 足够。

## Data Plane：数据平面

负责真正传文件：

```text
WebRTC TURN Relay
WebSocket Relay
HTTP Range Relay
WebTransport Relay
Socket.IO Relay
```

这里建议不要一开始搞复杂 server-to-server 转发。第一阶段最好是：

> 客户端直接连接选中的中继节点。

例如用户在 A 节点创建隧道，但 A 知道 B 是可信中继。A 可以给客户端下发：

```js
{
  relayCandidates: [
    {
      nodeId: "A",
      url: "wss://a.example.com/relay",
      priority: 100
    },
    {
      nodeId: "B",
      url: "wss://b.example.com/relay",
      priority: 90,
      token: "signed-relay-token"
    }
  ]
}
```

客户端自己测速，发现 B 更快，就直接连 B。

这比：

```text
客户端 → A → B → 对方客户端
```

更简单，也更快。

---

# 6. 推荐的传输路径选择

客户端进入隧道后，home server 返回：

```js
{
  tunnelId,
  homeNode: A,
  relayCandidates: [
    A,
    B,
    C
  ],
  turnCandidates: [
    A.turn,
    B.turn,
    C.turn
  ]
}
```

客户端自动跑 route probe：

```text
1. WebRTC direct host/srflx
2. TURN via A
3. TURN via B
4. TURN via C
5. WebSocket relay via A
6. WebSocket relay via B
7. HTTP range relay via nearest node
```

然后选择最快的。

可以设计评分：

```js
score = latencyWeight + routeTypeWeight + bandwidthWeight + reliabilityWeight + costWeight
```

优先级大概是：

```text
P2P host/srflx 直连
TURN UDP 最近节点
TURN TCP/TLS
HTTP/WebTransport Relay
WebSocket Relay
Socket.IO Relay
```

---

# 7. Relay Token 是关键

不能让任意客户端知道 B 的地址后就随便用 B 中继。A 要向 B 申请或签发一个被 B 认可的 relay token。

两种方式。

## 方案 A：B 签发 token

A 向 B 请求：

```http
POST https://relay-b.example.com/api/federation/relay-token
```

请求体：

```js
{
  tunnelId,
  fromNodeId: A,
  clientDeviceId,
  maxBytes,
  expiresAt,
  purpose: "file-transfer",
  signatureByA
}
```

B 返回：

```js
{
  relayToken,
  expiresAt,
  maxBytes,
  allowedEndpoints
}
```

客户端连接 B 时带 token：

```text
wss://relay-b.example.com/relay?token=...
```

B 验证 token 后允许中继。

## 方案 B：A 签发，B 验证 A 的签名

如果 A-B 已经 peering，B 保存 A 的 publicKey。A 可以直接签 token：

```js
{
  issuerNodeId: A,
  audienceNodeId: B,
  tunnelId,
  deviceId,
  maxBytes,
  expiresAt,
  nonce,
  signatureByA
}
```

B 验签即可。

这个性能好，但权限控制要谨慎。

---

# 8. Admin 管理页怎么展示中继网

你之前想做 admin 网络拓扑图，这里正好能接上。拓扑图可以分三种节点：

```text
设备节点 Device
隧道节点 Tunnel
中继节点 Relay Node
```

画法：

```text
[设备A] —— 加入 —— [隧道X] —— 使用中继 —— [Relay SG]
[设备B] —— 加入 —— [隧道X] —— 使用中继 —— [Relay HK]

[Relay SG] —— peering —— [Relay HK]
[Relay HK] —— peering —— [Relay JP]
```

节点状态：

```text
绿色：已 peering
黄色：收到邀请待处理
蓝色：推荐节点/间接发现
红色：不可达
灰色：已禁用
紫色：正在承担中继流量
```

中继节点详情：

```text
节点名
URL
NodeId
版本
地区
能力
当前连接数
今日中继流量
平均 RTT
失败率
直接 peer
推荐节点
是否允许拓扑传播
是否允许 relay
```

---

# 9. API 草案

## 节点元信息

```http
GET /.well-known/file-tunnel-node.json
```

返回：

```js
{
  nodeId,
  name,
  publicKey,
  baseUrl,
  wsUrl,
  version,
  capabilities,
  createdAt,
  signature
}
```

## 创建邀请

```http
POST /api/federation/invites
```

## 查看邀请

```http
GET /api/admin/federation/invites
```

## 同意邀请

```http
POST /api/admin/federation/invites/:inviteId/accept
```

## 拒绝邀请

```http
POST /api/admin/federation/invites/:inviteId/reject
```

## 节点心跳

```http
POST /api/federation/heartbeat
```

## 拓扑交换

```http
GET /api/federation/topology
```

返回直接 peer 和可推荐 peer：

```js
{
  selfNodeId,
  peers: [],
  introducedNodes: [],
  signedAt,
  signature
}
```

## 申请 relay token

```http
POST /api/federation/relay-token
```

## 客户端获取 relay candidates

```http
GET /api/sessions/:sessionId/relay-candidates
```

---

# 10. 数据库表 / 存储结构

如果你现在还是 JSON/SQLite 风格，可以先做这些表。

## relay_nodes

```js
{
  nodeId,
  name,
  baseUrl,
  wsUrl,
  publicKey,
  capabilities,
  status: "pending" | "active" | "blocked" | "offline",
  trustLevel: "direct" | "introduced" | "manual",
  introducedByNodeId,
  createdAt,
  updatedAt,
  lastSeenAt
}
```

## relay_peerings

```js
{
  peerNodeId,
  direction: "outbound" | "inbound" | "mutual",
  scopes,
  status: "invited" | "accepted" | "rejected" | "revoked",
  allowTopologyExchange,
  allowRelayUse,
  allowRelayProvide,
  maxBytesPerDay,
  createdAt,
  acceptedAt,
  revokedAt
}
```

## relay_invites

```js
{
  inviteId,
  fromNodeId,
  toNodeId,
  fromBaseUrl,
  requestedScopes,
  status,
  rawPayload,
  createdAt,
  expiresAt
}
```

## relay_usage

```js
{
  nodeId,
  tunnelId,
  deviceId,
  bytesIn,
  bytesOut,
  transferCount,
  routeType,
  createdAt
}
```

## relay_route_stats

```js
{
  nodeId,
  peerNodeId,
  rtt,
  successRate,
  avgThroughput,
  lastProbeAt
}
```

---

# 11. 安全问题必须一开始设计

这个功能很容易变成开放代理，所以要防护。

## SSRF 防护

A 管理员输入 B 的 URL 时，A 服务端会去请求 B。这会导致 SSRF 风险。

要防：

```text
默认禁止请求 localhost / 127.0.0.1 / 0.0.0.0
默认禁止请求内网 IP
默认禁止 file:// gopher:// ftp://
只允许 http/https
限制重定向次数
重定向后再次检查 IP
限制响应大小
设置短超时
```

如果用户自部署确实要邀请内网节点，必须 admin 显式开启：

```js
allowPrivateRelayNodeUrls: true
```

## 防止开放代理

每次 relay 必须有：

```text
有效 relay token
过期时间
最大字节数
绑定 tunnelId
绑定 deviceId
绑定 issuerNodeId
绑定 audienceNodeId
```

不要允许匿名连接 relay。

## 限额

每个 peer 设置：

```text
每日最大中继流量
最大并发传输
最大单文件大小
最大连接数
最大 token 数
```

## 审计

Admin 要能看到：

```text
哪个节点用了多少流量
哪个隧道用了哪个中继
哪个设备触发了 relay
失败原因
是否有异常峰值
```

## 黑名单

支持：

```text
禁用某个节点
撤销 peering
拉黑某个 nodeId
禁止某节点介绍新节点
禁止某节点使用本节点 relay
```

---

# 12. 数据传输层建议

## 第一版：客户端直连中继节点

最简单，最值得先做。

```text
设备1 —— B Relay —— 设备2
```

即便隧道是 A 管理的，只要 A 给设备签发 B 的 relay token，设备就可以直连 B。

## 第二版：HTTP Range Relay

大文件建议尽快做 HTTP Range Relay，而不是继续 Socket.IO chunk。

流程：

```text
发送端上传分片到 Relay B
接收端按 range 下载
中断后继续
Relay B 到期清理
```

好处：

```text
断点续传更稳
容易限速
容易统计
容易跨节点
比 Socket.IO 适合大文件
```

## 第三版：TURN Relay

如果每个节点都能提供 TURN，WebRTC 自己就能选中最近 relay。这个最好通过 coturn sidecar 做，不建议你用 Node.js 自己实现 TURN 协议。

节点配置里可以声明：

```js
turnServers: [
  {
    urls: [
      "turn:relay-b.example.com:3478?transport=udp",
      "turns:relay-b.example.com:5349?transport=tcp"
    ],
    credentialMode: "ephemeral"
  }
]
```

客户端拿短期凭证。

## 第四版：多跳 Relay

最后再做：

```text
设备1 → Relay A → Relay B → 设备2
```

这个要解决：

```text
多跳路由
环路检测
TTL
加密封包
拥塞控制
计费/限额分摊
节点失败重路由
```

第一阶段不建议做。

---

# 13. “同一套程序”可以，但要允许角色配置

你说每个中继节点都运行同一套程序，提供 HTTP/HTTPS/WebSocket 服务。可以。

但同一套程序应允许不同角色：

```js
roles: {
  homeServer: true,
  signalingServer: true,
  relayServer: true,
  turnProvider: false,
  topologyProvider: true,
  admin: true
}
```

有的节点只想做：

```text
只管理自己的隧道，不给别人中继
```

有的节点愿意做：

```text
给好友节点中继
```

有的节点只做：

```text
TURN 节点
```

这会让中继网更容易扩大。

---

# 14. 你说的“合法加入中继网”要落实成授权模型

“合法”不是只靠 admin 点同意，要体现在协议里：

```text
1. 节点有身份公钥。
2. 邀请有签名。
3. 同意有签名。
4. relay token 有签名。
5. token 绑定用途、限额、有效期。
6. 节点可以撤销 peering。
7. 节点可以拒绝间接传播。
```

这样才能避免变成任何人随便填 URL 就蹭中继。

---

# 15. 推荐落地路线

## Step 1：单节点中继能力标准化

先把当前服务端能力描述出来：

```http
GET /.well-known/file-tunnel-node.json
```

同时 admin 页显示本节点：

```text
Node ID
Public Key
Base URL
WebSocket URL
TURN 配置
Relay 能力
```

## Step 2：手动添加可信 relay 节点

先不要做邀请流程，先允许 admin 手动添加：

```text
添加可信中继节点 URL
测试连通性
保存
客户端获取 relayCandidates
```

这一步最快验证“多 relay 候选是否改善体验”。

## Step 3：正式邀请/同意流程

实现：

```text
A 邀请 B
B admin 收到
B 同意
A/B peering 生效
```

## Step 4：relay token

实现跨节点中继授权：

```text
A 管理隧道
B 提供 relay
A 给客户端发 B relay token
客户端连接 B relay
```

## Step 5：拓扑交换

实现：

```text
A 从 B 得知 C
A 显示 C 为“推荐节点”
A 可邀请 C
```

## Step 6：Admin 拓扑图

展示：

```text
节点关系
隧道关系
设备关系
中继流量
链路状态
```

## Step 7：HTTP Range Relay / TURN Mesh

让大文件中继更专业。

## Step 8：自动路由选择

客户端和服务端共同维护 route stats：

```text
上次哪个中继最快
哪个中继失败率高
当前哪个地区 RTT 低
```

---

# 16. 最小可行版本建议

你可以先做一个非常小的 MVP：

```text
1. 每个服务端生成 nodeId/publicKey/privateKey。
2. 暴露 /.well-known/file-tunnel-node.json。
3. Admin 可添加 relay node URL。
4. 服务端保存 relay_nodes。
5. 客户端加入隧道时收到 relayCandidates。
6. 客户端对 relayCandidates 做 RTT 测试。
7. 文件传输时优先选择最快 relay。
```

这个版本不需要邀请流程，但能验证中继网的价值。

第二版再加：

```text
邀请/同意
relay token
topology exchange
```

这样风险低很多。

---

# 17. 最终判断

可以实现，而且值得做。它会让 file-tunnel 从：

```text
一个单服务端传输工具
```

升级成：

```text
一个可联邦扩展的跨平台传输网络
```

但要记住一个原则：

> **节点发现可以传递，节点信任不能自动传递；中继使用必须有 token、限额和审计。**

你的中继网最佳形态不是“开放代理网络”，而是：

```text
熟人节点联邦
可邀请
可同意
可撤销
可限额
可测速
可选择最优路径
```

这会非常符合 file-tunnel 的“世界藤壶”方向：到处接内容入口，背后用一张可扩展中继网保证不同设备、不同网络、不同地区之间都能尽量顺畅地进入同一个隧道。
