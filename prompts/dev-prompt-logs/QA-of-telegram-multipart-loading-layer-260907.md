问：

    目前网盘所有文件都是以最大20MB分片储存在telegram托管文件频道，需要时就获取所有分片到服务器拼接成一个文件后输出到客户端。我觉得效率太低。

    网盘文件如果要对外部加载引用提供支持，比如提供在线视频播放、音乐播放、图片预览。要考虑到大文件快速预览，考虑给视频m3u8支持，视频拖动哪个进度，就从后台拉取对应文件分片，然后再进过m3u8程序更精细切割处理，达到用户拖动进度条快速响应的效果。

    你看看这个实现的可行性如何？还是说你有更好的快速加载文件方案？
    目前就只有单机服务器，也不可能扩展，系统也只对外少数几个人用，但也要让文件加载预览看起来很快，否则就连少数的几个人都不会去用
    
    
    
    
    
答：


你的思路是可行的，但我不建议把“每次预览都先完整拼接原文件”继续当主路径。更合适的是把网盘的读取层改成可随机访问的逻辑文件流：客户端请求某个字节范围/播放时间点时，服务端只拉对应 Telegram 分片，必要时做很小范围的转码或切片，再立即回传；HLS/m3u8 可以作为视频层的一种适配，而不是所有文件统一依赖它。

可行，但我会把你的方案稍微换一个层次：**不要把“m3u8/HLS”当成解决 Telegram 分片低效问题的基础层，先把“分片文件”做成一个支持随机读取的虚拟文件，再让视频 HLS 建在它上面。**

你现在真正低效的地方是：

```text
客户端要文件
→ Telegram 拉 chunk 1
→ 拉 chunk 2
→ ...
→ 拉完全部 chunk
→ 服务器拼成完整文件
→ 才开始输出
```

对于 1GB 视频，哪怕用户只想看第 10 秒，这个流程也要把 1GB 全部拉回来，确实不可接受。

我更建议改成：

```text
Telegram 20MB 分片
        ↓
Virtual File / Range Gateway
        ↓
HTTP Range 随机读取逻辑文件
        ↓
 ┌──────────┬────────────┬───────────┐
 图片预览    音乐播放      视频播放
             Range         Range / HLS
```

### 1. 最应该优先实现的是“逻辑文件 HTTP Range”

你的索引本来就已经知道：

```text
file_id = F001
size = 1GB

chunk 0 = bytes 0 ~ 20MB-1
chunk 1 = bytes 20MB ~ 40MB-1
chunk 2 = ...
...
```

那么对客户端提供：

```http
GET /disk/media/F001
Range: bytes=314572800-315621375
```

服务器直接算出：

```text
请求 300MB 附近
→ 对应 Telegram chunk 15
→ 只取得 chunk 15
→ 截取客户端真正需要的部分
→ HTTP 206 Partial Content 返回
```

而不是拼完整文件。

需要正确支持：

```http
Accept-Ranges: bytes
Content-Range: bytes START-END/TOTAL
Content-Length: ...
206 Partial Content
```

这样浏览器自己的 `<video>`、`<audio>` 对支持的媒体格式就可以直接拖进度条。

这条实际上比 HLS 更重要。

---

### 2. 视频不要一开始全部强制转 HLS

例如一个正常的：

```text
MP4
H.264
AAC
```

浏览器本来就能非常好地播放。

如果你的 `/media/:id` 支持 Range，那么用户拖到 47:30：

```text
浏览器发 Range
    ↓
服务器定位逻辑字节位置
    ↓
只拉相关 Telegram 分片
    ↓
直接开始播放
```

这种文件没必要：

```text
Telegram
→ 拼装
→ ffmpeg
→ HLS
→ 浏览器
```

否则反而多了一层 CPU、延迟和临时文件。

所以第一层策略应该是：

> **浏览器原生支持的容器/编码：直接 Range Streaming。**

---

### 3. HLS 用在真正需要它的视频上

你提出的：

> 拖到某个时间 → 拉对应 Telegram 分片 → m3u8 更精细切割

方向对，但这里有个技术问题：

**播放时间不能简单换算成文件字节位置。**

不能认为：

```text
1 小时视频
拖到 30 分钟
≈ 文件大小的 50%
```

因为：

