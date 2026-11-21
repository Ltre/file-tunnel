# 传输记录、文件资产、缓存与恢复链路

> **源码基线 Commit**：`4502065e4a4a1415d9b7c1a9f7a314f4167ff0cd`  
> **文档更新时间**：`2026-11-21`

## 子模块文档

- [Drop2Tunnel 磁链分享、种子发现与独立下载器](./transfer-cache/magnet-download.md)
- [文件夹 ZIP、合辑打包与本机目录镜像](./transfer-cache/folder-archive-directory-mirror.md)

## 1. 设计目标

文件传输链路经历了项目中最多的回归之一。最终形成的核心目标不是“只用某一种协议”，而是：

- 有本机完整副本时立即使用；
- 有在线浏览器供源时优先设备间获取；
- P2P 建链失败或传输失败时允许 Socket.IO Relay；
- server asset / Telegram 等特殊来源作为兜底；
- 当前设备获得完整副本后，再成为其它设备的普通供源者；
- UI 始终能区分记录存在、完整缓存存在、正在恢复、来源离线、中断等状态。

## 2. 文件与记录是两个对象

传输记录保存：

- message ID；
- 类型；
- 文件元信息；
- sender；
- remark；
- 时间；
- collection 关系等。

真实文件字节可能在：

- 当前浏览器 CacheStore；
- IndexedDB；
- OPFS；
- File System Access 外部句柄；
- 其它在线浏览器；
- VClient；
- server asset；
- Telegram；
- 暂存下载目录。

因此：

> 删除某条记录、释放某份缓存、删除服务器临时资产、删除 Telegram 文件，是不同操作，不能用一个“delete file”概念混在一起。

## 3. 浏览器缓存层

### 3.1 CacheStore

`client/cache-store.js` 抽象了：

- MemoryTempDriver；
- IndexedDbBlobDriver；
- OpfsCacheDriver；
- Drop2TunnelCacheStore。

历史上单纯把所有大 Blob 放 IndexedDB 会遇到性能/配额问题，因此当前缓存层已经具有独立驱动思维。

### 3.2 “完整缓存”判断

前端有：

- `hasCompleteFileCache()`
- `materializeCachedFileRecord()`
- `getStoredFileBytes()`
- file inventory / cache status helpers。

不要仅以“files store 中有一行”判断文件完整。

### 3.3 清理

用户操作分为：

- 释放当前浏览器缓存；
- 删除传输记录；
- 垃圾缓存清理；
- 网盘浏览器缓存清理；
- 合辑成员清理。

删除记录后，为降低大文件 DB 扫描阻塞，历史实现把孤立缓存清理推迟到 idle/异步队列。

## 4. File System Access 外部句柄

Chrome/Edge 安全上下文下，可以保留本机文件/目录句柄。

初衷：

- 大文件不用复制一份完整 Blob 到浏览器数据库；
- 原文件仍在本地时可直接供源。

但句柄并不可靠：

- 用户移动文件；
- 删除；
- 重命名；
- 权限过期；
- 不同浏览器不支持。

因此 UI 必须能从“💾 外部文件”回退到普通恢复状态。

历史需求特别强调：

- 远端副本确认前，不要过早清掉同 fileId 的安全缓存；
- 远端恢复成功后，立即刷新记录、合辑卡片和预览；
- 不应把外部句柄状态误判成“已经有可释放的浏览器缓存”。

## 5. 供源发现

服务器 `server/file-assets.js` 保存在线资产供源状态，并按：

- freshness；
- provider；
- receiver load；
- assignment

选择来源。

相关事件：

- `file-asset-discovery`
- `file-asset-manifest`
- `file-asset-request`
- `file-asset-available`
- `file-asset-unavailable`

浏览器获得完整缓存后会 announce，成为后续普通来源。

## 6. WebRTC P2P

### 6.1 初衷

大文件直接设备间传输，避免服务器成为带宽瓶颈。

### 6.2 当前实现要点

- RTCPeerConnection；
- DataChannel；
- offer / answer / ICE signaling；
- chunk send；
- bufferedAmount/backpressure；
- completion ack；
- timeout / retry；
- multi-source / range 场景。

### 6.3 历史高风险问题

Git 历史中大量提交专门处理：

