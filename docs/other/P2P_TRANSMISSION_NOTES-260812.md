# Drop2Tunnel WebRTC P2P、网络代理与本地地址权限复盘

日期：2026-08-12

维护补充：2026-10-14（§5.2 历史用例矩阵、§9.1—9.4 分层诊断；保留 8/12 原结论，并以当前 `dev/doc-overview` 代码复核超时/授权入口）

参考测试记录：

- `docs/other/TECH_CHALLENGES_OF_TRANSMISSION (260810, stable-1.7.12).md`
- `docs/other/TECH_CHALLENGES_OF_TRANSMISSION (260811, stable-1.7.27).md`

本文只分析文档中具有明确“期望”的测试用例。因代理配置导致页面本身无法打开、原文标记为“不需期望”的用例，不作为 P2P 成败依据。

## 1. 最终结论

一个月以来最容易误导排查方向的现象，是同一套代码、相同设备和相同 Wi-Fi，在不同 Origin、不同 Android VPN 状态下出现了不同的 WebRTC 结果。

2026-08-12 的无痕模式对照测试补齐了关键变量：

1. 两台 Android 设备都启用 Igniter，Chrome 无痕窗口中的站点尚未获得摄像头和麦克风权限时，文件传输使用 Socket.IO relay。
2. 关闭其中一台设备的 Igniter 后，可以建立 P2P。
3. 在 `https://tun.miku.us` 为两台设备授予摄像头和麦克风权限后，即使两台设备都启用 Igniter，也能建立局域网 P2P。
4. 在 `https://tun-test.miku.us` 重复授权后，也得到相同结果。
5. 授权后立即停止摄像头和麦克风、刷新页面，授权效果仍然存在，不需要持续采集媒体。
6. 撤销站点媒体权限后，在双 Igniter 条件下重新退回 Socket.IO relay。

因此，目前证据支持以下结论：

> 先前 `tun.miku.us` 与 `tun-test.miku.us` 的差异，主要不是文件传输代码、Cloudflare、Node.js 回源端口或 P2P 算法造成的，而是 Chrome 按 Origin 保存的媒体权限状态改变了 WebRTC 本地地址暴露策略。Android VPN 又放大了受限地址枚举带来的影响。

这里需要保持严谨：实验已经证明“媒体权限是足以改变结果的因果变量”，但没有直接证明某一版 Chrome 内部准确切换到了哪个实现模式。要确认每次实际暴露了什么地址，仍应采集授权前后的 ICE candidate 摘要和最终 selected candidate pair。

## 2. 为什么媒体权限会影响纯 DataChannel 文件传输

摄像头和麦克风没有参与文件内容传输。文件仍通过 `RTCDataChannel` 发送，媒体 track 在授权完成后立即停止。

权限产生影响的原因是 WebRTC 本地 IP 地址本身属于隐私信息。浏览器可以根据用户是否明确信任当前 Origin，决定允许 ICE 枚举多少网络接口。

RFC 8828 定义了从宽到严的 WebRTC IP 地址处理模式：

- Mode 1：枚举所有网络接口。暴露信息最多，连接能力也最强，需要用户同意。
- Mode 2：使用默认路由及其关联的本地地址。未取得额外同意时通常建议采用这一档。
- Mode 3：只使用默认路由，不暴露关联的私网地址。
- Mode 4：只使用代理路径，限制最严格。

RFC 8828 明确指出，实现可以把 Mode 1 所需的用户同意与 `getUserMedia` 的设备权限关联。因此，即使应用只传输 DataChannel，摄像头或麦克风授权也可能让 Chrome 更完整地枚举物理 Wi-Fi 接口。

授权被保存后，停止 media track 并不会撤销站点权限。后续新建的 `RTCPeerConnection` 仍可受益。这与本次“停止媒体、刷新后仍可 P2P；撤销权限后退回 relay”的实验完全一致。

## 3. Igniter 为什么会放大这个问题

Igniter 基于 Android VPN 能力工作。启用后，设备至少同时存在物理 Wi-Fi 接口和 VPN 虚拟接口，默认路由、UDP 路由和组播行为也可能发生变化。

在没有额外站点权限时，Chrome 可能只使用或优先使用：

