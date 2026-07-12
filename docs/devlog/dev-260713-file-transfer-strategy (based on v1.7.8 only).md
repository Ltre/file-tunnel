问：

你顺便解释下当前服务端和客户端所有关于传输链路的配置信息说明，不要改代码
    




    
答（仅基于v1.7.8版）：

我会只读梳理客户端 client/file-assets.js、客户端主逻辑里的 P2P 参数，以及服务端 server/file-assets.js 的中继、分配、限流和租约参数，按“建链、传输、重试、并发、服务端调度、缓存落地”说明它们的关系，不修改代码。

当前这套传输链路可以概括为：

```text
接收端请求文件
    ↓
服务端选择供源设备、去重、限流
    ↓
供源端优先建立 WebRTC DataChannel
    ↓
P2P 成功：直接传输
P2P 失败：降级 Socket.IO relay
    ↓
接收端写入本地缓存并确认完成
```

服务端不直接参与 P2P 数据传输，但会参与设备选择、请求转发、任务去重、并发限制和 relay 中继。

**客户端核心参数**

位于 [client/file-assets.js](D:/Workspace/github/Ltre/file-tunnel/client/file-assets.js) 文件顶部。

| 配置 | 当前值 | 作用 |
|---|---:|---|
| `RELAY_CHUNK_SIZE` | 64 KB | Socket.IO relay 每次从供源端发送的分片大小 |
| `P2P_CHUNK_SIZE` | 64 KB | WebRTC DataChannel 默认分片大小 |
| `P2P_FALLBACK_CHUNK_SIZE` | 64 KB | 无法从 DataChannel 得到合适消息上限时的兜底分片大小 |
| `BUFFER_LIMIT` | 4 MB | DataChannel 缓冲区达到此值后暂停继续发送 |
| `BUFFER_LOW_WATER` | 1 MB | 缓冲区降到此值以下后恢复发送 |
| `BUFFER_POLL_MS` | 20 ms | 检查 DataChannel 缓冲区的间隔 |
| `BUFFER_WAIT_TIMEOUT` | 5 秒 | 等待发送缓冲区排空的最长时间 |
| `BUFFER_STALL_TIMEOUT` | 8 秒 | 缓冲区连续没有排空进展时判定发送停滞 |
| `P2P_TIMEOUT` | 1500 ms | 普通 P2P 建链等待时间，主要用于等待现有 PeerConnection |
| `P2P_FILE_CHANNEL_TIMEOUT` | 5 秒 | 文件专用 DataChannel 等待打开的最长时间 |

`P2P_TIMEOUT` 不是整个文件传输的超时时间。它只影响“等待 P2P 连接准备好”的阶段；专用文件通道还有额外的 5 秒等待时间。

当前 WebRTC 使用：

- 多个 STUN 服务
- `iceTransportPolicy: 'all'`
- `iceCandidatePoolSize: 10`
- 有可用的局域网 host candidate 时，理论上可以直接内网连接
- 没有配置 TURN，因此跨网络时无法使用 WebRTC TURN relay，只能最终退回 Socket.IO relay

**客户端下载并发**

| 配置 | 当前值 | 作用 |
|---|---:|---|
| `MAX_CONCURRENT_FULL_DOWNLOADS` | 3 | 同时进行的完整文件下载上限 |
| `MAX_CONCURRENT_MULTI_SOURCE_DOWNLOADS` | 2 | 同时进行的多源文件下载上限 |
| `MAX_TOTAL_CONCURRENT_DOWNLOADS` | 4 | 所有下载任务合计上限 |
| `MAX_CONCURRENT_UPLOADS` | 2 | 单个设备同时上传的文件任务上限 |

这里有一个容易误解的地方：当前不是“3 个完整文件 + 4 个多源文件”同时运行，而是：

```text
完整文件最多 3 个
多源文件最多 2 个
所有下载任务合计最多 4 个
```

因此总上限 4 会优先限制实际运行数量。

小文件优先级：

```js
SMALL_TRANSFER_PRIORITY_SIZE = 1 MB
```

不超过 1 MB 的文件会获得较高调度优先级，目的是避免大文件长时间堵住小文件。

**多源分片下载**

