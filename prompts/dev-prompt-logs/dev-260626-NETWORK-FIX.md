我向chatgpt5.5最高模型提了个问题：”测试了让两台设备处于不同网路，例如电脑连着家里wifi，手机断开WIFI使用蜂窝数据，几乎没看到采用P2P传输，而是用socket.io中继。socket.io中继太慢了！有没有办法尽可能想办法成功建立P2P，想想有没有偏门的方案找到一条两个设备所处环境能最快直达的“

模型经过深度调研后，提到”已经看到一个很可能影响判断的点：你的前端 P2P 资源传输模块里，P2P 尝试超时常量是 1500ms；跨蜂窝网建立 ICE/DataChannel 经常不止这个时间，太早降级会让你“几乎看不到 P2P”。另外你的 ICE 配置目前只有 STUN，没有 TURN。不要用 Socket.IO relay 当主要兜底。应该改成：host/srflx P2P 优先；失败后用 TURN over WebRTC relay；最后才 Socket.IO relay。“

我的看法是，确实不能太早降级，但是也要让用户看着界面没什么动静（而实际后台在寻找最优链路中，没那么快有结果）以为有BUG了，想想怎么找到解决方案的平衡点，让设备处于几乎任何网络情况下都能看起来传输能力游刃有余。

那么你有什么高见？

大模型的完整回答如下：

有办法提高，但要先把边界说清楚：

**浏览器 WebRTC 里没有“神奇偏门”能保证两台都在 NAT/CGNAT 后面时一定直连。** ICE 的本质就是收集 host / srflx / relay candidates，然后对 candidate pair 做连通性检查，按优先级找能通的路径。RFC 8445 里明确描述了这个过程：排序 candidate pairs、逐个检查、成功后进入 valid pairs。([rfc-editor.org][1]) 如果运营商蜂窝网是 CGNAT / symmetric NAT，STUN 往往只能知道“对 STUN 服务器暴露的地址”，但这个地址对另一个 peer 不一定可用；这种场景最终经常必须 TURN。TURN RFC 也明确说，某些 NAT 情况下直连不可能，需要中间 relay。([rfc-editor.org][2])

但你现在的实现确实还有很大优化空间。最重要的结论是：

> **不要用 Socket.IO relay 当主要兜底。应该改成：host/srflx P2P 优先；失败后用 TURN over WebRTC relay；最后才 Socket.IO relay。**

---

## 1. 你当前为什么很容易掉到 Socket.IO 中继

你现在的 `createPeerConnection()` 配置只有 STUN，没有 TURN：

```js
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.stunprotocol.org:3478' }
],
iceTransportPolicy: 'all',
iceCandidatePoolSize: 10
```

也就是说，一旦 STUN 打洞失败，你没有 TURN candidate 可以进入 WebRTC relay，只能进入你自己的 Socket.IO relay。

更关键的是，你的 `client/file-assets.js` 里 P2P 资源传输超时是：

```js
const P2P_TIMEOUT = 1500;
```

跨蜂窝网络建立 ICE/DataChannel，1.5 秒太短。你的发送逻辑是：连接 peer → 等 DataChannel 1.5 秒 → 不行就标记 P2P 失败 → 30 秒 cooldown → 走 Socket.IO relay。

所以你看到“几乎没 P2P”，可能不是单纯网络不支持，而是**你太早判死刑**。

---

## 2. 第一优先级：延长 P2P 探测，不要 1.5 秒就降级

建议先改成：

```js
const P2P_CONNECT_TIMEOUT = 8000;      // 初次等待 DataChannel
const P2P_CHANNEL_TIMEOUT = 20000;     // 新建 file-asset channel
const P2P_RETRY_DELAY = [1000, 3000, 8000];
```

你的旧 `handleFileOffer()` / `handleFileAnswer()` 已经有 15 秒、20 秒等待 DataChannel 的思路。  但新的 `FileAssetTransfer` 模块却只给了 1500ms。建议统一成：

* 小文件：可以 2 秒失败后 relay。
* 中大文件：至少等 8–15 秒。
* 超大文件：允许后台继续 ICE 尝试，同时先用 relay 慢速预热，P2P 一旦连上就切流。

这叫 **relay-racing + P2P upgrade**：先不让用户等死，但也不放弃 P2P。

---

## 3. 第二优先级：加 TURN，而不是 Socket.IO relay