- P2P 100% 后又重新 Relay 一遍；
- DataChannel 提前 close，旧 receiver 兼容；
- 多源分片 completion race；
- 旧 relay attempt 未清；
- ICE restart 无效；
- VPN/代理多网卡 candidate 被错误补写；
- heartbeat/retry 调度风暴；
- 接收进度反复归零；
- 一个失败任务阻塞后续队列。

后续重构绝不能只验证“小文件本机两浏览器能传”，至少要覆盖：

- 大文件；
- 多文件；
- 多设备；
- P2P 成功；
- P2P 失败转 Relay；
- receiver 断线；
- 同 file 多来源。

### 6.4 PC 代理模式、Android VPN 与 Origin 权限：2026-08 对照复盘

**详细原始记录：** [P2P_TRANSMISSION_NOTES-260812.md](../other/P2P_TRANSMISSION_NOTES-260812.md)。其中 §5.2 直接交叉索引 2026-08-10 `stable-1.7.12` 和 08-11 `stable-1.7.27` 各自的 48 组用例；原始用例仍保存在 `TECH_CHALLENGES_OF_TRANSMISSION (260810/260811, ...).md`。

在同一局域网、Windows 11 trojan-gfw（关闭/PAC/全局/增强）和 Android Igniter 环境下，当时观察到：

| 两端状态 | `10.0.0.11` / `tun-test.miku.us` | `tun.miku.us` |
|---|---|---|
| Windows 任意上述模式 + Android 10 Igniter 关 | P2P | P2P |
| Windows 任意上述模式 + Android 10 Igniter 开、Exempt 开 | Socket.IO Relay | P2P 为主，个别样本偶发 Relay |
| Android 13 与 Android 10 均未启用 Igniter | P2P | P2P |
| 两台 Android 均启用 Igniter、Exempt 开 | Socket.IO Relay | P2P |
| Android Igniter 开、Exempt 关且网页无法访问 | 不纳入 WebRTC 成败统计 | 不纳入统计 |

**这不是“PC 全局代理必然损坏 P2P”或“正式域名天然有特殊穿透能力”。** 随后的 2026-08-12 双 Igniter/Chrome 无痕实验控制了站点媒体权限：未授权时 Relay、授权并刷新后 P2P、撤销后又 Relay；同一条件在 `tun.miku.us` 与 `tun-test.miku.us` 都复现。它支持 Origin 媒体授权状态影响浏览器 ICE 本地地址候选的解释；没有采集完整 candidate pair 的旧用例，不足以确定某次 UDP 走了哪个物理接口或 Chrome 内部哪种具体 IP 处理模式。

**区分三个层级：** (1) PAC/全局/Exempt 影响网页与 Socket.IO 信令能否抵达服务端，不保证 WebRTC 的 UDP/mDNS/本地接口可达；(2) ICE 与 DataChannel 是否实际连接，受 VPN、候选、浏览器隐私权限影响；(3) 文件级等待、完成 ACK、重试与 Relay 决定单个文件/分片最终怎么传。当前 `client/file-assets.js` 的共享连接等待窗口为 1500ms、文件通道等待为 5000ms，先发的任务可能 Relay、后续连接就绪的任务可能 P2P；不能只凭进度条定因。

当前标准文件 PeerConnection 使用 STUN、`iceTransportPolicy: 'all'`，没有在其 `iceServers` 中配置 TURN；**TURN ICE `relay` candidate 与应用层 Socket.IO Relay 是两个不同机制**。隧道设置中的“增强局域网 P2P”由用户主动获取媒体权限、立即停止 track，**不发送摄像头/麦克风内容**；授权后提示手动刷新，不自动中断传输。历史 LAN-only 独立 PeerConnection 试验已撤回，不应作为本问题的默认修复方向。

排查时先复刻 §5.2 的 PC PAC/全局 × Android Igniter × 三种 Origin 矩阵，同时固定 Chrome Profile、权限、设备/文件；记录 `requestId` / `transferId` / `attemptId`、ICE selected pair、文件 DataChannel 状态、`p2p-degrade-to-relay` 和 ACK，以区分 ICE 失败、文件等待超时、完成竞态及 UI 错标。

## 7. Socket.IO Relay

Relay 是可用性保障，而不是错误状态。

服务器：

- 接收 relay start/chunk/complete；
- 把 chunk 转发给指定 receiver；
- 维护 transfer token / relay key；
- 收集 ack；
- 清理超时 relay。

原则：

- Relay 不能与已成功 P2P 的 attempt 同时重复完成；
- late event 必须能识别旧 attempt；
- Relay 的服务器接触文件分块，因此项目不是“服务器永远零接触”。