| 配置 | 当前值 | 作用 |
|---|---:|---|
| `MULTI_SOURCE_THRESHOLD` | 10 MB | 文件大于此值且至少有两个供源时，启用多源模式 |
| `MULTI_SOURCE_RANGE_SIZE` | 2 MB | 每个分片请求的大小 |
| `MAX_CONCURRENT_RANGES` | 4 | 同一个多源文件同时运行的分片数量 |
| `MULTI_SOURCE_WATCHDOG_INTERVAL` | 3 秒 | 多源 watchdog 检查间隔 |
| `MULTI_SOURCE_STALL_MS` | 12 秒 | 分片连续 12 秒无活动则认为停滞 |

当前实际逻辑是：

- 小于或等于 10 MB：完整文件模式
- 大于 10 MB，但只有一个供源：仍然完整文件模式
- 大于 10 MB，且至少两个供源：多源模式
- 多源文件被切成约 2 MB 的 range
- 同一文件最多同时跑 4 个 range
- 每个 range 会轮换供源设备
- 某个 range 卡住后，watchdog 会安排它重试

例如一个 70 MB 文件，大致会被拆成 35 个 range，但不会同时发送 35 个，只会同时运行最多 4 个。

**失败、重试和 watchdog**

| 配置 | 当前值 | 作用 |
|---|---:|---|
| `RECEIVE_TIMEOUT` | 30 秒 | 某个接收任务长时间没有完成时触发重试 |
| `MAX_RETRIES` | 3 | 普通传输或多源 range 的最大重试次数 |
| `REQUEST_WATCHDOG_INTERVAL` | 5 秒 | 检查已发出但迟迟没有真正开始的请求 |
| `REQUEST_STALL_MS` | 45 秒 | 请求 45 秒没有进入实际传输则判定请求停滞 |
| `PROVIDER_TRANSFER_STALL_MS` | 120 秒 | 供源端状态 120 秒没有变化时认为供源任务失联 |
| `DISCOVERY_RETRY_MS` | 2.5 秒 | 设备发现重试的基础间隔 |
| `DISCOVERY_RETRY_MAX_MS` | 15 秒 | 设备发现重试间隔上限 |
| `DISCOVERY_REQUEST_THROTTLE_MS` | 3 秒 | 同一个文件的设备发现请求节流时间 |

多源 range 的重试不是立即无限重试，而是会：

1. 清理当前 range 状态；
2. 切换到下一个供源；
3. 延迟重新加入队列；
4. 重新调度；
5. 超过最大重试次数后标记传输中断。

**P2P 与 relay 的选择**

供源端收到文件请求后，大致执行：

1. 检查本地是否拥有完整缓存；
2. 检查该设备是否处于 P2P 冷却状态；
3. 调用 `connectPeer()`；
4. 创建文件专用 DataChannel；
5. 等待通道打开；
6. 通过 P2P 发送文件；
7. 如果 P2P 失败，则尝试 Socket.IO relay。

因此，服务端不会在一开始替客户端决定“P2P 还是 relay”。真正的选择发生在供源端：

```text
供源端 P2P 尝试成功
    => P2P

供源端 P2P 建链失败、通道关闭、发送失败
    => Socket.IO relay

供源端遇到 DataChannel backpressure
    => 当前代码不会立即改走 relay，而是报告失败并交给上层重试
```

这也是为什么日志中可能看到：

- 接收端先出现 P2P；
- 供源端随后出现 relay；
- 或者 P2P 和 relay 的进度条短时间先后出现。

这些并不表示两条链路一定同时成功传输了完整文件，可能是同一次请求的 P2P 尝试失败后进入 relay，也可能是旧请求和新重试请求的显示状态交错。

**客户端上传并发与公平调度**

客户端上传任务由：

```js
MAX_CONCURRENT_UPLOADS = 2
```

限制。

当一个设备同时给多个接收设备发送文件时，会根据不同接收设备当前的上传负载选择较空闲的任务，避免所有上传任务长期集中在同一个接收方。

但这个限制是“每个客户端本地”的，不是全局集群总限制。

**服务端文件限制**

位于 [server/file-assets.js](D:/Workspace/github/Ltre/file-tunnel/server/file-assets.js) 文件顶部。

| 配置 | 当前值 | 作用 |
|---|---:|---|
| `MAX_FILE_ASSET_SIZE` | 1 GB | 单文件最大大小 |
| `MAX_FILE_ASSETS_PER_SESSION` | 500 | 单隧道最多登记的文件资源数 |
| `MAX_RELAY_CHUNK_SIZE` | 256 KB | 服务端允许的单个 relay 分片最大大小 |
| `MAX_FILE_ASSET_RANGE_SIZE` | 4 MB | 服务端允许的单个 range 最大大小 |
| `RELAY_TARGET_ACK_TIMEOUT` | 30 秒 | relay 普通分片等待接收端确认 |
| `RELAY_COMPLETE_ACK_TIMEOUT` | 60 秒 | relay 完成消息等待接收端确认 |
| `LARGE_FILE_ASSET_SIZE` | 10 MB | 服务端认定大文件的阈值 |

