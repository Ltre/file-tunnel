问：

    这次和你的问答内容，已经整理到附件 QA-of-telegram-multipart-loading-layer-260907.md。

    认同你在问答中的建议，同时我也有以下需求：

        1、考虑对telegram分片请求http range，验证到底能不能边收边写缓存、边输出
        2、考虑在视频文件上传阶段分片时为截取片段的收尾选取合适的关键帧，以提取到的两个关键帧所在的字节位置，作为分片文件的真正首尾参照点。（这一步尽量在浏览器中执行，这样就不会被误解跟第4点提到的分片逻辑产生冲突）
        3、对于图片/音频，就不需要像视频那样复杂读取处理。
        4、目前分片上传的模式太烂了。要等一整个文件上传到服务器，才能开始分片上传到telegram。能不能这样改：客户端直接分片，逐个分片上传，当每个分片到达服务器后，放进队列里，由服务器消费队列以逐个分片上传，而客户端在服务器上传分片到telegram时，会继续从浏览器上传别的分片到服务端并加入服务器队列。直到客户端将所有分片上传到服务器后，开始执行检查服务器处理状态请求，可以获知队列执行到哪了，具体跟telegram交互的细节，直到最后上传完成或者出错提示，都可以把最终结果返回到浏览器显示。
        

    你根据这次问答内容，以及我的需求，整理 [基于telegram文件分片，设计高效率上传和加载图片、音频、视频的方案]


--------------------------------------------------------------


答：


    我会把这份方案整理成“上传流水线 + Telegram 存储分片 + 随机读取/缓存层 + 图片/音频/视频三类加载策略 + 降级与验证”这一套完整架构。这里有一个关键点我会特别处理：视频分片边界可以参考关键帧，但不能破坏原文件字节的连续覆盖与无损还原，否则“按关键帧切分”和“原文件硬分片”会互相打架。
    
    我按附件中已经确认的现状来整理：当前是 20MB 纯字节硬分片、Telegram 下载已经是流式输出、但尚不支持从指定分片/字节范围随机读取；并把你这次新增的 Range 验证、视频关键帧索引、图片/音频简化处理，以及“浏览器上传与 Telegram 上传并行流水线”合并成一套方案。





文档正文：

---------------------------------------------------------------

# 基于 Telegram 文件分片，设计高效率上传和加载图片、音频、视频的方案

## 1、总体设计

Telegram 继续作为网盘文件的底层托管存储。文件在逻辑上始终是一个完整文件，在 Telegram 中则拆分成若干不超过 20MB 的存储分片。

Telegram 分片只承担：

* 文件存储；
* 无损恢复原文件；
* 与虚拟网盘文件建立底层关联。

不要要求 Telegram 中的单个视频分片自身可以播放，也不要为了播放给每个 Telegram 分片重新添加视频头。

在 Telegram 存储层之上增加统一的“Virtual File / Range Gateway”逻辑文件读取层，使上层始终把多个 Telegram 分片视为一个连续的大文件：

```text
Telegram 分片
      ↓
分片读取 / 本地缓存
      ↓
Virtual File / Range Gateway
      ↓
完整逻辑文件字节空间
      ↓
├─ 普通文件下载
├─ 图片加载
├─ 音频播放
└─ 视频 Direct Range / HLS
```

以后普通下载、断点续传、图片预览、音乐播放、视频播放、第三方文件引用都尽量统一使用这一层，不再为每种文件分别实现一套 Telegram 分片读取逻辑。

## 2、Telegram 分片的读取与 HTTP Range

首先需要实际验证 Telegram Bot API 返回的文件下载 URL 是否可靠支持 HTTP Range，不能预先假定一定支持。

测试时至少验证：