你现在只有 STUN。MDN 说明 `iceServers` 可以配置 STUN/TURN，TURN 需要 `username` 和 `credential`；`iceTransportPolicy: "all"` 会考虑所有候选，`"relay"` 则只考虑 TURN relay。([MDN 網頁文檔][3])

建议配置成：

```js
const ICE_SERVERS = [
  // STUN: 发现公网映射，争取直连
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },

  // 你自己的 TURN：优先 UDP
  {
    urls: [
      'turn:turn.yourdomain.com:3478?transport=udp',
      'turn:turn.yourdomain.com:3478?transport=tcp',
      'turns:turn.yourdomain.com:5349?transport=tcp'
    ],
    username: turnUsername,
    credential: turnCredential
  }
];

const pc = new RTCPeerConnection({
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceCandidatePoolSize: 4
});
```

为什么 TURN 比 Socket.IO relay 好很多：

* TURN 是 WebRTC 原生 relay，数据走 DTLS/SCTP/DataChannel，不需要你在应用层用 Socket.IO 包一层又一层。
* TURN UDP relay 通常比 Socket.IO over WebSocket/HTTP relay 更适合大文件连续传输。
* ICE 会自动把 host、srflx、relay 候选放在同一套连接竞争里，不需要你手写太多 fallback。
* TURN 只在直连失败时兜底；RFC 8445 也建议 ICE agent 收集 server-reflexive 和 relayed candidates。([rfc-editor.org][1])

部署上直接用 coturn。至少准备：

* 新加坡 / 香港 / 日本 / 韩国节点，按用户地理位置选最近。
* UDP 3478。
* TCP 3478。
* TLS TCP 5349。
* `realm` 设置为你的域名。
* 使用短期凭证，别写死账号密码到前端。
* WebRTC 业务里优先 TURN/UDP，弱网和企业网再落到 TURN/TCP/TLS。

---

## 4. 第三优先级：记录 candidate 类型，别只看“P2P/Socket.IO”

你现在 UI 只显示：

```js
P2P
Socket.IO relay
multi-source P2P
multi-source Socket.IO relay
```

这不够。你要知道实际选中的 candidate pair 是：

* host-host：局域网/IPv6/公网直连，最好。
* host-srflx / srflx-srflx：NAT 打洞成功，理想跨网直连。
* relay-relay / relay-srflx：TURN relay，不是真直连，但仍应归到“WebRTC relay”，不要和 Socket.IO 混为一谈。

MDN 的 `getStats()` 可以拿 RTCPeerConnection 的统计数据。([MDN 網頁文檔][4]) 你应该在 DataChannel open 后取 selected candidate pair，记录 `localCandidateType`、`remoteCandidateType`、协议、RTT、bytesSent、bytesReceived。

示例：

```js
async function getSelectedCandidateInfo(pc) {
  const stats = await pc.getStats();
  let selectedPair = null;

  stats.forEach(report => {
    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
      selectedPair = report;
    }
  });

  if (!selectedPair) return null;

  const local = stats.get(selectedPair.localCandidateId);
  const remote = stats.get(selectedPair.remoteCandidateId);

  return {
    localType: local?.candidateType,     // host / srflx / relay / prflx
    remoteType: remote?.candidateType,
    protocol: local?.protocol,
    localAddress: local?.address || local?.ip,
    remoteAddress: remote?.address || remote?.ip,
    currentRoundTripTime: selectedPair.currentRoundTripTime,
    availableOutgoingBitrate: selectedPair.availableOutgoingBitrate
  };
}
```

然后 UI 显示：

* `直连 · srflx/srflx · UDP · RTT 38ms`
* `TURN 中继 · relay/relay · UDP · RTT 75ms`
* `Socket.IO 中继 · RTT 160ms`

否则你会误判：有些“不是 P2P”的情况其实已经是 TURN/WebRTC relay，比 Socket.IO 快得多。

---

## 5. 第四优先级：支持 IPv6 直连，这是最像“偏门”的正道

你测试场景是：

* 电脑：家里 Wi-Fi
* 手机：蜂窝数据

如果两边都有公网 IPv6，理论上很容易直连，不需要 NAT 打洞。很多中国移动/电信/联通蜂窝和家宽都有 IPv6，但家庭路由器、防火墙、系统策略、浏览器 candidate 隐私策略会影响可用性。ICE 里 IPv6 host candidates 是正常 candidate；RFC 8445 也专门讨论了 IPv6 host candidate 和 candidate pair。([rfc-editor.org][1])