* VBR 可变码率；
* MP4/MKV 容器结构；
* I/P/B Frame；
* keyframe；
* 音视频轨交错；

都会导致“时间位置”和“字节位置”不是简单线性关系。

因此 HLS 层应该是：

```text
HLS Player
  ↓
请求 37:30 附近 segment
  ↓
媒体索引知道该时间对应什么位置
  ↓
ffmpeg 访问 Virtual File
  ↓
Virtual File 发起 Range
  ↓
Range Gateway 找出需要哪些 Telegram chunks
  ↓
只下载这些 chunks
  ↓
ffmpeg 产生几秒钟的 HLS segment
  ↓
立即返回
```

也就是说：

**FFmpeg 不需要知道 Telegram 分片。**

它只需要认为自己面对的是一个正常、支持 Range 的大文件。

这样架构会干净很多。

---

### 4. 这里最值得做的是本地“分片 LRU Cache”

你只有一台服务器、用户也很少，这反而特别适合用缓存换体验。

例如：

```text
Telegram
    ↓
20MB chunk cache
    ↓
/var/cache/drop2tunnel/disk/
```

假设用户第一次拖到 38 分钟：

```text
需要 chunk 54
→ Telegram 下载
→ 本地缓存 chunk 54
→ 播放
```

接着拖到 38:20：

```text
仍然需要 chunk 54
→ 本地直接读取
→ 几乎立即响应
```

然后后台预取：

```text
chunk 53
chunk 54  ← 当前
chunk 55
chunk 56
```

顺序播放时则：

```text
正在播放 chunk 10
       ↓
后台预取 chunk 11
       ↓
快用完时预取 chunk 12
```

这对你的规模特别有效。

根本没必要 CDN，也没必要多服务器。

建议同时做：

```text
LRU
最大例如 10GB / 20GB / 50GB
+
TTL
+
并发下载去重
```

同一时刻两个人请求 chunk 38：

```text
不能 Telegram 下载两份
```

应该：

```text
chunk 38 = downloading
        ↓
两个请求共同等待同一个 Promise/Job
```

---

### 5. 甚至不应该每次把 20MB 全部下载完成后才开始响应

Telegram 官方 Bot API 的 `getFile` 下载目前仍限定单文件最大 20MB，正好与你现在的分片设计吻合。([Telegram API][1])

服务器拉某个 20MB Telegram 分片时，应该尽量：

```text
Telegram HTTP response
      ↓ streaming
本地 cache file
      +
播放器响应
```

边收边写缓存、边输出。

不要：

```text
20MB 完整下载
→ close()
→ 再打开
→ 再发给浏览器
```

这又能减少一点首包等待。

当然，如果客户端请求的是 chunk 中间某一段，而 Telegram 下载端不能可靠按 Range 获取，那么前面的数据仍可能需要先读掉。这也是为什么本地 chunk cache 很重要。

---

## 图片和音乐其实不需要 HLS

图片：

```text
小图
→ 直接拉完整文件

超大图片
→ 首次生成 preview / thumbnail
→ 缓存小尺寸预览
→ 用户点击“查看原图”才访问原文件
```

比如上传一个 80MB PNG，列表和全屏预览根本没必要每次加载 80MB。

第一次生成：

```text
original
thumbnail-320
preview-1920
```

以后：

```text
目录缩略图 → thumbnail
普通全屏预览 → preview
下载/查看原始图 → original
```

这会比研究 PNG/JPEG 的随机加载有意义得多。

音乐：

```text
MP3 / M4A / AAC / OGG / FLAC
```

浏览器支持的直接走：

```text
HTTP Range
```

拖播放位置也是 Range。

不需要 HLS。

---

# 视频建议最终做成两级策略

### A. Direct Streaming

优先使用：

```text
Virtual File
+
HTTP Range
```

适用于浏览器原生支持的：

```text
MP4 H.264/AAC
WebM
部分 M4V/MOV
...
```

优点：

* 几乎不吃 CPU；
* 不需要完整文件；
* 不需要预转码；
* 不生成大量小文件；
* seek 很快。

### B. On-demand HLS

浏览器不适合直接播放的：

```text
MKV
某些 HEVC
特殊音频编码
不兼容容器
```

再走：

```text
Virtual Range File
       ↓
ffmpeg
       ↓
HLS 4~6 秒 segment
       ↓
播放器
```