## 8. Server Asset

某些文件天然先存在服务器，例如：

- SNS/YouTube 下载成品；
- Telegram 恢复临时文件；
- 后端产生的资产。

它们可以注册成 server asset，再让浏览器按普通文件链路获取并缓存。

客户端包含：

- `fetchServerAssetCache()`
- `requestServerAssetWithPeerPreference()`
- recovery stage。

一个关键历史修复是：

> 即使记录来源是 SNS / server asset，如果已有其它在线浏览器缓存，也应先尝试 P2P，而不是每台设备都重新让服务器/上游下载。

## 9. Telegram 作为隧道文件恢复来源

这与“Telegram 网盘”不同。

普通隧道记录可以绑定 Telegram `file_id`，当浏览器供源均不可用时：

- 服务端按需下载；
- 浏览器获取完整文件；
- 浏览器之后成为普通供源者。

资源管理器还有“防失联”检查/修复：

- 检查旧 file_id 当前 Bot 是否仍能获取；
- 如果已有本机/在线副本，则通过新 Bot/当前 Bot 重新上传；
- 更新绑定。

Telegram `file_id` 与 Bot 强关联，不能当成全局永久地址。

## 10. 文件发送

入口包括：

- file input；
- drag/drop；
- PWA Share Target；
- 粘贴板图片；
- 文件夹；
- 已挂载本机文件；
- 网页工坊发布产生的 ZIP；
- SNS/server asset 转入隧道。

### 10.1 首屏记录与本地入库解耦

历史上多文件/音视频因为串行读文件导致发送后长时间看不到记录。后来把“先发布传输记录”与“后续准备本地缓存/封面”解耦。

因此不要为了保证“所有数据准备完再显示”而重新让大合辑首条消息延迟数十秒。

### 10.2 发送处理中占位

文件准备阶段会显示“发送处理中”及阶段进度。

它的目的不是伪造已发送，而是让用户明确知道点击/分享动作已经被系统接受。

## 11. 合辑

合辑是单条传输记录中的多文件集合。

要求包括：

- 合辑 remark；
- 子文件独立操作；
- 宫格；
- P / F / G 多层预览返回关系；
- 全屏跨文件切换；
- 删除单成员；
- 下载全部；
- 缓存恢复；
- 收藏。

“下载全部”可等待缺失缓存完成后打 ZIP，也允许用户提前下载当前已准备内容。

合辑中的 fileId 和单文件记录一样参与全局引用/缓存清理，不能把合辑 ZIP 当成唯一真实文件。

## 12. 文件夹发送与目录同步

### 12.1 发送文件夹

浏览器通过 `client/folder-archive.js` 将目录内容打成普通 ZIP，再复用普通文件资产发送，并标记 `isFolderArchive`、`folderName`、`entryCount`。详细格式与兼容边界见 [folder-archive-directory-mirror.md](./transfer-cache/folder-archive-directory-mirror.md)。

### 12.2 本机目录同步

存在目录 mirror 功能：

- Chromium File System Access `showDirectoryPicker({mode:'readwrite'})`；
- 本机目录签名；
- 约 5 秒扫描变化；
- snapshot ZIP；
- `isDirectoryMirror` 资产标记；
- 远端解包写回；
- `skipSignature` 避免刚应用的快照立即回传。

这不是 Telegram 网盘目录，也不是网页工坊 ZIP 目录，命名相似但数据模型不同。

## 13. Clipboard

早期只有文本剪贴板共享，后来增加图片监听/粘贴区。

图片共享要求：

- 只处理图片，不偷偷读取剪贴板文本；
- 内容指纹避免重复提示；
- 浏览器不完整支持 clipboardchange 时使用前台授权探测；
- 最终复用普通文件发送链路。

## 14. 备份与导入

支持：

- 元数据备份；
- 带文件二进制的完整备份；
- 原时间位置 / 追加到尾部；
- 跨隧道导入。

跨隧道导入特别要求：

- 重映射 fileId；
- 不要让两个隧道错误共享同一个缓存引用；
- 删除一个隧道时不能把另一个仍引用的缓存删掉。

退出隧道和导入大备份属于重操作，应有阻塞式进度反馈。

## 15. 会话资源管理器

资源管理器是“当前隧道文件资产及引用关系”的管理视图，不是 Telegram 网盘。

功能包括：

