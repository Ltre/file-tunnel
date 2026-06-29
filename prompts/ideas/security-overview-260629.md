分析这个项目中用到的传输链路逻辑，全面评估其网络安全性，确保不会被第三方监听到设备之间的任何传递信息

----------------------------------------------

结论先说清楚：**当前 `Ltre/file-tunnel` 的传输链路还不能保证“第三方绝对无法监听设备之间的任何传递信息”。**
它目前更接近 **“依赖 HTTPS/WSS + WebRTC/DTLS 的传输层加密”**，而不是 **“应用层端到端加密 E2EE”**。如果第三方指的是公网 Wi-Fi、运营商、普通旁路抓包者，在正确部署 HTTPS/WSS 且走 WebRTC P2P 时，内容通常不会被被动监听；但如果第三方包括 **你的中继服务器、服务器管理员、被攻陷的服务器、误入同隧道的设备、开放的 admin/debug 接口访问者**，当前代码仍存在明显明文暴露面。

## 1. 当前传输链路安全边界

### P2P 文件链路

项目使用 `RTCPeerConnection` 建立 P2P，配置了多个公共 STUN，并允许 `iceTransportPolicy: 'all'`，也就是说会尽量使用直连候选，必要时才走其它候选。代码里 `createPeerConnection()` 配置了 Google、Cloudflare、stunprotocol 等 STUN server，并创建 WebRTC data channel 做 P2P 通信。

WebRTC 本身会加密数据，W3C 规范明确说用户代理会使用强 per-session keying 加密数据，数据通道协议栈是 SCTP/DTLS/UDP；但规范也说明通信这件事本身、IP 地址、网络上下文和部分元数据可能暴露，且应用需要自己处理信令安全和恶意 SDP 等问题。([W3C][1]) ([W3C][1])

所以：**P2P 文件内容对普通网络旁路监听者是安全的；但项目没有在文件内容上再做一层应用层加密，也没有做设备指纹确认或信令认证。** 一旦信令服务器被控制，或者错误设备进入同一隧道，WebRTC 的传输层加密并不能自动证明“对面一定是你想要的那台设备”。

### Socket.IO relay 文件链路

一旦 P2P 不可用，代码会 fallback 到 Socket.IO relay。客户端 `sendViaSocketRelay()` 会把文件分片通过 `file-asset-relay-chunk` 直接发给服务端，服务端再转发给目标设备。

服务端这边 `file-asset-relay-chunk` 接收 `chunk`，只做大小、relay 状态、expectedSize 校验，然后 `target.emit('file-asset-relay-chunk', { ... chunk })` 转发。也就是说 relay 服务器进程能接触到文件分片明文。

所以：**Socket.IO relay 路径不是端到端加密。** HTTPS/WSS 只能防止公网链路上的旁路抓包者看见内容，但服务器本身仍然能看到文件字节。

### 文本、富文本、剪贴板、历史同步

普通消息直接通过 `socket.on('message')` 进入服务端历史，再广播给同会话其它设备。服务端会把 message 加入 session history，并 `socket.to(sessionId).emit('message', { message })`。

小文件也可能以内联数据进入历史：`createHistoryMessage()` 只会删除“大文件”的 `fileInfo.data`，注释里明确说小文件字节可以随 session snapshot 走 Socket.IO。

剪贴板共享也是明文走服务端：服务端接收 `text` 后直接广播给同会话设备。

协同编辑内容同样明文走服务端，服务端保存/同步 `content`，并广播 `editor-sync`。

所以：**文本、富文本、剪贴板、小文件内联历史目前都是服务端可见的明文。**

## 2. 当前代码中比较大的安全风险

### 风险 A：没有应用层 E2EE

我没有在关键传输链路中看到对文件 chunk、文本消息、富文本、剪贴板内容做 WebCrypto/AES-GCM 之类的应用层加密。当前文件 P2P 直接发送原始 `sliceData()`，relay 也直接发送原始 `sliceData()`。

这意味着：

```text
P2P 路径：
浏览器 WebRTC 层加密，但应用层明文。

Relay 路径：
公网传输若 HTTPS/WSS 则链路加密，但服务器内存中可见明文 chunk。

文本/富文本/剪贴板：
服务端直接可见明文。
```

如果你的目标是“任何第三方，包括服务器，都不能看到传递内容”，现在不达标。

### 风险 B：部署若是 HTTP/ws，会被公网或局域网直接监听

服务端当前创建的是 HTTP server，端口是 80。启动日志也显示 Web/API 是 `http://127.0.0.1:80` 和 `http://<LAN-IP>:80`，并提示 Nginx 应代理 public HTTP/HTTPS 流量到 upstream。

