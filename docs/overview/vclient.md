# VClient 独立缓存节点

> **源码基线**：`dev/2609-s1@b422e438fe50f78fdacd84ac1dff34a30a3d43ba`

## 1. 需求初衷

浏览器不是理想的 7x24 小时缓存节点：

- 标签页会关；
- 手机会休眠；
- 浏览器配额有限；
- background throttle；
- 用户不希望始终开一个 GUI。

VClient 因此被设计为独立 Node 进程：

> 作为某些隧道的“常驻设备 + 文件缓存供源者”，但不模拟完整人类浏览器 UI。

## 2. 主要实现

- `vclient/index.js`
- `vclient/runtime.js`
- `vclient/cache-store.js`
- `server/vclient-control.js`
- `scripts/vclient-push.js`
- `pages/vclient.html`
- `server/infra-store.js`

## 3. 两条连接

VClient 有两个不同逻辑连接：

### 3.1 Control namespace

Socket.IO namespace：

`/vclient-control`

用途：

- process 上线；
- assignments；
- heartbeat；
- asset state；
- history/audit 请求。

认证：

- `VCLIENT_CONTROL_TOKEN` 环境变量，或；
- `.tunnel-data/vclient-control.token`。

### 3.2 普通隧道 data socket

每个 enabled tunnel 创建一个 `TunnelClient`，以特殊 device 身份加入普通 session。

auth 标识：

`clientType: 'vclient'`

这样现有 file asset protocol 可以把 VClient 当普通 provider/receiver。

## 4. 控制面

后台 API：

- `GET /api/vclient/status`
- `POST /api/vclient/tunnels/:sessionId/enable`
- `POST /api/vclient/tunnels/:sessionId/disable`
- `GET /api/vclient/tunnels/:sessionId/status`
- `GET /api/vclient/tunnels/:sessionId/records`

这些都需要 admin auth。

`infra-store` 保存：

- desired_enabled；
- desired_updated_at；
- state；
- status_detail；
- last_error；
- instance_id；
- device_id；
- heartbeat_at；
- cached_files；
- cached_bytes；
- last_sync_at 等。

## 5. Assignments

控制进程在线后服务器会发送所有 desired enabled tunnel。

VClient Runtime：

1. 建立 enabled set；
2. 删除已经不再 enabled 的 TunnelClient；
3. 为新增 session 创建 TunnelClient；
4. 加入隧道；
5. request history；
6. announce 已缓存 assets。

disable 时服务器还会 force disconnect 对应 data socket，避免一个旧 VClient 继续供源。

## 6. 心跳

默认：

`20,000ms`

每个 TunnelClient 发 `tunnel-heartbeat`。

控制面也报告：

- process state；
- cached files；
- cached bytes。

服务端显示“desired enabled”与“实际 process online / tunnel state”是两个概念。

不能因为 desired=1 就在 UI 宣称 VClient 已经在线。

## 7. 缓存

VClient cache store 把文件写到服务器本机目录，并保存 metadata。

启动时：

- 枚举某 session 已缓存 assets；
- announce `file-asset-available`；
- `server-asset-cache-confirmed`；
- report asset cached。

因此其它浏览器可以把 VClient 当普通供源。

## 8. 接收文件

VClient 可以作为 receiver：

1. 发现新 asset；
2. 如果已经完整缓存，直接 announce；
3. 创建 partial path；
4. 按 file asset protocol 收 chunk；
5. 校验 size/hash；
6. commit temp；
7. announce；
8. report cached state。

这条链路应与 browser file asset 语义兼容，但不需要 DOM/progress UI。

## 9. 向浏览器供源

VClient 可以发送：

- normal file asset；
- editor asset。

对于普通文件可按 requested range 读取缓存 path 并分片 Relay。

对于 editor asset 有对应 editor relay event。

VClient 不需要建立浏览器 WebRTC DataChannel；它更像稳定 server-side provider，通过现有 Socket/Relay 协议响应。

## 10. 不支持的人类交互

当前 VClient 对这些请求明确拒绝/不参与：

- 摄像头；
- 联系人语音呼叫；
- 其它只对真实人类设备有意义的 UI 交互。

例如收到 camera request / contact-call，会回复：

`vclient-unsupported`

服务器 remote preview 也排除 VClient 作为目标设备。

这很重要：不要为了“所有 device API 一致”让 VClient 冒充有摄像头/扬声器的人类设备。

## 11. 历史同步

VClient 启动会请求：

`session-history-request`

并 ACK。

它需要历史的主要原因是知道：

- 哪些 file asset 存在；
- 哪些应缓存；
- 哪些已经删除。

但服务端 audit/history 不能因为 VClient 同步而阻塞普通浏览器实时链路。

## 12. 独立查看页

`/vclient`

页面用于查看缓存节点的传输记录/资产状态，不是 VClient 运行本身。

管理后台“查看缓存节点”跳到该页面。

## 13. Shell push

`scripts/vclient-push.js` 提供服务器 shell 推送能力。

用途：

- 管理员从命令行指定 input files；
- 建立 push payload；
- 连接服务；
- 把文件推到 VClient/对应隧道缓存。

历史动机是避免必须先在浏览器中“发送一次”才能让常驻缓存节点获得服务器本地文件。

该脚本是运维能力，不应开放成无认证网页 API。

## 14. 持久审计

`infra-store` 两张专用表：

- `vclient_tunnels`
- `vclient_asset_states`

前者是 tunnel assignment/state，后者是每 asset：

- state；
- bytes_cached；
- bytes_total；
- cache_path（服务端对外不应泄露任意 filesystem）；
- error；
- started/updated/completed。

## 15. 故障语义

### Control 断开

VClient 不应该继续永远假装 assignment 有效；runtime 有 suspend/audit retry。

### Tunnel disabled

- desired_enabled=0；
- control 通知；
- force disconnect；
- VClient 停对应 tunnel。

### 文件中断

partial file 不能 announce 为 cached；重启后必须识别 incomplete state。

### Server restart

persistent desired state 仍在 `infra.sqlite`，process 重新连接后再下发。

## 16. 安全

- control token 是 secret；
- command-line push 的服务器地址/token 不应 log；
- VClient 是有能力读取/缓存隧道文件的受信节点；
- public 用户不能随便 enable 某 session 的 VClient；
- 管理 API 需 TOTP admin session。

## 17. 修改前检查

- 不要把 VClient 和 browser session device 完全等同；
- 不要让 VClient 参与 camera/call；
- 不要破坏普通 file-asset event；
- 不要把 desired state 当 online state；
- 不要让 cache audit 高频写阻塞传输；
- 测 disable 时已有 data socket 是否被真正踢掉。

## 18. 测试

重点：

- `tests/vclient-runtime.test.cjs`
- `tests/vclient-shell-push.test.cjs`
- `tests/infra-store-audit.test.cjs`
- `tests/file-asset-audit-isolation.test.cjs`

此外必须用真实独立 VClient process 做一次：

- enable；
- cache；
- browser 从 VClient 恢复；
- disable；
- process restart；
- server restart。