客户端 relay 分片是 64 KB，小于服务端允许的 256 KB 上限，所以服务端通常不会截断客户端正常发送的 relay chunk。

relay 的每个 chunk 都需要经过：

```text
供源客户端
  → Socket.IO
  → Node.js 服务端
  → Socket.IO
  → 接收客户端
  → 接收端 ACK
  → 服务端 ACK 给供源端
```

所以 relay 天然比局域网 P2P 多了服务器转发和确认环节。

**服务端接收端限流**

| 配置 | 当前值 | 作用 |
|---|---:|---|
| `RECEIVER_MAX_ACTIVE_ASSETS` | 5 | 一个接收设备最多同时处理 5 个文件资源 |
| `RECEIVER_MAX_ACTIVE_LARGE_ASSETS` | 3 | 一个接收设备最多同时处理 3 个大文件资源 |
| `ASSIGNMENT_PENDING_STALE_MS` | 45 秒 | 已分配但供源尚未开始的任务，45 秒后视为过期 |
| `ASSIGNMENT_ACTIVE_STALE_MS` | 10 分钟 | 已开始的任务，10 分钟没有状态更新时间后视为过期 |

服务端会根据接收设备当前的 assignment 统计负载：

- 同一个文件的重复请求会被去重；
- 接收端超过 5 个活动资源时，新任务返回 `receiver-backpressure`；
- 大文件超过 3 个活动资源时，新大文件任务会被延后；
- 供源选择时会优先考虑当前负载较低的设备；
- 供源不存在、离线或本地没有缓存时，会从 provider 列表中移除并寻找替代供源。

因此服务端现在承担的是“调度闸门”，但不是字节级的 P2P 调度器。

**服务端任务分配流程**

接收端发出：

```text
file-asset-request
```

服务端会：

1. 检查隧道和文件资源是否存在；
2. 检查是否是重复 assignment；
3. 检查接收端并发上限；
4. 从拥有文件的在线设备中选择供源；
5. 建立 assignment；
6. 将请求转发给供源设备；
7. 等待供源报告 `started/completed/failed`；
8. 完成或失败后释放 assignment。

当前服务端记录了 `requestId`，旧请求的完成或失败状态不能覆盖更新后的请求，这主要用于防止旧重试污染新任务。

**当前最重要的几个实际结论**

1. `P2P_TIMEOUT = 1500` 不是 1500 毫秒后直接放弃整个文件，而是建链准备阶段的等待参数。

2. 多源模式不是所有大文件都会启用，必须同时满足：

   ```text
   文件 > 10 MB
   且在线供源至少 2 台
   ```

3. 当前客户端总下载并发上限是 4，服务端接收端资源上限是 5，两者共同限制实际吞吐。

4. 服务端目前不会强制把局域网设备识别成 P2P，也不会代替浏览器验证 DataChannel。P2P 是否成功，最终取决于两端 WebRTC ICE 和 DataChannel 状态。

5. 一旦供源端 P2P 发送失败，普通错误会降级为 Socket.IO relay；如果是 DataChannel 缓冲区严重背压，则当前代码会先报告失败，避免继续灌数据把浏览器拖死。

6. OPFS、IndexedDB、外部文件句柄属于缓存或文件来源层，不是链路选择层。它们决定“供源端能否读出文件”和“接收端如何落库”，不决定 P2P 是否成功。

如果要定位一次具体传输，最有价值的日志顺序是：

```text
receiver-file-request-sent
file-asset-request-forwarded
request-received
provider-cache-check
p2p-connect-start
p2p-connect-returned
p2p-file-channel-created
p2p-file-channel-open
p2p-send-completed
```

如果中途出现：

```text
p2p-degrade-to-relay
relay-start
relay-completed
```

说明供源端的 P2P 尝试失败后走了 relay。

如果一直停在：

```text
receiver-file-request-sent
```

说明请求尚未被服务端成功分配或供源没有及时响应。

如果到了：

```text
p2p-file-channel-created
```

但没有：

```text
p2p-file-channel-open
```

重点就是 WebRTC 文件通道建链或 ICE/DataChannel 状态，而不是缓存写入速度。
