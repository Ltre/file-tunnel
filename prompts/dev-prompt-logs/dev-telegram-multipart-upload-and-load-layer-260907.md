
问：

    本次问答已经记录到：

        文档1：QA-of-telegram-multipart-loading-layer-260907.md
        文档2：QA-telegram-multipart-upload-and-load-layer-260907.md

    其中 [文档2] 基于 [文档1] 产生。

    你根据这两篇文档，特别注意我在[文档2]头部提到的需求，重新整理 [基于telegram文件分片，设计高效率上传和加载图片、音频、视频的方案]
    
    




答：

    下面是重新整理后的版本。它以文档2开头明确提出的 4 条需求为最高优先级，并吸收文档1已经确认的现状：现有 Telegram 分片是约 20MB 的纯字节存储分片、下载本身已经能够流式输出，但缺少随机 Range 读取、缓存、媒体索引和高效 seek 层。 文档2进一步明确了：Telegram Range 要实测；视频关键帧分析与实际分片边界应尽量在浏览器完成；图片/音频保持简单；上传要改成浏览器分片与 Telegram 上传并行的生产者－消费者流水线。
    
    

整理后的文档正文如下：

-------------------------------------------------------------------

# 基于 Telegram 文件分片，设计高效率上传和加载图片、音频、视频的方案

## 1、设计目标

Telegram 继续作为网盘文件的底层托管存储。一个网盘文件在逻辑上始终是一个完整文件，在 Telegram 中则由若干分片 Message 共同保存。

本次改造主要解决两个问题：

1. **上传效率问题**
   不能再等待浏览器把整个大文件上传到服务器之后，服务器才开始分片上传 Telegram。应改造成“浏览器分片上传”和“服务器上传 Telegram”同时进行的流水线。

2. **加载效率问题**
   下载、图片预览、音乐播放、视频播放不能再以“从第一个 Telegram 分片开始顺序读取整个文件”为唯一方式。需要建立支持随机读取、缓存和媒体 seek 的逻辑文件读取层。

整体结构：

```text
上传：

Browser File
    ↓
浏览器分片
    ↓
Server Queue
    ↓
Telegram Worker
    ↓
Telegram Messages


读取：

Telegram Messages
    ↓
Telegram Part Reader
    ↓
Chunk Cache
    ↓
Virtual File / Range Gateway
    ↓
├─ 普通文件
├─ 图片
├─ 音频
└─ 视频
```

Telegram 分片只是底层存储形式。

上层业务始终面对一个完整的逻辑文件。

## 2、Telegram 存储分片的基本原则

目前继续以：

```text
≤ 20MB / part
```

作为默认 Telegram 分片上限。

普通文件、图片和音频可以继续按照普通字节边界分片。

视频则允许采用更适合 seek 的**可变大小分片**：

```text
目标大小 target_size
+
绝对上限 hard_max
```

例如：

```text
target_size = 16～18MB
hard_max    = 20MB
```

视频不要求每个分片严格等于 20MB，而是在接近目标大小的位置寻找适合的关键帧字节位置作为真正分片边界。

无论使用普通硬切还是视频关键帧对齐切分，都必须满足：

```text
part1 + part2 + ... + partN
```

能够按字节顺序无损恢复出原始文件。

Telegram 分片本身不要求可以独立播放，也不需要人为给每个分片添加视频头。

## 3、视频分片边界优先在浏览器端确定

这是视频上传与普通文件上传最大的区别。

视频文件开始上传前，浏览器先对本地 `File` 做轻量媒体索引解析：

```text
Browser File
    ↓
解析容器索引
    ↓
取得：
duration
container
codec
keyframe time
keyframe byte position
    ↓
生成 Media Seek Index
    ↓
根据关键帧确定实际分片 byte ranges
```

重点是：

**这一阶段发生在浏览器本地，不需要先把整个视频上传到服务器。**

浏览器可以利用：

```text
File.slice()
```

随机读取本地文件需要的区域。

对于 MP4 / MOV / M4V 等具备良好容器索引的格式，可以通过相关 box/table 得到：

```text
关键帧时间
↕
sample
↕
文件 byte position
```

例如：

```text
00:00:00.000 → byte 1,348,923
00:00:05.120 → byte 4,825,311
00:00:09.240 → byte 8,347,211
...
```

不要求把整个几 GB 视频加载进浏览器内存。