客户端 Socket.IO 地址默认使用 `window.location.origin`。如果页面是 `http://` 打开的，那么 Socket.IO 也会走非加密连接；如果页面是 `https://`，才会自然升级到安全的 WSS/HTTPS 同源链路。

所以生产环境必须强制：

```text
HTTPS 页面
WSS Socket.IO
禁止公网 HTTP 明文访问
HSTS
反代到本地 HTTP upstream
```

否则即使 WebRTC P2P 本身加密，**文本、信令、relay、session-history、剪贴板、短码/API 都可能在 HTTP/ws 层被监听或篡改。**

### 风险 C：admin 和 debug 接口暴露面过大

`/admin` 直接返回 `admin.html`，`/api/sessions` 可以列出所有 session，`DELETE /api/sessions/:sessionId` 可以删除会话；这些接口从当前代码看没有登录认证或管理员 token。

`/api/debug-logs` 只有在设置了 `DEBUG_LOG_TOKEN` 时才检查 header；如果环境变量没设置，代码会直接返回 debug logs。

虽然 debug 日志里对 `content/data/sdp/candidate/text/token/password` 做了一些字段级脱敏，但日志仍可能包含 sessionId、deviceId、deviceName、clientIp、文件名、文件大小、设备关系、传输状态等敏感元数据。脱敏逻辑见 `sanitizeDebugValue()`。

这不是“内容监听”本身，但对安全来说很危险：攻击者可以枚举在线会话、删除会话、观察设备和文件传输元数据，甚至结合其它漏洞进一步攻击。

### 风险 D：会话加入依赖 sessionId / 5 位短码，缺少真正的访问控制

服务端只校验 sessionId 格式和 deviceId 格式，知道 sessionId 的设备就能 `join-session`；短码是 5 位大写字母/数字，服务端通过 `/api/short-codes/:shortCode` 直接解析到 sessionId。

客户端的 `generateId()` 使用 `Math.random()` 生成 UUID 样式 ID，不是 CSPRNG。

这个设计适合“临时易用传输”，但不适合“确保第三方无法进入/监听”。只要链接、二维码、短码、sessionId 泄露，第三方设备就可以进入会话，看到 session history、设备列表、文件元数据，并可能请求文件缓存。

### 风险 E：STUN/P2P 会暴露网络元数据

当前 WebRTC 配置使用 `iceTransportPolicy: 'all'`，会收集并尝试使用 host/srflx 等候选；W3C 明确说明 WebRTC 建立连接会暴露浏览器网络上下文，可能包括可用于 WebRTC 的 IP 地址集合，连接也会向对端暴露用于通信的 IP 候选。 ([W3C][1])

这不等于内容泄露，但会泄露：

```text
公网 IP
局域网/内网地址或 mDNS 候选
网络类型
大致地理位置
通信双方存在连接这件事
文件大小与传输时序
```

如果你把“任何传递信息”理解到元数据级别，那 WebRTC 直连天然无法完全隐藏通信事实和流量大小。

## 3. 按攻击者分类评估

| 攻击者                      |               当前安全性 | 说明                                               |
| ------------------------ | ------------------: | ------------------------------------------------ |
| 公共 Wi-Fi / 运营商 / 路由旁路监听者 | 中到高，取决于是否 HTTPS/WSS | HTTPS/WSS + WebRTC P2P 下内容一般不可见；HTTP/ws 部署则危险。   |
| 公共 STUN 服务器              |                   中 | STUN 不应看到文件内容，但能参与 NAT 探测并获得网络元数据。               |
| 你的 Socket.IO 中继服务器       |                   低 | 能看到文本、富文本、剪贴板、小文件内联、relay 文件分片、session metadata。 |
| 被攻陷的服务器                  |                   低 | 可读取 relay 明文、改信令、伪造设备关系、返回恶意历史/设备列表。             |
| 误入同隧道的设备                 |                   低 | 只要能加入 session，就可接收广播历史、看到元数据，并可能请求可用文件。          |
| 只拿到 GitHub 源码但没有部署访问权的人  |                   高 | 源码公开本身不导致当前会话内容泄露。                               |
| admin/debug 接口访问者        |                 低到中 | 当前 admin/session/debug 接口未强制认证，会暴露管理和元数据面。       |

## 4. 要达到“第三方监听不到任何传递信息”，必须做的改造

### 第一优先级：全链路应用层 E2EE

不要只依赖 WebRTC/HTTPS。应该在业务层加密所有内容，服务器只负责转发密文。

建议结构：

```text
routingSessionId：只用于服务端路由，可以发给服务器
sessionSecret：256-bit 随机密钥，只放在 URL hash / QR / 本地，不发送给服务器
```

例如链接改成：

```text
https://example.com/#sid=<routingSessionId>&key=<base64url-256bit-secret>
```

服务端只知道 `sid`，不知道 `key`。浏览器用 `key` 派生：