- 文件/合辑/富文本/协同引用；
- 本机缓存状态；
- 外部句柄；
- 远端 provider；
- Telegram 兜底；
- 类型/缓存/来源筛选；
- 跳转引用；
- 挂载本机文件/目录；
- 清理垃圾；
- Telegram 连续性检查/修复；
- 最小化/恢复。

历史要求桌面居中大浮层、移动端全屏；最小化后保留筛选、搜索、scroll、已加载 DOM。

## 16. 进度 UI

主应用有独立传输进度抽屉。

需求包括：

- 多任务；
- 发送/接收方向；
- 排序；
- active 状态；
- 点击定位对应传输记录；
- 折叠/展开；
- 页面刷新/状态恢复边界。

历史上曾因“为了历史懒加载清理 DOM”误删活动进度元素，说明 progress UI 不能简单绑定可见 message DOM 生命周期。

## 17. 预览与缓存的关系

文件预览只应对有意义的媒体类型直接打开。

常见状态：

1. 本机已有完整缓存：直接预览；
2. 外部句柄有效：直接读取；
3. 缺缓存但有 provider：请求恢复；
4. server asset/Telegram 兜底：按需回源；
5. 无来源：显示等待/恢复提示。

不应该因为用户只是打开“属性”就偷偷拉完整几百 MB 文件。

## 18. 大媒体与 Range

普通隧道文件和 Telegram 网盘都出现过 Range / 流媒体场景，但实现不同。

历史上播放器发生：

- waiting/stalled 时主动重设 URL + load；
- 导致浏览器当前 Range 被中断；
- 新请求又从 `bytes=0-` 开始；
- 看起来像缓存到 100% 仍 Loading。

后续取消了这种激进 reload，更多依赖浏览器原生 Range。

修改播放器恢复策略前，应验证真实大 MP4，而不是只测短样例。

## 19. 引用完整性

清理缓存前需要判断：

- 当前 session 是否还有记录引用；
- 其它 session 是否引用；
- collection 成员；
- rich/editor asset；
- mounted / external state；
- pending transfer。

因此 `findReferencedFileIds()`、`isFileReferencedOutsideSession()` 一类逻辑是安全边界，不应为了清理速度删除。

## 20. 测试与修改提示

核心测试至少包括：

- `tests/p2p-connection-regression.test.cjs`
- `tests/file-asset-audit-isolation.test.cjs`
- `tests/history-startup-regression.test.cjs`
- `tests/infra-store-audit.test.cjs`
- `tests/infra-store-write-batching.test.cjs`
- 版本 features tests。

对传输链路的大改，应把历史 Git 中带“看似能用 / 有 BUG / WRONGCODE”的提交视为反例资料：它们证明某个局部修复很容易破坏另一个 fallback 状态。

## 21. 2026-09—10 缓存、剪贴板与来源连续性调整

- 剪贴板图片入口现在先验证可读取且非 0 字节，再出现发送动作；按隧道持久记录已处理指纹，并在异步读取前锁定重复点击，重新授权或内容变化后可重新探测。浏览器用户激活权限限制仍然有效。
- 删除记录先建立持久 tombstone，拦截迟到消息广播、审计写入和历史恢复，避免“已删除又复活”的时序回归；普通无权限或未知记录的删除仍拒绝。
- Telegram Chat 字典支持旧 public 名称到数字 Chat ID 的人工确认映射：手动“防失联检测及修复”可在不下载文件时仅迁移本机来源标注；真正完整 Telegram 回源后仍有校验缓存再迁移的兜底。不会凭任意当前 public 名称推测历史文件归属，不变更 file_id、缓存/供源协议。
- 传输记录滚动区在有溢出时显示到顶/到底按钮，最后滚动后自动淡出，尊重系统减少动画偏好。PWA 初始阶段现在先使交互可用，再按规定恢复历史并建立 Socket，不能为加速无条件省略本地历史或破坏既有安全顺序。

## 22. 2026-10-13—15：上传命名、保存分区及传输授权

