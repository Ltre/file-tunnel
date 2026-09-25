# 媒体预览、音乐播放器与实时音视频

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 模块范围

“媒体”在当前系统中包含两大类：

1. **文件型媒体**：图片、视频、音频的本地/远程预览、全屏、音乐播放器；
2. **实时媒体**：摄像头广播、群语音、对讲机、联系人语音呼叫、远程控制另一设备打开文件预览。

主要源码：

- `app.js`
- `client/media.js`
- `server/media-session.js`
- `client/file-assets.js`

这两类都用到浏览器 Media / WebRTC API，但状态机完全不同。

## 2. 普通文件预览

传输记录只对图片、视频、音频等适合网页内查看的文件直接打开媒体预览；文本/PDF/CSV/JSON 等更多走文件信息/下载视图。

预览与文件缓存是解耦的：

- 已有本机完整缓存 → 直接打开；
- 本机有效文件句柄 → 直接读取；
- 缺缓存 → 进入恢复；
- 恢复成功后刷新当前预览；
- 无供源 → 显示缺失状态。

预览不应为了查看属性就提前拉完整大文件。

## 3. Preview / Fullscreen / History 层次

历史实现中常把文件预览称为 F，全屏媒体为 G，合辑又有 P 层。虽然源码命名并不一定使用这些字母，需求语义是：

- 传输记录；
- 文件/合辑预览；
- 单文件详情；
- 全屏；
- 音乐播放器；
- 远程预览设备选择；
- 分享/属性对话框；

必须保持明确父子关系。

### 3.1 重要回归

曾反复出现：

- 关闭全屏后把整个网盘/父预览也关掉；
- 关闭文件预览跳回历史目录；
- 连续切目录后预览，close 消费旧 history；
- 子分享框层级低于播放器；
- 点击桌面 backdrop 误关父层。

原因多数和 `history.pushState/popstate` 及层叠上下文有关。

任何预览重构必须验证：

- 点击 X；
- Esc；
- 浏览器 Back；
- Android 返回手势；
- 全屏 → 预览 → 记录；
- 预览中左右切文件；
- 网盘内预览关闭仍留在同一目录。

## 4. 图片

要求：

- 长图完整适配；
- 超宽图完整适配；
- 不能固定用普通 16:9 box 裁切；
- PC 支持缩放/拖动平移；
- 移动支持 pinch zoom；
- 单指/双指平移；
- 图片切换手势与平移手势隔离；
- pan 不能无限把图片拖出可视区。

窗口 resize / orientationchange 后应重新 fit。

## 5. 视频

### 5.1 比例

竖屏视频、超宽视频必须 `contain`，不能被固定容器裁切。

### 5.2 Range

大视频依赖 Range。

历史上 `waiting/stalled/seeking` 后主动改 media src + `load()` 的恢复方式会让浏览器丢弃当前 Range，重新请求开头，造成：

- 100% 仍 Loading；
- seek 卡住；
- cache 后半段重复读取。

后续取消激进重载。修改 retry 逻辑必须用真实长视频测试。

### 5.3 Poster

传输记录/网盘都尽量提前生成 poster/thumbnail。

目标：

- 文件主体还没完整恢复时就能看到封面；
- 不需要为了封面下载整个视频；
- poster 本身也有缓存生命周期。

## 6. 音频临时预览

点击单个音频文件可以临时试听。

临时试听与后台音乐播放器是不同模式：

- 临时试听只服务当前 preview；
- 打开全屏音乐播放器时可以把当前 track handoff 到后台 player；
- 临时试听需要在关闭 preview 时释放；
- 后台 player 即使 preview 关闭仍继续播放。

## 7. 后台音乐播放器

这是一个长期状态组件，不是简单 `<audio>`。

### 7.1 Queue

队列包含：

- 当前 track；
- queue order；
- current index；
- track duration；
- poster；
- favorite；
- 当前时间进度。

支持：

- 上一曲/下一曲；
- 自动补歌；
- 队列拖动排序；
- 滑动删除；
- 打开/收起 queue drawer；
- 封面左右滑切歌；
- 最小化；
- 关闭；
- Media Session。

### 7.2 自动补歌

历史最终要求：

- 从**当前隧道**的音乐库随机补；
- 不再只限收藏；
- 同一 queue 不重复；
- 库耗尽后短期记忆“已耗尽”，避免每到队尾重复扫描；
- 用户手工加歌后重置耗尽标记。

### 7.3 状态恢复

播放状态曾同时存在：

- localStorage；
- IndexedDB/session storage 类副本。

早期出现：

- 当前队尾歌曲刷新后跑到队首；
- queueOrder 漂移；
- queue drawer 中 - / X 失效；
- current index 恢复到第一个。

因此现在需要：