## 4、视频关键帧对齐分片策略

假设当前分片起点：

```text
previous_boundary = 0
```

目标：

```text
target_size = 17MB
hard_max    = 20MB
```

理论目标位置：

```text
target =
previous_boundary + target_size
```

浏览器在该位置附近寻找合适的视频关键帧。

例如：

```text
理论位置：
17,000,000

附近关键帧：
16,782,921
17,834,215
20,914,822
```

如果：

```text
17,834,215 - previous_boundary <= hard_max
```

则可以选择：

```text
17,834,215
```

作为真正分片边界。

得到：

```text
part 1
byteStart = 0
byteEnd   = 17,834,214

part 2
byteStart = 17,834,215
...
```

下一片继续从新的边界向后寻找。

### 4.1、选择边界时的优先级

建议：

1. 优先选择目标大小附近的关键帧；
2. 不允许超过 Telegram 单分片绝对大小上限；
3. 尽量不要产生过小分片；
4. 如果目标范围内没有合适关键帧，则扩大搜索范围；
5. 如果仍无法找到可用关键帧，则允许退化为普通字节边界分片。

不能为了等待下一个关键帧而产生：

```text
21MB
22MB
25MB
```

等超过 Telegram 上传限制的分片。

### 4.2、关键帧边界并不代表分片可独立播放

例如：

```text
part 17
```

虽然从某个 H.264 IDR 关键帧附近开始，但它仍然可能缺少：

```text
MP4 moov
track metadata
sample table
codec initialization data
```

因此：

```text
part17.bin
```

仍然只是存储分片，不能直接当：

```html
<video src="part17.bin">
```

使用。

关键帧对齐的主要价值是：

```text
用户 seek
↓
找到目标关键帧
↓
该关键帧尽量接近某个 Telegram part 起点
↓
服务器可以直接请求这个 part
↓
无需先从很远的字节位置慢慢读取
```

## 5、浏览器生成并提交 Media Seek Index

视频上传时，浏览器不仅生成各 Telegram 分片的 byte range，也应将分析得到的 Media Seek Index 一并提交给服务器。

例如：

```json
{
  "duration": 7245.32,
  "container": "mp4",
  "videoCodec": "h264",
  "audioCodec": "aac",
  "keyframes": [
    {
      "time": 0,
      "byte": 1348923
    },
    {
      "time": 5.12,
      "byte": 4825311
    }
  ],
  "parts": [
    {
      "index": 1,
      "byteStart": 0,
      "byteEnd": 17834214
    },
    {
      "index": 2,
      "byteStart": 17834215,
      "byteEnd": 35118232
    }
  ]
}
```

服务器需要验证：

```text
所有 part 是否连续
是否存在重叠
是否存在缺口
总字节数是否等于原文件 size
是否超过 hard_max
part 数量是否正确
```

不能完全信任浏览器提交的数据。

### 5.1、Media Seek Index 的作用

以后用户拖动到：

```text
01:43:25
```

服务端可以直接二分查找：

```text
目标时间
↓
前一个关键帧
↓
keyframe byte_pos
↓
该 byte 属于哪个 Telegram part
```

而不是使用：

```text
播放时间 / 总时长 × 文件大小
```

这种不可靠的估算方式。

### 5.2、格式不支持时必须允许降级

并不是所有视频格式都适合在浏览器中快速解析。

因此需要允许：

```text
media_index_mode = precise
```

或者：

```text
media_index_mode = unavailable
```

如果浏览器无法解析某个视频：

```text
浏览器媒体分析失败
↓
退化成普通字节分片
↓
仍然正常上传 Telegram
```

不能因为 Media Seek Index 失败而禁止用户保存视频。

## 6、上传改造成真正的流水线

当前模式：

```text
Browser
↓
整个文件全部上传 Server
↓
Server 分片
↓
Telegram
```

需要改成：

```text
Browser
↓
part 1
↓
Server
↓
Queue
↓
Telegram

与此同时：

Browser
↓
part 2
↓
Server
↓
Queue
```

也就是说：

**客户端负责决定分片，服务器负责消费分片。**

## 7、上传任务初始化

浏览器开始上传前，先创建整个逻辑文件上传任务。

服务器返回：

```text
upload_id
operation_id
logical_file_id
```

浏览器提交至少包括：

```text
name
type
size
part_count
```

视频还提交：

