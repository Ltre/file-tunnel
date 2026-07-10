# 总体建议

不要把 Android、iPhone、iPad 做成当前 H5/PWA 的等比例复制版。更适合的定位是：

* **Android：完整传输节点、后台供源节点、目录同步节点**
* **iPhone：随身收发客户端、分享入口、前台近场节点**
* **iPad：桌面级资源管理和协同控制中心**
* **现有 H5/PWA：免安装通用客户端**

三个原生端应保证的是：

> 隧道、记录、缓存、恢复、权限和版本语义一致，而不是每个平台功能形式完全相同。

当前 H5 深度依赖 IndexedDB、Service Worker、DOM、File System Access 和 WebRTC DataChannel，原生端应该复用协议和业务模型，而不是继续套 WebView。

---

# 一、所有原生端都应该增加的功能

## 1. 把“传输任务”提升为一等数据

当前系统更偏向：

```text
传输记录 + 文件缓存 + 临时进度
```

原生端应正式增加：

```text
TransferTask
TransferBatch
TransferCheckpoint
TransferRoute
```

每个任务保存：

* 已传字节数；
* 已完成分片；
* 当前来源设备；
* 当前传输路径；
* 重试次数；
* 暂停原因；
* 是否等待来源上线；
* 是否允许蜂窝网络；
* 电量和网络限制；
* 创建时间和最后活动时间。

这样用户关闭 App、重启设备或网络切换后，任务仍能继续，而不是重新从消息记录推断任务。

---

## 2. 系统级分享入口

原生版的最重要优势不是界面，而是能真正进入系统分享流程。

### Android

支持：

* `ACTION_SEND`
* `ACTION_SEND_MULTIPLE`
* Direct Share
* 文本、图片、视频、PDF、任意文件
* 分享时直接选择目标隧道

Android 官方允许应用通过系统 Sharesheet 接收其他应用分享的内容，也支持把特定联系人或群组作为 Direct Share 目标。([Android Developers][1])

推荐体验：

```text
相册 → 分享 → Drop2Tunnel
                  ↓
        最近隧道 / 最近设备
                  ↓
           立即建立传输任务
```

不要再先打开 App、进入隧道、点击文件选择。

### iOS / iPadOS

增加 Share Extension：

```text
照片 / 文件 / Safari
      ↓
分享
      ↓
Drop2Tunnel
      ↓
选择隧道和备注
```

Share Extension 只负责快速接收内容和建立任务，真正的大文件上传交给主 App 或后台 URLSession。

---

## 3. 真正的后台传输

### Android

Android 可以把用户明确发起的大文件传输放入：

* User-Initiated Data Transfer
* Foreground Service
* WorkManager 长任务

系统要求长任务显示持续通知，并允许用户取消；WorkManager 的长任务底层也会使用前台服务。([Android Developers][2])

通知应显示：

```text
正在发送 12 个文件
2.4 GB / 6.8 GB · 36%
Galaxy S23 → 家里电脑

[暂停] [取消]
```

Android 端因此可以真正承担：

* App 切后台后继续传输；
* 长时间作为文件供源；
* 目录同步；
* 网络恢复后自动续传；
* 设备重启后恢复任务。

### iOS / iPadOS

苹果提供后台 URLSession，适合服务器式上传和下载。([Apple Developer][3])

但产品上不要承诺：

> iPhone 锁屏后仍会无限期作为局域网 P2P 文件服务器。

更合理的是：

* 前台时允许设备间直传；
* 进入后台后，未完成任务转入服务器临时中转；
* 或暂停并等待对方重新进入前台；
* 后台 URLSession 继续执行服务器上传/下载；
* 使用推送通知提醒对方恢复任务。

这意味着 iOS 端需要一个可靠的 **server spool 临时文件层**。

---

## 4. 原生文件系统整合

### Android

Android 的 Storage Access Framework 支持：

* 打开文件；
* 创建文件；
* 选择目录；
* 获得用户明确授权的目录 URI；
* 访问云盘或外部存储提供者。

用户选定目录后，应用可访问该目录及其子目录。([Android Developers][4])

因此 Android 可以完整增加：

* 持久目录挂载；
* 自动目录同步；
* 本机文件供源；
* 下载目标目录；
* 文件变化监听；
* “收到的文件”系统目录；
* 外置硬盘、U 盘和网络文件提供者。

当前 H5 中反复出现的“外部文件授权”提示，在原生端应改成一次系统授权后长期使用，而不是每打开一个文件重新询问。

### iOS / iPadOS

使用：

* Document Picker；
* Security-scoped URL；
* Files App；
* File Provider；
* 应用沙箱缓存。

