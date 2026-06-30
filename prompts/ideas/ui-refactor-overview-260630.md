重构更简单、更凸显核心功能的UI
    1、近场发现页（扫描附近打开这页面的设备） 
        1.1、可以参考三星S Share的UI 
        1.2、浏览器里的JS能不能监听某个端口（用于凸显网络特征易被扫描到） 
    2、传输记录区域可以有另一个UI表现形式（提供一个按钮打开这个UI），即打开一个资源管理器，文件按方阵或列表平铺，方便管理 
    3、admin管理页增加网络拓扑图：
        显示所有在线的设备，以及所加入的隧道（设备与隧道用一条线连接，表示其加入，设备采用设备机型LOGO为图示，隧道用动态的多个广播状同心圆线为图示）




-----------------------------------------------------------------------------------------------



我的判断：这次界面改造不要只做“更好看”，而要把 file-tunnel 的产品定位彻底拉出来：

> **file-tunnel 不是普通传文件页面，而是“附近发现 + 可恢复传输任务 + 资源管理容器 + 网络拓扑可视化”。**

你前面已经发现的核心优势是“隧道能保存挂起任务，双方以后再次在线还能恢复一批任务”。所以新界面应该围绕这个优势展开，而不是单纯模仿 PairDrop / Quick Share 的一次性发送体验。

## 一、整体产品结构建议

建议把主界面从现在偏“聊天房间”的结构，改成四个清晰区域：

```text
首页 / 近场发现
  ├─ 附近设备
  ├─ 最近隧道
  ├─ 可恢复任务
  └─ 创建 / 加入隧道

隧道页
  ├─ 当前在线设备
  ├─ 传输任务队列
  ├─ 聊天 / 简短消息
  └─ 协同内容

资源管理器
  ├─ 文件方阵 / 列表
  ├─ 批次管理
  ├─ 挂起任务
  ├─ 已完成资源
  └─ 缓存 / 还原 / 删除

Admin 拓扑页
  ├─ 在线设备
  ├─ 隧道节点
  ├─ 设备-隧道关系线
  ├─ 传输链路状态
  └─ P2P / TURN / Socket.IO 路由信息
```

重点是：首页不要只显示“加入隧道”，而要直接显示：

```text
附近可发现设备
未完成传输任务
最近使用的隧道
```

这样用户一打开就知道这个工具的价值：**发现设备、继续未完成任务、管理传输资源。**

---

# 二、近场发现页

## 1. UI 方向：可以参考 Quick Share / Samsung Share 的“雷达式附近设备”

你说参考三星 S Share，我理解你主要想参考那种“附近设备浮现出来”的系统级分享体验。Quick Share / Nearby Share 这类系统级方案本身依赖蓝牙、Wi-Fi Direct、系统可见性等能力，不是普通网页能完整复刻的；但它的 UI 心智很值得借鉴：用户打开分享页后，看到附近设备列表，选择设备后发送，接收方确认。Quick Share / Nearby Share 类功能本身就是面向附近设备选择和传输的系统级体验。([維基百科][1])

你可以做成：

```text
              正在扫描附近设备...

                   [我的设备]
                Ltre-PC · Windows
              可被附近设备发现 10 分钟

        ○       ○       ○       ○
     Galaxy S23       MacBook Pro
     同网络          曾加入此隧道
     RTT 18ms        可恢复 3 项任务

        iPhone
        通过服务器发现
        需确认加入
```

视觉元素：

* 中间是“本机”。
* 外圈是雷达波纹。
* 附近设备以卡片 / 圆形头像出现。
* 设备卡片显示：

  * 设备名；
  * 设备型号；
  * 是否同公网 IP；
  * 是否可能同局域网；
  * 上次是否加入过同一隧道；
  * 是否有可恢复任务；
  * 当前最佳链路：P2P / TURN / Socket.IO；
  * RTT / 延迟估计。

这比单纯显示“在线设备列表”强很多。

---

## 2. 浏览器里的 JS 能不能监听某个端口？

**纯浏览器 JS 不能像 Node.js / 原生 App 那样监听一个 TCP/UDP 端口，不能直接开一个本地服务等附近设备扫描。**

浏览器 WebSocket API 的角色是“浏览器连接服务器”，MDN 也描述 WebSocket 是在用户浏览器和服务器之间打开双向通信会话，而不是让网页自己变成 WebSocket 服务器。([MDN Web Docs][2])

WebRTC 可以建立浏览器和浏览器之间的连接，也可以使用 DataChannel 做双向数据通道；但它需要信令交换、ICE 候选收集、连接协商，不等于“网页监听一个固定端口让别人扫”。MDN 对 WebRTC 的说明也是通过 `RTCPeerConnection` 建立连接后，再添加媒体流或 `RTCDataChannel`。([MDN Web Docs][3])