- VPN 关联的默认路由；
- 被 mDNS 名称隐藏的 host candidate；
- VPN 出口形成的 srflx candidate；
- 其它受 Chrome IP handling policy 限制的候选。

当两台设备都启用 Igniter 时，双方都可能缺少彼此可达的物理 Wi-Fi host candidate。ICE connectivity check 无法形成有效的 `host ↔ host` candidate pair，最终只能由应用降级到 Socket.IO relay。

关闭其中一台设备的 Igniter 后，至少一端更容易暴露普通 Wi-Fi 路径，ICE 可能通过 host 或 peer-reflexive 路径直连。因此，“只关闭一端代理即可 P2P”不代表代理域名分流已经正确，而是可用候选条件发生了变化。

授予媒体权限后，Chrome 可以采用限制更少的接口枚举方式。物理 Wi-Fi host candidate 重新进入候选集合，双 Igniter 场景才重新具备局域网直连条件。

## 4. `Exempt Chinese Domain/IPs` 为什么不等于 WebRTC 已绕过代理

能在浏览器打开 `http://10.0.0.11`，或 DevTools 显示 HTTP 请求的 Remote Address 为 `10.0.0.11`，只能证明网页 HTTP/Socket.IO 信令流量可以直达该地址。

这不能证明以下行为也绕过了 VPN：

- WebRTC 枚举网络接口；
- mDNS 发布与解析；
- ICE UDP connectivity check；
- 向对端私网 candidate 发送 UDP；
- STUN 请求及其返回路径；
- Chrome 对候选地址的隐私过滤。

WebRTC 数据并不是后续继续向页面域名发送。信令完成后，ICE 会直接向对端 candidate 的 IP 和端口发包。因此，按网页域名或“中国 IP”做的代理排除规则，不一定覆盖 WebRTC 的接口枚举、mDNS 和动态 UDP 目的地址。

## 5. 两版测试记录透露出的稳定规律

stable-1.7.12 与 stable-1.7.27 的核心测试矩阵基本一致。这说明大量链路代码调整没有改变真正的浏览器和 VPN 边界条件。

### 5.1 本地 HTTP 与 tun-test

在测试记录中的 `http://10.0.0.11` 和 `https://tun-test.miku.us`：

- Windows 与 Android 都不启用相关代理时，通常可以 P2P。
- Windows 使用 trojan-gfw 的 PAC、全局或增强模式，而 Android 不启用 Igniter 时，仍通常可以 P2P。
- Windows 与启用 Igniter 的 Android 10 组合，在当时未确认媒体权限的条件下，多次退回 relay。
- 两台 Android 只有一台启用 Igniter时，多数用例可以 P2P。
- 两台 Android 都启用 Igniter 时，多数用例退回 relay。

### 5.2 48 组原始用例的横向矩阵（不遗漏 PAC / 全局 / 直连）

原始两份测试采用相同条件：同一 Wi-Fi/子网、Windows 11 + Android 10 或 Android 13 + Android 10；Windows 使用 trojan-gfw 1.1.6，Android 使用 Igniter 0.10.3-beta。**每一组都独立测试**三个入口：A=`http://10.0.0.11`，B=`https://tun-test.miku.us`，C=`https://tun.miku.us`。8 月 10 日 stable-1.7.12 和 8 月 11 日 stable-1.7.27 都有 1—48 号用例；下列结果是这两次历史记录，不代表不同版本、设备或网络的永久规则。

**Windows 11 ↔ Android 10**（Windows 代理模式为测试时的 trojan-gfw 设置，Android VPN 均指 Igniter）：

