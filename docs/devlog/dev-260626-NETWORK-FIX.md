# dev-260626-NETWORK-FIX

## 背景判断

- 不再把浏览器 WebRTC 的 STUN 打洞失败直接等同于“只能 Socket.IO 中继”。正确层级应是：WebRTC host/srflx 直连优先，WebRTC TURN relay 次之，Socket.IO relay 只保留为最后兜底。
- 当前最明显的问题是文件资源传输的 P2P 等待时间过短：原来 `client/file-assets.js` 只等 1500ms，跨蜂窝网络建立 ICE/DataChannel 很容易超过这个时间，导致过早降级。
- 用户体验上不能让用户面对长时间空白等待，所以新增“正在寻找最优链路”的进度状态，让后台可以多等 P2P，前台仍有明确反馈。

## 本次代码改动

- `client/file-assets.js`
  - 将固定 `P2P_TIMEOUT = 1500` 改为按文件/分片大小动态等待：
    - 小文件默认 2500ms。
    - 512KB 以上默认 8000ms。
    - 20MB 以上默认 15000ms。
  - P2P 等待超时后的冷却由固定 30 秒调整为按失败原因区分：
    - DataChannel/ICE 等待超时：短冷却 5 秒，允许稍后继续尝试。
    - 明确连接失败：30 秒冷却。
  - 在请求文件、发送文件、启动多源分片前显示 `route-search/probing` 进度状态，避免用户误以为无响应。
  - DataChannel 建立后读取当前 WebRTC route，将 `p2p-host`、`p2p-srflx`、`turn-udp`、`turn-tcp`、`turn-tls` 等信息随 `file-asset-start` 发给接收端。
  - 接收端按实际 route 显示进度，而不是统一显示泛化的 P2P。

- `app.js`
  - 新增 WebRTC ICE 配置读取逻辑：默认 STUN + `runtime-config.js` 下发的 TURN/ICE 配置。
  - 新增 selected candidate pair 识别逻辑，基于 `RTCPeerConnection.getStats()` 区分直连、NAT 打洞、TURN。
  - 文件进度文字细化为“局域网/IPv6直连”“NAT 打洞直连”“WebRTC TURN UDP/TCP/TLS”“Socket.IO 中继”“正在寻找最优链路”。
  - 协同编辑图片 P2P 等待由 1500ms 提高到 8000ms，失败冷却由 5 分钟缩短到 30 秒。
  - 修正旧 `fileTransfer` DataChannel 的可靠性配置：移除 `maxRetransmits: 0`，保留可靠有序传输。

- `client/media.js`
  - 语音、摄像头、对讲机等媒体 WebRTC 连接复用同一套运行时 ICE/TURN 配置。

- `server.js`
  - `/runtime-config.js` 增加下发 `tunnel.config.json` 中的 `rtc` 配置。

- `tunnel.config.json`
  - 新增 `rtc.turnServers` 和 `rtc.p2pTimeoutMs` 配置结构。默认不配置 TURN，不影响现有本地运行。

- `service-worker.js`
  - 缓存版本升级到 `instant-tunnel-v20`，确保 PWA 能刷新到新的前端传输逻辑。

## 配置示例

```json
{
  "serverPort": 80,
  "rtc": {
    "turnServers": [
      {
        "urls": [
          "turn:turn.example.com:3478?transport=udp",
          "turn:turn.example.com:3478?transport=tcp",
          "turns:turn.example.com:5349?transport=tcp"
        ],
        "username": "short-lived-user",
        "credential": "short-lived-credential"
      }
    ],
    "p2pTimeoutMs": {
      "small": 2500,
      "medium": 8000,
      "large": 15000
    }
  }
}
```

## 仍需后续推进

- 当前只是让前端支持 TURN 配置入口，并未部署 TURN 服务。真实跨蜂窝网络要明显改善，需要部署 coturn 或等价 TURN 服务。
- 还没有实现 TURN-only retry 的独立 PeerConnection；当前是默认 `iceTransportPolicy: all`，由 ICE 自己在 host/srflx/relay candidate 中选路。
- 还没有做 HTTP Range/WebTransport relay。Socket.IO relay 仍作为最后兜底存在。
- 后续可以加入设备对设备的网络画像：记录上次成功 route、RTT、是否 IPv6、是否 TURN，并作为下一次传输的链路排序依据。

## 2026-06-26 PWA 慢网启动修复

- 现象：大陆环境中使用 ctExcel 英国流量卡漫游打开 PWA，强刷缓存后首页启动失败，报错 `QRCode is not defined`。
- 判断：这是二维码库加载和 `app.js` 启动之间的竞态。慢网、漫游网络、PWA 缓存重建时，`app.js` 可能先于 `/client/qrcode-1.0.0.min.js` 执行。
- 调整：
  - `index.html` 将二维码库从 `defer` 改为普通脚本，尽量保证它先于首页应用脚本执行。
  - `app.js` 的 `generateQRCode()` 改为可降级逻辑：二维码库未就绪时显示“二维码加载中...”，并主动补载本地二维码库；补载失败时显示当前隧道链接文本，不再抛异常阻断首页启动。
  - `service-worker.js` 缓存版本升级到 `instant-tunnel-v21`，确保 PWA 能刷新到新启动逻辑。