```text
Media Seek Index
每个 part 的 byteStart / byteEnd / size
```

服务器保存整个上传计划。

之后浏览器：

```text
part 1
part 2
part 3
...
```

逐个上传。

## 8、浏览器分片到达服务器后的处理

每个 part 到达服务器后：

```text
Browser
↓
Server
↓
校验 part
↓
写临时文件
↓
标记 received
↓
加入 Telegram Upload Queue
```

Telegram Worker 无需等待其它所有 part。

可以马上：

```text
part 1
Server → Telegram
```

与此同时浏览器继续：

```text
part 2
part 3
part 4
```

上传到服务器。

典型流水线：

```text
Browser：

part1 ─────────────→
      part2 ─────────────→
            part3 ─────────────→
                  part4 ─────────────→


Telegram Worker：

      part1 ───────→ Telegram
            part2 ───────→ Telegram
                  part3 ───────→ Telegram
```

## 9、必须增加队列背压，避免服务器重新积累整个文件

这里不能只设计“无限 Queue”。

原因是浏览器上传服务器的速度很可能远高于：

```text
Server → Telegram ≈ 300KiB/s
```

例如浏览器很快上传完一个 1GB 文件，而 Telegram 只完成几十 MB，那么服务器最终还是会积累接近整个 1GB 文件。

所以服务器上传队列必须有：

```text
max_queue_parts
```

或者：

```text
max_queue_bytes
```

例如：

```text
最多允许：
5～10 个待处理 part

或者：
100～200MB 临时数据
```

达到上限后：

```text
Server
↓
返回 BACKPRESSURE / PAUSE
↓
Browser 暂停继续上传
```

Telegram Worker 消耗掉部分队列之后：

```text
Server
↓
允许继续
↓
Browser 恢复上传
```

最终形成真正受控的流水线：

```text
Browser
↓
小规模上传 ahead
↓
Server Queue
↓
Telegram
```

而不是：

```text
Browser
↓
整个 1GB 全堆在服务器
```

## 10、Telegram Worker 与 Album

Telegram Worker 原则上按照：

```text
part_index
```

顺序处理。

每个分片至少记录：

```text
part_index
byte_start
byte_end
size

client_status
queue_status
telegram_status

telegram_message_id
telegram_file_id
media_group_id

retry_count
error
```

状态例如：

```text
receiving
received
queued
telegram_uploading
telegram_uploaded
failed
```

逻辑文件状态：

```text
client_uploading
telegram_processing
finalizing
completed
failed
cancelled
```

为了让 Telegram 托管频道中的分片 Message 不至于过于零散，仍然尽量使用 Telegram Album / Media Group。

Worker 可以将队列中已经到达的连续分片组织成：

```text
part 1 + part 2
→ Album A

part 3 + part 4
→ Album B
```

具体组批时同时考虑：

```text
Telegram Media Group 数量限制
请求体大小限制
当前连续分片数量
等待时间
```

不要为了等待凑满一个大 Album 而长期阻塞已经可以上传的 part。

## 11、浏览器完成上传后继续查询服务器处理进度

浏览器最后一个 part 上传成功，并不意味着文件已经完成保存。

此时 UI 应显示：

```text
浏览器 → 服务器：
100%

服务器 → Telegram：
仍在处理中
```

随后使用：

```text
operation_id
```

持续查询后台状态。

例如：

```text
GET /operations/:operation_id
```

返回：

```text
客户端上传：
52 / 52

Telegram：
37 / 52

当前：
正在上传 part 38

队列：
14 个 part

阶段：
等待 Telegram 响应
```

还应能够显示：

```text
Telegram 限流
Telegram 网络重试
正在建立 Album
正在补充 Message Caption
正在写入索引
正在最终校验
```

最终：

```text
completed
```

才代表逻辑文件真正可用。

## 12、失败、断线与续传

已经成功上传 Telegram 的 part 不应因为后续某个 part 失败而重新上传。

每个 part 都必须能够独立确认状态。

例如：

```text
1 uploaded
2 uploaded
3 uploaded
4 failed
5 queued
```

重试时：

```text
从 part 4 继续
```

而不是从 part 1 重新开始。

浏览器断线后重新进入页面，可以通过：

```text
upload_id
operation_id
```

查询：

```text
客户端哪些 part 已经接收
Telegram 哪些 part 已经完成
哪些仍需要客户端补传
```

## 13、服务器临时分片生命周期