| Windows 模式 | Android 10 | A：局域网 HTTP | B：测试 HTTPS | C：正式 HTTPS | 三个入口原始用例 |
|---|---|---|---|---|---|
| 关闭、PAC、全局、增强（分别测试） | Igniter 关闭 | 全部 P2P | 全部 P2P | 全部 P2P | A：1/4/7/10；B：17/20/23/26；C：33/36/39/42 |
| Windows 关闭 | Igniter 开，Exempt 开 | 全部 Socket.IO Relay | 全部 Socket.IO Relay | P2P 为主；8/10 用例 34 偶有 Relay | 2/18/34 |
| Windows PAC | Igniter 开，Exempt 开 | 全部 Socket.IO Relay | 全部 Socket.IO Relay | 全部 P2P | 5/21/37 |
| Windows 全局 | Igniter 开，Exempt 开 | 全部 Socket.IO Relay | 全部 Socket.IO Relay | 全部 P2P | 8/24/40 |
| Windows 增强 | Igniter 开，Exempt 开 | 全部 Socket.IO Relay | 全部 Socket.IO Relay | 全部 P2P | 11/27/43 |
| 关闭、PAC、全局、增强（分别测试） | Igniter 开，Exempt 关 | 页面不可访问，**不评估 P2P** | 页面不可访问，**不评估 P2P** | 页面不可访问，**不评估 P2P** | A：3/6/9/12；B：19/22/25/28；C：35/38/41/44 |

这里的“增强”是 **trojan-gfw 自身的增强模式**，不是后来隧道设置中的“增强局域网 P2P”媒体授权功能，两者不能混同。页面不可访问的行原文明确标为“不需期望”，不能统计为 WebRTC 建链失败。

**Android 13 ↔ Android 10**：

| 双端 Igniter（启用时 Exempt 均开启） | A：局域网 HTTP | B：测试 HTTPS | C：正式 HTTPS | 原始用例 |
|---|---|---|---|---|
| 两端均关闭 | 全部 P2P | 全部 P2P | 全部 P2P | 13/29/45 |
| Android 13 关、Android 10 开 | 全部 P2P | 全部 P2P | P2P 为主；8/11 用例 46 偶有 Relay | 14/30/46 |
| Android 13 开、Android 10 关 | 全部 P2P | 全部 P2P | 全部 P2P | 15/31/47 |
| 两端均开启 | 全部 Socket.IO Relay | 全部 Socket.IO Relay | 全部 P2P | 16/32/48 |

原记录中“全部 P2P”“全部 Relay”属于该次样本的观察。偶发 Relay 也应原样保留：它可能是一次实际 fallback、瞬时网络波动或进度展示造成的混淆，仅凭旧文案无法确定，不可擅自归零或计算成准确失败率。

**最值得记住的交叉结论**：

- Windows **关闭/PAC/全局/增强**四种模式在已完成的 Windows↔Android 用例里没有改变结果分组；因此不能一看 PC 开了“全局代理”就断言文件的 WebRTC UDP 必然走该代理，更不能断言 PAC 必然保证 P2P。
- 在 A/B 入口，**Android 10 开 Igniter（Exempt 开）**的 Windows↔Android 用例均退到 Socket.IO Relay；Android↔Android **双 Igniter**也均 Relay。
- C 入口却在类似代理组合下基本 P2P，这是需要解释的反常对照，而不是证明 `tun.miku.us` 的 CDN、域名或 Node 端口具备特殊的 P2P 穿透能力。
- 8/12 无痕窗口的权限实验补齐了一项可控制变量，见 §1 与下一小节；它解释了这批样本的主要差异，但**旧 48 组报告本身未记录两端具体媒体权限、候选列表或 selected candidate pair**，不能从矩阵倒推出确定的 ICE IP/接口。

### 5.3 tun.miku.us 的历史优势

`https://tun.miku.us` 在相同设备和双代理条件下仍经常可以 P2P，长期被误认为域名、Cloudflare 或旧版链路代码拥有特殊优势。

新的无痕对照实验表明：

- 无痕窗口在未授权时，`tun.miku.us` 同样退回 relay。
- 为该 Origin 授予媒体权限后，双 Igniter 又可 P2P。
- `tun-test.miku.us` 获得同样权限后也可 P2P。

更合理的解释是，日常 Chrome Profile 曾经因为摄像头广播、语音聊天、对讲机等功能为 `tun.miku.us` 保存过媒体权限，而 `tun-test.miku.us` 没有。权限按 Origin 隔离，两个域名不会共享授权。

## 6. 没有媒体权限时，纯网页还能不能保证双 VPN 下的局域网 P2P

### 6.1 简短答案

不能保证。

