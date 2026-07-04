研究需求: 近场发现：两台设备只要打开PWA或者网页，就能在附近被发现。






可以做，但要先把“附近”定义现实一点：

> **纯 PWA / 网页不能像原生 App 那样在局域网里广播自己、监听端口、被别人扫到。**
> 但可以做一个体验上很像“近场发现”的系统：**服务器辅助发现 + 同公网 IP/历史关系筛选 + WebRTC 链路探测 + 用户确认加入**。

也就是说，第一版不要叫“局域网扫描附近设备”，更准确叫：

> **寻找附近和最近可连接设备。**

这样既不会被浏览器能力卡死，又能做出接近 Quick Share / AirDrop 的体验。

---

# 1. 浏览器/PWA 的能力边界

## 纯网页不能做的事

普通网页/PWA 不能：

```text
监听 TCP/UDP 端口
UDP 广播 / 组播
mDNS 注册服务
像原生 App 一样后台蓝牙扫描
像系统 Nearby Share 一样自动发现附近手机
让别人主动扫到当前网页
```

Chrome 的 Private Network Access 也在限制网页访问私有网络目标，目标是防止网页攻击路由器、内网服务等私有网络资源；Chrome 文档说明私有网络请求会被纳入安全限制，并要求更明确的授权/预检机制。([Chrome for Developers][1])

所以不能指望：

```text
两台设备只要打开网页，就自动在局域网广播，然后彼此发现
```

纯 Web 做不到这个级别。

---

## Web Bluetooth 也不是万能近场发现

Web Bluetooth 可以让网页请求连接附近 BLE 设备，但它需要用户手势触发，浏览器会弹设备选择器，用户只能选择一个设备；Chrome 文档明确说 `navigator.bluetooth.requestDevice()` 必须由点击/触摸等用户手势触发，并会显示 chooser 让用户挑选设备。([Chrome for Developers][2])

更关键的是：Web Bluetooth 页面通常扮演 Central 角色去连接 BLE GATT 设备，不是让两个普通网页互相广播成为“附近设备”。([Chrome for Developers][2])

所以它不适合作为第一版“打开 PWA 就被发现”的主方案。

---

## Web NFC 也不适合“附近自动发现”

Web NFC 目前主要是读写 NFC 标签。Chrome 文档明确写到 Web NFC 限于 NDEF 标签读写，不支持 Peer-to-Peer 和 HCE。([Chrome for Developers][3])

它适合做：

```text
碰 NFC 标签进入隧道
```

不适合做：

```text
两台手机打开 PWA 后互相发现
```

---

# 2. 最可行方案：服务器辅助近场发现

第一版建议做成：

> **设备打开 PWA/网页后，向同一个 file-tunnel 服务端登记“我正在可发现”。服务端按关系和网络特征筛选候选设备。前端再用 WebRTC 做轻量链路探测，最终展示为附近设备。**

这个模型非常适合你现在的架构，因为 file-tunnel 本来就有 Socket.IO、deviceId、session、tunnel、传输记录、P2P 探测。

---

# 3. 发现模型建议：不要只靠一个条件

“附近”应该是综合评分，不是单一判断。

可以分成 5 层：

```text
L1：同一隧道内在线设备
L2：曾加入过同一隧道的在线设备
L3：同一公网 IP 下的在线设备
L4：WebRTC 探测显示可直连/低延迟的设备
L5：同账号/同设备组/最近配对设备
```

最终 UI 不直接说“附近 100%”，而是显示：

```text
附近可连接
可能在同一网络
曾一起使用过隧道
可直连
需要中继
```

这样既有产品体验，又不技术虚假。

---

# 4. 设备打开 PWA 后上报什么

设备进入首页或近场发现页时，通过 Socket.IO 发：

```js
socket.emit('nearby-presence-update', {
  deviceId,
  deviceName,
  deviceModel,
  platform,
  browser,
  pwaInstalled,
  currentTunnelId,
  lastTunnelIds,
  visible: true,
  visibleUntil: Date.now() + 10 * 60 * 1000,
  capabilities: {
    webrtc: true,
    webNfc: 'NDEFReader' in window,
    webBluetooth: !!navigator.bluetooth,
    shareTarget: true
  }
});
```

服务端补充：

```js
{
  observedIp,
  userAgentHash,
  socketId,
  lastSeenAt,
  joinedTunnelIds,
  recentTunnelIds,
  relayRegion,
  serverNodeId
}
```

注意：客户端不要自己声称公网 IP，由服务端根据连接来源记录。

---

# 5. 候选设备筛选规则

服务端可以返回一个候选列表：

```js
{
  candidates: [
    {
      deviceId,
      deviceName,
      deviceModel,
      platform,
      browser,
      relation: {
        sameTunnel: true,
        mutualTunnelCount: 2,
        sameObservedIp: true,
        recentPaired: true
      },
      confidence: 86,
      reasons: [
        'same-observed-ip',
        'mutual-tunnel',
        'recent-online'
      ],
      currentTunnelId,
      lastSeenAt
    }
  ]
}
```