你可以做一个“IPv6 直连增强”：

1. 客户端收集 `onicecandidate` 里的 candidate。
2. 解析 candidate type、协议、地址族。
3. 后台日志里标记是否出现 IPv6 host candidate。
4. 如果双方都有 IPv6 host candidate 但不成功，提示用户：

   * 家庭路由器 IPv6 防火墙可能拦入站。
   * 手机运营商 IPv6 可能可出不可入。
   * 浏览器 mDNS candidate 可能隐藏本地地址，但 ICE 内部仍可使用。

这不是邪门方案，而是最可能让“家宽 ↔ 蜂窝”真正直达的方案。

---

## 6. 第五优先级：主动探测 NAT 类型和网络路径

不要只在传输时才知道慢。进入隧道后就做 “connectivity probe”。

每台设备加入后，自动跑：

* STUN 成功与否。
* 是否有 host candidate。
* 是否有 srflx candidate。
* 是否有 relay candidate。
* 是否有 IPv6 candidate。
* ICE 到对方是否 host/srflx/relay。
* RTT。
* 估算吞吐：发 256KB、1MB 测速块。
* 记录历史：这个设备组合上次哪条路径最快。

下次同一对设备传输时：

* 如果上次 P2P 成功，优先等 P2P 久一点。
* 如果连续 3 次 P2P 失败，直接 TURN/WebRTC relay，不再 Socket.IO。
* 如果 TURN/UDP 比 TURN/TCP 快，优先 TURN/UDP。
* 如果某个 TURN 区域快，记住区域。

---

## 7. 第六优先级：不要把 Socket.IO relay 做成大文件兜底

你当前服务端 `file-asset-relay-chunk` 限制是 64KB chunk。 这对可靠性可以，但 Socket.IO 做大文件中继会有几个问题：

* 每块事件封装开销大。
* JS 主线程和 Socket.IO 序列化开销大。
* WebSocket backpressure 不如 WebRTC DataChannel 适配。
* 你的中继和信令/管理共用一个 Socket.IO 服务，会互相影响。
* 移动网络抖动时，应用层重试复杂。

建议层级变成：

1. WebRTC P2P DataChannel。
2. WebRTC TURN/UDP relay。
3. WebRTC TURN/TCP/TLS relay。
4. HTTP range relay / WebTransport relay。
5. Socket.IO relay 只保留给小文件、兼容兜底、控制消息。

如果你真的要保留自建 relay，大文件也建议改成普通 HTTP 上传/下载或 WebTransport，而不是 Socket.IO event chunk。HTTP range 的优势是浏览器、CDN、反向代理、断点恢复、限速、缓存、超时控制都成熟。

---

## 8. “偏门方案”清单：哪些值得做，哪些不要做

### 值得做的

**A. TURN 区域竞速**

客户端启动时向多个 TURN 区域做极小连接探测，选 RTT 最低的 TURN。比如：

* Singapore
* Hong Kong
* Tokyo
* Seoul
* Guangzhou / Shenzhen，如果有国内服务器

这不是 P2P，但用户体感会比 Socket.IO 好很多。

**B. 家里设备常驻“出口节点”**

如果电脑在家里，给 Windows/macOS 桌面助手加能力：

* 尝试 UPnP / NAT-PMP / PCP 自动开端口。
* 获取家宽公网 IPv6。
* 家里路由支持时建立一个固定 UDP/TCP 监听端口。
* 手机通过服务器拿到这个候选地址后直连电脑助手。
* Web 页面通过本机 helper bridge 调用 native 网络能力。

浏览器纯 Web 做不了 UPnP/PCP；桌面 helper 可以。这是非常实用的“偏门”。

**C. WireGuard/Tailscale/ZeroTier 模式**

给高级用户一个选项：两台设备加入同一虚拟网，file-tunnel 直接把虚拟网 IP 当候选路径。浏览器本身不一定能直接枚举所有虚拟网 IP，但桌面 helper / Android 原生壳可以做本地桥接。

这类方案本质是“先建一张 overlay 网络”，P2P 成功率比裸 WebRTC 高。

**D. 双向连接竞速**

同一资源传输时不要只让一侧创建 DataChannel。你现在用 `shouldInitiatePeerConnection(deviceId)` 避免 glare，让 deviceId 小的一方发 offer。 这个设计是对的，但可以在传输层做“候选通道竞速”：