一个 part：

```text
Browser
↓
Server temp
↓
Queue
↓
Telegram
↓
Telegram 返回 message_id / file_id
↓
索引持久化
```

完成以后，该服务器临时 part 就可以删除。

不需要等待整个逻辑文件全部完成才删除。

这样即使上传：

```text
10GB
```

服务器也只需要保存：

```text
当前接收分片
+
有限队列分片
```

而不是同时保存整个 10GB。

## 14、Telegram HTTP Range 必须先进行真实验证

目前服务器从 Telegram 下载分片本身已经可以 Stream。

也就是说：

```text
Telegram part 还没完整下载
```

时，服务器已经能够处理收到的前部数据。

但还需要进一步验证：

> Telegram 返回的分片文件 URL 是否真正支持 HTTP Range。

至少测试：

```text
Range: bytes=0-999999
Range: bytes=5000000-5999999
Range: bytes=最后1MB
```

检查：

```text
HTTP 206
Accept-Ranges
Content-Range
Content-Length
```

以及实际网络流量。

关键不是只看 Telegram 是否返回内容，而是确认：

> 请求第 5～6MB 时，Telegram 是否真的只传输这一段数据。

## 15、Range 支持与不支持的两种读取路径

### Telegram 支持 Range

最佳情况：

```text
Client Range
↓
Virtual File
↓
计算对应 Telegram part
↓
对 Telegram part 再发 Range
↓
只获取真正需要的数据
↓
Client
```

例如：

```text
逻辑文件需要：
byte 205MB～206MB

对应：
part 11 内部某个区域
```

Telegram 只需要返回这一小段。

### Telegram 不支持 Range

则：

```text
Client Range
↓
Virtual File
↓
定位 Telegram part
↓
Telegram 从该 part 开头开始传
↓
Server 丢弃前面不需要的部分
↓
到目标 offset 后开始输出
```

这种情况下，视频关键帧对齐分片尤其有价值：

```text
关键帧
≈ part 起点
```

可以明显减少需要从 part 开头白白读取的数据。

## 16、边收 Telegram 数据、边写缓存、边输出

读取 Telegram 分片时采用：

```text
Telegram Stream
       ↓
       ├→ 当前请求消费者
       │
       └→ Local Chunk Cache
```

也就是说：

```text
Telegram
→ 收到 64KB
→ 立即交给客户端 / FFmpeg
→ 同时写缓存

→ 再收到 64KB
→ 继续
```

而不是：

```text
Telegram
→ 下载完整 20MB
→ 保存
→ 再重新读取
```

临时缓存：

```text
part.cache.tmp
```

只有完整下载并验证成功后，才原子改名为：

```text
part.cache
```

如果客户端中途取消播放，是否继续把当前 part 下载完用于缓存，可以根据：

```text
当前完成比例
缓存价值
服务器负载
```

决定。

## 17、Chunk Cache

建立：

```text
Telegram Chunk Cache
```

例如：

```text
/cache/telegram-parts/
```

缓存键至少包含：

```text
storage_backend
telegram_file_id
part_index
```

避免不同 Bot、不同 Telegram Backend 之间产生冲突。

采用：

```text
LRU
+
最大容量
+
TTL
```

单机少用户场景下，可以根据磁盘容量设置：

```text
10GB
20GB
50GB
```

等缓存上限。

## 18、重复请求合并

如果：

```text
User A
User B
```

同时请求：

```text
part 37
```

不能产生：

```text
Telegram request A
Telegram request B
```

两份完全一样的上游下载。

应该：

```text
part37 fetching
↓
共享同一个上游下载任务
↓
A / B 同时消费结果
```

减少 Telegram 请求数量。

## 19、相邻分片预取与并行下载

播放：

```text
part 20
```

时，可以同时预取：

```text
part 21
part 22
```

如果实测：

```text
单个 Telegram file ≈ 300KiB/s
```

而多个 Telegram file 同时请求可以获得更高聚合带宽，则允许有限并发：

```text
part 20
part 21
part 22
```

同时获取。

并发数需要配置，例如：

```text
2
3
4
```

不能无限并发。

是否确实能从：

```text
300KiB/s
```

提高到：

```text
600KiB/s
900KiB/s
```

必须通过实际网络测试判断。

## 20、Virtual File / Range Gateway

所有 Telegram parts 在上层统一映射为一个连续逻辑文件：