HLS 本身就是由媒体 segment 组成；HLS 标准也支持 media segment 通过 byte range 表示。([IETF Datatracker][2])

生成出来的 HLS segment 同样放服务器缓存：

```text
/cache/hls/F001/
    index.m3u8
    segment-000123.m4s
    segment-000124.m4s
```

第二次看同一位置：

```text
不用 Telegram
不用 ffmpeg
直接读取 segment
```

---

# 我甚至建议你在上传时顺手保存“媒体索引”

既然文件上传时本来就经过你的服务器，可以顺便取得：

```text
duration
container
video codec
audio codec
resolution
bitrate
keyframe/index 信息
```

存进 SQLite。

例如：

```json
{
  "duration": 7412.38,
  "container": "mp4",
  "video_codec": "h264",
  "audio_codec": "aac",
  "streamable": true
}
```

以后用户点视频：

```text
streamable=true
→ Range direct

streamable=false
→ HLS
```

就不用每次打开时重新探测。

如果能进一步保存关键帧时间/字节位置，那么 HLS seek 会更快。

---

# 还有一个很重要的优化：不要执着于所有分片都必须 20MB

你的定义实际上应该是：

> **每片最大 20MB**

而不是：

> **每片必须正好 20MB**

如果以后实测 Telegram 单片下载延迟成为 seek 的主要瓶颈，可以让：

```text
普通文件：
20MB

视频：
8~20MB

或者：
根据文件大小动态选择
```

不过我暂时不会第一版就这么做。

因为：

```text
20MB chunk
+ Range Gateway
+ 本地 LRU cache
+ prefetch
```

大概率已经能达到你“少数用户觉得很快”的要求。

再继续切到 4MB，Telegram message 数量会暴涨。

---

# 所以我认为比你原始方案更好的完整路径是

```text
                   Telegram
                 20MB chunks
                      │
                      ▼
            ┌──────────────────┐
            │ Chunk Cache      │
            │ 本地 LRU         │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │ Virtual File     │
            │ Random Access    │
            │ HTTP Range 206   │
            └────────┬─────────┘
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
     图片           音乐           视频
       │             │             │
 thumbnail       HTTP Range   能直接播？
 preview             │          │      │
                     │         YES     NO
                     │          │      │
                     │        Range   FFmpeg
                     │                 │
                     │              HLS Cache
                     │                 │
                     └────────────┬────┘
                                  ▼
                               Client
```

**我会优先做 Range Gateway，而不是优先做 m3u8。**

你现在“全部 Telegram 分片 → 完整拼接 → 输出”的模式，真正缺少的是**随机访问抽象**。一旦这一层做好，音乐在线播放、大视频拖动、下载断点续传、第三方 `<video src>` 引用、甚至以后 WebDAV 都会一起受益。

HLS 只应该负责：

> **那些浏览器不能直接高效播放的视频。**

而不是承担“Telegram 分片随机访问”的基础职责。

对于你这种**单机服务器 + 少量用户**的实际规模，我认为“Range + 10～几十 GB 本地 LRU chunk cache + 相邻分片预取 + 必要时 HLS”已经足够做到体感很快，没必要引入 CDN、对象存储集群或者复杂的分布式缓存。

[1]: https://core.telegram.org/bots/api?utm_source=chatgpt.com "Telegram Bot API"
[2]: https://datatracker.ietf.org/doc/html/rfc8216.html?utm_source=chatgpt.com "RFC 8216 - HTTP Live Streaming"





------------------------------------------------------------------------------------------------




问：



    视频文件分片目前不知道是硬切割还是有一定的分片可播放逻辑处理（简单说就是有没有给每个视频分片加个让分片可播放的视频头），我猜是硬切割的。你可以先看看分支dev/2608C-step2的代码。
    我不知道用m3u8播放视频微小片段是否要考虑加入视频头信息的问题

    你提到"播放时间不能简单换算成文件字节位置"，那能不能考虑在上传视频文件阶段，就给每个分片记录其真正的开始/结束播放时间？

    我还考虑到实际服务器拉取telegram分片文件速度很慢（300KiB/s），是否考虑今后再把分片且更小一点，比如5MB一片？我看你还提到"服务器拉某个20MB telegram分片时应该尽量边收边写缓存边输出"?意思是从telegram拉分片未完成的情况下能做到在服务器读取已经下载好的一部分了吗？如果真的完全可行且不影响效率的话，那也可以先不考虑把分片大小从20MB降到5MB。
    
    
    



