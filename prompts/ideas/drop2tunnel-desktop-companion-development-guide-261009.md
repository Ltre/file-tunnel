# Drop2Tunnel Desktop Companion 开发指南

> 文档定位：供后续新建**独立仓库**时作为产品约束、架构设计、开发分期及验收依据。  
> 产品名称：**Drop2Tunnel Desktop Companion**  
> 状态：开发前规划；**尚未核对现有 Drop2Tunnel 最新代码与协议实现**。本文明确区分已确定的产品需求、建议设计与需要实际核对的对接事项。

## 1. 产品定位

Drop2Tunnel Desktop Companion 是 Drop2Tunnel 的**跨平台桌面增强客户端**，不是完整 PWA 的替代品，也不只是一个托盘图标。

- **Drop2Tunnel PWA**：继续提供完整隧道、传输记录、网盘、网页工坊等现有功能。
- **Desktop Companion**：在 PWA/承载浏览器关闭时仍可独立运行，提供系统托盘常驻、切换隧道、查看最新传输记录、主动发送文件、点击指定文件按需下载，以及本机缓存与指定 PWA 的衔接。
- **现有 Drop2Tunnel 服务端及 PWA**：保留当前隧道、设备发现、记录元数据与文件传输的实际权威归属及协议；哪些状态在服务端、哪些在浏览器或设备端，需以最新代码为准。Companion 必须尽量复用既有协议和记录模型，不另起一套平行文件系统。

**核心原则：仅持续接收必要的隧道状态、设备状态及传输记录元数据；不自动同步、下载或镜像文件内容。**

## 2. 支持平台与发布目标

| 平台 | 目标范围 | 说明 |
| --- | --- | --- |
| Windows | **Windows 10、11** | 最低 Windows 10；优先 x64，其他架构视需求与实测决定 |
| macOS | **macOS 10.15 Catalina 至最新版本** | 10.15 重点覆盖 Intel；Apple Silicon 对应其实际支持的较新 macOS 系统 |
| Linux | **Ubuntu / Debian 主流常用版本** | 首轮测试目标：Ubuntu 22.04、24.04、26.04 LTS；Debian 12、13。支持结论以打包依赖及真机测试为准 |

- **不支持** Windows 7/8/8.1 及 macOS 10.14 或更早版本；不要为了历史系统限制主架构。
- Linux 不设脱离发行版及依赖环境的笼统“最低内核版本”。需要核对 WebKitGTK、GTK、AppIndicator、glibc、显示服务器及安装包依赖。
- 桌面环境优先覆盖 GNOME、KDE Plasma、Xfce；兼顾 X11、Wayland。
- 构建/发布目标建议：Windows 安装包、macOS Intel/Apple Silicon 安装包、Linux `.deb`；其后按需考虑 AppImage、`.rpm`。并非所有安装包都必须在首轮同时完成。
- **支持平台是产品目标，不等于现已通过兼容性验证。**最低系统版本必须在实际打包及测试后确认。

## 3. 技术方案与不可逾越的边界

采用：**Rust Core + Tauri 2 + 现有 HTML/CSS/JavaScript 技术栈**。

```text
                  Drop2Tunnel 现有服务端
                  （既有会话/隧道/协议）
                          /       \
                         /         \
            Desktop Companion     Browser / PWA
                   |                   |
             Rust Core             PWA Cache
            /   |     \                 |
       协议层  缓存层  Local Bridge <---->
            |
        Tauri 2 Shell
          /    |     \
      Windows macOS  Linux
            |
    轻量 HTML/CSS/JS 浮层
```

### 3.1 Rust Core

**必须独立于 Tauri WebView 和桌面浮层**，承载：

- 与现有 Drop2Tunnel 服务器的会话、隧道、设备发现、记录事件对接；
- 按需文件发送/下载、传输状态、校验、失败恢复；
- 本机 Companion Cache（文件内容）及 SQLite（缓存索引/业务关联）；
- 指定 PWA 的本机配对、Local Bridge 与导入状态；
- 统一的错误、事件、配置及日志模型。

