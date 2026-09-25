# 隧道核心、设备、历史同步与权限

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 功能初衷

“隧道”是 Drop2Tunnel 最早且始终保持的核心抽象：多台设备临时或长期加入同一个逻辑空间，不要求传统账号系统，就能交换内容和协同状态。

早期 Prompt 的关键诉求是：

- 用户可以快速创建/加入会话；
- 多设备应该看到一致的传输记录；
- 新设备加入后要补齐历史；
- 页面刷新后协同内容要从在线设备恢复；
- 支持二维码以外的 5 位短码；
- 后续希望有附近设备发现、设备邀请、联系人、备注等能力。

随着项目演进，“session / tunnel”不仅承载文件，还承载权限、管理员、VClient、实时媒体和跨隧道转发。

## 2. 隧道身份

一个隧道至少涉及：

- 内部长 `sessionId`；
- 5 位 `shortCode`；
- 可选备注 `remark`；
- 创建者/owner；
- 普通设备权限；
- 后续管理员记录；
- 已加入设备/历史成员；
- 传输记录和文件资产。

服务端 `infra-store.js` 的 `tunnels`、`tunnel_members`、`devices` 保存基础审计信息。

### 2.1 短码

短码的目标是降低“复制长 UUID / 完整 URL”的使用成本。

当前入口同时支持：

- 输入 5 位短码；
- 最近加入的本地隧道选择；
- QR / 链接；
- 设备邀请；
- 后台/其它功能中的隧道目标选择。

相关 Socket / API：

- `join-by-short-code`
- `short-code-session`
- `session-short-code`
- `GET /api/short-codes/:shortCode`

### 2.2 备注名

备注的需求来源是多隧道长期使用后，单靠短码难以识别用途。

当前备注会出现在：

- 功能首页；
- 隧道切换；
- 后台隧道列表；
- 某些跨隧道目标选择器。

服务端事件：

- `session-remark-update`
- `session-remark`

后续新增 UI 时应优先显示“备注 + 短码”，而不是只显示不可读的 session UUID。

## 3. 路由页与进入隧道

`pages/index.html` 同时承载：

- 路由/landing 状态；
- 功能首页 `#appShell`。

主逻辑：

- `initSessionLanding()`
- `openSession()`
- `startTunnelApplication()`

历史需求曾专门把品牌文案从功能首页迁到路由页顶栏，避免功能首页主体重复占空间。

路由页应负责“选择/输入隧道”，进入后才显示主功能三栏。

## 4. 设备身份与显示

浏览器本地持久化设备 ID，并生成/保存设备名称。

当前设备体系还包括：

- 设备 profile；
- 在线状态；
- last access / membership 审计；
- 本地备注；
- 备注的不可见备份；
- 关注联系人；
- 联系人资料页；
- 设备邀请；
- 附近设备候选。

### 4.1 设备备注

需求明确要求备注是**设置方自己的展示语义**，不是把对方全局改名。

显示可组合为：

`备注名(原设备名)`

相关事件：

- `device-remark-backup`
- `device-remark-restore-request`
- `device-remark-restore-response`

这样即使浏览器本地数据部分丢失，也可以从被备注设备保存的不可见副本尝试恢复。

## 5. 在线设备与心跳

当前有：

- Socket connect/disconnect；
- `tunnel-heartbeat`；
- server 设备列表；
- client `device-joined/device-left/device-updated/session-devices`。

服务重启后旧的 online bit 不能作为事实，因此 `infra-store` 启动 migration 会把持久化 online/active 清零，等待设备重新加入。

## 6. 历史同步

### 6.1 为什么复杂

最早的主要 Bug 之一就是：

> 多台设备并没有真正同步出一致的历史。

因此后来形成了多个层次：

- 本地 IndexedDB messages；
- 服务端当前历史；
- 服务端持久审计；
- join 后 history snapshot；
- explicit history request / ack；
- reconcile；
- deletion tombstone；
- 排序 timestamp；
- 浏览器 scroll anchor。

相关事件至少有：

- `session-history`
- `session-history-request`
- `session-history-ack`
- `history-reconcile`
- `message`
- `message-ack`
- `message-updated`
- `message-deleted`

### 6.2 历史顺序

前端有独立历史排序逻辑：

- `nextHistoryTimestamp`
- `getHistorySortValue`
- `compareHistoryMessages`

不能只依赖 DOM append 顺序。

当前传输记录标题时间按本地完整格式显示：

`YYYY-MM-DD hh:mm:ss`

该需求在 260924-1 已人工验收通过。

### 6.3 删除墓碑

历史上出现过“服务器重启后，旧客户端又把已删除记录带回来”的问题，因此删除不能只删某个浏览器 DOM / IndexedDB 行；服务端需要保存能阻止旧副本复活的删除状态。

后续碰历史 merge/reconcile 时必须保留 tombstone 语义。

### 6.4 大量历史性能

2026-08 曾尝试通过历史指纹、可见窗口、延迟 hydrate 等方式优化大量记录，但一度破坏普通浏览器传输链路。后续回退到稳定基线，并把审计持久化移到非阻塞旁路。

因此当前原则：

- 不要为“后台统计完整”牺牲前台实时广播；
- 不要因为历史很多就擅自只保留 DOM 可见窗口，除非同时验证活动 transfer/progress；
- 优化需要以 `p2p-connection-regression` 和 history startup 回归为基础。

## 7. 传输记录类型

当前时间线可承载：