网页可以请求浏览器建立 WebRTC，但没有标准 API 可以强迫 Chrome 枚举物理 Wi-Fi 接口、绕过 Android VPN，或者把浏览器隐私策略隐藏的本地 IP 注入 ICE agent。

`iceTransportPolicy: 'all'` 的含义只是允许 ICE 使用浏览器愿意提供的所有 candidate。WebRTC 规范明确允许浏览器继续执行自己的地址过滤策略。“all”不等于“枚举全部网卡”。

### 6.2 不授权时仍可能成功的条件

以下方案能提高成功率，但都不是应用可单方面保证的：

1. Igniter 对局域网 IPv4、IPv6、UDP 和 mDNS 做完整 split tunnel，确保物理 Wi-Fi 路径没有进入 VPN。
2. 浏览器产生 mDNS host candidate，双方又能通过局域网正确发布、解析和访问该 candidate。
3. 至少一端没有启用 VPN，使 ICE 有机会通过 host 或 peer-reflexive 路径建立连接。
4. 设备由组织管理时，通过 Chrome 企业策略 `WebRtcLocalIpsAllowedUrls` 明确允许指定 Origin 暴露本地 IP。
5. 使用原生应用、浏览器扩展配合 Native Messaging，或本机辅助服务获取并控制真实网络接口。
6. 在局域网部署高速中继。它可以解决吞吐，但属于 LAN relay，不是浏览器之间的端到端 P2P。

Chrome 正在推进独立的 Local Network Access 权限。这种权限在产品语义上比借用摄像头和麦克风权限更合适，但不能把它当作当前的通用解法：Chrome 最初只把它用于 fetch、子资源和子框架，后续稳定发布说明扩展到了 WebSocket 与 WebTransport；WebRTC 接入仍属于单独、版本相关的工作。即使未来目标 Android Chrome 已支持，它仍然是一项需要用户同意的权限，并不是“完全不授权也能强制拿到 Wi-Fi host candidate”。在替换现有入口前，必须先用目标 Chrome 版本验证该权限能否改变 WebRTC candidate 集合和 selected pair。

### 6.3 已验证或原理上无效的方向

以下做法不能突破浏览器地址权限边界：

- 单纯延长 P2P 等待时间；
- 把 `iceTransportPolicy` 设置为 `all`；
- 创建一个 `iceServers: []` 的 LAN-only PeerConnection；
- 让客户端向服务端上报它从页面脚本中看到的“本地 IP”；
- 让服务端把猜测到的局域网 IP 发给对端；
- 手工拼接一个 host candidate 并调用 `addIceCandidate`；
- 增加更多 STUN 服务器；
- 依靠 OPFS、IndexedDB 或文件大小改变建链结果。

手工 candidate 不能赋予 ICE agent 一个它没有创建和绑定的本地 UDP socket。服务端看到的地址也可能是代理出口、公网 NAT 或 VPN 地址，而不是浏览器被允许使用的物理 Wi-Fi 接口。

## 7. 推荐的产品策略

### 7.1 用户主动授权

在“隧道设置”提供明确的“增强局域网 P2P”入口：

- 只在用户点击后请求摄像头和麦克风权限；
- 请求前明确说明用途是提高 Android Chrome + VPN 场景的局域网直连成功率；
- 明确说明媒体设备只会短暂启动并立即停止；
- 不上传、不保存音视频；
- 不自动弹权限框，不把拒绝权限当作错误；
- 保留 Socket.IO relay 作为拒绝授权或 P2P 失败时的兜底。

本次实现采用这一策略。授权成功后立即停止所有 media track，并提示刷新页面。之所以提示刷新，是因为授权前已经创建的 PeerConnection 不一定会自动重新枚举接口；刷新后新建连接更容易稳定使用新的权限状态。为了避免中断正在传输的任务，代码不自动刷新页面，也不擅自关闭现有 PeerConnection。

### 7.2 授权边界

- 权限按 Origin 保存，`tun.miku.us` 与 `tun-test.miku.us` 必须分别授权。
- 不同 Chrome Profile 之间不共享。
- 无痕窗口中的授权通常只在本次无痕会话内有效。
- PWA 与浏览器页面是否共享权限取决于平台实现和安装来源，必须实测。
- 同一连接的两端都授权，最符合本次已经验证成功的条件。
- 用户可以随时在 Chrome 站点设置中撤销权限。