答：


我先看 dev/2608C-step2 里网盘分片上传/下载的实际实现，重点确认三件事：是不是纯字节硬切、分片有没有单独可播放处理、下载时是不是必须整片落完后才开始给客户端。然后再结合这个现状判断“上传阶段记录真实播放时间”和“20MB 是否需要降到 5MB”。

代码已经能回答你第一个和第三个疑问：当前 dev/2608C-step2 的 Telegram 分片是纯字节硬切，没有给每个视频分片做可播放封装；但下载链路也并不是“全部分片先落盘拼完整文件再输出”，而是逐分片流式串接，当前分片从 Telegram 一边收到，服务端就已经可以一边往客户端 pipeline 输出。

我再补看一下预览/下载路由是否都走这条流式链，再给你判断 20MB 是否真的有必要降到 5MB，以及时间索引应该怎么记录才最有效。

我看了 `dev/2608C-step2`，你猜得对：**现在的视频分片就是纯字节硬切，没有任何“让每个分片自身可播放”的媒体处理。**

`server/disk-limits.js` 把单片固定为 `20_000_000` 字节；`server/disk-telegram.js` 直接按 `start = index * MAX_TELEGRAM_PART_SIZE`、`end = start + size - 1` 从原文件读取对应字节。只要文件被拆成多片，上传到 Telegram 时 MIME 也直接改成 `application/octet-stream`。这里没有 ffmpeg、关键帧切割、MP4 header 重建之类的操作。

所以目前的：

```text
video.mp4

part01 = 原文件 bytes 0 ~ 19,999,999
part02 = 原文件 bytes 20,000,000 ~ 39,999,999
part03 = ...
```

只是把这些文件作为 Telegram document 存起来。多个分片确实会通过 `sendMediaGroup` 尽量组织成 Telegram Album，但这只是频道展示层的聚合，与视频格式本身无关。

### 关于你说的“m3u8 微小片段是否需要视频头”

需要考虑，但**不要给现有 Telegram 20MB 存储分片补视频头**。

这两种东西应该分清楚：

```text
Telegram storage chunk
= 原文件的纯字节块
= 用于无损还原原文件

HLS segment
= 真正符合 HLS 规范的媒体片段
= 用于播放
```

不能直接：

```text
part37.bin
→ 改名 37.ts
→ 写进 m3u8
```

这样通常不能播放。

如果用 MPEG-TS HLS，每个 segment 要有足够的流初始化信息，规范要求 TS segment 有 PAT/PMT，而且 H.264 segment 为了高效独立解码最好从 IDR 关键帧附近开始。

如果使用现在更适合的 fragmented MP4：

```text
init.mp4
segment001.m4s
segment002.m4s
...
```

则 `init.mp4` 提供初始化信息，而每个 `.m4s` 是合法的 `moof + mdat` fragment。FFmpeg 本身就支持 `hls_segment_type fmp4` 并生成独立的 init 文件。([FFmpeg][1])

所以以后应该：

```text
Telegram 硬分片
      ↓
虚拟原文件读取层
      ↓
FFmpeg
      ↓
init.mp4 + 几秒一个的 m4s
      ↓
m3u8
```

而不是修改 Telegram 存储格式。

---

## 你提出“上传时记录每个分片真正对应的播放时间”，方向是对的，但建议再进一步

**可以在上传阶段做，而且上传阶段恰恰是做这件事成本最低的时候**，因为这时完整原文件就在服务器上。

不过我不建议只给每个分片保存：

```text
part 12
start_time = 13:24
end_time   = 14:03
```

因为它不是绝对准确的一一对应关系。

一个 MP4 里面可能有：

```text
视频 packet
音频 packet
字幕 packet
moov
mdat
索引
```

互相交错，而且 20MB 边界甚至可能正好切在一个 packet/box 中间。

更适合保存的是**媒体 Seek Index**，例如：

```text
文件：
duration = 7200.52
container = mp4
video_codec = h264
audio_codec = aac

part 17：
byte_start = 320000000
byte_end   = 339999999

media_time_min ≈ 1523.42
media_time_max ≈ 1617.84

first_keyframe:
    time = 1528.06
    byte_pos = 321733844

last_keyframe:
    time = 1613.18
    byte_pos = 338411220
```