不要把长时间运行的文件传输核心依赖于可被隐藏、关闭或销毁的 WebView 页面。**Rust Core 独立 ≠ 可以不核对现有协议就自行另造一种传输协议**；协议互通必须先进行 PoC。

### 3.2 Tauri Shell / OS Adapter

负责托盘/菜单栏、弹出窗口、文件选择器、操作系统通知、开机启动、系统密钥存储接口、应用退出及平台差异。尽可能只通过稳定的 Core 接口获取业务数据，不直接决定传输记录归属或缓存生命周期。

### 3.3 HTML/CSS/JavaScript 界面

复用 Drop2Tunnel 已有前端技术与部分视觉组件，但**只实现 Companion 所需的轻量视图**；不把整个 PWA 页面嵌入后台成为另一个完整客户端。未来可以整理可共享的 UI 包，但独立仓库首期不以改造整个 PWA 为前提。

## 4. 第一版功能清单（MVP）

| 功能 | 第一版要求 |
| --- | --- |
| 常驻 | 最小化/关闭浮层不终止后台 Core；用户明确“退出”时才结束程序 |
| 托盘 / 菜单栏 | 显示在线状态，入口可打开轻量界面；可选开机启动 |
| 隧道选择 | 查看有权访问的隧道，选择/切换当前隧道；切换后更新显示内容与操作上下文 |
| 最近传输记录 | 显示隧道内最新推送记录，支持滚动、必要的增量加载及记录中的文件清单 |
| 发送文件 | 用户主动选择文件后，复用现有隧道的正式记录与传输机制执行发送 |
| 按需下载 | 仅在点击某条记录中**具体文件**旁的 `⏬` 时启动相应下载 |
| 传输进度 | 显示进行中/失败/完成状态；可重试、取消；不把展示进度视为已完成校验 |
| Companion Cache | 对完成的发送与下载保留可验证的本地缓存副本及归属索引 |
| PWA 配对及缓存导入 | PWA 可以不运行；打开后由目标 PWA 自己安全导入对应缓存 |
| 打开完整 PWA | 使用绑定的浏览器/Profile 打开对应 Drop2Tunnel PWA，无法精确定位时给出明确提示或回退 |
| 恢复能力 | 程序/网络中断后可识别未完成任务及未导入缓存；不能制造重复正式记录 |

**明确不做：**后台自动下载所有传输记录、自动文件/目录同步、全量远端文件镜像、每个新文件的“接受/拒绝”弹窗、独立网盘客户端、完整 PWA 功能复制。

系统通知可用于提示新记录、传输成功/失败，但**通知≠已经下载文件**，不得借通知触发隐式文件下载。

## 5. 托盘交互与界面规范

下面是产品结构示意，不是最终像素稿：

```text
┌───────────────────────────────────┐
│ Drop2Tunnel                ● 在线  │
│                                   │
│ 当前隧道                          │
│ 家里设备组  ▾                     │
│                                   │
│ [ 发送文件 ]                      │
│                                   │
│ 最近传输                          │
│ ────────────────────────────────  │
│ 19:32  Galaxy S10                 │
│   photo.zip        128 MB   ⏬    │
│   note.txt          23 KB   ⏬    │
│                                   │
│ 19:26  Laptop                     │
│   project.zip      840 MB   ⏬    │
│                                   │
│ 18:51  本机                        │
│   video.mp4        316 MB   ✓     │
│                                   │
│       ↑↓ 滚动查看更多             │
│                                   │
│ [ 打开 Drop2Tunnel ]  [ 设置 ]    │
└───────────────────────────────────┘
```