评分建议：

```text
同当前隧道：+100
共同历史隧道：+60
同公网 IP：+40
最近 10 分钟上线：+20
曾经配对过：+30
同账号设备组：+80
WebRTC host/srflx 直连成功：+80
WebRTC TURN 成功：+30
RTT < 50ms：+30
RTT < 150ms：+15
```

排序时优先：

```text
当前同隧道 > 共同历史 > 同公网 IP > WebRTC 直连 > 最近配对
```

---

# 6. WebRTC 探测是“近场发现”的关键增强

服务器只能猜“可能附近”，真正判断网络体验，要靠 WebRTC probe。

流程：

```text
1. A/B 都打开近场发现页。
2. 服务端发现 A/B 可能相关。
3. 服务端通过 Socket.IO 给双方发 probe 请求。
4. 双方创建轻量 RTCPeerConnection。
5. 建一个 probe DataChannel。
6. 发送 16KB / 64KB 测试数据。
7. 读取 selected candidate pair。
8. 得到 route：host / srflx / relay。
9. 测 RTT 和小包吞吐。
10. UI 显示“可直连 / 需中继 / 不可达”。
```

你前面已经在做 WebRTC route 识别、TURN、Socket.IO fallback，这里正好复用。

前端可以显示：

```text
Galaxy S23
可能在同一网络
链路探测：NAT 打洞直连 · RTT 28ms
[邀请进隧道] [发送文件]
```

或者：

```text
MacBook Pro
曾一起使用过隧道
链路探测：TURN 中继 · RTT 86ms
[继续未完成任务]
```

---

# 7. UI 设计：雷达页 + 设备卡片

近场发现页可以做成：

```text
正在寻找附近设备...

          ◎ 我的设备
        Ltre-PC · Windows

  ○ Galaxy S23
    可能在同一网络
    可直连 · RTT 24ms
    [邀请] [发送]

  ○ MacBook Pro
    曾加入同一隧道
    有 3 个可恢复任务
    [继续任务]

  ○ iPad
    通过服务器发现
    需要中继
    [邀请]
```

设备卡片字段：

```text
设备名
设备类型/平台
是否已安装 PWA
关系标签：同网络 / 曾同隧道 / 最近配对
当前状态：在线 / 刚离线 / 等待确认
链路状态：探测中 / 可直连 / 需 TURN / 仅 Socket.IO
可恢复任务数
操作按钮：邀请进隧道 / 发送文件 / 继续任务
```

不要一开始就显示很多技术字段，但可以有“详情”：

```text
连接详情
- 来源：同公网 IP + 共同历史隧道
- WebRTC：srflx/srflx
- RTT：32ms
- 中继候选：SG / HK
```

---

# 8. 关键交互流程

## 流程 A：打开首页即发现

```text
用户打开 PWA
↓
自动进入“可被发现 10 分钟”
↓
服务端返回候选设备
↓
前端显示附近设备
↓
后台对候选设备做 WebRTC probe
↓
卡片更新为可直连/需中继
```

隐私上建议显示一个状态：

```text
你正在被附近和最近设备发现，剩余 09:58
[停止可见]
```

---

## 流程 B：邀请某设备进入当前隧道

```text
A 正在隧道 ABC12
A 在附近设备里看到 B
A 点“邀请”
B 弹出：
  Ltre-PC 邀请你加入隧道 ABC12
  [加入] [拒绝]
B 同意后加入
```

这个很好用。

---

## 流程 C：双方没有当前隧道，自动选择共同历史隧道

```text
A/B 都打开近场发现
服务端发现两者共同加入过 ABC12、K92PQ
选择最近使用的 ABC12
双方卡片显示：
  共同隧道 ABC12 · 上次 2 小时前
  [一起进入]
```

这对应你之前 NFC 策略 1，也适合近场发现。

---

## 流程 D：继续未完成任务

如果 A/B 有挂起任务：

```text
Galaxy S23
有 5 个文件等待恢复
[继续传输]
```

点击后进入对应隧道和批次恢复中心。

这会把 file-tunnel 的差异点凸显出来：不是只发现设备，而是发现“可以继续的任务”。

---

# 9. 安全和隐私策略

这个功能必须有边界，否则容易变成“同服务器用户互相看到”。

建议默认规则：

```text
只显示以下设备：
1. 当前同一隧道的设备；
2. 曾经加入过同一隧道的设备；
3. 同公网 IP 且双方都打开近场发现页；
4. 同账号/同设备组；
5. 被明确邀请过的设备。
```

不要默认显示：

```text
同一个 file-tunnel 公网服务器上的所有在线设备
```

否则很危险。

## 可见性模式

用户可以选择：