* 基础 PeerConnection 仍保持单 offerer。
* 文件传输通道可以开多个策略：

  * 已有 DataChannel。
  * 新建 file-asset channel。
  * TURN-only PeerConnection。
  * relay 预热。
* 谁先稳定且快，就用谁。

**E. IPv6 优先测试**

如果双方都有 IPv6，直接标注“IPv6 直连可用/不可用”。这会帮助你在真实用户那里定位问题。

### 不建议做的

**A. 端口预测 / symmetric NAT 硬打洞**

理论上存在，但移动网络 CGNAT 大多不可控，端口分配不稳定。投入产出比低。

**B. 浏览器里扫端口 / 尝试私有网络探测**

浏览器安全策略越来越严，这条路会越来越难，而且容易被浏览器限制或被用户安全软件拦。

**C. 伪装成 HTTPS/443 做 P2P**

WebRTC 媒体/DataChannel 走 ICE/DTLS/SCTP，浏览器不能让你随便伪装任意 TCP 连接。TURN/TLS 443 可以作为 relay 兜底，但不是直连偏门。

---

## 9. 你代码里建议立刻改的点

### 改 1：P2P timeout 从 1500ms 提到按文件大小动态

```js
function getP2PTimeout(asset) {
  const size = Number(asset?.size || 0);
  if (size < 512 * 1024) return 2500;
  if (size < 20 * 1024 * 1024) return 8000;
  return 15000;
}
```

然后把：

```js
await this.deps.waitForDataChannel(from, P2P_TIMEOUT)
```

改成：

```js
await this.deps.waitForDataChannel(from, getP2PTimeout(asset))
```

你现在的 1.5 秒超时是导致过早 Socket.IO relay 的核心问题。

---

### 改 2：把 P2P cooldown 从固定 30 秒改成按失败原因

现在失败后直接：

```js
this.p2pUnavailablePeers.set(from, Date.now() + 30000);
```

然后就 relay。

建议：

* `waitDataChannelTimeout`：cooldown 5 秒，并允许后台继续 ICE。
* `ice failed`：cooldown 30 秒。
* `relay already faster`：cooldown 当前文件。
* `network changed`：清 cooldown，重新 ICE。

---

### 改 3：加入 TURN 后，把 fallback 从 Socket.IO 改成 TURN-only retry

当 P2P 失败时，不要马上 `sendViaSocketRelay()`。先新建一个 TURN-only PeerConnection：

```js
const relayPc = new RTCPeerConnection({
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'relay',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
});
```

`iceTransportPolicy: "relay"` 的含义是只考虑 TURN relay candidates。MDN 对这个配置项有说明。([MDN 網頁文檔][3])

流程：

1. 默认 PC：`iceTransportPolicy: "all"`，争取直连。
2. 8–15 秒还没打开：启动 relay PC。
3. relay PC 成功：走 WebRTC TURN relay。
4. relay PC 也失败：最后 Socket.IO relay。

---

### 改 4：区分传输类型

现在 `getFileProgressStatus()` 把非 Socket.IO 都叫 P2P。 建议改成：

* `p2p-host`
* `p2p-srflx`
* `turn-udp`
* `turn-tcp`
* `turn-tls`
* `socket-relay`
* `http-relay`

否则你无法做路由优化。

---

### 改 5：修正旧 DataChannel 的可靠性配置

你旧的 `fileTransfer` channel 写了：

```js
maxRetransmits: 0  // 使用可靠传输
```

但 MDN 对 `maxRetransmits` 的定义是“失败后最多重传次数”；设置非 null 是 unreliable mode。`0` 不是可靠传输，而是最多重传 0 次。([MDN 網頁文檔][5]) 这段旧传输如果还会用，建议改成：

```js
const channel = pc.createDataChannel('fileTransfer', {
  ordered: true
});
```

新的 `file-asset` channel 目前 `{ ordered: true }` 更合理。

---

## 10. 推荐的最终传输策略

我建议 file-tunnel 的传输栈改成这个顺序：

```text
Route 0: local cache / same-device no transfer
Route 1: WebRTC host/srflx direct
Route 2: WebRTC TURN UDP relay
Route 3: WebRTC TURN TCP/TLS relay
Route 4: HTTP range relay / WebTransport relay
Route 5: Socket.IO relay only for small fallback
```

