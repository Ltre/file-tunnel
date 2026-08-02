# dev-2607B 开发记录

## 2026-07-28：LAN-only WebRTC 安全升级与原链路无阻塞兜底

### 失败版本复盘

- 复盘 `af0e7a3275b0e2d2e7852a9c57361891e903ad18` 后确认，旧实现用 LAN 探测替换了设备加入时原本立即执行的标准 `connectToPeer()`，导致所有设备都必须先等待 LAN 超时才启动原 P2P。
- 旧实现还把 `lan-*` 类型塞进原 `signal` 事件；旧客户端虽然不识别这些类型，却会先在原信令处理函数中创建标准 PeerConnection，可能留下没有 offer 的连接并影响后续原 P2P 建链。

### 本次实现

- 不让独立 LAN-only PeerConnection 与标准 PeerConnection 同时进行 ICE 建链。回归日志证明，两套连接同时处于 `checking` 会在部分移动端争抢 WebRTC/ICE 资源，使原本的标准连接也转为 `disconnected`、`failed`，并让多个小文件长期停在“建链中”。
- 设备互相发现后先执行一次独立 LAN-only 尝试，其 `iceServers` 为空，只尝试浏览器可用的 host 直连路径；尝试窗口严格限制为 1500ms，同一设备共享同一个尝试 Promise，多个文件不会各自重复启动 LAN 建链。
- LAN-only 在 1500ms 内成功时立即供文件任务使用；随后等待 1000ms，再在后台启动原标准 STUN PeerConnection，以保留协同编辑等既有功能。此时 LAN 已经稳定，不会与标准连接同时竞争首次 ICE。
- LAN-only 超时或失败时先彻底关闭该 PeerConnection，再立即调用原 `connectToPeer()`；标准 STUN WebRTC 的 offer/answer、ICE candidate、重连和 Socket.IO relay 逻辑保持原样。
- 如果混用旧客户端，旧客户端先发来标准 `signal`，新客户端会立即取消尚未完成的 LAN 尝试并处理标准信令，不会让两套 ICE 并行。
- 不使用“上报 IP 相同”作为硬判断条件：代理、CGNAT、mDNS 和浏览器隐私策略都可能令该判断误报或漏报；LAN-only probe 能否真正打开就是最终的局域网可达性判定。
- LAN 信令使用独立的 Socket.IO `lan-signal` 事件、独立队列和独立限流，不进入原 `signal` 处理函数，也不占用原信令的速率额度。
- 同一设备的文件传输链路选择短时锁定 10 秒，避免多个并发文件在 LAN 与标准 PeerConnection 之间交叉创建 DataChannel。
- 新服务端与旧客户端混用时，旧客户端会完全忽略独立 `lan-signal` 事件；新客户端连接旧服务端时 LAN probe 会静默超时，但原传输链路不受影响。
- 修正文件供源端的超时判断：原逻辑在 PeerConnection 仍为 `checking/connecting`、但信令状态已经是 `stable` 时，会跳过 1500ms 连接等待，并继续额外等待 5000ms 文件 DataChannel 超时。现在无论信令状态如何，只要 PeerConnection 在 1500ms 后仍未连通，就立即进入既有 Socket.IO relay 兜底，并对同一设备启用短暂 P2P 冷却，防止一批小文件逐个重复长时间建链。

### 诊断日志

- `[lan-peer] background host-only probe started`：旁路 LAN 探测已启动。
- `[lan-peer] host-only channel ready`：LAN probe DataChannel 已打开，可供后续文件任务优先选择。
- `[lan-peer] selected candidate pair`：输出 LAN 连接实际选中的 candidate pair。
- `lan-peer-first-attempt-ready`：LAN 首试在 1500ms 窗口内成功。
- `lan-peer-first-attempt-fallback`：LAN 首试未成功，已切换到原标准链路。
- `lan-peer-standard-background-started`：LAN 已稳定，开始补建原标准连接；或 LAN 失败后立即启动原标准连接。
- `[file-asset-route] lan-host-only-peer-selected`：本次文件任务使用 LAN-only 连接。
- `[file-asset-route] standard-peer-selected`：LAN 尚不可用，本次文件任务立即使用原标准 P2P 链路。
- `p2p-degrade-to-relay` 且错误为 `Peer connection failed to become ready before P2P timeout`：标准 PeerConnection 在 1500ms 内未连通，已直接降级，不再额外等待文件通道超时。

## 2026-07-29：撤回 LAN-only 实验

### 回归结论