```text
仅自己设备可见
仅同隧道历史设备可见
同一网络可见
临时公开可见 10 分钟
不可见
```

默认建议：

```text
同隧道历史设备 + 同公网 IP 临时可见
```

## 加入必须确认

即使发现了，也不要无感拉进隧道：

```text
某设备邀请你加入隧道
[加入] [拒绝]
```

首次配对必须确认，之后可以允许“信任此设备”。

---

# 10. 服务端接口草案

## 更新可见状态

```http
POST /api/nearby/presence
```

```js
{
  deviceId,
  visible: true,
  mode: 'nearby',
  currentTunnelId,
  lastTunnelIds,
  visibleUntil
}
```

## 获取候选设备

```http
GET /api/nearby/candidates?deviceId=xxx
```

返回：

```js
{
  candidates: [
    {
      deviceId,
      name,
      platform,
      relationTags,
      confidence,
      lastSeenAt,
      currentTunnelId,
      pendingTaskCount,
      probeState
    }
  ]
}
```

## 发起邀请

```http
POST /api/nearby/invite
```

```js
{
  fromDeviceId,
  toDeviceId,
  tunnelId,
  reason: 'join-current-tunnel'
}
```

## 接受邀请

```http
POST /api/nearby/invite/:id/accept
```

## WebRTC 探测信令

可以复用现有 Socket.IO signal：

```text
nearby-probe-offer
nearby-probe-answer
nearby-probe-ice
nearby-probe-result
```

---

# 11. 数据结构建议

```js
NearbyPresence {
  deviceId,
  sessionId,
  socketId,
  visible,
  mode,
  currentTunnelId,
  observedIpHash,
  capabilities,
  visibleUntil,
  lastSeenAt
}

NearbyRelation {
  deviceA,
  deviceB,
  relationType: 'same-tunnel' | 'mutual-history' | 'same-ip' | 'trusted-device' | 'recent-pair',
  score,
  lastMatchedAt
}

NearbyProbe {
  id,
  deviceA,
  deviceB,
  routeType,
  rtt,
  throughput,
  success,
  createdAt
}

NearbyInvite {
  id,
  fromDeviceId,
  toDeviceId,
  tunnelId,
  status: 'pending' | 'accepted' | 'rejected' | 'expired',
  expiresAt
}
```

---

# 12. 和“本地助手/原生 App”的关系

PWA 版做的是：

```text
服务器辅助发现 + WebRTC 探测
```

如果后面你愿意做桌面助手 / Android App，可以升级为真正近场：

```text
UDP/mDNS 广播
BLE 广播
局域网端口监听
本机 helper bridge
后台常驻 provider
```

原生增强版可以做到：

```text
同一 Wi-Fi 真实发现
蓝牙附近发现
后台常驻被发现
局域网直接传输
电脑作为家庭中继节点
```

但第一版不需要等原生助手。PWA 先做服务器辅助版就能产生体验价值。

---

# 13. 第一版 MVP 我建议这样做

不要一开始搞 BLE/NFC。先做这个：

```text
1. 首页增加“附近设备”模块。
2. 打开首页/PWA 后自动进入 10 分钟可发现状态。
3. 服务端记录在线设备、当前隧道、历史隧道、公网 IP hash。
4. 返回候选设备：
   - 同当前隧道
   - 共同历史隧道
   - 同公网 IP
5. 前端对候选设备做 WebRTC probe。
6. 卡片显示：
   - 可直连
   - 需中继
   - 有可恢复任务
7. 点击设备可以：
   - 邀请加入当前隧道
   - 进入共同最近隧道
   - 继续未完成任务
```

这已经能给用户一种“打开 PWA 就能看到附近设备”的感觉。

---

# 14. 最终产品定义

这个需求可以这样定义：

> **近场发现：当多台设备打开 file-tunnel PWA/网页时，系统会根据当前隧道、共同历史、同网络特征和 WebRTC 链路探测，自动发现附近可连接设备，并支持邀请加入隧道、继续未完成任务或直接发起传输。**

一句话卖点：

```text
打开即发现，靠近即可续传。
```

但技术实现上要诚实：

```text
不是局域网广播扫描，而是服务器辅助发现 + WebRTC 链路确认。
```

我建议你先做这个版本。它和你现有 file-tunnel 架构最贴合，开发量可控，也能直接服务“可恢复传输任务容器”的核心定位。

[1]: https://developer.chrome.com/blog/private-network-access-update "Private Network Access update: Introducing a deprecation trial  |  Blog  |  Chrome for Developers"
[2]: https://developer.chrome.com/docs/capabilities/bluetooth "Communicating with Bluetooth devices over JavaScript  |  Capabilities  |  Chrome for Developers"
[3]: https://developer.chrome.com/docs/capabilities/nfc "Interact with NFC devices on Chrome for Android  |  Capabilities  |  Chrome for Developers"