另外，Chrome 的 Private Network Access 正在限制网页访问私有网络端点，核心目的就是防止网页随便请求路由器、局域网设备、localhost 等私有网络目标。Chrome 文档明确提到，PNA 会限制网站向私有网络服务器发送请求，并要求安全上下文和更明确的授权机制。([Chrome for Developers][4])

所以结论是：

```text
纯网页模式：
不能监听端口
不能 UDP 广播
不能 mDNS 注册服务
不能真正被局域网主动扫描到

可做：
连接公网信令服务器
通过 WebRTC ICE 探测链路
通过服务器辅助发现同页设备
通过 QR / 短码 / 同隧道关系发现设备
```

如果你真的想做“设备打开页面后，附近网络可扫描到它”，需要加一个本地助手。

---

## 3. 推荐做成三层发现能力

### 第一层：服务器辅助发现，立即可做

设备打开近场发现页后，向服务器上报：

```js
{
  deviceId,
  deviceName,
  deviceModel,
  sessionId,
  visibility: 'nearby',
  visibleUntil,
  userAgent,
  externalIpObservedByServer,
  lastKnownTunnelIds,
  routeProbeSummary
}
```

服务器按这些条件聚合：

* 同一公网 IP；
* 最近加入过同一隧道；
* 同一短码来源；
* 同一账号，未来如果有账号；
* 同一浏览器指纹弱标识，谨慎使用；
* WebRTC route probe 成功；
* RTT 近；
* 设备名曾配对。

UI 上不要说“百分百同局域网”，而是说：

```text
可能在同一网络
曾加入同一隧道
可尝试直连
通过服务器发现
```

这样比较诚实，也更稳。

---

### 第二层：WebRTC 近场探测，建议做

在近场页里，所有可见设备之间自动跑轻量级 WebRTC probe：

* 尝试建立 DataChannel；
* 只发 16KB / 64KB 测试块；
* 记录 selected candidate pair；
* 判断 route：

  * host-host；
  * srflx-srflx；
  * relay；
  * failed；
* 记录 RTT。

UI 显示：

```text
直连可用
NAT 打洞成功
需 TURN 中继
仅服务器中继
```

这会让“附近发现页”不只是装饰，而是真的变成网络链路诊断页。

---

### 第三层：本地助手增强，后续做

如果你愿意做 Windows/macOS/Android 原生壳，可以加一个本地 helper：

```text
file-tunnel-helper
  ├─ 监听 UDP 广播 / mDNS
  ├─ 监听本地 HTTP/WebSocket
  ├─ 汇报局域网 IP / IPv6
  ├─ 做 UPnP / NAT-PMP / PCP
  ├─ 作为常驻 provider
  └─ 帮浏览器恢复文件缓存 / 续传任务
```

浏览器页面通过：

```text
ws://127.0.0.1:port
http://127.0.0.1:port
```

和本地助手通信。

这样才能真正做到：

```text
附近设备打开后互相广播
本机被附近设备扫描到
电脑常驻提供文件恢复
手机下次上线继续取回未完成任务
```

不过要注意：这就从纯 Web App 变成“Web + 桌面助手 / 原生壳”架构了。

---

## 4. 近场发现页最重要的产品文案

不要写：

```text
扫描附近设备
```

因为纯网页未必是真正局域网扫描。

建议写：

```text
寻找可连接设备
```

或者：

```text
寻找附近和最近使用过的设备
```

设备状态可以分层：

```text
附近可见
同网络可能
曾加入同一隧道
可恢复任务
等待对方确认
链路探测中
直连可用
中继可用
```

这样既有“附近发现”的感觉，又不会把技术能力吹过头。

---

# 三、传输记录区域增加“资源管理器”视图

这个非常值得做，而且我认为它比近场发现更优先。

你的核心优势是：**传输任务可以挂起、恢复、批量管理。**

那就必须有一个资源管理器，而不是只在聊天流里滚动找文件。

## 1. 入口设计

在传输记录区域上方加按钮：

```text
[资源管理器]
```

或者：

```text
[打开资源库]
[查看挂起任务]
```

点击后打开全屏 / 抽屉式资源管理器。

---

## 2. 两种视图

### 方阵视图

适合图片、视频、压缩包、批量文件：

```text
[图片] [视频] [ZIP] [PDF]
[图片] [APK]  [文件夹] [音频]
```

每个卡片显示：

* 缩略图 / 文件图标；
* 文件名；
* 大小；
* 状态角标：

  * 已完成；
  * 未完成；
  * 可恢复；
  * 等待来源设备；
  * 本机缓存已清理；
  * 仅有记录；