## 8. 过去一个月容易混在一起的不同问题

### 8.1 ICE 建链问题

典型表现：

- 长时间停留在“建链中”；
- `iceConnectionState` 长期为 `checking`；
- DataChannel timeout；
- 最终降级 relay。

重点检查 candidate、selected pair、VPN、权限和信令时序。

### 8.2 传输完成确认问题

典型表现：

- P2P 进度到 100% 后又出现 relay；
- 服务端出现 `Multi-source range mismatch`；
- 接收端实际已有文件，但 UI 仍显示无缓存。

这类问题发生在数据分片、范围校验、缓存 commit 或 UI 刷新阶段，不应被误判为 ICE 没有建立。

### 8.3 调度风暴和重复请求

典型表现：

- 同一文件出现多个上传或下载进度条；
- manifest、file request、watchdog retry 重复出现；
- 已完成任务仍继续上传；
- 多设备互传时大量任务一直为 0%；
- 页面和低性能设备被日志、DOM 更新及重试拖垮。

这类问题属于文件调度和任务去重，不应通过反复重建 PeerConnection 解决。

### 8.4 存储性能问题

OPFS、IndexedDB、内存拼接和 Worker 决定文件接收后的写入速度与主线程压力，但不决定 ICE 选择 host、srflx 还是 relay。OPFS 慢不能解释“双方启用 Igniter 后没有 host candidate”。

### 8.5 UI 标签与真实链路不一致

供源端和接收端曾显示不同传输类型，或多源任务在 P2P 与 relay 文案间切换。排查时应使用统一 attempt/request/transfer ID 关联两端日志，并以 `getStats()` 中的 selected candidate pair 和实际 DataChannel/relay 事件作为依据，不能只看进度条标题。

## 9. 调试建议

每次测试只改变一个变量，并记录以下信息：

1. 页面 Origin、浏览器 Profile、普通或无痕模式。
2. 两端摄像头和麦克风权限状态。
3. 两端 VPN 是否启用、局域网豁免规则及版本。
4. ICE candidate 类型摘要：host、srflx、prflx、relay。
5. host candidate 是数值私网地址还是 mDNS 名称。
6. ICE gathering、signaling、connection 和 DataChannel 状态时间线。
7. `getStats()` 的 selected local/remote candidate type、protocol 和 networkType。
8. 文件 transferId、requestId、attemptId，避免把不同重试当成同一次传输。
9. 页面实际加载的静态资源版本和哈希，排除 Service Worker 旧缓存。

推荐的最小对照矩阵：

| 编号 | 设备 A | 设备 B | 媒体权限 | 期望 |
|---|---|---|---|---|
| 1 | VPN 关 | VPN 关 | 无 | P2P |
| 2 | VPN 开 | VPN 关 | 无 | 尽量 P2P |
| 3 | VPN 开 | VPN 开 | 无 | 记录 candidate，允许 relay 兜底 |
| 4 | VPN 开 | VPN 开 | 两端授权 | 优先 `host ↔ host` P2P |
| 5 | VPN 开 | VPN 开 | 授权后撤销 | 应重新表现为受限候选或 relay |

测试小文件与大文件时也要分开判断。小文件可以验证建链时延，大文件用于验证背压、分片、commit 和持续吞吐，不能用大文件后半程的问题反推 ICE 初始候选一定错误。

### 9.1 PC 全局/PAC、Android VPN 与 Socket.IO Relay 的分层判断

面对“同一 Wi-Fi、同一个文件，在 PC 关代理/PAC/全局与 Android VPN 切换后，有时 P2P、有时 Relay”时，按以下**三层**区分：