- 列表是**传输记录**，不是文件接收请求队列；每项保留稳定记录身份，内部可包含一个或多个文件。
- `⏬` 属于记录内的**具体文件**，点击只请求这一文件；已缓存显示 `✓`，失败/下载中采用明确状态及操作反馈。
- 不显示“接受/拒绝”作为收取文件的必经步骤。
- 最新记录可实时增加；历史记录通过滚动增量加载，切换隧道不能串记录。
- Windows/macOS 优先实现托盘图标激活浮层；在 Linux 使用托盘菜单中的“查看最近传输”打开同一个轻量窗口，避免依赖不一定可用的图标点击事件。
- 失焦隐藏只影响窗口，不中止正在进行的传输。Linux Wayland 不保证能把窗口精确定位在托盘图标旁边；功能可用性高于像素级定位。

## 6. 记录流与传输对接：独立仓库最关键的前置工作

**在创建具体文件传输实现之前，必须先核对 Drop2Tunnel 最新项目代码。**讨论只确定了功能目标，并未提供当前权威 API 的准确签名、Socket.IO 事件名、记录字段或 WebRTC/服务器中转的实现细节。

应当从现有项目实查并形成 `docs/integration/current-protocol-audit.md`：

1. 身份登录、设备会话、加入/退出隧道、隧道列表权限；
2. 记录生成、推送、分页/回补、去重、稳定 `recordId`、文件/集合成员身份；
3. 文件提供者发现、请求与授权、WebRTC/DataChannel/Socket.IO/中转的可用路径；
4. 分片顺序、断点、校验、文件大小、来源缓存优先级与失败处理；
5. PWA 当前缓存类型、写入入口、关联记录的主键及跨会话恢复机制；
6. Companion 与 PWA 被识别为两个在线端点时的设备身份/显示问题；
7. 现有协议能否让**非浏览器的 Rust 客户端**直接参与数据传输。

### 推荐的适配边界（概念接口，不宣称现有服务端已经提供）

```text
TunnelGateway
  authenticate / restore_session
  list_tunnels / subscribe_tunnel
  list_records(cursor) / subscribe_record_events
  list_available_sources(tunnel, record, file)

TransferGateway
  publish_file_record / send_file
  fetch_file(tunnel, record, file)
  cancel / retry / progress

PwaCacheBridge
  pair / list_pending / stream_object
  acknowledge_verified_import
```

这些是**新仓库内部抽象**；实现时应映射到既有协议，不得将名称直接误当为已有后端接口。若缺少不可替代的服务端能力，应形成一份最小兼容改造提案，尽量通过原项目中的协议/记录模块补齐，不在 Companion 内长期维护私有平行逻辑。

**第一项技术验证（阻断性）：** 完成“Rust ↔ 现有隧道传输路径 ↔ PWA/其他设备”的真实文件互通。若现有传输必须经过浏览器 WebRTC DataChannel，需评估原生端可互通的 WebRTC/DTLS/SCTP 实现及现有信令；也可复用项目已有的服务端中转路径（前提是项目确实支持且权限语义一致）。不要为了赶 UI 进度擅自换协议。

## 7. 按需下载与主动发送

### 7.1 下载行为

```text
隧道记录中出现 file F
    ↓ 仅显示元数据，不拉取文件字节
用户点击该文件的 ⏬
    ↓
使用 tunnelId + recordId + fileId 查找原文件
    ↓
通过现有设备/来源与传输协议按需获取
    ↓
Companion 专用临时区写入 + 进度更新
    ↓
完整性校验（至少长度；有可信 digest 时校验 digest）
    ↓
原子提交 Companion Cache 与 CacheBinding
    ↓
等待指定 PWA 后续导入
```

- 不能凭文件名或页面 DOM 锚点猜测文件身份。
- 若原提供者离线，按项目真实可用的提供者/回退链处理；没有可用来源则展示“暂不可下载”，**不能凭空假设 Telegram 网盘必然保存该文件**。
- 文件重复点击/多个并发请求应去重或显式复用同一任务，严禁在重试进度中重复计算逻辑字节。
- 需要确认现有分片/Range/断点机制是否可复用；不能以“已开始下载”冒充“缓存完成”。

### 7.2 发送行为