* `Range: bytes=0-999999`；
* 从文件中间开始的 Range；
* 文件尾部 Range；
* 多次连续 Range；
* 返回状态是否为 `206 Partial Content`；
* 是否存在正确的 `Content-Range`；
* Telegram 是否真的只传输指定范围，而不是忽略 Range 后返回整个文件；
* 不同大小文件、不同 Bot、不同时间取得的 `file_path` 是否行为一致。

如果 Telegram 文件下载地址可靠支持 Range：

```text
客户端请求逻辑文件 bytes A-B
        ↓
Range Gateway
        ↓
计算涉及哪些 Telegram part
        ↓
第一片 / 最后一片只请求需要的字节范围
        ↓
中间完整分片正常请求
        ↓
组合为 HTTP 206 返回
```

这样即使一个 Telegram 分片是 20MB，也可以直接读取其中真正需要的几百 KB 或几 MB。

如果 Telegram 不支持 Range，或者某次请求忽略 Range 返回 `200`：

```text
请求逻辑文件某个范围
        ↓
定位到需要的 Telegram part
        ↓
从该 Telegram part 开头开始下载
        ↓
跳过前面暂时不需要的字节
        ↓
到达目标位置后开始输出
```

因此 Range Gateway 必须同时支持：

* Telegram 上游支持 Range 的快速路径；
* Telegram 上游不支持 Range 的兼容路径。

不能把整个系统建立在 Telegram 一定支持 Range 的假设上。

## 3、边收 Telegram 数据、边缓存、边输出

当前 Telegram 下载本身已经可以流式读取，因此进一步增加缓存时，不应该变成：

```text
Telegram
→ 整片下载完成
→ 写缓存
→ 再读取缓存
→ 客户端
```

而应该：

```text
                ┌→ 本地分片缓存
Telegram Stream ┤
                └→ 当前客户端 / FFmpeg
```

同一批从 Telegram 收到的数据，在流入服务器后同时：

1. 写入服务器本地临时缓存；
2. 立即交给正在等待的客户端或媒体处理程序。

例如一个 20MB Telegram 分片下载速度只有 300KiB/s，也不需要等约一分钟把整个 20MB 下载完成后才开始处理；收到前面的数据后就可以立即向下游继续输出。

缓存文件建议先写：

```text
part-xxxx.cache.tmp
```

完整接收并确认：

* 大小正确；
* 分片 ID 正确；
* 必要时 hash 正确；

之后再原子重命名为正式缓存文件，避免把下载到一半的数据误认为完整缓存。

如果多个用户同时请求同一个尚未缓存的 Telegram 分片，不应重复向 Telegram 发起多个完全相同的下载任务，而应该尽量共享同一个正在进行中的分片获取任务。

本地缓存采用 LRU + 最大容量限制，例如按服务器实际磁盘空间配置 10GB、20GB、50GB 等上限。

播放时可以进行有限的相邻分片预取：

```text
正在使用 part 20

同时预取：
part 21
part 22
```

如果实际测试发现 Telegram 对不同文件请求分别限速，允许少量并行下载还可能提高总体吞吐量；并发数应做成可配置值，不宜无限并发。

## 4、文件上传改为“浏览器 → 服务器 → Telegram”流水线

目前“浏览器先把整个大文件上传到服务器，服务器收到完整文件后才开始切分并上传 Telegram”的模式需要改掉。

新的上传流程应该采用生产者－消费者流水线。

浏览器直接按照网盘规定的分片大小切分文件，例如：

```text
1GB 文件

浏览器：
part 1
part 2
part 3
...
```

上传任务开始时，服务器先创建：

```text
upload_id
operation_id
logical_file_id
总文件大小
总分片数
文件元信息
```

之后浏览器逐片上传。

当：

```text
part 1
浏览器 → 服务器
```

完成后，服务器不需要等待 part 2～最后一个分片，而是立即：

```text
part 1
→ 校验
→ 写入临时文件
→ 加入 Telegram Upload Queue
```

Telegram Worker 随即开始消费队列：

```text
part 1
服务器 → Telegram
```