- 浏览器普通上传与文件夹上传在**同批次、同目标目录**出现重名时，先通过 `client/disk-upload-names.js` 规划保留扩展名的递增文件名并请用户确认；不同子目录的同名互不冲突。确认后只包装新的浏览器 File 对象，不改本地实体；拒绝则不启动该批次。确认前后的请求仍绑定原发起网盘账号。
- 隧道文件“存到网盘”已改为明确选择**有效登录账号、原生分区及目标目录**，可在对话框新建多级目录；不可无意继承正浏览的协同 Mount 作用域。各账号/分区保留独立目标位置记忆，最终请求固定所选作用域。完成后按原记录建立额外网盘来源，不改变文件资产 ID 或其它供源。
- 2026-10-15 起普通会话加入/跨隧道回源须具备 `server/tunnel-access.js` 签名身份；外部磁链仍仅有特定文件的独立读能力。旧设备短码迁移和离线缓存可读不是服务端授权绕过。详情参见 `tunnel-core.md`、`transfer-cache/magnet-download.md`。
- 传输 UI 的完成、来源/网盘定位和进度展示继续以任务身份、确认 ACK 和文件版本为准。切换账号、刷新、旧请求响应或历史恢复均不能把文件上传到另一个账号/分区。

## 23. 2026-10-17—19：记录复制、文件选择区与消息输入

- 传输记录菜单新增“复制文本”：文本记录复制正文，富文本同时写 `text/html` 与 `text/plain`（清除可执行标签、事件属性及脚本协议）；文件/合辑先使用备注，再以**前后换行**附上各文件名。单文件无备注仍复制文件名，不拿文件名冒充备注正文。菜单改成图标列＋文字列，复制失败给出反馈。此前 261017-3 版本的“只复制备注”已被 261017-4 替代。
- 首页 `#dropZone` 文件选择区改为单行“📁拖拽或选择文件”，保留原 ID、拖入与上传行为；窄屏不再隐藏其中某个提示，约 46px 高的样式测试不代表真机手势验收。
- `#textInput` 现在是保留原 ID 和 1000 字符约束的 `textarea`，按内容自动扩到 **1—4 行**，多余部分框内滚动；桌面 Enter 发送、Shift+Enter 换行，触摸主指针环境中 Enter 换行，Ctrl/Cmd+Enter 可发送，IME 组合中不抢发。发送成功恢复一行；文件选择到输入区间隔缩到约 6px，窄屏安全区仍保留。
- 各界面文字补入现有非简体中文语言资源，更新 `client/index.css` 和对应 app shell 功能后缀。测试需覆盖普通正文、多文件换行、富文本净化、中文输入法、缩放/自动折行及剪贴板权限；不要把宿主浏览器读不到系统剪贴板认作文本已丢失。

相关入口：`app.js`、`pages/index.html`、`client/index.css`、`client/i18n.js`、`client/i18n-catalog.js`；`tests/features-261017-3.test.cjs`、`features-261017-4.test.cjs`、`features-261018-1.test.cjs`、`features-261019-1.test.cjs`、`features-261019-2-client.test.cjs`。

## 24. 2026-10—11：Markdown 消息、历史批量操作与缓存归属

### Markdown 与引用状态

隧道记录新增单独 Markdown 格式与引用处理：`client/tunnel-markdown.js`、`server/markdown-records.js` 维护正文版本、来源引用与附件对应关系。编辑必须携带基准版本，发生冲突拒绝旧覆盖；刷新及消息转发后按安全作用域恢复附件引用，不能把图片文件名或文本里出现的字符串当作可直接读取的文件授权。

SNS/X 帖子转成 Markdown 时，正文附件有对应生命周期和图片资产引用；重复消息和已删除图片的迟到上传不能让正文引用失效或“复活”已删除记录。跨隧道历史需要以会话和消息身份做双重校验。富文本 HTML 的净化与 Markdown 对受限 `data:`/资源地址的规则不同，不能无条件放行通用 Markdown 的任意外链脚本。

### 批量选择与可恢复缓存

- 传输记录支持多选、批量复制和批量删除；界面按钮必须正确区分“已选择数量、真正完成数量、无法操作的记录”。纯文本、富文本、带文件及合辑的复制分别按自己的内容类型形成剪贴板文本/安全 HTML；选中状态离开列表或切隧道后不应污染其它会话。
- 网盘保存位置、转存结果回执和缓存 pin 在跨账号/目录切换、刷新与来源等待期间保持身份一致；`server/disk-task-save-receipts.js` 新增持久回执，结果未知先核对原预约与回执而非再次发到 Telegram。
- “一键获取缺失缓存”按**当前消息实际可追溯资产**运行，进度/成功失败有具体结果；没有供源时不能只显示一段无实际请求的转圈。服务端资产已确认且被本地引用时可安全复用，而来源服务器/浏览器暂时离线仍要反馈原因。
- 原有普通文件的 P2P/Socket.IO Relay 与串流台对节目 Range 的 P2P 直传是不同机制；用户在 PC PAC / Android VPN 下的 WebRTC 差异仍以 [260812 P2P 复盘](../other/P2P_TRANSMISSION_NOTES-260812.md) 和抓取的候选对为准。暂存记录 `prompts/dev-prompt-logs/p2p-progress-origin-difference-todo-261030.md` 是待调查线索，**不是确认修复**。