```text
用户点击「发送文件」并选择文件
    ↓
确认当前隧道和文件清单
    ↓
通过现有协议创建/关联正式传输记录
    ↓
按项目原有传输语义主动发送
    ↓
传输完成且满足既有成功条件
    ↓
保留经过核验的独立本机缓存副本
    ↓
绑定同一条正式记录，不创建“托盘专属记录”
```

- 缓存不应只保存原始路径：原文件之后可能被移动或删除。
- 可研究可靠的文件系统快照/克隆优化，但不能在未经验证时把硬链接或原路径当作稳定副本。
- 若文件传输成功而本机缓存因磁盘不足失败，明确区分**传输成功**与**缓存未就绪**，绝不谎报“已导入 PWA”。
- 发送大文件前做好空闲磁盘与临时空间检查；清理不能破坏未完成或未导入的重要缓存。

## 8. Companion Cache：数据与状态模型

数据根目录使用各平台的用户级应用数据目录，不写死 Windows 路径。示意：

```text
<platform-user-app-data>/Drop2TunnelDesktopCompanion/
  cache/objects/<content-id>
  cache/staging/<task-id>.part
  index.sqlite
  logs/
```

建议至少划分下列概念（字段为设计草案，最终与现有记录模型对齐）：

```text
CachedObject
  contentId, size, digest?, mime?, relativePath
  integrityStatus, createdAt, lastAccessAt

CacheBinding
  bindingId, origin, accountIdentity, tunnelId
  transferRecordId, fileId, contentId
  direction(sent|downloaded), anchorHint?
  importState, createdAt, completedAt

TransferTask
  taskId, operation, tunnelId, transferRecordId, fileId
  sourceIdentity?, expectedSize?, expectedDigest?
  receivedBytes, state, retryState, stagingPath

PwaHostBinding
  hostBindingId, pwaOrigin, browserFamily
  browserProfileHint?, pwaAppId?, pairingIdentity
  accountIdentity, permittedScope, pairedAt, lastSeenAt
```

关键约束：

- `tunnelId + transferRecordId + fileId` 是缓存与业务记录关联的**核心身份组合**；需要额外包含服务器/账户命名空间，避免不同服务器或用户 ID 碰撞。
- `anchorHint` 仅供 UI 跳转展示，**DOM 锚点不是缓存数据库主键**。
- 同一内容可以去重存储，不同记录仍保留不同 `CacheBinding`。
- 缓存文件与 SQLite 索引要遵守“文件校验完成 → 原子提交可见状态”的顺序；崩溃后恢复扫描 staging，不将半文件标记为完整。
- 记录被删除、用户切换账户、PWA 取消配对、重复导入、缓存过期、磁盘空间不足都必须有明确行为。
- 不可将浏览器缓存导入 ACK 当作未验证的成功；PWA 先确认完整对象和对应记录的写入，再通知 Companion 更新 `importState`。
- Cache 保留/回收策略可配置。首版优先保守，不因“已发送成功”自动立即删除本机唯一副本。

建议导入状态至少为 `pending`、`importing`、`imported`、`failed`，支持可重试、幂等及重新校验；传输任务状态与 PWA 导入状态**相互独立**。

## 9. 指定浏览器 Profile 与 PWA 配对

讨论中已确定：用户应能指定其常用浏览器的某个 Profile 承载 Drop2Tunnel PWA，且 **PWA/浏览器不必始终开启**。

需要澄清的技术事实：**浏览器 Profile 不是 Google 账号**。Chrome/Edge/Firefox 等浏览器的 Profile、PWA 安装身份、站点 Origin 与用户的 Drop2Tunnel 身份不能混作同一字段。

### 推荐流程