与此同时：

```text
part 2
part 3
part 4
```

仍然可以继续：

```text
浏览器 → 服务器
```

形成真正的流水线：

```text
客户端：

part1 ───────────────→
      part2 ───────────────→
            part3 ───────────────→
                  part4 ───────────────→

服务器 Telegram Worker：

      part1 ─────→ Telegram
            part2 ─────→ Telegram
                  part3 ─────→ Telegram
                        part4 ─────→ Telegram
```

这样服务器不需要等整个 1GB 文件上传完以后才开始 Telegram 上传。

### 4.1、服务器上传队列

每个逻辑文件的分片至少记录：

```text
part_index
offset
size
client_received
queued
telegram_uploading
telegram_uploaded
telegram_message_id
telegram_file_id
media_group_id
retry_count
error
```

分片状态可以类似：

```text
receiving
received
queued
telegram_uploading
telegram_uploaded
failed
```

逻辑文件总任务状态可以类似：

```text
client_uploading
telegram_processing
finalizing
completed
failed
cancelled
```

Telegram Worker原则上按照分片顺序处理。

为了继续利用 Telegram Album / Media Group 整理频道消息，可以让相邻且已经进入队列的分片组成小批次：

```text
part 1 + part 2
→ 一个 Telegram Media Group

part 3 + part 4
→ 下一个 Media Group
```

不要求客户端等待服务器凑满全部分片。

Worker 可以在满足：

* Telegram Album 数量限制；
* Telegram 请求体大小限制；
* 当前已经进入队列的连续分片；

的情况下动态组批。

### 4.2、客户端全部上传完成后的状态查询

浏览器完成所有客户端分片上传后，不代表整个网盘文件已经上传完成。

此时前端进入：

```text
文件已传输到服务器
正在等待服务器完成 Telegram 存储
```

并开始通过 `operation_id` 查询后台执行状态。

例如：

```text
GET /operations/:operation_id
```

可以返回：

```text
浏览器上传：
100%

Telegram：
37 / 52 分片完成

当前：
正在上传 part 38

Telegram：
正在等待响应

队列：
14 个分片等待处理
```

还应显示：

* Telegram 限流等待；
* Telegram 网络重试；
* 当前 Album；
* 已成功的分片；
* 失败分片；
* 索引写入；
* 最终文件确认。

直到服务器返回：

```text
completed
```

前端才把整个逻辑文件视为真正上传完成。

如果失败，应返回具体：

```text
失败阶段
失败分片
Telegram 错误
是否允许重试
```

已经成功写入 Telegram 的分片不能因为某一个后续分片失败就全部重新上传。

应保留任务状态，并优先支持从缺失/失败分片继续。

## 5、服务器临时分片的生命周期

客户端一个分片到达服务器以后：

```text
客户端 part
↓
临时文件
↓
Telegram Queue
↓
Telegram 上传成功
↓
message_id / file_id 已可靠写入索引
```

在普通文件场景下，这个本地临时分片即可删除。

不要为了等待整个文件上传完成长期保留全部临时文件。

但视频存在额外的媒体分析需求，因此视频临时分片可以适当延长保留时间，直到 Media Seek Index 建立完成。

如果视频媒体分析失败，也不能把已经成功上传 Telegram 的原文件判定为上传失败。

应该：

```text
文件存储状态 = completed
media_index_status = failed
```

以后仍然允许普通下载，并可以重新执行媒体索引分析。

## 6、视频文件的关键帧与 Media Seek Index

视频仍然以原始字节形式存储在 Telegram 中，不要求 Telegram part 自身可以播放。

需要额外建立 Media Seek Index。

至少保存：

```text
duration
container
video_codec
audio_codec
resolution
bitrate
```

并保存关键帧信息：

```text
keyframe:
    time
    byte_pos
```

例如：

