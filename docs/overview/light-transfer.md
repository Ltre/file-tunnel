# 光媒（Light Transfer / D2L1）离线二维码传输

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`
> 主要实现：`client/light-transfer.js`、`pages/light-file-parts.html` 及 `server.js` 对应网络加速/回执接口。  
> 原始设计与迭代详见 `prompts/ideas/LIGHT-TRANSFER-overview-260813.md` 与 `docs/devlog/dev-2608B-features.md`。

## 1. 功能初衷

“光媒”不是普通二维码分享链接，而是把实际文件数据编码成连续动态二维码，通过另一台设备摄像头接收。

目标场景：

- 两台设备无法直接联网互传；
- 只允许单向光学通道；
- 网络不稳定；
- 用户希望把光学传输与网络加速组合；
- 大文件可以中断后继续，而不是每次从第一个二维码重新扫描。

因此协议需要：

- 明确任务身份；
- manifest；
- 数据块；
- hash；
- 本机残片；
- 完成回执；
- 可选 network provider。

## 2. 当前协议常量

前端当前：

- Protocol：`D2L1`
- IndexedDB：`drop2tunnel-light-transfer-v1`
- DB version：1
- atomic block：256 bytes
- manifest part payload：240 chars
- network request 一次最大 indices：32

这些是兼容边界；改变 block/frame 编码时应考虑旧 residual task。

## 3. IndexedDB

Stores：

- `tasks`
- `chunks`
- `receipts`

### tasks

保存任务 manifest / state / updatedAt。

### chunks

key：

`<taskId>:<blockIndex>`

按 taskId 建索引。

### receipts

保存已完成接收记录。

这样浏览器刷新后仍可以继续未完成任务。

## 4. Task ID

发送端会把文件集合、总长度、hash、隧道/来源信息等组成稳定 identity，再 SHA-256 得到 taskId。

因此：

- 同一个内容/身份可识别为同一任务；
- 残片不会仅凭“文件名一样”就串到别的任务。

如果浏览器没有 WebCrypto `crypto.subtle.digest`，源码有纯 JS SHA-256 fallback，以兼容 HTTP/非 secure context。

## 5. Manifest

manifest 至少描述：

- task ID；
- title；
- kind（single/collection）；
- tunnel identity；
- source message；
- files；
- file offset/size/hash；
- blockSize；
- blockCount；
- createdAt。

manifest 自身也有 hash：

`manifestHash`

manifest 会先 base64url，再拆成多个 manifest frame。

## 6. Frame 类型

D2L1 当前有三个核心 frame：

### Summary frame

包含：

- taskId；
- manifest hash；
- total size；
- block count / size；
- file count；
- title 摘要；
- kind；
- 可选 tunnel/message；
- network provider 描述。

### Manifest frame

包含：

- taskId；
- manifestHash；
- part index/count；
- manifest fragment。

### Data frame

包含：

- taskId；
- start block；
- block count；
- total block count；
- block size；
- data。

接收端不能只看到 Data 就盲写，必须匹配 task/manifest。

## 7. 距离模式

当前三种：

### 远距离

- 1 block/frame
- 4 FPS
- QR size 560
- correction H

### 常规距离

- 1 block/frame
- 8 FPS
- QR size 500
- correction Q

### 近距离

- 2 blocks/frame
- 12 FPS
- QR size 460
- correction M

实际渲染前还有 capacity probe。

## 8. 为什么要做容量探测

历史上出现过：

`code length overflow`

原因是二维码库在：

- 版本选择；
- Unicode byte counting；
- error correction level；

上的实际容量与简单字符数估算不一致。

当前实现：

- envelope 尽量 ASCII；
- `findSafeQrLevel()` 逐级试渲染；
- manifest 用最长 part 做 probe；
- data 从目标 blocksPerFrame 向下退；
- summary 还有 compact fallback。

因此不要再写一套“根据字符串长度猜 QR version”的逻辑替换真实 render probe。

## 9. Sender UI

发送浮层主要有：

- 标题；
- 距离选择；
- QR stage；
- network acceleration toggle；
- frame/status；
- file count/size；
- block count；
- task digest；
- tunnel；
- network provider 状态。

动态 frame 会轮播：

- summary；
- manifest；
- data。

QR 应完整显示 quiet zone，不能因为容器 `overflow:hidden` 截边。

## 10. Receiver UI

接收端：

- camera stage；
- scan frame；
- progress；
- bitmap；
- status；
- per-file status；
- preview；
- residual tasks / simple receipt 页面入口。

接收后 block 先写 IndexedDB，不能等待全部文件后才持久化。

## 11. 提前预览

当一个文件对应的 block 已经完整，即使整个合辑还没结束，也可以：

- 校验该文件；
- 生成临时 preview；
- 图片/视频/音频提前看。

但“可预览”不等于整任务已经完成。

UI 必须区分：

- file complete；
- task complete。

## 12. 网络加速

光媒可以同时广播一个可选 network provider。

用户在接收端主动启用后：

- 根据缺失 block indices 请求；
- 与摄像头扫描获得的 block 合并；
- 已有 block 不重复保存；
- 网络不是默认必须。

初衷是：

> 光媒负责发现/离线兜底，网络可用时帮助快速补缺失块。

不能把“支持网络加速”改成“扫码后直接全部走 HTTP”，否则失去光媒本身的意义。

## 13. 多设备接收

同一 share 可以被多个接收设备扫描。

发送者维护 share task；每个接收设备拥有自己的 residual bitmap / receipt。

一台设备完成不能终止其它接收者。

## 14. 完成后的隧道写入

完成数据重组和 hash 校验后：

### 原传输记录仍存在

接收设备应把文件作为该记录的本地完整缓存并 announce，成为普通 provider。

### 原记录不存在

可以根据 manifest/source metadata 恢复/建立合适记录，具体行为以当前 app integration 为准。

光媒完成后不应形成一个永远只能被 Light Transfer 自己读取的孤立缓存。

## 15. 单文件与合辑

协议统一描述 files[]。

因此：

- 单文件不是另一套 protocol；
- 合辑只是多个 files + offsets；
- task global byte space 用 `readGlobalRange()` 映射回各文件。

这减少两套 QR 协议分叉。

## 16. Share 入口语义

历史区分：

- 分享整个合辑；
- 分享合辑中的单个文件。

前者 manifest.kind/record 信息保留集合语义；后者只构造目标 file。

不要因为用户在合辑 preview 中点某个 file 就自动把整个 album 都发出去。

## 17. HTTP 非安全环境

WebCrypto 在部分 HTTP 场景不可用。

为了让局域网 HTTP 测试仍可 hash，当前有 SHA-256 fallback。

但 camera/getUserMedia 等浏览器 API 仍可能受 secure context 限制，所以“hash 能算”不代表所有光媒功能都能在任意 HTTP origin 工作。

## 18. iframe / 独立页

`/light-file-parts` 用于查看：

- 未完成任务；
- receipt；
- residual chunks。

历史上 iframe 行为和返回层级专门调整过，避免把 receiver 状态嵌入错误 parent UI。

## 19. 完整性

完成前至少验证：

- manifest hash；
- per-file SHA-256；
- total size；
- block count；
- file offsets。

残片身份不只是 block index，还必须属于相同 taskId。

## 20. 相关测试与人工测试

自动测试在 2608B features 中覆盖协议和 UI 结构。

真实验收需要：

- 不同手机摄像头；
- 远/中/近距离；
- 光线；
- 屏幕刷新率；
- QR frame capacity；
- 刷新续传；
- network acceleration on/off；
- 合辑；
- 提前 preview。

这是典型“Node test 不能证明摄像头体验”的模块。