```text
logical byte 0
...
logical byte N
```

提供类似：

```text
read(startByte, endByte)
```

的能力。

Range Gateway 负责：

```text
逻辑 byte range
↓
查 part map
↓
需要：
part 17
part 18
part 19
↓
读取 Cache / Telegram
↓
拼成连续 stream
```

并正确向客户端支持：

```http
206 Partial Content
Accept-Ranges: bytes
Content-Range
Content-Length
```

以后：

```text
普通文件下载
断点续传
音频
视频
第三方引用
```

都可以建立在这一层之上。

## 21、图片加载保持简单

图片不需要：

```text
Media Seek Index
关键帧
HLS
FFmpeg 视频切片
```

普通图片：

```text
Browser
↓
Virtual File
↓
Cache / Telegram
```

即可。

对于超大图片，可以生成：

```text
thumbnail
preview
original
```

例如：

```text
文件列表
→ thumbnail

普通全屏预览
→ preview

查看原图 / 下载
→ original
```

衍生图片可以存入服务器 Media Cache。

不改变 Telegram 原图的存储方式。

## 22、音频加载保持简单

音频也不使用视频级关键帧分析。

浏览器能够直接播放的：

```text
MP3
M4A
AAC
OGG
FLAC
...
```

优先：

```text
<audio>
↓
HTTP Range
↓
Virtual File
↓
Cache / Telegram
```

拖动进度条交给浏览器 Range 请求即可。

上传时最多补充：

```text
duration
codec
bitrate
```

等基础媒体信息。

不默认转换 HLS。

## 23、视频优先 Direct Range Streaming

浏览器本身能够直接播放的：

```text
MP4
H.264
AAC
WebM
...
```

优先：

```text
<video>
↓
HTTP Range
↓
Virtual File
↓
Telegram Range / Chunk
```

不要所有视频都强制先走 FFmpeg + HLS。

这样：

```text
CPU 开销更低
临时文件更少
首播路径更短
```

## 24、视频 seek

用户拖动：

```text
01:37:35
```

处理流程：

```text
01:37:35
↓
Media Seek Index
↓
找到目标时间前最近关键帧
↓
keyframe byte_pos
↓
查 part map
↓
定位 Telegram part
↓
Chunk Cache？
├─ hit → 直接读取
└─ miss
     ↓
   Telegram
```

因为浏览器上传时已经尽量：

```text
Telegram part boundary
≈
关键帧 byte position
```

所以第一次访问未缓存位置时，可以尽量从较接近关键帧的位置开始获取。

## 25、HLS 只作为视频高级适配层

浏览器不能直接播放，或者需要低码率播放版本时，再进入：

```text
HLS
```

推荐：

```text
init.mp4
+
segment-xxxx.m4s
+
m3u8
```

即 fragmented MP4 HLS。

流程：

```text
目标播放时间
↓
Media Seek Index
↓
关键帧
↓
Virtual File
↓
少量 Telegram parts
↓
FFmpeg
↓
生成目标附近 HLS segments
↓
播放器
```

## 26、HLS 必须按需生成

用户拖到：

```text
01:20:00
```

不能：

```text
重新从 00:00:00 转整个视频
```

而应该：

```text
01:20:00
↓
查关键帧
↓
读取附近必要数据
↓
只生成目标时间附近的 segment
```

例如：

```text
01:19:56
01:20:00
01:20:04
01:20:08
```

几个小 segment。

生成结果进入：

```text
Media Cache
```

第二次访问同一位置：

```text
不访问 Telegram
不重新 FFmpeg
直接返回缓存
```

## 27、低码率 HLS

当前 Telegram 分片实际下载速度可能只有：

```text
≈ 300KiB/s
≈ 2.46Mbps
```

如果源视频：

```text
8Mbps
```

则即使 seek 很快：

```text
Telegram 下载速度
<
视频持续消费速度
```

连续播放仍然可能缓冲。

这种场景可以让 HLS 同时承担：

```text
降低播放码率
```

例如：

```text
源视频：
8Mbps

HLS：
1.5～2Mbps
```

降低连续播放对 Telegram 下载吞吐量的要求。

## 28、20MB 暂时不改成 5MB

第一阶段继续保留：

```text
hard_max ≈ 20MB
```

先完成：