```text
00:10:32.440 → byte 188234221
00:10:36.520 → byte 189976423
00:10:40.600 → byte 191773210
```

这样用户拖动视频到：

```text
00:10:38
```

不需要：

```text
10:38 / 总时长 × 文件大小
```

来猜位置，而是直接查 Media Seek Index：

```text
目标时间 00:10:38
↓
找到前一个关键帧 00:10:36.520
↓
byte_pos = 189976423
↓
根据 byte_pos 定位 Telegram part
```

### 6.1、关键帧与 Telegram 分片边界的关系

视频上传时可以记录每个 Telegram 存储分片附近真正的媒体边界。

例如物理存储分片：

```text
storage_start = 180000000
storage_end   = 199999999
```

同时保存：

```text
previous_keyframe:
    time
    byte_pos

first_keyframe_inside_part:
    time
    byte_pos

last_keyframe_inside_part:
    time
    byte_pos

next_keyframe:
    time
    byte_pos
```

这样每个分片除了知道：

```text
自己属于原文件的哪个字节范围
```

还知道：

```text
自己大约覆盖视频的哪个播放时间区间
以及真正适合解码的关键帧在哪里
```

不过需要注意：

**不要为了强行把 Telegram 存储分片切到关键帧位置，而破坏第 4 条“浏览器上传与 Telegram 上传同步流水执行”的能力。**

如果必须等整个视频上传完、完整执行 ffprobe 后，才能决定每个物理分片应该在哪里切，那么又会退回：

```text
必须先收到完整视频
→ 分析
→ 才能上传 Telegram
```

这与新的流水上传目标冲突。

因此第一阶段更建议：

```text
Telegram storage part
= 继续按字节大小稳定切分

Media Seek Index
= 单独记录真正的关键帧位置
```

并为每个物理分片建立“关键帧参照点”。

如果以后验证出“物理分片也按关键帧边界调整”能显著改善首播/seek，同时又能找到不会阻塞流水上传的实现，再进一步做可变大小关键帧对齐分片。

这两个概念需要分开：

```text
Storage Boundary
= Telegram 文件存储边界

Decode Boundary
= 视频真正适合开始/结束解码的位置
```

不要强行要求两者完全一致。

## 7、视频读取和拖动播放

视频分为两种路径。

### 7.1、浏览器可以直接播放的视频

例如浏览器原生支持的：

```text
MP4
H.264
AAC
```

优先：

```text
<video>
↓
HTTP Range
↓
Virtual File
↓
Telegram Range / Telegram part
```

不需要无意义地全部转成 HLS。

### 7.2、需要 HLS 的视频

浏览器不能直接可靠播放、需要转码、或者希望提供低码率版本时：

```text
播放器
↓
m3u8
↓
请求目标 segment
↓
Media Seek Index
↓
找到前一个适合的关键帧
↓
Virtual File
↓
拉取涉及的 Telegram part
↓
FFmpeg
↓
生成目标 HLS segment
```

建议优先使用：

```text
init.mp4
+
segment-xxxx.m4s
+
m3u8
```

也就是 fragmented MP4 HLS。

Telegram part 不需要自己具有视频头。

真正负责生成合法可播放媒体片段的是 FFmpeg/HLS 层。

### 7.3、HLS 不应处理整个视频

用户拖到 01:20:00 时，不应该：

```text
从视频开头开始重新生成 HLS
```

而应该：

```text
01:20:00
↓
Media Seek Index
↓
附近关键帧
↓
读取少量必要 Telegram part
↓
只生成附近若干 HLS segment
```

生成的 HLS segment 同样进入服务器缓存：

```text
/cache/hls/<file_id>/
```

第二次播放同一位置时直接使用缓存。

## 8、视频低速 Telegram 下载的处理

目前实测 Telegram 分片下载约 300KiB/s，因此需要区分两个问题：

### Seek 延迟

决定用户拖动后多久能开始看到画面。

优化方式：

