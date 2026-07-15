# 260716_0239 功能与稳定性改进

## 需求范围

本轮围绕隧道文件输入、移动端页面稳定性、传输进度入口、Admin 隧道信息，以及 SNS / Telegram Bot 文件记录的历史恢复链路进行调整。实现继续复用现有文件消息、合辑、文件缓存和 provider 模型，没有新增互不兼容的文件类型或独立传输协议。

## 截图粘贴与文件拖放

- 在普通隧道页面监听剪贴板图片 Blob，并转换为带 MIME 对应扩展名和时间戳文件名的普通 `File`，随后进入现有单文件或多文件发送流程。
- 输入框、文本域、可编辑元素、富文本编辑器和 Quill 编辑区域继续使用各自原有粘贴行为，不会重复生成文件记录。
- 一次粘贴多张图片时复用现有“合辑 / 拆分成多条”选择流程。
- 拖放入口现在完整读取全部有效文件，不再只处理一个文件。
- 使用 `webkitGetAsEntry()` 与 `getAsFileSystemHandle()` 识别目录；目录不会进入缓存、消息或发送队列。
- 文件与目录混合拖入时仅忽略目录，合法文件继续发送；多文件选择浮层会显示被忽略的目录数量。
- 拆分发送时单个文件失败只记录该文件错误，其余文件继续处理。
- 新增目录拒绝、目录忽略、隐藏传输进度等相关多语言词条。

## 移动端页面缩放保护

- viewport 增加 `maximum-scale=1.0`、`user-scalable=no` 与 `viewport-fit=cover`。
- 仅在移动或粗指针环境拦截 Safari gesture 系列事件和多指 `touchmove`。
- 没有设置全局 `touch-action: none`，保留单指滚动、三栏滑动、编辑器操作、媒体手势和按钮交互。

## 传输进度抽屉

- 抽屉统一为 `expanded`、`collapsed`、`hidden` 三种状态，并使用独立 localStorage key 保存用户选择。
- 用户手动隐藏后，普通进度更新不会重新弹出抽屉。
- 收缩状态右侧和展开状态右上角均提供“隐藏传输进度”按钮；按钮阻止事件冒泡，不会误触展开、收缩或锚点定位。
- 顶栏齿轮按钮右侧增加进行中任务数字入口，仅统计现有状态模型中最近确实有进度增长的任务，不包含等待、建链或停滞任务。
- 数字入口采用固定尺寸和轻量脉冲动画，任务数为零时隐藏；点击后将抽屉恢复为展开状态。

## Admin 隧道列表

- Admin 隧道列表同时显示内部会话 ID 与服务端返回的真实五位短码。
- 短码统一转为大写；字段缺失或格式无效时显示 `—`，不从会话 ID 推算。

## SNS / Telegram Bot 历史恢复

### 根因

客户端处理历史快照时，在逐条保存和渲染消息的循环内同步等待文件恢复。服务器来源文件还会先等待浏览器 provider，再请求 Node.js 文件地址；任一请求慢、长期 pending 或失败，都会阻塞后续消息元数据进入传输记录区域。

### 修改

- 历史消息的 IndexedDB 保存、DOM 渲染和排序不再等待文件内容恢复。
- 文件内容改由独立后台恢复队列处理，按 `sessionId + assetId` 去重，并发上限为 3；每个任务都在 `finally` 中释放槽位。
- 合辑按单个 asset 入队，一个文件失败不会阻塞同合辑其他文件或后续记录。
- Node.js 文件请求增加独立超时和重复落库前的本地完整缓存复查，避免永久占用恢复任务及并发来源重复覆盖。
- 后台恢复任务绑定入队时的 `sessionId`；用户切换隧道后，旧隧道的排队任务会被跳过，进行中的 Node.js 下载会被主动取消，避免文件状态和界面刷新串入新隧道。
- 浏览器 provider 请求发出后，若 P2P 下载任务已经进入工作状态，会给予有限的继续传输时间；只有仍未得到完整缓存时才回退到 Node.js 来源，避免同一文件刚开始点对点传输就并发下载第二份。
- 浏览器从 Node.js 成功取得完整文件并落库后，立即执行 provider announce，并安排一次幂等的本地完整资源重新公告，无需刷新页面。
- P2P、Socket.IO 或多源传输成功后的原有“完整落库后 announce”逻辑保持不变。