```text
messageKey
fileKey
metadataKey
deviceAuthKey
```

所有这些内容都应该加密后再发：

```text
文本消息
富文本 HTML
剪贴板文本
小文件 data
大文件 chunk
relay chunk
文件名
MIME type
可选：文件大小分桶/模糊化
```

文件 chunk 建议：

```text
AES-GCM
nonce = fileId + chunkIndex / transferId 派生
AAD = sessionId + fileId + chunkIndex + totalSize + senderDeviceId
```

这样 relay 服务器只能看到：

```text
assetId / chunkIndex / ciphertext / 大小 / 发送方 / 接收方
```

看不到文件内容。

### 第二优先级：设备身份认证，防止信令服务器 MITM

只做共享 session key 还不够。如果服务器可恶意改设备列表和信令，它仍可能把攻击设备塞进会话。建议每个设备第一次进入时生成长期设备密钥：

```text
deviceIdentityKeyPair
devicePublicKey
deviceFingerprint
```

设备之间建立信任时显示短指纹，例如：

```text
A 设备看到：7F3A-91C2
B 设备看到：7F3A-91C2
```

用户确认后才信任。后续所有消息和文件都带签名或 MAC，接收端验证：

```text
发送者确实是已信任设备
内容没有被服务器篡改
重放/乱序/串包能被拒绝
```

最低成本方案是“首次信任 TOFU + 指纹可查看”；更强的是“加入新设备必须由已有设备批准”。

### 第三优先级：短码不能直接等于访问权限

5 位短码适合便利加入，但不适合作为安全凭证。建议改成：

```text
短码只用于找到会话
真正加入需要已有设备确认
或者短码 + 二次确认码 / SAS
或者短码只在 60 秒内有效且一次性使用
```

如果你仍想保留“输入短码即加入”，那就不能承诺“第三方无法进入监听”。

### 第四优先级：所有公网入口强制 HTTPS/WSS

必须做到：

```text
HTTP 80 只允许跳转到 HTTPS
Socket.IO 只允许 WSS
ALLOWED_ORIGINS 不允许默认 *
设置 HSTS
设置 CSP
禁用公网直连 upstream
```

当前代码默认 `ALLOWED_ORIGINS` 是 `['*']`，CORS origin 只要 `*` 就放行。

建议生产环境：

```bash
ALLOWED_ORIGINS=https://your-domain.com
DEBUG_LOG_TOKEN=<strong-random-token>
HISTORY_DEBUG=false
```

并在反代层加：

```text
Strict-Transport-Security
Content-Security-Policy
X-Frame-Options / frame-ancestors
Referrer-Policy
```

### 第五优先级：admin/debug 接口必须加认证

至少做：

```text
/admin 需要管理员登录或 ADMIN_TOKEN
/api/sessions 需要 ADMIN_TOKEN
DELETE /api/sessions/:id 需要 ADMIN_TOKEN
/api/debug-logs 必须强制 DEBUG_LOG_TOKEN，没设置就直接 403
```

现在的 debug 行为应该改成：

```js
if (!DEBUG_LOG_TOKEN) {
  return res.status(403).json({ error: 'Debug log disabled' });
}
```

而不是 token 为空时开放访问。

### 第六优先级：元数据保护

如果你真的要“任何传递信息都不泄露”，文件名、MIME、大小也要处理。当前 file asset metadata 包含：

```text
id
name
type
size
ownerDeviceId
folderName
entryCount
```

这些会通过服务端公告和请求调度广播。

加固方向：

```text
文件名加密
MIME 加密或统一 application/octet-stream
folderName 加密
entryCount 视需求隐藏
size 可分桶或 padding
```

但大小和时序完全隐藏很难，会影响性能和体验。

## 5. 最终评估

当前项目的安全等级我会这样定：

```text
传输层防旁路监听：中等，取决于 HTTPS/WSS 部署；WebRTC P2P 本身较安全。
服务端不可见内容：不达标。
同隧道访问控制：不达标。
relay 文件保密：不达标。
文本/富文本/剪贴板保密：不达标。
元数据隐私：不达标。
```

一句话总结：

**现在可以说“在 HTTPS/WSS + WebRTC P2P 情况下，普通网络旁路第三方较难监听文件内容”；但不能说“第三方无法监听任何设备间传递信息”。要达到这个目标，必须引入应用层端到端加密，并把 session key、设备身份、短码加入、admin/debug、metadata 都重新设计。**

最实际的下一步是：先做 **E2EE v1**，把文本、富文本、剪贴板、小文件、大文件 relay chunk 全部变成密文；P2P 即使已有 DTLS，也同样走应用层密文。这样才有资格把产品文案写成“服务器不可见内容”。

[1]: https://www.w3.org/TR/webrtc/ "WebRTC: Real-Time Communication in Browsers"