```text
Telegram Range 实测
Virtual File
Chunk Cache
边下载边缓存边输出
Media Seek Index
视频关键帧对齐分片
相邻预取
并发获取
Direct Range
HLS
```

之后再测试真正的：

```text
首次 seek 未缓存位置
```

延迟。

如果最终确认：

```text
Telegram 不支持 Range
```

并且即使关键帧分片对齐后：

```text
20MB part
```

仍然造成明显 seek 等待，再考虑：

```text
视频：
5～10MB

普通文件：
20MB

图片：
20MB

音频：
20MB
```

不用整个网盘一起改小。

## 29、缓存体系

建议至少两类缓存。

### Telegram Chunk Cache

```text
/cache/telegram-parts/
```

保存：

```text
Telegram 原始存储分片
```

### Media Cache

```text
/cache/media/
```

保存：

```text
图片 thumbnail
图片 preview

HLS init.mp4
HLS m4s

其它媒体衍生缓存
```

两类缓存都可以：

```text
LRU
+
TTL
+
容量限制
```

## 30、最终上传数据流

普通文件：

```text
Browser File
↓
浏览器按固定大小 slice
↓
part
↓
Server
↓
Bounded Queue
↓
Telegram Worker
↓
Telegram
```

视频：

```text
Browser Video
↓
浏览器解析 Media Index
↓
keyframe time ↔ byte position
↓
生成关键帧对齐 part ranges
↓
File.slice()
↓
Server
↓
Bounded Queue
↓
Telegram Worker
↓
Telegram
```

与此同时：

```text
Operation Job
```

持续记录整个过程。

## 31、最终读取数据流

普通文件：

```text
Client
↓
Virtual File
↓
Chunk Cache
↓ miss
Telegram
↓
边缓存
边输出
```

图片：

```text
thumbnail / preview
↓
Media Cache

原图
↓
Virtual File
```

音频：

```text
<audio>
↓
Range
↓
Virtual File
↓
Telegram / Cache
```

视频 Direct：

```text
<video>
↓
Range
↓
Media Seek Index
↓
Virtual File
↓
Telegram / Cache
```

视频 HLS：

```text
Player
↓
m3u8
↓
目标时间
↓
Media Seek Index
↓
keyframe
↓
Virtual File
↓
Telegram / Cache
↓
FFmpeg
↓
init.mp4 + m4s
↓
Player
```

## 32、推荐开发顺序

建议按以下顺序开发：

1. 客户端直接分片上传；
2. 服务器建立有容量上限的 Telegram Upload Queue；
3. 浏览器上传与 Telegram 上传形成真正流水线；
4. 完善每个 part 和逻辑文件的 Operation Job；
5. 完善断线、失败分片续传；
6. 实测 Telegram HTTP Range；
7. 建立边下载、边缓存、边输出机制；
8. 建立 Telegram Chunk Cache；
9. 建立 Virtual File / Range Gateway；
10. 图片接入 Virtual File；
11. 音频接入 Range Streaming；
12. 浏览器端视频 Media Index 解析；
13. 浏览器端关键帧对齐分片；
14. 服务端保存并校验 Media Seek Index；
15. 视频 Direct Range Streaming；
16. 相邻分片预取和有限并发；
17. 按需 HLS；
18. HLS Segment Cache；
19. 低码率 HLS；
20. 实测 20MB 视频分片的最终 seek 性能；
21. 只有实测证明必要时，再考虑视频改为 5～10MB。

## 33、最终原则

整个方案需要始终保持以下边界：

**Telegram Message / Part 是存储层。**

**Virtual File / Range Gateway 是文件读取层。**

**Media Seek Index 是视频时间与原文件字节位置之间的定位层。**

**图片、音频和视频预览是媒体应用层。**

**HLS 是视频播放适配层，而不是 Telegram 文件分片层。**

视频上传时应尽量由浏览器提前完成关键帧索引与关键帧对齐分片，使：

```text
Telegram part boundary
≈
视频关键帧 byte position
```

同时浏览器直接逐片上传，服务器收到一个 part 就立即进入 Telegram 队列，从而实现：

```text
Browser → Server
```

和：

```text
Server → Telegram
```

两段链路真正并行。

读取时则通过：

```text
Range
+
Chunk Cache
+
边收边输出
+
Media Seek Index
+
预取
+
必要时 HLS
```

尽量降低 Telegram 低速下载对用户实际预览体验的影响。


-------------------------------------------------------------------