关联 `app.js`、`client/file-assets.js`、`client/cache-store.js`、`server/file-assets.js`、`server/markdown-records.js` 以及 `tests/history-*.test.cjs`、`tests/markdown-*.browser.cjs`、`tests/transfer-feedback-261101-3.*`、`tests/resource-cache-261106.test.cjs`。

## 25. 2026-11-07—10：P2P attempt 放弃历史、跨隧道转发确认与缓存安全

### 历史方案：P2P 背压失败的明确放弃协议（2026-11-16 已撤回）

- 这是 2026-11-07—10 阶段曾合入的实现，不是当前行为：当时在背压/排空失败后关闭本次文件 DataChannel，并通过 `abandonedAttemptId` 释放接收端对应 attempt。该协议于 2026-11-16 被撤回，当前代码不再发送或校验此字段。
- 历史阶段的服务端校验/转发逻辑也已移除；保留该段仅用于解释 11 月 8 日开发日志中的中间实现，不能作为当前协议说明。
- 普通 `failed`、旧请求通知、其它供源的失败及短暂队列背压不能中断仍在工作的 P2P 路径。没有修改 ICE 建链、分包、并发、缓冲阈值、8 秒停滞判定、30 秒接收期限或 Relay 竞争策略。
- `server.js` 将 P2P `signal` 的每分钟限流计数与聊天/编辑/转发消息分开；沿用同一个限额常量，但普通消息突发不再消耗 WebRTC 建链信令额度。首个超限事件记录 `p2p-signal-rate-limited`。
- `file-asset-relay-complete` 增加阶段、耗时、Socket、会话、目标、资源、传输和 attempt 诊断字段，区分验证、接收端完成 ACK 和服务端记录完成；不记录文件正文。

### 跨隧道来源身份与缓存发现

- 文件资产请求不再只从当前设备身份读取一个旧的 `tunnel-access:{sessionId}` 字符串。客户端优先使用每隧道 `tunnel-authorization:{sourceSessionId}` 中的 `deviceId + grant`，并把精确的 `recordMessageId`、`sourceDeviceId`、`sourceAccessGrant` 随请求发送；旧键仅作为兼容回退。
- 服务端以签名 grant 校验该来源隧道绑定的 deviceId，**请求里自报的 sourceDeviceId 本身不授予权限**。转发文件的目标历史超出内存窗口时，按 `recordMessageId` 从持久历史读取那一条记录后再核对引用关系，不以其它记录或同名文件代替。
- 目标隧道已拥有被转发的文件，但尚无供源设备时，服务端可在确认目标记录归属后触发一次受限 `file-asset-discovery`；同一会话/资源两秒内限一次，单设备记录表限制 256 项。发现只帮助找回目标端已有副本，不提升原来源授权。
- `requestedMetadata` 以合并方式保留来源会话、消息锚点及 `backupSourceSessionId` 等来源字段，避免后续 provider presence 广播覆盖掉目标记录的跨隧道 provenance。资源浏览器重新构建资源项时也保留 `backupSourceSessionId`、`forwardedToSessionId`、`forwardedSourceGrant`。

### 批量转发的逐条确认和未知结果恢复

- 单条与多条转发统一走逐条发送流程。结果对话框分别显示等待、发送中、已确认、失败、未发送和结果未确认；批量处理对确定失败的项目可继续，对结果未知的项目停止后续发送，避免继续扩大不确定状态。
- 每条转发在本地保留稳定目标消息 ID；服务端按源会话、源设备和消息 ID 对并发重复请求做合并，并检查相同消息指纹。转发记录必须实际写入持久历史并完成 flush 后才 ACK。
- 10 秒发送 ACK 超时后，客户端用 `forward-message-status` 查询目标隧道中同一条目标消息，校验 sender、`forwardedFrom` 源会话/消息及目标访问授权。确认成功才标记成功；仍无法确认时显示“结果尚未确认”，用户重试沿用原消息 ID，不盲目新建重复记录。
- 批次记录在当前页面保留已确认项目，重试跳过它们；最多保留 10 个未完成批次，单条最多 50 个未确认目标消息。文件/合辑要求源端缓存可供源；Markdown 附件必须有可用副本，缺失时拒绝转发。