Apple 提供 Document Picker 和 File Provider 框架，用于与系统文件体系整合。([Apple Developer][5])

建议分两期：

第一期只做：

* 从“文件”选择文件；
* 保存到“文件”；
* 访问最近打开的文件；
* 应用内部缓存。

第二期再考虑 File Provider Extension，使 Drop2Tunnel 资源直接出现在系统“文件”App 中：

```text
文件 App
  └─ Drop2Tunnel
      ├─ 最近隧道
      ├─ 已接收
      ├─ 等待恢复
      └─ 已收藏
```

---

## 5. 真正的附近发现

原生 App 不再受浏览器“不能监听端口、不能 BLE 扫描”的限制。

### Android

可以优先研究 Nearby Connections。它能通过 Bluetooth、BLE 和 Wi-Fi 发现附近设备、建立加密连接，并传输 Bytes、File 或 Stream；也支持 Android 和 Swift SDK。([Google for Developers][6])

但不要只依赖 Nearby Connections。考虑到部分 Android 设备缺少或限制 Google Play 服务，最好同时提供：

* mDNS / NSD；
* 同局域网 UDP 发现；
* 自有 TLS TCP/QUIC；
* 服务器辅助发现；
* QR / NFC 配对。

### iOS / iPadOS

可使用：

* Multipeer Connectivity；
* Bonjour；
* Network.framework；
* Local Network 权限。

Apple 提供 Multipeer Connectivity 和本地网络隐私机制。([Apple Developer][7])

### 跨平台注意

不要分别做：

```text
Android Nearby Connections
iOS Multipeer Connectivity
```

然后期待二者天然互通。

建议传输协议统一为：

```text
发现层：
Nearby / Multipeer / mDNS / 服务器发现

认证层：
设备公钥 + 短码确认

传输层：
TLS TCP / QUIC / WebRTC Native

业务层：
统一 Drop2Tunnel Asset Protocol
```

平台原生发现只作为入口，最终进入你自己的统一传输协议。

---

## 6. 本地缓存加密和生物识别

原生端应该增加：

* 本地缓存可选加密；
* Android Keystore；
* Apple Keychain / Secure Enclave；
* 指纹、Face ID 解锁；
* 隧道级应用锁；
* 隐私模式隐藏文件名和缩略图；
* App 切后台时遮挡最近任务画面。

尤其是原生版会真正保存大量文件，安全边界比浏览器缓存更重要。

---

## 7. 系统通知和实时状态

增加：

* 传输进度通知；
* 等待来源设备上线；
* 收到新文件；
* 文件恢复完成；
* 隧道邀请；
* 富文本编辑冲突；
* Telegram 兜底失败。

iOS 可以进一步使用 Live Activity 展示长任务；Android 使用进度型通知和通知操作。

但不要每个小文件发一条通知，应按批次聚合。

---

# 二、建议减少或取消的现有功能形式

## 1. 移除所有 PWA 专属概念

原生端不需要：

* Service Worker；
* Manifest；
* PWA Share Target；
* “安装到主屏幕”；
* 清除 Service Worker；
* “强制刷新应用资源”；
* 浏览器缓存版本号；
* 网页启动失败后的重载页。

原生版的更新、缓存迁移和数据库升级应由应用自身处理。

---

## 2. 不再暴露 P、F、G 多层浮层式体验

当前 H5 中：

```text
传输平层 P
→ 合辑宫格 F
→ 文件预览 G
→ 全屏播放器
```

在原生端应改成系统导航语义：

```text
任务列表
→ 合辑详情
→ 文件详情
→ 系统级预览
```

iPhone 使用 NavigationStack 和全屏预览；Android 使用 Navigation Compose；iPad 使用多栏详情。

不要把网页上的嵌套浮层完整搬过去，否则返回手势、系统返回键和多任务状态会很难维护。

---

## 3. 弱化“聊天流承载所有东西”

当前文件、文本、富文本、合辑、操作按钮都堆在传输记录流中。

原生端建议拆成：

```text
消息
任务
资源
协同
```

其中：

* “消息”显示事件时间线；
* “任务”显示发送和恢复状态；
* “资源”管理文件；
* “协同”放富文本和实时编辑。

文件仍可以在消息中出现，但不能只靠聊天气泡管理所有资源。

---

## 4. 剪贴板共享改为显式操作

不建议原生端继续周期性读取剪贴板。

改成：

* “发送剪贴板内容”按钮；
* 用户粘贴后发送；
* Android 分享到 Drop2Tunnel；
* iOS Share Extension；
* 可选的“仅前台自动同步”开关。

这样更符合移动系统隐私预期，也避免用户担心 App 在后台不断读取剪贴板。