路由选择逻辑：

```js
async function sendAssetSmart(asset, peerId) {
  const direct = startDirectWebRTC(asset, peerId);       // all candidates
  const relayWarmup = delay(2500).then(() => startTurnRelay(asset, peerId));
  const httpFallback = delay(12000).then(() => startHttpRelay(asset, peerId));

  const winner = await Promise.any([
    direct,
    relayWarmup,
    httpFallback
  ]);

  await winner.transfer();
}
```

大文件不要等一个路径彻底失败才换路径，而是**并行竞速**。用户看到的是“马上开始”，系统背后选择最快路径。

---

## 11. 现实预期

你这个测试场景“家里 Wi-Fi ↔ 蜂窝数据”很典型：

* 家宽有公网 IPv4/IPv6：成功率较高。
* 家宽在运营商 CGNAT 后：直连成功率下降。
* 手机蜂窝 CGNAT：直连成功率下降。
* 双方都有 IPv6：可能非常好。
* 一方或双方 symmetric NAT：STUN 直连基本没戏，TURN 是正解。
* 你现在只有 STUN + 1.5 秒超时：很容易假阴性，直接掉 Socket.IO。

所以我的结论是：

> **先别纠结“有没有黑科技 P2P”。你当前最该做的是：加 TURN、延长 ICE/DataChannel 等待、记录 selected candidate pair、把 Socket.IO relay 降级为最后兜底。**

这四步做完，你会看到三类结果：

1. 一部分原来误判失败的，会变成真正 P2P。
2. 一部分仍无法直连的，会变成 TURN/WebRTC relay，速度明显优于 Socket.IO。
3. 真正恶劣网络才落到 Socket.IO 或 HTTP relay。

这才是 file-tunnel 面向真实互联网环境应该有的传输架构。

[1]: https://www.rfc-editor.org/rfc/rfc8445 "RFC 8445: Interactive Connectivity Establishment (ICE): A Protocol for Network Address Translator (NAT) Traversal | RFC Editor"
[2]: https://www.rfc-editor.org/rfc/rfc8656 "RFC 8656: Traversal Using Relays around NAT (TURN): Relay Extensions to Session Traversal Utilities for NAT (STUN) | RFC Editor"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection "RTCPeerConnection: RTCPeerConnection() constructor - Web APIs | MDN"
[4]: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats "RTCPeerConnection: getStats() method - Web APIs | MDN"
[5]: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel "RTCPeerConnection: createDataChannel() method - Web APIs | MDN"



本次修改的需求以及改动的明细要分门别类整理好章节，存放到项目的docs目录中，具体文件路径是 docs/devlog/dev-260626-NETWORK-FIX.md （请用尾行追加的方式写入）
请切换到分支"dev-260626-NETWORK-FIX-NEWCODE"进行此需求的代码改动，但不要暂存，也不要提交。


答：

我先把附件和当前分支状态读一下，再切到你指定的新分支。这里有未提交改动的概率很高，我会先确认，不会把上一轮工作不小心带到新分支里。

已运行 3 条命令

我已经在目标分支 dev-260626-NETWORK-FIX-NEWCODE 上了。附件的核心建议我会先落一版“不会假死、也不会太早放弃 P2P”的改动：延长并按文件大小动态等待、把链路状态说清楚、为后续 TURN 接入留配置入口，同时把明细追加到指定 devlog。

已运行 4 条命令

我读到当前代码确实有 client/file-assets.js 的 P2P_TIMEOUT = 1500，而且主连接 ICE 只有 STUN；这正好对应附件里提到的“过早降级”。我会先在现有架构内做可验证的小步：资源传输按文件大小动态等待 P2P，等待期间 UI 明确显示“正在寻找最优链路”，超时后也不把 peer 冷却太久。

已运行 4 条命令

另外我看到旧 fileTransfer DataChannel 还写着 maxRetransmits: 0，注释说可靠传输，但这个配置实际是不重传。这个坑会影响旧文件链路，我会把它改成只设 ordered: true。这属于“网络稳定性”范围内的小修。

已运行 12 条命令

我会把 TURN 做成配置能力，而不是硬编码：tunnel.config.json 里预留 rtc.turnServers，服务端通过 runtime-config.js 下发，前端把它追加到默认 STUN 后面。这样现在没 TURN 也能运行；你部署 coturn 后只改配置即可。