### 缓存盘点和清理的安全性

- 首页 Presence、编辑器图片供源和资源浏览器盘点改用 `getCurrentSessionFileInventory()` 元数据游标，不为枚举资源读取每个 IndexedDB Blob。这样不会仅为筛选少量图片而把大量视频 ArrayBuffer 全部载入内存。
- 垃圾缓存预览失败时显示检查失败并停止，不把读取异常当作“空引用/无文件”。真正删除前重新读取当前会话资源目录和引用集合，核对候选仍属于当前会话；仍被消息、合辑、Markdown、富文本或编辑器引用的**完整缓存**保留；标记为 partial 或 transferInterrupted 的不完整缓存仍可作为清理候选。流媒体缓存另走 StreamingCache 清理。
- 删除失败保留候选并允许重试；资源浏览器单项删除也同时核对 UI 引用和实际 IndexedDB 引用。源会话、目标会话和本地缓存归属字段在重建时继续保留。此处的保护针对**浏览器缓存删除**，不替代服务端消息删除权限。
- 控制中心的批量转发入口支持 Shift 范围选择；逐项结果反馈不再只给一个总成功/失败提示。

关联回归：`tests/p2p-connection-regression.test.cjs`、`p2p-live-261108.browser.cjs`、`source-access-261107.test.cjs`、`relay-diagnostics-261109.test.cjs`、`bulk-forward-261108.test.cjs`、`forward-confirmation-261108.test.cjs`、`forward-results-261108.browser.cjs`、`persisted-forward-261108.test.cjs`、`cache-safety-261107.test.cjs`。


## 26. 2026-11-11—21：传输基线恢复、线路诊断、多源进度与缓存写入保护

### P2P 当前故障处理

- 2026-11-16 以不可变历史对象 `0de94882c998bd6d1556e80954fa3840835e0746` 为对照，恢复发送、等待、背压、失败处理和原有 DataChannel 协议；`abandonedAttemptId`、接收端主动放弃事件及相应服务端字段不再存在。
- 当前发送队列满/背压失败会记录 `p2p-backpressure-failed-without-relay` 并按基线报告失败；不会额外主动关闭共享 PeerConnection、发送放弃通知或立即竞争 Relay。其它明确连接失败/关闭、超时等仍按基线既有分支处理。
- 没有借本轮恢复调整块大小、并发、ICE、超时、冷却或 Relay 降级阈值。旧 attempt/请求 ID 仍用于拒绝迟到完成；被替换的接收任务不能在排队写入结束后提交旧正文或清除新任务，拒绝的迟到完成会收到负 ACK。

### 实际线路诊断与多源标签

- `client/file-assets.js` 在可用时通过 `RTCPeerConnection.getStats()` 读取 selected candidate pair，记录本地/远端地址和端口、candidate type、协议、RTT、连接级字节计数/速率及应用传输类型。每个 PeerConnection 至少约 5 秒才采样一次，最多保留 32 个未完成采样；异步卡住、失败或无候选对不会阻断传输。
- 这些速率属于 PeerConnection/candidate-pair 级统计，可能包含同连接上的其它文件或媒体流，不能当成某个文件的独占速度。没有 selected pair 时记录 unknown，不伪装成 host/local 路径。
- 多源接收端按**当前活动 Range 的实际 transport**显示纯 P2P、纯 Socket.IO Relay 或 mixed；仅有 manifest/等待中的范围不显示空闲接收行。Range ACK 只完成该范围，不等于整文件完成；完整缓存公告到达后才结束文件行并显示 100%。发送端进度按文件和接收设备合并本机已供给的唯一范围，并从已发送量扣除 DataChannel 待排缓冲。
- `app.js` 将进度 UI 绘制节流为至少约 120 ms，合并高频更新并保留终态刷新；不改变网络分片或 ACK 协议。

### IndexedDB 正文与恢复元数据竞争