1. 用户在 Companion 中选择“连接我的 PWA”。
2. 引导用户使用**自己常用的浏览器 Profile** 打开指定 Drop2Tunnel PWA。
3. PWA 在其实际运行的 Origin/Profile 存储空间中发起本地 Companion 配对；通过一次性配对挑战和登录态验证完成关联。
4. Companion 保存经过配对确认的 `PwaHostBinding`；允许用户查看、更换、解除绑定。
5. 用户点击“打开 Drop2Tunnel”时，尽量在对应浏览器/Profile 中启动已安装的 PWA。无法准确启动时，使用明确提示/可配置浏览器启动方式，而不是擅自打开另一个 Profile 并声称正确。

**不得**从浏览器 Profile 中盗取/复制 Cookie、登录令牌或直接编辑浏览器站点存储数据库。不能只通过 Chrome 可执行文件路径或邮箱地址证明当前 PWA 就是绑定的 Profile；应以**该 PWA 实际完成的配对身份**为准。

首期应优先验证 Chrome/Edge 的常见 Profile 路径及 PWA 安装方式；Firefox 或不同浏览器支持细节以实际运行测试决定，不承诺所有浏览器都以相同命令启动“安装型 PWA”。

## 10. Local Bridge：浏览器关闭时离线暂存、打开后导入

**默认架构必须是：Companion 专用缓存 → 目标 PWA 在线后通过 Bridge 导入**，而不是尝试在浏览器关闭时直接写 Chromium/Firefox 的 Cache Storage、IndexedDB、OPFS 文件。

```text
[Companion 接收/发送完成]
       ↓
本机 CacheBinding: pending
       ↓ 浏览器和 PWA 可以一直关闭
[绑定 Profile 中的 PWA 启动]
       ↓
PWA ↔ Loopback Bridge 配对身份握手
       ↓
查询当前 Origin/账户/隧道范围内待导入条目
       ↓
以流方式获取原缓存对象并校验
       ↓
PWA 使用**既有的缓存写入机制**关联原记录/文件
       ↓
PWA 确认持久化成功 → 发送 ACK
       ↓
Companion 将对应条目标记 imported
```

实现要求：

- Bridge 只能监听 `127.0.0.1` / `::1` 等 loopback；绝不默认对局域网开放。
- 校验 `Origin`、配对会话、账户身份、允许访问的 tunnel/record/file 范围；所有读文件端点拒绝任意路径、跨账户读取及目录遍历。
- CORS 和 CSRF 防护均需完整设计；**本机 loopback 不等于天然可信**。
- 浏览器访问本地服务可能受到 Chrome Local Network Access 许可、混合内容、预检请求及各浏览器差异影响。因此第一阶段必须先证明实际 PWA Origin 能与 loopback 通信，不要把它当作未经验证的技术前提。
- 端口占用、版本兼容、服务发现、离线状态、配对撤销、一次性/短期令牌、异常断连以及重新导入均需覆盖。
- Bridge 传输可按区间/分片恢复；需要避免把整个大型文件一次性加载到 JS 内存。
- PWA 必须调用**自己的正式缓存入口**，严格将对象映射回原隧道、原传输记录、原文件。不得因为缓存导入而新建一条“Companion 下载”记录。
- 对同一 `CacheBinding` 重复执行导入应保持幂等；只有目标 PWA 持久化、校验并确认成功后才能 ACK。
- 如果当前 PWA 缺少适当的缓存导入 API，可在主项目中提出小范围增强；不要在 Companion 中模仿或篡改浏览器私有存储格式。

**浏览器权限兼容性是阻断性 PoC。** 如果某浏览器/版本无法安全访问 Bridge，应明确标示该浏览器的缓存自动导入不可用，保留 Companion 缓存，等待可用的受支持方式；不可静默标记完成。

## 11. 状态机、并发和恢复

**元数据观察**与**文件内容传输**严格解耦，推荐：

```text
Record:  observed → updated / removed    （元数据生命周期）

TransferTask:
  queued → connecting → transferring → verifying → cached
                    ↘ failed / cancelled ↗

CacheBinding:
  pending → importing → imported
                ↘ failed → retry
```