---

## 5. 管理后台不要完整塞进 App

以下功能继续保留 Web Admin：

* 服务器统计；
* Telegram Bot Token；
* Webhook；
* 服务器日志；
* 会话清理；
* TOTP 管理；
* 拓扑诊断。

原生 App 只提供：

* 当前隧道设置；
* 本设备状态；
* 当前传输诊断；
* 普通用户权限。

否则移动客户端会过于臃肿，也扩大管理接口攻击面。

---

## 6. 语音、摄像头和播放器不要阻塞首版

优先级建议：

1. 文件和任务；
2. 近场发现；
3. 后台恢复；
4. 资源管理；
5. 富文本；
6. 协同编辑；
7. 音乐播放器；
8. 语音、对讲机、摄像头。

当前系统的差异化价值仍然是：

> 可恢复的跨设备传输任务容器。

不是另一个语音聊天软件。

---

# 三、Android 端建议

## 产品定位：完整节点

Android 端应是功能最完整的移动版本。

建议增加：

* 前台服务持续供源；
* 后台上传和下载；
* 设备启动后恢复未完成任务；
* 系统 Sharesheet；
* Direct Share 到最近隧道；
* SAF 目录挂载；
* 目录自动同步；
* U 盘和外部存储；
* Nearby / BLE / LAN 发现；
* 快捷方式；
* 通知栏暂停、继续、取消；
* 可选“充电且 Wi-Fi 时作为常驻供源节点”。

### Android 首页

```text
继续传输
附近设备
最近隧道
已挂载目录
```

### 不建议默认开启

* 永久后台在线；
* 永久扫描附近设备；
* 使用移动数据供源；
* 低电量时大文件上传。

让用户明确选择：

```text
仅 Wi-Fi
仅充电时供源
允许移动数据
允许后台保持在线
```

---

# 四、iPhone 端建议

## 产品定位：随身收发客户端

iPhone 版本强调：

* 分享快；
* 接收快；
* 界面简单；
* 前台近场直传；
* 后台服务器续传；
* 系统文件和照片整合。

建议首页只保留三块：

```text
继续任务
附近设备
最近隧道
```

底栏建议：

```text
首页 | 隧道 | 任务 | 资源
```

不要默认显示 H5 的三栏结构。

### iPhone 需要接受的减法

* 不承诺后台长期作为 P2P Provider；
* 不做目录长期监听；
* 不做持续附近广播；
* 大文件进入后台时优先转服务器；
* 文件句柄不可用时立即切换到缓存或服务器任务；
* 后台音乐、语音、相机分别按系统能力管理，不要混成一个常驻进程。

---

# 五、iPadOS 端建议

## 产品定位：资源和协同控制中心

iPad 不应只是放大的 iPhone。

推荐三栏：

```text
左栏
隧道 / 设备 / 筛选

中栏
传输记录 / 任务 / 资源列表

右栏
文件预览 / 合辑详情 / 富文本编辑
```

Apple 为 iPadOS 提供多任务、侧边栏和拖放设计能力。([Apple Developer][8])

建议重点支持：

* 从 Files 拖文件到隧道；
* 从照片拖入合辑；
* 从任务列表拖到其他隧道完成转发；
* 分屏同时打开 Drop2Tunnel 和 Files；
* 每个隧道独立窗口；
* 外接键盘快捷键；
* 鼠标右键菜单；
* 多选；
* 框选；
* Command+F 搜索；
* Command+O 导入；
* Command+Enter 发送；
* Apple Pencil 富文本批注；
* 多窗口中分别打开不同隧道。

### iPad 资源管理器

iPad 上应把资源管理器直接做成主页面，而不是设置页中的浮层。

可以提供：

```text
图标视图
列表视图
分栏视图
按批次
按设备
按隧道
按缓存状态
```

iPad 仍受 iOS 后台限制，所以它适合作为**前台强节点和管理台**，不是锁屏后的常驻服务器。

---

# 六、Android 平板和折叠屏

不要只为 iPad 做大屏。

Android 官方推荐根据窗口尺寸使用：

* 导航栏和导航轨切换；
* List-Detail 双栏；
* Supporting Pane；
* 折叠姿态适配；
* 键盘、鼠标、触控板和手写笔。

([Android Developers][9])

建议与 iPad 共用产品结构：

```text
手机：单栏 + 底部导航
平板：双栏或三栏
折叠屏展开：列表 + 详情
折叠屏半开：上方预览，下方操作
```

---

# 七、推荐的传输路径设计

## 同平台附近设备

```text
Android ↔ Android
Nearby / LAN / QUIC

Apple ↔ Apple
Multipeer / Bonjour / QUIC
```