* 来源设备；
* 所属批次。

---

### 列表视图

适合管理大文件、批量任务：

```text
文件名              大小       来源       状态           操作
video.mp4          1.2GB     电脑       43% 可恢复     继续
backup.zip         5.6GB     手机       等待来源上线   保留/删除
photos.zip         820MB     手机       已完成         下载/清缓存
```

---

## 3. 关键筛选器

资源管理器顶部建议放：

```text
全部
未完成
可恢复
等待来源设备
已完成
本机有缓存
缓存已清理
按批次
按来源设备
```

其中最重要的是：

```text
可恢复
等待来源设备
按批次
```

因为这正是 file-tunnel 和 PairDrop 拉开差异的地方。

---

## 4. 批次视图是重点

每次用户上传 / 分享一组文件，都生成一个 `batchId`。

资源管理器里应该有：

```text
2026-06-30  来自 Galaxy S23 的 36 个文件
已完成 28 个，未完成 8 个
[一键继续] [查看文件] [删除批次] [清理已完成缓存]
```

批次比单文件更有产品感。用户真正关心的是：

```text
我上次那一批照片有没有传完？
我上次那个目录有没有继续？
```

而不是单个 fileId。

---

## 5. 数据模型建议

可以新增或抽象出：

```js
TransferBatch {
  id,
  tunnelId,
  title,
  sourceDeviceId,
  targetDeviceIds,
  totalCount,
  completedCount,
  totalBytes,
  completedBytes,
  status: 'active' | 'paused' | 'recoverable' | 'waiting-source' | 'completed',
  createdAt,
  updatedAt
}

TransferTask {
  id,
  batchId,
  tunnelId,
  assetId,
  fileName,
  fileSize,
  sourceDeviceId,
  targetDeviceId,
  receivedBytes,
  status: 'pending' | 'transferring' | 'paused' | 'waiting-source' | 'recoverable' | 'completed' | 'failed',
  lastRoute,
  lastProgressAt,
  createdAt,
  updatedAt
}
```

资源管理器不应该只读 `messages`，而应该读：

```text
files + fileAssets + transferTasks + transferBatches + messages references
```

这样才能支撑长期管理。

---

## 6. 资源管理器的操作

每个资源 / 批次建议支持：

```text
继续传输
一键恢复本批次
下载
预览
发送到当前在线设备
转发到另一个隧道
收藏到存储库
清除本机缓存
删除记录
永久删除资源
查看来源
查看引用位置
```

删除要分清楚：

```text
清除缓存：只删除本机文件内容，记录仍保留
删除记录：删除这个隧道里的传输记录
永久删除：删除本机记录和缓存，并同步删除任务
```

这会显著增强“掌控感”。

---

# 四、Admin 管理页增加网络拓扑图

这个方向也很对。Admin 页现在不应该只是表格，而应该展示 file-tunnel 最有特色的结构：

```text
设备  <--加入-->  隧道  <--包含-->  传输任务 / 资源
```

## 1. 拓扑图视觉设计

设备节点：

```text
[Galaxy S23 图标]
Ltre 的手机
Android · Chrome
外网 IP: x.x.x.x
当前 route: TURN UDP
```

电脑节点：

```text
[Windows PC 图标]
家里电脑
Windows · Edge
可提供资源 12 个
```

隧道节点：

```text
动态同心圆
Tunnel ABCD
在线设备 3
挂起任务 8
活跃传输 2
```

线条：

```text
设备 —— 隧道
```

线条颜色 / 状态：

```text
绿色：在线加入
蓝色：正在传输
橙色：有挂起任务
灰色：离线但有历史记录
紫色：TURN 中继
红色：连接失败
```

隧道节点用你说的“多个广播状同心圆线”很好，可以用 CSS 动画做：

```css
.tunnel-node::before,
.tunnel-node::after {
  content: '';
  position: absolute;
  border: 2px solid rgba(99, 102, 241, .35);
  border-radius: 999px;
  animation: pulse-ring 2.4s infinite;
}
```

---

## 2. 拓扑图要表达三层关系

不要只画“在线设备和隧道”，建议分三层：

```text
设备层
  手机 / 电脑 / 平板 / 浏览器实例

隧道层
  当前在线隧道 / 最近活跃隧道 / 有挂起任务隧道

传输层
  活跃任务 / 挂起任务 / 可恢复任务
```

视觉上可以先只显示设备和隧道，点击隧道后右侧详情面板显示任务。

---

## 3. Admin 拓扑图接口设计

服务端加一个接口：

```http
GET /api/topology
```

返回：