- 初次看到文件记录仅创建/更新元数据，不创建下载任务。
- 点击 `⏬` 后才产生下载任务；用户发送文件时才产生上传/发送任务。
- 处理同一文件并发请求、超时、断网、来源离线、进程重启、磁盘不足、对象完整性失败与取消。
- 应实现合理的并发上限和任务队列，但数量由实际协议与性能测试决定，不写死缺乏依据的吞吐保证。
- 进度使用**有效逻辑文件字节**，重试不重复累计，完成条件与校验/缓存提交分开。
- 账号登出/切换、隧道权限撤销后，禁止继续通过旧 Bridge 令牌访问受保护文件。既有本机缓存如何保留/清理应有明确安全策略。
- 中断后读取持久化状态，核实临时文件尺寸和 digest，按协议决定重试/重下；不得仅凭 UI 最后一次状态恢复“已完成”。

## 12. 三平台交互与系统集成

| 能力 | Windows | macOS | Ubuntu / Debian |
| --- | --- | --- | --- |
| 常驻入口 | 系统托盘 | 菜单栏状态项 | AppIndicator/托盘（依桌面环境） |
| 最近记录窗口 | 托盘点击轻量浮层 | 菜单栏点击轻量浮层 | 托盘菜单打开同一轻量窗口；不强求直接点击图标回调 |
| 原生通知 | Windows 通知 | macOS 通知 | freedesktop/桌面通知，按环境适配 |
| 登录启动 | 可选 | 可选 | 可选，尊重用户桌面会话 |
| 文件选择 | 原生对话框 | 原生对话框 | 原生/桌面环境文件选择器 |
| 打开宿主 PWA | 绑定浏览器/Profile | 绑定浏览器/Profile | 绑定浏览器/Profile |

- Linux 托盘在 GNOME 等环境中可能需要扩展或面临没有托盘区域的情况；必须有可从应用菜单打开轻量窗口的备用入口。
- Wayland 不应假定应用可以取得托盘精确坐标或任意移动窗口。
- macOS 10.15 的 WebKit/系统能力需单独验证前端兼容性；Apple Silicon 应另用受支持的较新 macOS 版本测试。
- 避免自启动后弹出干扰性主窗口；保持用户可见的“退出”和禁用开机自启入口。

## 13. 后续扩展接口预留（不纳入 MVP 强制范围）

独立仓库应从一开始定义可注册的**桌面动作入口**，但不必立即逐个平台实现：

| 扩展方向 | 预留契约 |
| --- | --- |
| 文件右键“发送到 Drop2Tunnel” | `SendFilesIntent(paths, tunnelId?)`；Windows Explorer / macOS Finder / Linux 文件管理器 |
| 系统分享菜单 | `ShareIntent(files/text, sourceApp)`；仅在平台提供适用机制时实现 |
| 拖放发送 | `SendFilesIntent` 的另一种触发源，不复制传输逻辑 |
| 文件/目录集合 | 接入现有集合记录和成员身份，不自行压缩成单个 ZIP 代替原模型 |
| 文件关联 | 先定义打开/导入意图，再按系统实现 |
| 深度链接 | 预留 `drop2tunnel://` 协议处理入口、可信参数解析与鉴权 |
| 后台能力扩展 | 将来可以新增原生通知、快捷键、状态查看等，但不偷偷启用自动同步 |

统一经过 `IntentRouter → 权限/隧道检查 → Rust Core`；插件/外部应用不能绕过身份鉴权或 Local Bridge 权限范围直接读取缓存文件。

## 14. 独立仓库建议结构

以下为建议目录，不要求新仓库在初始化前已经存在这些文件：