## 验证记录

- `node --check app.js`：通过。
- `node --check client/file-assets.js`：通过。
- `node --check server/file-assets.js`：通过。
- `node --check server.js`：通过。
- 本地浏览器加载 `http://127.0.0.1/?leave=1`：无新增 console error。
- 页面结构检查：viewport 参数、顶栏任务按钮顺序、抽屉隐藏按钮均正确；桌面视口无横向溢出。
- 390 × 844 移动视口检查：页面宽度保持 390px、无横向溢出；检查后已恢复浏览器默认视口并关闭测试标签。
- 服务端启动检查已执行到监听阶段；因本机已有服务占用 `0.0.0.0:80`，第二个实例返回 `EADDRINUSE`。
- `npm run deploy:build -- --profile txsl`：通过，静态资源由 1,471,995 bytes 压缩至 885,698 bytes，gzip 总量 248,690 bytes。
- `npm run deploy:verify -- --profile txsl`：构建后的校验器仍报告两项既有规则问题：将服务端路由 `/sns-cookies` 误判为缺失静态文件，以及把 `pages/index.html` 中运行时加载的 `/client/cache-store.js` 判定为源码路径。本轮未为绕过校验器而改动这两条既有路由/加载逻辑。

## 待生产环境回归

- Windows / Android / iOS 的截图粘贴差异，以及多图片剪贴板行为。
- Chrome / Edge / Safari 对文件与目录混合拖放的数据项差异。
- 有真实传输任务时抽屉三态切换、任务数字增减与移动端触摸命中区域。
- 最早一条服务器文件永久不可用时，后续 SNS / Telegram Bot 元数据是否完整显示并继续恢复。
- 浏览器 A 从 Node.js 取得文件后，浏览器 B 在不刷新 A 的情况下能否发现 A provider。

## 260716 进度入口回归修正

- P2P / Socket.IO 选择、传输请求 watchdog、常规供源选择与核心服务端分配保持 `HEAD` 原有链路行为；进度抽屉需求不介入传输调度。第 7 项仅保留在应用层的 SNS / Telegram 非阻塞后台恢复与成功落库后的供源公告。
- 顶栏传输入口改为常驻显示，数字表示抽屉中的全部任务数；存在进行中任务时才启用跳动动画，仅有等待、建链或停滞任务时保持静止。
- 即使当前没有任务，用户点击顶栏入口仍可重新打开已隐藏的进度抽屉，不会失去恢复抽屉的入口。
- 回归修正：顶栏传输入口仍常驻，但当进度项、等待队列和活动下载均为零时，抽屉本体无条件完全隐藏，不再因为上次保存为展开状态而显示空抽屉。

## ICE 建链诊断

- 保持 `client/file-assets.js` 与 `server/file-assets.js` 的核心链路策略和 `HEAD` 完全一致，仅在 `app.js` 增加只读诊断。
- 输出本地及远端 ICE candidate 的类型、协议、地址、端口和 STUN URL，并记录 candidate error 与 gathering 状态。
- ICE 持续 `checking` 接近文件 DataChannel 原有 5 秒超时前，通过 `RTCPeerConnection.getStats()` 输出本地/远端候选集合、候选对状态、transport 与选中候选对信息。
- ICE 成功或失败时也输出同结构快照，用于区分候选信令缺失、host 候选不可达、STUN 失败和候选对检查失败；诊断不调整超时、重试或 relay 降级。

### ICE 信令关联诊断补充