编辑了 2 个文件

现在先落配置和候选链路识别。接下来要把 WebRTC 选中的 candidate pair 记录下来，进度条才能显示“直连 / TURN / Socket.IO”，否则用户看到的“P2P”会很含糊。

编辑了 1 个文件

协同编辑图片的 P2P 等待也从 1.5 秒提高到 8 秒，并把失败冷却从 5 分钟降到 30 秒，避免一次蜂窝网络慢握手就长期退回 Socket.IO。

编辑了 1 个文件正在编辑 1 个文件执行了 2 条命令编辑了 1 个文件正在编辑 1 个文件执行了 2 条命令

旧文件通道的 maxRetransmits: 0 已确认就在这里，我会把它移除，恢复可靠有序 DataChannel。

正在编辑 1 个文件正在编辑 1 个文件

还是编码上下文问题，我改成只锚定 maxRetransmits 那一行。

正在编辑 1 个文件正在编辑 1 个文件

这行里有不可见/编码异常字符，普通 patch 匹配不到。我先用 Node 只打印这几行的 JSON 形式确认字面量，再决定最小改法。

已运行 node -e "const fs=require('fs');const lines=fs.readFileSync('app.js','utf8').split(/\r?\n/);for(let i=1148;i<=1152;i++)console.log(i+1, JSON.stringify(lines[i]));"

确认实际文件是正常中文，只是 PowerShell 显示乱码。现在用真实内容 patch。

编辑了 1 个文件

接下来加 selected candidate pair 的读取和分类，这样文件资源模块能知道当前 WebRTC 是 host/srflx 直连还是 TURN relay。

编辑了 1 个文件

现在把这个路由识别接到文件传输模块里，并把进度文字改成更像“正在调度链路”的表达，避免用户看到 0% 不动误以为坏了。

编辑了 1 个文件

进度文字我会把 “P2P / Socket.IO” 这种粗分类改细一点：直连、NAT 打洞、TURN、Socket.IO，并给链路探测期一个明确状态。

编辑了 1 个文件

开始改 client/file-assets.js：动态 P2P 等待、短冷却、链路探测进度、以及把真实 route 带给接收端。

编辑了 1 个文件

动态等待规则会按实际传输范围大小算：小文件快一点、中等文件等 8 秒、大文件等 15 秒；分片传输则按分片大小算，避免每个 2MB 分片都等超大文件级别。

编辑了 1 个文件

现在调整发送端：先显示“寻找最优链路”，连接等待按文件大小动态计算；如果只是等待超时，冷却 5 秒就允许再试，不再 30 秒内一律放弃 P2P。

编辑了 1 个文件

接着把 DataChannel 成功后的真实 route 写进传输开始消息，这样接收端也能显示“TURN UDP / NAT 打洞直连”等，而不只是泛泛的 P2P。

编辑了 1 个文件

接收完成时我也会保留当次实际 transport，避免最后一跳又退成泛泛的“P2P”。

编辑了 2 个文件

多源分片下载也尽量带链路状态：如果某些分片已经开始，会优先显示当前活跃分片使用的 WebRTC/TURN/Socket.IO 类型。

编辑了 1 个文件

我还要避免一个小反作用：如果 peer 已在短冷却中，不应该因为“冷却中”这个错误又把冷却拉长到 30 秒。

编辑了 1 个文件

媒体通话/摄像头也使用 WebRTC，我顺手让它读取同一份 ICE/TURN 配置，避免文件传输能用 TURN、语音视频却还是只有 STUN。

编辑了 2 个文件

我会在 tunnel.config.json 预留 TURN 配置结构，但默认空数组，不影响你现在直接运行。后续部署 coturn 后填进去就能让前端拿到 TURN。

编辑了 1 个文件

我注意到接收端后续分片进度沿用的是 transfer.transport，如果只保存原始 p2p-srflx 会让“正在接收”状态追踪不够完整。顺手把接收态 transport 规范化一下。

编辑了 1 个文件

代码改动主体已经完成；接下来写 devlog，按“链路策略、配置、UI 反馈、已知边界/下一步”分章节追加。

已运行 Test-Path docs\devlog\dev-260626-NETWORK-FIX.md

目标 devlog 文件还不存在，所以我会新建它；后续如果继续补充，再按你要求尾行追加。

已创建 1 个文件