```js
{
  devices: [
    {
      id,
      name,
      model,
      platform,
      browser,
      externalIp,
      internalIp,
      online,
      lastSeenAt,
      currentSessionIds,
      providingAssetCount,
      pendingTaskCount
    }
  ],
  tunnels: [
    {
      id,
      shortCode,
      createdAt,
      lastActivity,
      onlineDeviceCount,
      totalDeviceCount,
      pendingTaskCount,
      activeTransferCount
    }
  ],
  edges: [
    {
      deviceId,
      tunnelId,
      joinedAt,
      online,
      role: 'member' | 'provider' | 'receiver',
      activeTransferCount,
      pendingTaskCount,
      lastRoute
    }
  ]
}
```

如果要实时刷新，可以用 Socket.IO：

```text
admin-topology-update
device-online
device-offline
session-updated
transfer-status-updated
```

Admin 页面每 2–5 秒刷新也可以，第一版不用太复杂。

---

## 4. 图形实现建议

第一版不需要引入很重的图库。可以用：

```text
SVG + 简单 force layout
```

或者：

```text
Canvas + 手写布局
```

如果想快一点，可以用现成图谱库，但我更建议第一版手写 SVG，因为你的关系结构简单：

```text
设备节点在左侧
隧道节点在右侧
线条连接
```

布局可以固定为二分图：

```text
左：设备
右：隧道
中间：连接线
```

不需要一上来做复杂力导向图。

---

# 五、三个功能的实施优先级

我建议优先级不要按你列的顺序，而是这样：

## P0：资源管理器 / 挂起任务中心

这是 file-tunnel 的核心差异。先做它，产品价值最明显。

最小版本：

```text
按钮：资源管理器
视图：方阵 / 列表切换
筛选：全部 / 未完成 / 可恢复 / 已完成 / 缓存缺失
操作：继续 / 下载 / 清缓存 / 删除
```

这一步做完，你的产品就不再像聊天传文件 demo。

---

## P1：近场发现页

先做“服务器辅助发现 + WebRTC route probe”，不要一开始追求真正局域网广播。

最小版本：

```text
打开页面后广播自己可见
显示同公网 IP / 同隧道 / 最近设备
点击设备创建或加入隧道
后台做 WebRTC 探测
显示直连 / TURN / Socket.IO 可用性
```

---

## P2：Admin 拓扑图

这个对开发调试和产品演示都很有价值，但不是普通用户第一优先级。

最小版本：

```text
设备节点
隧道节点
设备-隧道连线
在线/离线状态
点击节点看详情
```

---

## P3：本地助手 / 原生增强

如果你后面真的想做到“像系统级附近发现一样”，就要做：

```text
Windows/macOS helper
Android 原生壳
UDP/mDNS 发现
本地端口监听
后台续传
常驻 provider
```

这一步做完，file-tunnel 才能接近 Quick Share / AirDrop 那种系统级体验。

---

# 六、我建议的新首页布局

可以这样：

```text
┌─────────────────────────────┐
│ file-tunnel                 │
│ 可恢复的跨设备传输隧道       │
├─────────────────────────────┤
│ 继续未完成任务               │
│ 3 个批次等待恢复             │
│ [一键查看]                  │
├─────────────────────────────┤
│ 附近设备                     │
│        ◎ 我的设备            │
│   ○ Galaxy S23   ○ PC        │
│   可直连        曾加入隧道    │
├─────────────────────────────┤
│ 最近隧道                     │
│ ABC12  2 台设备  5 个挂起任务 │
│ K92PQ  1 台设备  已完成       │
├─────────────────────────────┤
│ [创建新隧道] [输入短码加入]   │
└─────────────────────────────┘
```

这个首页会比单纯“二维码/短码/聊天框”更有产品感。

---

# 七、关键提醒：不要让“近场发现”抢走核心

近场发现很好看，也适合传播，但它不是 file-tunnel 最强的地方。

你的真正强点是：

```text
一次建立隧道
一批任务进入容器
中断后仍可管理
双方以后在线即可恢复
```

所以资源管理器和挂起任务中心应该比近场发现更重要。

可以这样定义产品：

> file-tunnel 是一个可恢复的跨设备传输任务容器。附近发现只是入口，隧道是任务容器，资源管理器是掌控中心，Admin 拓扑图是网络视图。

这条主线非常清晰。

[1]: https://en.wikipedia.org/wiki/Quick_Share?utm_source=chatgpt.com "Quick Share"
[2]: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API "WebSocket API (WebSockets) - Web APIs | MDN"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API "WebRTC API - Web APIs | MDN"
[4]: https://developer.chrome.com/blog/private-network-access-update "Private Network Access update: Introducing a deprecation trial  |  Blog  |  Chrome for Developers"