- 客户端记录当前 origin、本机与对端设备 ID、确定性 offer 发起角色、页面安全上下文，以及浏览器可查询到的摄像头、麦克风和本地网络权限状态。
- offer、answer 与 ICE candidate 增加 ICE username fragment（ufrag）关联信息，可判断候选是否属于当前 SDP 协商轮次，避免把旧候选、并发 offer 或回滚后的候选误认为同一次建链。
- 客户端按时间线记录连接复用、等待指定发起端、普通 offer、文件通道 offer 检查、glare 忽略/回滚、远端描述落地和 answer 落地等阶段；高频 candidate 明细仅写浏览器 console，避免诊断流量反过来干扰建链。
- 服务端在现有 `/api/debug-logs` 中记录信令限流、载荷/设备/类型校验拒绝、目标 socket 缺失和成功转发，并附带双方设备 ID、socket ID、SDP ufrag 及候选摘要。
- 本次补充仍未调整 P2P 超时、ICE 配置、offer/answer 分支、candidate 转发、重试或 Socket.IO relay 降级行为；`client/file-assets.js` 与 `server/file-assets.js` 保持和 `HEAD` 完全一致。

### 单文件恢复重试互相覆盖修正

- 根据 4.1MB 文件恢复日志确认：首次请求到首块数据之间约 47.6 秒，同一文件产生 16 次请求、7 次 relay start、7 轮远端 offer，进度抽屉因此反复创建和清理。
- 根因之一是完整文件的旧尝试返回 `file-asset-unavailable` 时，接收端没有像 transfer status 那样校验 `requestId`；旧失败会错误触发当前请求重试，新 requestId 又会使已启动的 relay 被判为过期，形成循环。
- `handleUnavailable()` 现对完整文件执行 requestId 校验，忽略不属于当前请求的旧 unavailable；多源分片仍按原有 transferId 逻辑处理。
- 未修改 P2P/relay 选择、ICE 配置、超时、并发、分片、传输进度或服务端分配策略。

### 缓存公告误重启下载修正

- 根据后续 4.1MB 文件恢复日志确认：首次发出两个相隔约 418ms 的完整文件请求；第一次 relay 启动后没有数据，约 15 秒后第三次请求的 relay 才在 78ms 内收到首块并完成。
- 根因是 `announceStoredFileAssets()` 在设备更新、页面 focus、可见性变化、心跳等普通缓存公告完成后也执行 `resumePending()`，清除当前请求占槽并为仍在建链的文件生成新 requestId，造成服务端现有分配与接收端当前请求身份错位。
- 现在仅在 Socket 真正连接时先恢复断线前待办，再执行本地缓存公告；普通缓存公告不再重置正在建链或传输的任务。
- 未修改 P2P/relay 选择、ICE 配置、5 秒文件通道等待、并发、分片、传输进度或服务端调度参数。

### 服务端陈旧分配静默阻塞修正

- 后续测试日志确认，第一次完整文件请求发出后 51.478 秒内没有 provider start、relay start 或首块数据；第二次请求发出 5.119 秒后启动 relay，并在 123ms 后收到首块。该间隔对应 45 秒请求 watchdog、3 秒重试退避及扫描余量。
- 服务端原本会将同一文件、同一接收设备的 assignment 在 pending 状态保留 45 秒、started/active 状态保留 10 分钟；这段时间内即使强制还原携带了新的 requestId，也会作为重复请求被静默丢弃。
- 新的强制 requestId 现在可以立即替换旧 assignment；同一 socket、同一 requestId 的普通重复请求仍按原逻辑去重。
- assignment 新增接收端 socketId 关联；同一设备切换网络或 Socket 重连后，新 socket 的恢复请求不会继续被旧 socket 的 assignment 阻塞。
- receiver rejection、relay 清理和发送端取消标记按 requestId/attemptId 隔离，旧尝试只能清理自己的 relay，不能释放或中止同文件的新尝试。
- 未修改 P2P/relay 优先级、ICE 配置、超时常量、并发上限、分片大小或进度抽屉状态算法。