现在跑语法和 JSON 检查。这个改动牵涉前端模块、服务端 runtime 配置和 PWA 缓存，检查要覆盖这些点。

已运行 4 条命令

四个 JS 语法检查都过了。再检查 service worker、JSON 和 diff 空白。

已运行 4 条命令

检查发现一个麻烦点：补丁工具把几个原本 CRLF 的文件改成 LF，导致 diff 看起来像全文件重写。这不是业务改动，我会把行尾恢复成原来的 CRLF，避免制造巨大无意义差异。

已运行 2 条命令

git ls-files --eol 显示索引是 LF，工作区这些文件混入了 CRLF。我要做一次纯机械行尾归一化到 LF，只处理这次碰过的文本文件，不改内容。

已运行 node -e "const fs=require('fs'); for (const file of ['app.js','client/file-assets.js','client/media.js','server.js','service-worker.js','tunnel.config.json','docs/devlog/dev-260626-NETWORK-FIX.md']) { if (!fs.existsSync(file)) continue; const text=fs.readFileSync(file,'utf8'); fs.writeFileSync(file, text.replace(/\r\n/g,'\n'), 'utf8'); }"

行尾已归一化。再跑一遍检查，确认 diff 回到正常规模。

已运行 3 条命令

现在 diff 规模恢复正常，空白检查通过。再跑一次语法检查，确保行尾归一化后没有意外。

已运行 4 条命令

核心检查通过。再补查 service worker 和配置 JSON，然后看一下最终工作区状态，确认没有暂存/提交。

已运行 4 条命令

状态里还有一个 prompts/dev-260626.md 是当前工作区原本已有的未提交改动，我没有碰它；本次网络修复改动集中在 app.js、client/file-assets.js、client/media.js、server.js、service-worker.js、tunnel.config.json 和新增 devlog。

已运行 2 条命令

你前一条还问了 dev-260625 上两个 commit 之间的合计差异，我顺手用这两个 SHA 直接算一下 shortstat；不切分支，不影响当前改动。

已运行 2 条命令

两个 commit 的累计差异也算出来了：22 个文件，5080 行新增，222 行删除。现在我最后确认一下当前分支状态。

已运行 2 条命令


已完成，当前在 dev-260626-NETWORK-FIX-NEWCODE，没有暂存、没有提交。
这次网络链路改动主要做了：
文件资源 P2P 等待从固定 1500ms 改成按大小动态等待：小文件 2500ms，中等文件 8000ms，大文件 15000ms。
等待期间进度条显示“正在寻找最优链路”，避免用户觉得卡死。
P2P 超时后只短冷却 5s，明确失败才冷却 30s，避免太早长期降级到 Socket.IO。
新增 WebRTC selected candidate pair 识别，进度可区分：局域网/IPv6直连、NAT 打洞直连、WebRTC TURN UDP/TCP/TLS、Socket.IO 中继。
tunnel.config.json 新增 rtc.turnServers 配置入口；当前默认空，不影响现有运行，部署 coturn 后可直接填。
媒体通话/摄像头/对讲机也复用同一套 ICE/TURN 配置。
修正旧 fileTransfer DataChannel 的 maxRetransmits: 0，恢复可靠有序传输。
PWA 缓存版本升到 instant-tunnel-v20。
已新增 devlog：[docs/devlog/dev-260626-NETWORK-FIX.md](D:\\Workspace\\github\\Ltre\\file-tunnel\\docs\\devlog\\dev-260626-NETWORK-FIX.md)。


--------------------------------

在大陆使用了一台设备插着ctexcel英国流量卡漫游，打开了PWA，强刷缓存，无法进入首页，提示：【页面启动失败    可能是浏览器缓存了旧资源。请先强制刷新应用资源。 QRCode is not defined】

--------------------------------

那么接着处理以下问题：

 - 当前只是让前端支持 TURN 配置入口，并未部署 TURN 服务。为了让真实跨蜂窝网络要明显改善，那就部署 coturn 或等价 TURN 服务。
 - 当前是默认 `iceTransportPolicy: all`，由 ICE 自己在 host/srflx/relay candidate 中选路。那请实现 TURN-only retry 的独立 PeerConnection。
 - 那就做 HTTP Range/WebTransport relay，不要让Socket.IO relay 作为最后兜底存在。
 - 请加入设备对设备的网络画像：记录上次成功 route、RTT、是否 IPv6、是否 TURN，并作为下一次传输的链路排序依据。



.