| 层 | 影响项 | 能证明什么 | 不能因此证明什么 |
|---|---|---|---|
| 页面与信令 | PC 代理规则、PAC、全局模式、域名/IP 分流、HTTPS/Socket.IO 可达 | 能否打开网页、加入同一隧道、交换 SDP 与 ICE candidate | 浏览器的 ICE UDP 一定绕开 VPN 或使用物理 Wi-Fi |
| WebRTC ICE / DataChannel | Android VPN 虚拟接口、默认路由、mDNS、STUN、浏览器 Origin 权限及本地地址策略 | 选中候选对且 DataChannel 打开后，能否进行浏览器对浏览器传输 | “网页打开正常”或“信令正常”就等于 P2P 一定连通 |
| 文件级传输与兜底 | PeerConnection 等待窗口、文件 DataChannel、分片 ACK、watchdog、供源选择、Socket.IO relay | 本文件/分片这次是 P2P 完成、Relay 完成，还是发生了重试、竞态或 UI 错标 | 仅从进度条出现 Relay 就断定前一段 P2P 从未成功 |

**PAC 是 HTTP(S) 请求代理选择机制，不是 WebRTC UDP 接口枚举策略**；“全局代理”也不等于所有浏览器实现、所有 UDP/ICE 目的地址都会按同一规则转发。Windows trojan-gfw 和 Android Igniter 的机制及作用层级不同，不能把两个平台上同名“全局”作为相同控制变量。分流选项 `Exempt Chinese Domain/IPs` 只是在测试中的具体开关，不能推导出对任意 ICE candidate、mDNS、STUN 或 VPN split tunnel 的完整覆盖。

浏览器的 ICE candidate 类型 `relay` 专指 **TURN relay candidate**，与 Drop2Tunnel 在文件任务失败后通过 **Socket.IO Relay** 转发字节是两个不同概念。本次源码的标准文件 PeerConnection `iceServers` 列表是 STUN、未配置 TURN；不能把 UI 的 Socket.IO Relay 标签反推为“选中了 TURN candidate”。

### 9.2 1500 ms 等待窗口造成的时序差异

当前 `client/file-assets.js` 保留 `P2P_TIMEOUT = 1500`（已有协商的等待窗口）与 `P2P_FILE_CHANNEL_TIMEOUT = 5000`（文件 DataChannel 就绪窗口）。一项文件任务赶在共享 PeerConnection 连通前触发，可能先走 Socket.IO Relay；**同一双设备稍后共享 ICE 连通，下一次文件请求仍可能直接 P2P**。因此，短时间内先 Relay 后 P2P 不必意味着 PAC/VPN 配置发生变化。

`p2p-degrade-to-relay`、`relay-start`、`relay-completed` 与该 `requestId` 对应的 P2P/channel 状态，是比“当前这台设备曾经显示 P2P”更可靠的文件级证据。遇到多源分片还要核对 `transferId` / `attemptId`：同一文件不同分片可能走不同传输路径，不能把全文件视为只有一个连接结果。

### 9.3 曾尝试但撤回的网络层方案

`docs/devlog/dev-2607B-features.md` 记录了 2026-07-28—29 的历史演进：

1. 曾在标准 PeerConnection 之外引入独立 `iceServers: []` 的 LAN-only PeerConnection，并尝试探测本地直连；后来因双 ICE 竞争、重复 offer、候选/连接代际错位和批量文件卡“建链中”而撤回。
2. 其后保留**单一标准 STUN PeerConnection**，修复并发 offer 合并、旧连接回调污染、心跳引发的无文件重复建链，以及 stale offer 恢复问题。这里的每一轮修改针对的是不同生命周期故障，不等同于突破 Chrome/VPN 的网络接口隐私限制。
3. 当时曾讨论 mDNS host candidate 与服务端可观察私网地址的补充方案，但服务端“知道”或猜测地址并不意味着浏览器 ICE agent 就能发送该地址上的 UDP；不能把候选字符串重写当成可靠的系统级 VPN 绕过手段。
4. “把失败等待缩短、Relay 更快出现”只是加快降级，不是修复 P2P 建链；盲目加长超时也不能让浏览器产生被隐私策略隐藏的本地地址。

这些是**失败方案/历史经验**，不是建议恢复旧 LAN-only 协议。当前是否仍存在某个候选处理分支，需要逐次以 `app.js`、`client/file-assets.js` 和实际回归测试确认，不可把历史开发日志的每个中间实现当成现状。

### 9.4 重现问题的最小证据包