甚至文件级直接保存：

```text
keyframes:
00:00:00.000 → byte 123456
00:00:04.120 → byte 873123
00:00:08.240 → byte 1649823
...
```

这样用户拖到：

```text
01:37:35
```

服务端不是计算：

```text
97.58 / 120分钟 × 文件大小
```

而是查：

```text
01:37:35
↓
前一个可用 keyframe = 01:37:32.480
↓
byte_pos = 783,412,992
↓
对应 Telegram part 40
```

然后优先取 part 40，必要时再取 part 39/41。

这比给每个 20MB part 硬定义一个“开始时间/结束时间”准确得多。

而且 FFmpeg/ffprobe 本身就可以提前取得 packet 的时间戳、关键帧和 byte position。

---

## 更重要的一点：你现在其实已经实现了“边从 Telegram 下载，边往客户端输出”

这个我看代码后可以明确告诉你：

**完全可行，而且你现在的代码实际上已经这么干了。**

`readPart()`：

```text
fetch Telegram file URL
↓
拿到 response.body
↓
Readable.fromWeb(response.body)
```

它没有：

```text
await 全部 20MB
↓
fs.writeFile()
↓
再读取
```

而是拿到 Telegram HTTP body 后直接变成 Node Stream。

然后 `telegram.read()` 是：

```text
part 1 stream
→ yield chunk
→ part 2 stream
→ yield chunk
→ part 3 stream
...
```

所以当前某个 20MB Telegram part **还没下载完成时，已经收到的前几百 KB 就可以继续向下游输出**。

`disk-api.js` 的下载接口又直接：

```text
telegram.read()
    ↓
Transform 统计进度
    ↓
pipeline()
    ↓
HTTP response
```

因此普通网盘下载已经是：

```text
Telegram
→ Node stream
→ Browser
```

不是：

```text
Telegram
→ 下载完整文件到服务器
→ 拼接
→ Browser
```

这一点比我们之前假设的现状好很多。

### 但是目前有一个关键缺口

现在 `telegram.read()` 永远：

```text
part 1
→ part 2
→ part 3
→ ...
```

**还不支持从指定 part / 指定 byte range 开始读取。**

所以对于在线视频：

```text
用户拖到 70%
```

当前架构仍然不能：

```text
直接跳到 part 36
```

而会从 part 1 开始。

真正下一步应该加的是：

```text
telegram.readRange(item, startByte, endByte)
```

或者更上一层：

```text
VirtualFile.read(start, end)
```

它自动算：

```text
startPart = floor(start / 20MB)
endPart   = floor(end / 20MB)
```

只访问所需分片。

---

# 那么 20MB 要不要降到 5MB？

我的建议现在变得很明确：

**先不要改成 5MB。**

先实现：

```text
1. 媒体索引
2. Virtual File / Range 读取
3. Telegram chunk 本地缓存
4. 相邻 chunk 预取
5. HLS 按需生成
```

然后再测。

因为“边下载边输出”意味着，假设播放器真正需要的是一个 part 开头的数据：

```text
20MB part
Telegram 300KiB/s
```

并不意味着一定要等：

```text
20MB / 300KiB/s ≈ 65 秒
```

才能看到东西。

例如 Telegram 返回：

```text
0.1s → 30KB
0.5s → 150KB
1s   → 300KB
```

这 300KB 马上就能交给 FFmpeg/客户端处理。

所以：

```text
20MB
```

本身并不等于：

```text
首播延迟 65 秒
```

---

但这里还有一个必须注意的限制。

当前代码请求 Telegram 时是：

```js
fetch(fileUrl)
```

**没有向 Telegram 发送 HTTP Range。**

而官方 Bot API 文档只承诺可以通过 `file_path` 下载这个文件，并没有承诺这个 HTTP 文件地址支持任意 Range 下载。([Telegram API][2])

所以我们不能把架构建立在：

```text
Telegram part 20MB

我只想要里面第 18~19MB
→ Telegram 只发这 1MB
```

这个假设上。

至少当前实现做不到。

因此存在一个最坏情况：

```text
真正需要的数据位于 part 内部第 18MB
Telegram 速度 300KiB/s

→ 可能仍需把前 18MB 流过来
→ 大约 60 秒
```