```text
drop2tunnel-desktop-companion/
├── README.md
├── docs/
│   ├── development-guide.md                 # 本文
│   ├── architecture.md
│   ├── integration/
│   │   ├── current-protocol-audit.md         # 实查现有项目后填写
│   │   ├── server-contract.md
│   │   └── pwa-cache-bridge-contract.md
│   ├── testing/
│   │   ├── compatibility-matrix.md
│   │   └── acceptance-checklist.md
│   └── decisions/                            # 架构决策与变更记录
├── crates/
│   ├── companion-core/                       # 不依赖 Tauri
│   ├── tunnel-adapter/                       # 现有服务器/传输协议适配
│   ├── cache-store/                          # SQLite、缓存、校验
│   └── pwa-bridge/                           # loopback 对接
├── src-tauri/                                # Tauri Shell / OS Adapter
├── src/                                      # 轻量 HTML/CSS/JS UI
├── tests/
└── .github/workflows/
```

文件结构可按实际技术约束调整，核心是分清：**业务 Core、协议适配、桌面宿主、PWA Bridge、共享 UI、平台构建**。新仓库独立版本管理，但需要和 Drop2Tunnel 主项目通过**受版本管理的协议契约**协作。

## 15. 推荐开发阶段与验收关卡

### Phase 0：事实核查与双 PoC（优先级最高）

1. 检查主项目**最新代码**，输出现有协议、record/file 稳定身份、PWA 缓存入口、认证与来源发现的审计文档；不要依据旧讨论自行编造接口。
2. PoC-A：Rust 测试客户端真实加入隧道，收到增量记录，并与 PWA/现有设备成功往返传输一个文件。
3. PoC-B：在绑定 Profile 中的实际 HTTPS PWA，与 loopback Bridge 完成跨浏览器权限与配对验证，读入一个文件并写入**现有** PWA 缓存。
4. 确认跨平台版本下界，尤其 macOS 10.15、Ubuntu/Debian 运行时依赖和 Linux 托盘回退机制。

**未通过 PoC-A 或 PoC-B，不应把“跨端文件收发”和“PWA 缓存迁移”宣布为已实现。**若需要主项目改动，先产生明确的最小对接需求清单。

### Phase 1：骨架与基本交互

- 初始化 Rust workspace、Tauri 2、轻量前端、Windows/macOS/Linux 编译配置；
- 托盘常驻、浮层/菜单回退、可选启动项、单实例行为；
- 隧道列表/切换、最新记录展示与滚动，离线和异常状态；
- 适配器先可用 Mock 数据测试 UI，再接真实服务端。

**验收：**PWA 完全关闭时，Companion 可独立启动、连接、显示元数据；未点击下载时没有文件数据传输。

### Phase 2：按需文件收发与缓存

- 完成协议互通适配、发送、点击记录指定文件下载；
- 进度、取消/重试、校验、缓存持久化及记录身份绑定；
- 重启恢复、重复请求去重、缓存空间保护。

**验收：**发送及下载的文件均映射到原记录，缓存可跨 Companion 重启恢复；无自动文件镜像。

### Phase 3：PWA 宿主绑定及缓存导入

- 浏览器/Profile 绑定、配对及解绑；
- PWA ↔ loopback Bridge 的权限、对象流、完整性校验与 ACK；
- PWA 缓存落地和原记录关联；
- 处理 PWA 长时间关闭、导入中断、重复导入、账户切换。

**验收：**PWA 关闭期间收发文件，之后打开**正确的 Profile**，在**原隧道原传输记录原文件**看到已缓存状态；不产生重复记录，也不误导入另一 Profile。

### Phase 4：系统适配、安装和发布

- Windows 10/11、macOS 10.15 Intel 和较新 Apple Silicon 系统、Ubuntu/Debian 目标版本真机/VM 测试；
- Linux GNOME/KDE/Xfce + X11/Wayland 至少覆盖主要组合；
- 安装包、代码签名/公证（适用平台）、可选自启动、日志与升级策略；
- 文档与首轮发布候选版验收。

**验收：**各承诺平台具备可用的托盘/菜单入口、按需收发和安全缓存衔接；明确公开尚未通过的版本/浏览器限制。

## 16. 必须覆盖的测试用例