- queueOrder 归一化；
- current track ID 优先；
- 比较两个副本时选择更合理/更新状态；
- 不能只用数组 index 当稳定 identity。

### 7.4 顶栏

音乐播放器最小化/后台播放时，功能首页顶栏显示 `♪` 入口及 Now Playing 状态。

网页工坊最小化 `🌐` 位于网盘 `▤` 和音乐 `♪` 之间。

## 8. Media Session / 系统通知

后台音乐会更新：

- MediaMetadata；
- playback state；
- play/pause/next/prev action。

目标是在锁屏/系统媒体控件也能控制，而不是只在网页内显示通知。

## 9. 摄像头广播

历史需求：

- 同一隧道一次只有一个 broadcaster；
- 第二设备开播会“顶号”，并提示会中止已有广播；
- 发起设备按钮显示“关闭摄像头”；
- 其它设备在已有广播时显示类似“顶号开播”。

服务端 `media-session.js`：

- session.media.camera 保存当前 `broadcastId + ownerDeviceId`；
- 新广播替换旧广播；
- 告知原 owner stop；
- viewer ready 后才触发对应 WebRTC offer。

客户端 `MediaController.startCamera()` 会申请视频，音频设备不存在时允许 fallback。

## 10. 群语音

功能允许同隧道三人及以上即时语音。

服务端只协调 participant set 和 signaling：

- `voice-join`
- `voice-leave`
- `voice-state`
- `voice-peer-joined`
- `voice-peer-left`

客户端对 participants 建 WebRTC mesh。

权限 capability：

`groupVoice`

服务端也会检查权限，不能只隐藏按钮。

## 11. 对讲机

对讲机区别于群语音：

- 单向即时推送语音；
- 可指定一个设备；
- 可全局指定所有其它设备；
- 开始后按钮应切为关闭；
- stop 用 `intercom-stop` 通知 recipients。

全局对讲受 `globalIntercom` capability 约束。

## 12. 联系人语音呼叫

后来从“同隧道按钮直接建 WebRTC”升级为服务端全局呼叫状态机：

- dialing；
- incoming；
- accept；
- reject；
- busy；
- no-answer；
- ended；
- offline；
- call timer。

事件：

- `contact-call-request`
- `contact-call-accepted`
- `contact-call-rejected`
- `contact-call-ended`
- `contact-media-signal`

VClient 不能接人类语音呼叫，会明确 reject unsupported。

### 12.1 铃声

支持：

- 内置；
- 本地自定义；
- 来电铃声预览。

### 12.2 Audio constraints

联系人语音有专门 audio constraints / Opus 倾向 / output gain。不能随便复用摄像头 audio constraints。

### 12.3 ICE recovery

联系人呼叫连接失败会进行受控 ICE recovery/restart，且有次数限制和外部依赖日志。

## 13. 远程预览

目标：

> A 设备在本机选中某文件，命令 B 设备如果已经有完整缓存，则在 B 直接打开并全屏；A 保持持续控制面板。

这不是远程桌面。

### 13.1 安全流程

不能直接发“open fileId”就让目标打开。

服务端流程：

1. controller 发 cache-check；
2. target 验证自己是否有完整缓存；
3. result 回 controller；
4. 只有 verified available 后才允许 open；
5. 建立 control session；
6. control action 必须匹配 controller/target/session。

VClient 被排除为可控目标。

### 13.2 Controller UI

持续控制面板支持：

- target device；
- 当前文件；
- prev/next；
- play/pause；
- fullscreen exit；
- minimize 为 `#️⃣` bubble；
- restore；
- close/exit。

退出后迟到回执不能把面板重新拉起来。

### 13.3 被控端文件切换

切下一首/下一图时，目标端应寻找邻近**已经完整缓存**的可预览文件，不应因为 remote next 一次就触发全量历史物化。

## 14. 自动播放限制

移动浏览器可能拒绝远程音频 autoplay。

系统有：

- remote audio unlock；
- 用户手势解锁；
- persistent unlock 提示。

不能把浏览器 autoplay policy 失败误报成 WebRTC 断开。

## 15. 设备离线清理

`cleanupMediaDevice()` 在 disconnect 时必须：

- 移除 voice participant；
- 如果是 camera owner 停广播；
- 结束 contact call；
- 结束 remote preview control；
- 清理相关 peer state。

否则其它设备会残留“通话中/广播中/控制中”幽灵状态。

## 16. 修改检查

媒体改动至少覆盖：

- 普通预览；
- 全屏；
- history；
- music queue；
- background audio；
- camera；
- voice；
- intercom；
- contact call；
- remote preview；
- device disconnect；
- Android gesture。

相关历史 regression 很多，不要把“某个浮层逻辑看起来重复”就抽掉，而没有验证对应 back/gesture 情况。