- 文本；
- 富文本；
- 单文件；
- 文件合辑；
- Telegram 入站文件/album；
- SNS 获取结果；
- 网页 ZIP；
- 从其它隧道转发的记录；
- server asset 生成的普通文件记录。

文件记录与二进制内容是分离的：

> 有记录 ≠ 本机已有完整文件缓存。

因此 UI 必须根据缓存/供源状态显示“可直接打开、需要恢复、等待来源”等状态。

## 8. 富文本与协同编辑

最初需求要求：

- 同隧道设备实时同步编辑内容；
- 页面刷新时，从在线设备恢复权威内容；
- 如果其它在线设备都是空、本机非空，则保留本机；
- 发送协同内容后，同隧道所有设备清空编辑区；
- 图片不能用巨大 data URL 粗暴同步，需单独资产链路。

当前涉及：

- `editor-sync`
- `editor-state`
- editor asset request/provider/relay 事件；
- 本地 editor IndexedDB；
- 富文本发送；
- 富文本记录二次编辑；
- 版本历史 / diff；
- `baseVersion` 并发校验；
- 离线 pending edit；
- 冲突后手工合并或作为新记录发布。

编辑器中的图片/文件引用已经独立为 editor asset，不应回退为把所有二进制直接嵌入 HTML。

## 9. 权限体系

当前隧道权限不是只在 UI 隐藏按钮，而要求服务端事件层也验证。

历史权限矩阵至少包括：

- 读取记录；
- 发送文本；
- 发送富文本；
- 发送文件；
- 删除；
- 协同编辑；
- 全局对讲；
- 群语音。

相关事件：

- `session-permissions-update`
- `session-permissions`
- `permission-denied`

前端：

- `isTunnelOwner()`
- `canManageTunnelSettings()`
- `hasTunnelPermission()`
- `requireTunnelPermission()`
- `applyTunnelPermissionUi()`

### 9.1 读取权限特别重要

无读取权限设备不能只是在 UI 上隐藏历史，而应该：

- 不发历史 snapshot；
- 不发实时记录；
- 不允许其它历史广播泄露。

### 9.2 管理员

项目后来增加了管理员设备选择和 `session-admins-update`。整理权限需求时，要区分：

- owner；
- admin；
- normal joined device。

旧 README 中“尚未完成多管理员”已可能滞后，修改前应以当前源码为准。

## 10. 联系人、附近设备与邀请

### 10.1 Nearby

“附近设备”历史需求的动机是减少扫码/输入短码。

当前实现属于**服务端辅助 nearby**，不是 Bluetooth / Android Nearby Connections。

相关：

- `nearby-presence`
- `nearby-devices`
- `enablePreciseNearbyDiscovery()`
- `inviteNearbyDeviceToCurrentTunnel()`

用户可额外授权更精确的局域网 P2P 引导，但不应把服务端候选列表描述为系统级物理近场发现。

### 10.2 设备邀请加入隧道

事件：

- `device-tunnel-invite`
- `device-tunnel-invite-ack`

客户端有离线/排队处理，邀请浮层与通知状态都需要考虑当前是否存在其它阻塞 UI。

### 10.3 联系人

当前已支持：

- follow/unfollow；
- profile；
- 备注；
- 语音呼叫；
- 对讲等入口。

联系人语音已经演进到服务端呼叫状态机，不再只是“在同隧道直接发 WebRTC”。

## 11. 移动端三栏

功能首页逻辑上是：

- 左：连接设备；
- 中：传输记录；
- 右：协同编辑。

移动端通过横向 workspace 进行 Focus 和手势切换，核心函数包括：

- `setMobileWorkspaceView()`
- `normalizeMobileWorkspaceView()`
- `settleMobileWorkspaceView()`
- `initWorkspaceSwipeNavigation()`

历史上出现过：

- 自动 Focus 某条记录后整个三栏偏移；
- 页面认为自己处在左栏，但画面实际 90% 是中栏；
- 返回/右滑失效；
- Loading 层导致坐标错位。

修改三栏 transform / scroll / width 时必须在 Android 真机或至少触摸环境测试。

## 12. 隧道控制中心

移动端 Focus 到“隧道”后再次点击，会打开“切换隧道 + 功能磁贴”的控制中心。

历史上新增：

- 磁贴排序；
- 顺序记忆；
- 主题快捷切换；
- 网盘；
- 网页工坊；
- 通知/工具入口等。

控制中心不是简单导航栏：部分磁贴点击后应关闭面板，部分（如主题轮换）应保持面板打开。后续增加磁贴要明确该行为。

## 13. 主题

主题已经从最初的 `#themeSwitcher` 常驻/临时浮层，演进为：

- 顶栏主题按钮：点击立即切下一个主题，同时展开竖向主题列表；
- 点击空白关闭列表；
- 移动控制中心主题磁贴：立即切下一个主题，但不关闭控制中心，也不打开顶栏竖条；
- 完整主题选择器迁到隧道设置页。

因此不要恢复旧的“五秒悬浮 #themeSwitcher”方案。

## 14. 高风险回归点

后续 AI 修改本模块尤其要注意：

1. join/reconnect 时不要用空本地 editor 覆盖在线非空内容；
2. 历史 reconcile 不要复活 tombstone；
3. 大量历史优化不要误删正在传输的 progress；
4. history.back/popstate 不要多消费一层；
5. 移动三栏 Focus 与 scroll/transform 需要保持一致；
6. 权限不能只做客户端；
7. nearby 不等于物理 Nearby；
8. owner/admin/normal device 语义不要混淆。