## 跨平台附近设备

```text
Android ↔ iPhone/iPad
mDNS/服务器发现
        ↓
统一设备认证
        ↓
QUIC/TLS TCP 或 Native WebRTC
```

## 远程设备

```text
优先 Native WebRTC
        ↓
失败后服务器临时中转
        ↓
仍失败则 Telegram file_id 等恢复来源
```

## 后台状态

```text
Android 后台：
可继续直传或服务器传输

iOS/iPadOS 后台：
优先 URLSession 服务器传输
不依赖设备持续监听本地连接
```

---

# 八、服务端需要同步改造的部分

原生化之后，服务端不能只继续维护“在线 Socket + 内存消息”。

建议增加：

## 1. 客户端能力声明

```json
{
  "platform": "android",
  "capabilities": {
    "backgroundProvider": true,
    "nearbyDirect": true,
    "directoryMount": true,
    "nativeWebRTC": true,
    "serverSpool": true
  }
}
```

## 2. 持久化传输任务

增加：

* `transfer_tasks`
* `transfer_ranges`
* `transfer_providers`
* `transfer_receipts`
* `device_capabilities`

## 3. 临时对象存储

用于：

* iOS 后台传输；
* 跨平台 P2P 失败；
* 来源设备无法长期在线；
* 推送唤醒后恢复。

文件应：

* 加密；
* 随机不可猜地址；
* 有 TTL；
* 接收完成后自动删除；
* 支持 Range；
* 支持校验哈希。

## 4. 推送服务

* Android FCM；
* Apple APNs；
* 设备上线通知；
* 任务恢复通知；
* 隧道邀请；
* 文件已准备好；
* 富文本冲突。

---

# 九、建议的发布阶段

## 第一阶段：原生核心

* 隧道创建和加入；
* 文本、单文件、合辑；
* 系统分享；
* 本地缓存；
* 任务持久化；
* 服务器中转；
* 后台上传下载；
* 通知；
* 释放和恢复；
* 权限。

## 第二阶段：平台增强

Android：

* 目录挂载；
* 后台供源；
* Nearby；
* 自动同步。

iOS/iPadOS：

* Multipeer；
* Share Extension；
* File Provider；
* Live Activity；
* 多窗口和拖放。

## 第三阶段：高级协作

* 富文本版本历史；
* Diff；
* 冲突合并；
* 协同编辑；
* 资源管理器；
* 批次管理。

## 第四阶段：媒体

* 后台音乐；
* 群语音；
* 对讲机；
* 摄像头；
* 联系人通话。

---

# 最终产品形态

最合理的功能分层是：

| 能力        | Android | iPhone | iPadOS |
| --------- | ------- | ------ | ------ |
| 文本、文件、合辑  | 完整      | 完整     | 完整     |
| 后台服务器传输   | 完整      | 完整     | 完整     |
| 后台 P2P 供源 | 强       | 弱      | 弱      |
| 目录挂载和同步   | 强       | 有限     | 有限     |
| 附近发现      | 强       | 强      | 强      |
| 系统分享入口    | 完整      | 完整     | 完整     |
| 资源管理      | 完整      | 简化     | 最完整    |
| 多窗口       | 视设备而定   | 否      | 强      |
| 拖放和键鼠     | 平板增强    | 有限     | 强      |
| 长期常驻节点    | 适合      | 不适合    | 不适合    |

一句话概括：

> **Android 应做成“移动服务器节点”，iPhone 应做成“随身快速客户端”，iPad 应做成“桌面级资源和协同控制台”。**

[1]: https://developer.android.com/training/sharing/receive "Receive simple data from other apps  |  App data and files  |  Android Developers"
[2]: https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running "Support for long-running workers  |  Background work  |  Android Developers"
[3]: https://developer.apple.com/documentation/foundation/url_loading_system/downloading_files_in_the_background "Downloading files in the background | Apple Developer Documentation"
[4]: https://developer.android.com/training/data-storage/shared/documents-files "Access documents and other files from shared storage  |  App data and files  |  Android Developers"
[5]: https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller "UIDocumentPickerViewController | Apple Developer Documentation"
[6]: https://developers.google.com/nearby/connections/overview "Overview  |  Nearby Connections  |  Google for Developers"
[7]: https://developer.apple.com/documentation/multipeerconnectivity "Multipeer Connectivity | Apple Developer Documentation"
[8]: https://developer.apple.com/design/human-interface-guidelines/multitasking "Multitasking | Apple Developer Documentation"
[9]: https://developer.android.com/develop/ui/compose/layouts/adaptive "Get started with adaptive apps  |  Jetpack Compose  |  Android Developers"