- 实机日志确认，独立 LAN-only PeerConnection 在设备加入后反复超时，随后才启动标准 PeerConnection；两套连接的生命周期还会引发重复 offer、DataChannel 关闭以及 `checking -> disconnected -> failed` 循环。
- “更快出现 Socket.IO relay”来自缩短 P2P 失败后的等待，并不代表 P2P 建链得到修复。
- 多文件场景中，该实验造成大量任务停留在“建链中”，不满足可用性要求，因此不再保留。

### 回退明细

- 完整移除客户端 LAN-only PeerConnection、`lan-signal` 队列、LAN 探测定时器、文件链路短时锁定及相关设备生命周期接入。
- 完整移除服务端 `lan-signal` 转发与独立限流。
- 撤回文件供源端“连接在 1500ms 后仍未就绪便立即降级”的额外判断。
- `app.js`、`client/file-assets.js`、`server.js` 的传输链路实现恢复为基线 `0b8e4e18b84a035586a17977de76c7c701945995`：设备发现后立即预建原标准 WebRTC 连接，失败时继续使用原有 Socket.IO relay 兜底。

## 2026-07-29：标准 P2P 并发建链修复

### 日志根因

- 接收端日志中，少量缺失文件触发了大量重复请求；同一设备之间反复出现 `checking -> disconnected -> failed`，但没有出现 `Data channel opened`。
- 多个文件任务会同时复用一个尚未稳定的 PeerConnection，却又分别尝试创建文件 DataChannel 和触发 offer。每个文件通道各自等待超时后再降级，导致小文件也长时间停留在“建链中”。
- 旧 PeerConnection 进入失败状态后只从 `state.peers` 删除，没有真正关闭。旧连接的 ICE 回调仍可能继续向后续新连接发送候选，造成信令代际互相污染。
- 旧控制 DataChannel 的关闭回调会无条件删除设备当前通道，可能误删后来已经建立的新通道。

### 实现调整

- 保留单一的标准 STUN WebRTC 链路，不恢复独立 LAN-only PeerConnection，也不新增服务端信令协议。
- 同一远端设备只保留一个当前 PeerConnection，并以单个 `_offerPromise` 合并并发 offer 请求；一批文件不会各自发起一轮 SDP 协商。
- 设备加入时仍立即预建标准 PeerConnection。文件任务先等待共享连接就绪，再创建各自的文件 DataChannel。
- 共享 PeerConnection 的等待窗口保持 1500ms；超过窗口但 ICE 尚未明确失败时仅让本次任务使用 Socket.IO relay，不把该设备误标记为 P2P 冷却状态，后续文件仍可复用稍后连通的 P2P。
- PeerConnection 明确失败或断开超时后会真正关闭，清理属于该连接的控制通道和候选；不在空闲期自行循环重建，下一次真实文件请求或对端新 offer 才创建新连接。
- ICE、answer 和 DataChannel 回调都会确认自己仍属于当前 PeerConnection；旧连接的迟到回调不能覆盖新连接状态。
- 保留确定性 offer 发起方规则；双方发生 offer 竞争时，指定发起方保留本地 offer，另一方回滚并应答，避免 `setLocalDescription` 状态冲突。
- 服务端 `server.js` 保持基线信令与文件中继逻辑，没有加入新的调度或链路选择分支。

### 回归验证

- 新增 `npm run test:p2p`，覆盖 24 个并发连接请求只创建一个 PeerConnection 和一个 offer。
- 覆盖文件侧并发 offer 合并、旧连接关闭后不能继续发送 ICE、候选先于 offer 到达、offer 竞争、共享连接等待和明确降级。
- 以 16 个并发小文件模拟批量发送：共享 PeerConnection 连通前不创建文件通道，连通后全部走 P2P，未触发 relay。
- 源码 `app.js`、`client/file-assets.js`、`server.js`、`server/file-assets.js` 均通过 `node --check`。
- `txsl` 部署构建成功，压缩后的 `app` 与 `file-assets` 脚本均通过语法检查。
- 本地浏览器以 `127.0.0.1` 和 `localhost` 两个独立来源模拟两台设备：ICE 从 `checking` 进入 `connected`，双方控制 DataChannel 正常打开，控制台无警告或错误。

### 实机日志补充修复