这才是以后把：

```text
20MB → 5MB
```

可能带来实际收益的地方。

5MB 时最坏大概变成：

```text
5MB / 300KiB/s ≈ 17秒
```

但代价也很明显：

```text
1GB：

20MB → 约 50 个 Telegram message
5MB  → 约 200 个 Telegram message
```

消息量直接四倍。

所以现在不应该为了一个**尚未实测的 seek 瓶颈**先把整个存储层变成 5MB。

---

## 还有一个比“20MB→5MB”更值得先测试的方案：并行预取

当前实现是严格顺序：

```text
part 1 下载完成
→ part 2
→ part 3
```

如果你实际测出来的 300KiB/s 是**单个 Telegram 文件 HTTP 请求的速度**，而不是服务器到 Telegram 的总带宽上限，那么可以：

```text
正在播放 part 20

同时：
part 21 下载
part 22 下载
part 23 下载
```

例如 3 个连接分别约：

```text
300KiB/s
300KiB/s
300KiB/s
```

理论聚合可能接近：

```text
900KiB/s
```

是否真的能达到要实测 Telegram 的限速维度，但很值得测试。

对于播放而言，这种：

```text
当前 part 流式播放
+
未来 2~3 part 并行预取
+
本地缓存
```

往往比把所有文件长期切成 5MB 更划算。

而且还有一个现实问题：

**300KiB/s 本身只有约 2.46Mbps。**

如果原视频是：

```text
5Mbps
8Mbps
15Mbps
```

那不管你分成 20MB 还是 5MB：

```text
Telegram 下载速度 < 视频消费速度
```

连续播放迟早还是会缓冲。

**减小分片只能改善 seek 延迟，不能提高持续吞吐量。**

真正解决连续播放，需要：

```text
并行预取
+
本地缓存
```

或者 HLS 时顺便转成一个较低码率版本，比如：

```text
源视频 8Mbps
↓
HLS 1.5~2Mbps
```

这样 300KiB/s 左右的 Telegram 输入才更容易撑住持续播放——当然首次转码仍然受原文件拉取速度制约。

---

## 所以我现在建议你把架构定成这样

```text
上传阶段
│
├─ 原文件仍按 ≤20MB 硬切
│
├─ 保证可完全无损拼回原文件
│
└─ 对视频额外运行 ffprobe
      ↓
   保存 Media Seek Index
   ├─ duration
   ├─ codec/container
   ├─ keyframe time
   ├─ keyframe byte_pos
   └─ byte → Telegram part 映射


播放阶段
│
├─ 用户拖到 01:37:35
│
├─ 查 Seek Index
│
├─ 找前一个关键帧及 byte_pos
│
├─ 定位 Telegram part
│
├─ 优先拉对应 part
│   ├─ 边下载
│   └─ 边送给处理层
│
├─ 同时预取后续 part
│
├─ 写本地 LRU cache
│
└─ FFmpeg
      ↓
   init.mp4
   +
   几秒一个 m4s
      ↓
   m3u8
```

其中 **Telegram 的 20MB part 永远只是存储分片，不要求自身能播放。**

这是我现在最推荐的方案。

至于 **20MB→5MB**，我建议放到这一套完成后的性能测试项：

> 如果“第一次跳转到一个完全未缓存的位置”仍然因为必须从 Telegram 分片头部开始读取而等待明显过久，再考虑将**视频文件**单独改成 5～10MB 分片；普通 ZIP、备份、安装包等文件完全没有必要跟着缩小。

甚至以后可以做到：

```text
普通文件：20MB
音乐：20MB
图片：20MB
视频：5~10MB
```

而不必整个网盘统一改。

所以你最后一句的判断基本成立：**既然现在已经能够真正做到“Telegram 还没下载完整个分片，就把已经收到的数据继续交给下游”，第一阶段可以先保留 20MB。真正应该优先开发的是“从指定分片开始读取 + 媒体 Seek Index + 缓存/预取”，而不是先把分片尺寸缩小四倍。**

[1]: https://ffmpeg.org/ffmpeg-formats.html?utm_source=chatgpt.com "FFmpeg Formats Documentation"
[2]: https://core.telegram.org/bots/api?utm_source=chatgpt.com "Telegram Bot API"