- **不自动下载：**仅收到新纪录消息，网络上不应产生对应文件内容传输。
- **精确下载：**多文件记录中只点击一个 `⏬`，只下载该文件；不同隧道/同名文件不串缓存。
- **主动发送：**通过 Companion 发出文件后，PWA 显示同一条正式记录及同一文件，并能导入发送端缓存。
- **离线 PWA：**浏览器完全退出数小时/数天后再打开，未导入缓存仍存在且正确归属。
- **Profile 隔离：**同一 Chrome 两个 Profile（甚至相同用户登录不同站点身份），只允许正确配对者导入。
- **身份安全：**退出登录/取消配对/隧道权限撤销后旧令牌不能读取缓存；陌生网页不能滥用 loopback API。
- **失败恢复：**断网、强退、源设备离线、临时文件残留、空间不足、校验失败、Bridge ACK 丢失。
- **幂等：**重复收到记录事件、重复点击下载、反复导入，不产生重复正式记录或缓存索引损坏。
- **大文件：**持续流式读写、内存占用合理；缓存导入不整文件加载进浏览器 JS 内存。
- **多平台：**开机启动、退出、通知、任务栏/菜单栏状态、Linux 无托盘环境及 Wayland 回退可用。
- **长期兼容：**服务端协议升级或 PWA 版本落后时明确报告兼容性错误，不静默破坏历史缓存。

## 17. 在新仓库交给 Codex 的执行纪律

1. **先核对真实协议，再动手对接。**文档中的接口名称、数据结构与目录仅为建议，不代表已有实现。
2. 每个阶段独立落地并验收，优先做 Phase 0 的阻断性验证，不要从复杂 UI 开始或一次性铺开全部功能。
3. 不得默认拥有 Drop2Tunnel 原仓库的修改权限；如需修改主项目，先列出变更位置、原因、兼容影响与最小接口契约。
4. 协议适配必须复用现有隧道/正式记录身份，不能引入破坏性分叉；Tauri UI 不承载数据传输核心。
5. 新功能不影响 PWA 独立使用；Companion 未安装或关闭时，原 Drop2Tunnel 功能保持正常。
6. 不对失败任务、不可读缓存、未经校验的文件或未收到 PWA ACK 的条目宣称成功。
7. 重要设计取舍记录到 `docs/decisions/`；进度/测试结论明确注明“实际运行验证”还是“Mock/静态检查”。
8. 新仓库建立后，先整理技术与产品 README、本指南、真实对接契约和 Phase 0 PoC，再进入分阶段开发。

## 18. 仍待从现有代码确认的事项

下列问题**不是让用户重新定义产品需求**，而是留给编码 Agent 在拿到真实项目代码后核实：

- 当前最新服务器及 PWA 的具体协议版本、认证过程和可稳定引用的记录/文件/集合 ID；
- Rust 对接现有 WebRTC/P2P/服务端中转链的实际可行路径；
- 当前 PWA 缓存模型与“为已存在记录注入已校验文件缓存”的正式写入流程；
- 文件发送“成功”在现有系统里是已入记录、已上传到服务器、已被目标设备接受还是其它状态；
- 浏览器 Profile/PWA 识别与启动方式在各平台的可验证范围；
- HTTPS PWA 访问本地 loopback 的具体权限、预检/跨源行为和需支持的浏览器；
- Linux 包的依赖版本、托盘支持情况与已验证发行版矩阵；
- 用户切换服务器实例、账号及隧道权限时对本机缓存的访问控制。

## 19. 官方参考资料（技术核验入口）

- [Tauri 2 前置要求](https://v2.tauri.app/start/prerequisites/)
- [Tauri 2 System Tray](https://v2.tauri.app/learn/system-tray/)
- [Tauri 2 Autostart](https://v2.tauri.app/plugin/autostart/)
- [Tauri 2 权限模型](https://v2.tauri.app/security/permissions/)
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access/)
- [MDN Local Network Access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access)

以上文档仅作为技术参考。实际所选 Tauri/Rust/WebView 版本及浏览器安全策略，应在**开始实施时重新核查**并通过真实端到端测试确认。