* Media Seek Index；
* Telegram HTTP Range（如果验证可用）；
* 从目标 Telegram part 直接开始；
* 分片本地缓存；
* 边下载边送 FFmpeg；
* 关键帧定位。

### 连续播放吞吐量

决定视频能不能一直播放而不卡顿。

300KiB/s 约等于 2.46Mbps。

如果原视频码率明显高于这个速度，例如：

```text
8Mbps
```

仅仅把：

```text
20MB 分片
→ 5MB 分片
```

不会解决连续播放问题。

需要考虑：

* 同时预取后续分片；
* 验证多个 Telegram 请求是否可以获得更高聚合速度；
* 本地缓存；
* 必要时生成更低码率的 HLS 播放版本。

例如：

```text
原视频 8Mbps
↓
HLS 1.5~2Mbps
```

对于低速 Telegram 来源更容易持续播放。

## 9、暂时保留 20MB 分片，不立即改成 5MB

第一阶段继续保持：

```text
MAX_TELEGRAM_PART_SIZE ≈ 20MB
```

因为目前已经具备“Telegram 分片尚未完整下载，就继续输出已经收到的数据”的能力。

在增加：

* Telegram Range 验证；
* Virtual File；
* Range Gateway；
* Media Seek Index；
* 本地缓存；
* 相邻预取；

之后，再测试：

```text
首次跳转到完全没有缓存的视频位置
```

真正需要多久。

只有在确认：

```text
Telegram 不支持 Range

并且：

目标数据经常位于 20MB part 深处
导致首次 seek 等待时间明显过长
```

时，才考虑把视频文件单独缩小为：

```text
5MB～10MB / part
```

没有必要让普通 ZIP、安装包、备份文件等一起缩小。

以后允许：

```text
普通文件：20MB
图片：20MB
音频：20MB
视频：5～20MB，根据性能测试决定
```

分片大小应属于存储策略，而不是整个网盘永远固定成同一个值。

## 10、图片加载策略

图片不采用视频那套 Media Seek Index / HLS / 关键帧逻辑。

普通图片：

```text
Virtual File
↓
Telegram part
↓
浏览器
```

即可。

对于特别大的图片，为提高预览速度，可以增加简单的缩略图/预览图机制：

```text
原图
├─ thumbnail
└─ preview
```

列表：

```text
thumbnail
```

全屏普通预览：

```text
preview
```

用户明确查看原图/下载：

```text
original
```

这些衍生图只是一种可选优化，不改变原始图片在 Telegram 中的存储方式。

## 11、音频加载策略

音频也不需要视频那套复杂处理。

浏览器支持的：

```text
MP3
M4A
AAC
OGG
FLAC
...
```

优先直接使用：

```text
HTTP Range
↓
Virtual File
↓
Telegram part
```

进行在线播放和拖动。

上传阶段最多补充：

```text
duration
codec
bitrate
```

等简单媒体信息。

不需要为音频建立视频级关键帧索引，也不需要默认转换成 HLS。

## 12、缓存体系

建议至少区分两类缓存：

### Telegram Chunk Cache

```text
/cache/telegram-parts/
```

缓存从 Telegram 获取的原始分片。

键至少包含：

```text
backend
file_id
part_index
```

避免不同 Bot / 不同文件之间产生冲突。

### Media Cache

```text
/cache/media/
```

包括：

* 图片 thumbnail；
* 图片 preview；
* HLS init.mp4；
* HLS m4s；
* 临时媒体分析结果。

两类缓存都可以使用：

```text
LRU
+
最大容量
+
TTL
```

单机少量用户的情况下，优先使用服务器本地磁盘缓存即可，不需要 CDN 或分布式缓存。

## 13、最终推荐的数据流

### 上传