- `saveToStore('files', ...)` 对 metadata-only 恢复写入启用保护：在同一个 IndexedDB readwrite transaction 中重新读取现有行，再合并元数据；如果现有记录已有完整正文，保留其 `data/cacheStoreRef/cacheStorage` 和完整缓存状态，防止迟到恢复元数据覆盖已完成文件。
- 内存回退存储在异步读取后重新读取最新行再合并。显式 `clearFileCache` 不走该保护，用户主动清理仍可删除正文。

### 跨隧道恢复锚点补强

- 当旧客户端/缓存恢复请求缺少 `recordMessageId` 时，服务端仅在目标隧道持久历史中按精确 `sessionId + fileId` 查找记录，再执行原有 sender、来源 grant、删除状态、文件元数据及前驱记录证明；请求提供了错误锚点或已有引用冲突时不会降级到宽泛查找。
- 空 MIME 与 `application/octet-stream` 在旧转发记录核验时按同一未知二进制类型处理，不放宽所有权或来源证明。此回退仅恢复目标端已持有的精确副本，不授权读取原来源隧道其它文件。

### 来源授权生命周期、目标副本回退与诊断（2026-11-20）

- 文件请求/发现事件在检查来源权限前，先确认当前 Socket 已加入目标隧道、请求的 `sessionId` 与当前会话一致、设备仍是目标成员。尚未完成加入、旧隧道迟到包或已移除成员的请求交回既有处理器丢弃，不再误报“来源隧道尚未获得访问权”；加入完成后沿用原 `resumePending` 恢复路径。
- 来源访问仍优先要求已验证的转发关系或来源隧道签名 grant。两者都不能证明时，新增的 `canSeekDestinationCopy()` 只允许目标隧道内的受限查找：当前设备必须是目标成员且具备 read 权限；服务端持久历史必须存在未删除的目标记录和未移除的文件引用；fileId、来源隧道、目标隧道及可选 recordMessageId 必须精确匹配。它只帮助发现/恢复目标隧道已经持有的那份副本，不授予来源隧道读取权、不扩展来源成员资格，也不允许读取来源隧道其它文件。
- 没有目标在线供源时保留恢复意图，等待目标隧道内的缓存设备上线并公告后再沿现有流程请求；不会把“暂时没有供源”伪装成来源权限拒绝。真正无 read 权限、记录已删除/引用已移除、锚点冲突或文件不匹配仍拒绝。
- 真正的来源拒绝会返回 `FILE_SOURCE_ACCESS_DENIED`，并附带 `CAONIMA-GPT` 关联诊断（request/transfer/file/record/session/socket 和授权判断）。只查询当前用户可读的目标记录，不返回来源凭据或文件正文；客户端 `app.js` 将其写入浏览器错误日志，IndexedDB 仅用 `getKey` 检查缓存键是否存在，不读取大文件正文。诊断辅助失败不能中断原权限提示。
- Express `sendfile()` 的 `Request aborted/ECONNABORTED` 与 Socket.IO 来源授权拒绝是不同入口；当前日志没有证据证明二者同因，不能合并成一个根因。

### DataChannel 缓冲排空期间的发送进度（2026-11-20）

- 文件块入队后若 DataChannel 仍有 `bufferedAmount`，客户端每约 100 ms 采样一次已离开发送缓冲区的字节，更新发送端进度；采样仅影响显示，不增加网络消息或等待步骤。
- 采样停止于通道关闭、失败、取消或缓冲排空；排空后进度最多显示 99%，整文件 100% 仍必须等待接收端完整缓存/完成 ACK。没有改变块大小、并发、背压、P2P/Relay 选路、超时或完成协议。

关联回归：`tests/transfer-baseline-261116.test.cjs`、`tests/file-route-diagnostics-261111.test.cjs`、`tests/file-progress-261114.test.cjs`、`tests/whole-file-progress-261116.test.cjs`、`tests/transfer-progress-261117.browser.cjs`、`tests/multi-source-route-261119.test.cjs`、`tests/cache-metadata-261111.browser.cjs`、`tests/forwarded-server-assets-261117.test.cjs`、`tests/source-access-feedback-261120.test.cjs`、`tests/source-access-diagnostic-261120.browser.cjs`、`tests/direct-route-261116.test.cjs`、`tests/relay-complete-261116.test.cjs`。

**现场边界：**开发日志仍将真实手机代理环境中的低速、偶发 Relay 根因及启动等待问题列为未完全查明；本机隔离 Chrome/WebRTC 的正文一致性不能代替实体 Android、用户 VPN 或真实磁盘环境验收。