复现时建议先用上面 §5.2 的代表性组合，保持同一文件、设备、Wi-Fi、Chrome/Profile 与版本，逐次只改一项：Windows 关闭/PAC/全局，Android Igniter 关/开，Origin A/B/C，站点媒体权限“未授权→授权并刷新→撤销”。每次至少留存：

- 两台设备各自的代理应用/版本、模式、Igniter Exempt 状态；浏览器普通/无痕 Profile 与 Origin。
- 页面及 Socket.IO 是否连通；ICE gathering/checking/connected/failed 的时间；候选类型和 selected candidate pair（host、srflx、prflx 或 TURN relay）。
- 文件级 `assetId`、`requestId`、`transferId`、`attemptId`、P2P 等待/打开时间、`p2p-degrade-to-relay` 原因、Relay 开始/完成和 ACK。
- 本次操作究竟是**建链就失败**、**P2P 已连通但文件 DataChannel 超时**、**文件传完未完成确认**，还是**仅 UI 进度来源混淆**；用这四类之一定位代码，不混修。

没有候选对或底层网络抓包时，只能得出“历史对照与权限存在强关联，且授权切换可改变结果”的结论；不能声称已经证实 Chrome 某一个精确 ICE policy mode、确定的 UDP 出口或 PAC 实际转发路径。

## 10. 当前代码入口

- `app.js` 的 `createPeerConnection()`：文件 DataChannel 使用的标准 WebRTC 连接、ICE candidate 事件和连接状态。
- `app.js` 的 `connectToPeer()`、offer/answer 和 ICE signal handlers：P2P 信令入口。
- `client/file-assets.js`：文件请求、P2P 发送、Socket.IO relay、多源、重试、watchdog 和进度回调。
- `server/file-assets.js`：文件 manifest、供源端选择、relay、接收请求状态和服务端调度。
- `client/cache-store.js`：OPFS/IndexedDB 缓存，不负责选择网络链路。
- `client/media.js` 的 `getMedia()`：媒体权限请求及错误处理。
- `app.js` 的 `grantLanP2pPermission()`：本次新增的用户主动授权入口，只请求权限并立即停止 track，不修改传输链路。
- `pages/index.html` 的 `grantLanP2pPermissionBtn`：设置页中的“增强局域网 P2P”按钮。

以后排查时，应先判断问题属于“候选与建链”“传输调度”“数据完整性与 commit”“缓存状态”“进度 UI”中的哪一层，再进入对应文件。不要因为最终显示 relay，就直接修改所有层级。

## 11. 关键经验

1. 同一 Wi-Fi 不等于浏览器一定能使用物理 Wi-Fi candidate。
2. HTTP 绕过代理不等于 WebRTC UDP、mDNS 和接口枚举绕过代理。
3. Origin 权限是网络表现的隐藏变量，普通窗口与无痕窗口必须分开测试。
4. `getUserMedia` 权限可能改善纯 DataChannel 的地址枚举，即使媒体 track 已经停止。
5. P2P 等待时间只能等待已有候选成功，不能创造被浏览器隐藏的候选。
6. 独立 LAN-only PeerConnection 不能绕过浏览器策略，还可能与标准连接竞争 ICE 资源。
7. STUN、TURN、Socket.IO relay、OPFS 分别解决不同层面的问题，不能互相替代。
8. 对浏览器隐私边界无能为力时，应透明地请求用户授权，并保留可靠兜底，而不是继续堆叠复杂的启发式链路代码。

## 12. 参考资料

- RFC 8828, WebRTC IP Address Handling Requirements: https://www.rfc-editor.org/rfc/rfc8828.html
- W3C WebRTC 规范，`iceTransportPolicy: all` 仍允许实现执行自己的地址过滤策略：https://w3c.github.io/webrtc-pc/
- Chromium `WebRTCIPHandlingPolicy`：https://chromium.googlesource.com/chromium/src/+/main/content/public/common/webrtc_ip_handling_policy.h
- Chromium `WebRtcLocalIpsAllowedUrls` 企业策略：https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Miscellaneous/WebRtcLocalIpsAllowedUrls.yaml
- Chrome Local Network Access 说明：https://developer.chrome.com/blog/local-network-access