```text
Browser
│
├─ part 1 → Server → Queue → Telegram
│
├─ part 2 → Server → Queue → Telegram
│
├─ part 3 → Server → Queue → Telegram
│
└─ ...
│
└─ 客户端上传完成
      ↓
   查询 operation_id
      ↓
   等待 Telegram Queue 清空
      ↓
   写入完整逻辑文件索引
      ↓
   completed
```

视频额外：

```text
视频临时数据
↓
ffprobe / 媒体分析
↓
Media Seek Index
↓
keyframe time ↔ byte_pos ↔ Telegram part
```

### 下载 / 普通读取

```text
Client Range
↓
Virtual File
↓
Chunk Cache
↓ miss
Telegram part / Telegram Range
↓
边收
├→ Cache
└→ Client
```

### 音频

```text
<audio>
↓
HTTP Range
↓
Virtual File
↓
Telegram / Cache
```

### 图片

```text
缩略图 / Preview
优先缓存

原图
↓
Virtual File
↓
Telegram / Cache
```

### 视频

```text
目标播放时间
↓
Media Seek Index
↓
关键帧 byte_pos
↓
Virtual File
↓
Telegram part / Range / Cache
↓
├─ 浏览器可直接播放 → HTTP Range
│
└─ 需要转换
      ↓
    FFmpeg
      ↓
    init.mp4 + m4s
      ↓
    m3u8
```

## 14、开发优先顺序

建议不要一次把所有媒体优化同时做完，按照以下顺序实施：

1. 改造客户端分片上传，使“浏览器上传”和“服务器上传 Telegram”形成生产者－消费者流水线；
2. 完善每个 part 和整个 logical file 的 Operation Job 状态；
3. 实测 Telegram 文件 URL 的 HTTP Range 能力；
4. 建立 Telegram Chunk Cache，并实现边下载、边缓存、边输出；
5. 建立 Virtual File / Range Gateway；
6. 图片和音频优先接入 Range Gateway；
7. 视频上传后生成 Media Seek Index；
8. 视频 Direct Range Streaming；
9. 按需 HLS + segment cache；
10. 测试 20MB 分片在真实 seek 场景的延迟；
11. 只有性能数据证明有必要时，再考虑视频单独改成 5～10MB 分片。

整体目标不是让 Telegram 分片本身变成“媒体片段”，而是：

**Telegram 只负责可靠保存原始文件分片；Virtual File 负责把这些分片重新抽象成可随机读取的完整文件；图片、音频和视频再根据各自特点建立高效加载方式。**


---------------------------------------------------------------



这里我特意没有直接照搬你第 2 点为“把物理 Telegram 分片首尾直接改成两个关键帧位置”，因为它与第 4 点的实时流水上传存在明显冲突：如果必须先完整分析视频才能决定物理切分点，就又得等整个视频到达服务器。

更合适的是先保留 Storage Boundary（存储边界） 与 Decode Boundary（关键帧解码边界） 两套信息：既不牺牲现在最需要的流水上传，又能让之后的 Range/HLS 精确找到真正应该读取的位置。后续实测如果证明“物理分片关键帧对齐”收益足够大，再单独升级这一层。



----------------------------------------------------------------


问：


    你提到"不要为了强行把 Telegram 存储分片切到关键帧位置，而破坏第 4 条“浏览器上传与 Telegram 上传同步流水执行”的能力。  "，我第2点的意思是，【在视频文件上传阶段分片时为截取片段的收尾选取合适的关键帧，以提取到的两个关键帧所在的字节位置，作为分片文件的真正首尾参照点】这一步就在浏览器完成。能做到吗
    
    
答：



能做到，而且如果你的意思是“**浏览器在上传前就完成媒体索引分析，并据此决定每个 Telegram 存储分片的实际字节边界**”，那我前面担心的“必须先把完整视频上传到服务器才能分析”就不存在了。

更准确地说，浏览器可以在本地文件上先做一次**轻量媒体索引扫描**，然后再开始分片上传：