- 新一轮实机日志显示，真实文件请求到达之前，同一远端已经连续经历多轮 `checking -> disconnected -> failed -> reconnect`，文件请求随后撞上下一轮尚未完成的 ICE，约 1500ms 后进入 relay。
- 根因之一是失败后的 750ms 自动重建：两端进入失败状态的时间不同，一端的新 offer 可能落到另一端即将关闭的旧 PeerConnection 上，形成连接代际错位。
- 根因之二是服务端每 15 秒心跳都会返回 `session-devices`，客户端此前每次收到列表都调用 `connectToPeer()`；失败连接因此即使没有文件任务，也会被心跳周期性重启。
- 移除失败后的主动重建定时器。失败连接仍会立即彻底释放，但会等待真实文件请求或远端 offer 再建立一套干净连接。
- `session-devices` 只有在设备首次出现时才预建 P2P；`heartbeat` 和 `history-request` 只刷新设备在线信息，不再触发后台建链。
- 新增回归测试，确认失败后不会自动创建第二个 PeerConnection；下一次文件请求只创建一个新连接并只发送一个 offer；心跳和历史刷新不会重启失败连接。
- 浏览器双端等待超过一个完整的 15 秒心跳周期后，两端 `Connecting to peer` 计数均未增加；设备重新进入时可重新建立 P2P 和控制 DataChannel。

### 局域网 mDNS host candidate 补充

- 最新实机日志确认 offer/answer 已完成并进入 `ICE checking`，随后没有候选对连通，文件任务才在原有 1500ms 窗口结束后降级到 Socket.IO relay；失败点位于 ICE 候选连通，而不是文件链路误选。
- 浏览器会把私网 host candidate 的真实地址隐藏为 `.local` mDNS 名称；当当前设备或 Wi-Fi 不能解析对端的 mDNS 名称时，同一局域网的 host-host 路径也会丢失。
- 保留浏览器原始 mDNS candidate，同时在会话设备目录已有服务端观察私网地址时补充一条等价 host candidate。该逻辑不建立第二条 PeerConnection、不替换原 candidate，也不改变 P2P 等待时间或 relay 降级策略。
- 新增回归测试，覆盖私网观察地址补充 mDNS host candidate，以及公网观察地址不得改写 candidate。

## 2026-07-29：公网域名预连接恢复与吞吐诊断

### 问题定位

- `tun-test.miku.us` 的日志显示，页面载入时创建的共享 PeerConnection 长期停在“等待对端发起”；约两分钟后的文件请求仍未复用到已连接的 P2P，随后才进入 Socket.IO relay。
- 此现象与局域网 HTTP 环境可通过私网 host candidate 快速连通并不矛盾：公网 HTTPS 环境更依赖提前完成的标准 ICE 协商，而此前完全忽略心跳刷新会令首次丢失或卡住的预连接永久失去修复机会。
- 浏览器内使用与正式代码相同的 64 KiB 分片、4 MiB 高水位和 20ms 背压轮询进行 32 MiB DataChannel 基准，`host ↔ host / UDP` 可达到约 18.5 MiB/s；改为约 240 KiB 分片没有提升。因此没有把分片尺寸作为约 1 MiB/s 现象的推定根因。

### 实现调整

- 仍不恢复失败后 750ms 无限自动重建；仅在 15 秒隧道心跳返回设备列表时，检查尚未连通的共享 PeerConnection 并补一次预连接。
- 已连接的 PeerConnection、最近 8 秒内刚发送 offer 的连接，以及历史记录刷新均不触发补建，避免扰动健康连接或正在正常协商的连接。
- 对超过 8 秒仍停在 `have-local-offer` 的无应答协商，先彻底释放旧 PeerConnection，再创建一套干净连接，防止死 offer 长期阻塞后续文件请求。
- 不改变文件任务的 1500ms P2P 等待窗口、STUN 列表、文件调度、DataChannel 参数和 Socket.IO relay 兜底。

### 可观测性

- ICE 连通后新增 `[p2p-ice-selected-pair]` 日志，记录最终 `host/srflx/relay` candidate 类型、地址、协议、RTT 和浏览器估算的可用发送码率。
- P2P 降级日志的 peer 快照新增本地/远端已收集 candidate 类型和当前 offer 年龄，用于区分“没有 host candidate”“信令未应答”和“候选已齐但检查失败”。
- 每次 P2P 发送及接收完成新增应用层吞吐日志，记录字节数、纯数据阶段耗时、MiB/s 和 P2P 分片大小，避免以系统总流量或 UI 进度刷新速度代替链路测速。

### 回归验证

- P2P 回归测试扩展至 16 项，覆盖未连通 peer 的心跳补建、健康 peer 不被心跳扰动，以及陈旧无应答 offer 被替换；全部通过。