```text
浏览器本地 File
   ↓
解析容器索引 / 关键帧信息
   ↓
得到：
time ↔ keyframe ↔ byte_pos
   ↓
以约 20MB 为目标寻找合适关键帧
   ↓
生成实际分片边界
   ↓
File.slice(startByte, endByte)
   ↓
边上传 part1 / part2 / part3...
```

这样第 4 条的流水线仍然成立：

```text
浏览器分析完成
↓
part1 → Server → Telegram
       part2 → Server → Telegram
              part3 → Server → Telegram
```

并不需要服务器先收到整个文件。

### 关键是：浏览器不需要“播放完整视频”才能知道关键帧

对于 MP4 这类容器，关键帧、sample、时间戳和文件位置本来就有索引结构。例如可以从 MP4 的：

```text
moov
stss    → sync sample / keyframe
stts    → sample 时间
stsc
stsz
stco/co64 → chunk 文件偏移
```

推导出类似：

```text
关键帧 #1
time = 00:00:00.000
byte_pos = 1,348,923

关键帧 #2
time = 00:00:05.120
byte_pos = 4,825,311

...

关键帧 #173
time = 00:14:32.600
byte_pos = 198,734,551
```

浏览器可以用纯 JS 的 MP4 parser，比如 `mp4box.js` 这类实现来做，不一定需要沉重的 ffmpeg.wasm。

而且浏览器 `File` 本身支持随机：

```js
file.slice(start, end)
```

所以即使 `moov` 在文件尾部，也可以直接读取尾部对应区域分析，**不需要先把整个几 GB 文件复制进内存**。

---

你提出的实际分片策略可以变成：

假设目标：

```text
最大约 20MB
```

原本机械切：

```text
0
20MB
40MB
60MB
...
```

现在浏览器先把“20MB 理论位置”附近的关键帧找出来。

比如：

```text
理论边界：20,000,000

附近关键帧：

18,931,282
20,834,192
24,112,391
```

那么选择：

```text
20,834,192
```

作为边界。

下一片再从这里开始寻找：

```text
20,834,192 + 20MB
≈ 40,834,192
```

附近合适关键帧：

```text
39,744,033
41,013,226
```

选择其中之一。

最后得到：

```text
part1
bytes 0 ~ 20,834,191

part2
bytes 20,834,192 ~ 41,013,225

part3
bytes 41,013,226 ~ ...
```

于是每个分片不是严格 20MB，而是：

```text
18MB
21MB
19MB
...
```

当然因为 Telegram 有硬上限，所以实际策略必须是：

> **关键帧优先，但分片绝对不能超过 Telegram 允许的最大值。**

也就是说如果最大允许 20,000,000 bytes，最好设置一个更低的目标值，比如：

```text
TARGET = 16~18MB
HARD_MAX = 20MB
```

然后在：

```text
TARGET 附近
```

寻找关键帧，同时要求：

```text
boundary - previousBoundary <= HARD_MAX
```

否则不能为了等下一个关键帧把分片做到 22MB。

---

不过这里有一个非常重要的技术区别。

### “关键帧字节位置作为存储分片边界”可以做

但：

> **不代表这个 part 本身就是可独立播放的视频片段。**

例如：

```text
part17
start = 某 H.264 IDR keyframe 的 byte_pos
```

虽然开始位置很好，但它仍然没有：

```text
MP4 moov
track metadata
sample table
codec initialization data
```

所以：

```text
part17.bin
```

还是不能直接：

```html
<video src="part17.bin">
```

播放。

但这没关系，因为你本来的目的就不是让 Telegram part 自己成为视频。

它的作用是：

```text
用户 seek 到 37:20
↓
查索引
↓
37:20 前一个关键帧
刚好位于 part17 开头附近
↓
Telegram 只需开始拉 part17
↓
很快就获得关键帧附近的数据
↓
交给 Virtual File / FFmpeg / HLS
```

这对你特别有价值。

---

### 还有一个需要处理的细节：音频和视频数据是交错的

例如 MP4 中可能是：

```text
video chunk
audio chunk
video chunk
audio chunk
...
```

所以：

```text
视频关键帧 byte_pos = X
```

不一定意味着：

```text
X 以前所有音频都属于上一时间段
X 以后所有音频都属于下一时间段
```

因此不要给分片定义过于绝对的：

```text
这个 part = 10:00.000 ~ 11:00.000
```

比较准确的是：

```text
part:
    byte_start
    byte_end

    boundary_keyframe_start:
        time
        byte_pos

    boundary_keyframe_end:
        time
        byte_pos
```

也就是说它保存的是：

> 这个字节分片首尾所参考的两个视频关键帧。

而不是声明这个 Telegram part 自身就是严格的媒体时间 segment。

---

## 浏览器最好生成完整的 Media Index

我会建议你不要只保存每个 part 的两个关键帧。

浏览器既然已经分析一次了，顺手把完整关键帧索引保存下来：

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
      "byteEnd": 20834191,
      "endKeyframeTime": 49.52,
      "endKeyframeByte": 20834192
    },
    {
      "index": 2,
      "byteStart": 20834192,
      "byteEnd": 41013225,
      "startKeyframeTime": 49.52,
      "startKeyframeByte": 20834192,
      "endKeyframeTime": 97.08,
      "endKeyframeByte": 41013226
    }
  ]
}
```

以后用户拖到：

```text
01:43:25
```

直接二分查找：

```text
keyframes
↓
01:43:22.400
↓
byte = 1,384,828,921
↓
part 73
```

几乎没有计算成本。

---

## 但不同视频格式不能全部用同一套 parser

这件事对：

```text
MP4 / M4V / MOV
```

最好做。

WebM 也可以通过：

```text
Cues
Cluster
```

之类结构建立索引。

MKV 可以做，但浏览器端解析复杂程度明显提高。

TS、某些损坏文件、特殊容器则可能没有那么好的随机索引。

所以架构应该允许：

```text
media_index_mode = precise
```

或者：

```text
media_index_mode = unavailable
```

不能因为一个奇怪视频无法解析关键帧，就不让文件上传。

降级：

```text
无法解析媒体索引
↓
普通 20MB 硬切
↓
仍然正常上传 Telegram
↓
以后服务器需要时再分析
```

---

## 这也会改变我之前对你第 2 点的建议

你原来的：

> 在视频文件上传阶段分片时为截取片段的收尾选取合适的关键帧，以提取到的两个关键帧所在的字节位置，作为分片文件的真正首尾参照点。

**如果明确“这一步由浏览器完成”，我是支持的。**

而且可以进一步准确表述成：

```text
视频上传前，浏览器先解析本地视频的容器索引和关键帧，
建立 keyframe time ↔ byte position 映射。

在满足 Telegram 单分片最大尺寸限制的前提下，
以目标分片大小附近的合适关键帧 byte position
作为相邻 Telegram 存储分片的实际字节边界。

浏览器随后直接按照这些确定好的 byte ranges
通过 File.slice() 逐片上传到服务器，
服务器收到每片后立即进入 Telegram 上传队列，
因此媒体分析不会阻塞“浏览器 → 服务器 → Telegram”的流水式上传。
```

这比我上一版方案里的“存储边界固定、关键帧只作为旁路索引”更符合你的原始设想。

我只会再加一个约束：

> **不要要求每片都严格接近 20MB，而应该设 `target size + hard max`。**

例如：

```text
target = 16MB
hard max = 20MB
```

在 16MB 附近优先找关键帧，但绝不超过 20MB。

这样既保留 Telegram 上传安全余量，又能最大程度让：

```text
Telegram part 开头
≈ 视频可 seek 的关键帧位置
```

这对于你 300KiB/s 的慢速 Telegram 下载环境，确实有实际意义。



