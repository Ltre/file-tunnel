# SNS / YouTube Premium、音轨修复与视频转码

> **源码基线 Commit**：`059099607a7aa986d9a66ff386f5fd691c604b78`  
> **文档更新时间**：`2026-09-26`

## 子模块文档

- [SNS Cookie 管理与浏览器自动同步扩展](./download-transcode/sns-cookie-sync.md)

## 1. 模块边界

当前有三类容易被误写成一个“下载器”的功能：

1. `/sns-dl`：通用 SNS 下载中心；
2. `/youtube-premium-dl`：YouTube / YouTube Music 私人高级下载与元数据处理；
3. `/video-transcode`：独立 FFmpeg 转码任务中心。

另有：

- 音轨修正版：对 download-sections 等导致的 offset 问题重新处理成品；
- Telegram 指定目标转发；
- 转发到隧道；
- 浏览器成品缓存。

## 2. 通用 SNS 下载

服务端：

- `server/sns-downloader.js`
- 相关分析/yt-dlp helpers 在 `server.js`

页面：

- `pages/sns-dl.html`

浏览器缓存：

- `client/sns-download-cache.js`

### 2.1 平台

历史能力包括：

- TikTok；
- Facebook；
- Instagram；
- Threads；
- LINE；
- Twitter/X；
- 后来加入 Bilibili。

YouTube / YT Music 有更专门的 Premium 页面，但服务端通用 SNS 识别也可能遇到 YouTube URL，修改 platform routing 前应看当前 normalize/analyze 实现。

### 2.2 任务

任务大致记录：

- id；
- URL/platform；
- mode；
- selectedFormatIds；
- downloadSections；
- title；
- media type；
- remark/tags；
- status/progress；
- output path/name/size；
- cover；
- timestamps/error。

活动状态会进入独立 queue，Node 重启后持久化任务中的运行状态会重新入队/恢复到可执行状态。

### 2.3 模式

支持默认选择和自定义媒体 format。

Custom 最多有限数量的 format ID，避免用户拼接任意 yt-dlp 命令。

`downloadSections` 是业务字段，而不是允许客户端传 shell 字符串。

## 3. YouTube Premium

服务端：

- `server/youtube-premium.js`

页面：

- `pages/youtube-premium-dl.html`

缓存：

- `client/youtube-premium-cache.js`

### 3.1 设计初衷

独立页面是为了支持比普通 SNS 更复杂的：

- format 枚举与自定义选择；
- Premium / cookies；
- music 模式；
- song metadata；
- cover；
- Track/Disc；
- Album Artist；
- Composer/Genre；
- source language；
- download sections；
- Telegram 歌曲分享。

### 3.2 媒体格式模型

`normalizeYtDlpFormats()` 会识别：

- video；
- audio；
- video_audio；
- other；

字段包含：

- format ID；
- ext；
- codec；
- resolution；
- bitrate；
- sample rate；
- dynamic range；
- language；
- approximate size。

不能仅用文件后缀判断“有音轨/有视频”，X/Twitter 和 HLS 等历史上已经出现 yt-dlp metadata 与实际 rendition 不一致。

### 3.3 默认视频选择

当前 `getPreferredPremiumVideoFormat()` 会按分辨率和 codec 偏好选择可用 video。历史策略经历过 H.264 优先与 AV1/VP9 降级调整，当前事实必须以函数代码为准。

### 3.4 音乐模式

`asMusic=true` 时要求最终选择单一 audio format。

`getPreferredMusicAudioFormat()` 会在 M4A、Opus 等候选间按质量策略选取。

任务公开数据明确包含：

- `asMusic`
- `downloadSections`

### 3.5 Song metadata

YouTube Music 链路会处理：

- title/track；
- artist；
- album；
- album artist；
- track/disc number；
- year；
- composer；
- genre；
- cover。

一个重要语义：

> Album Artist 不能因为缺失就无条件回填歌曲 Artist。

历史修复规则：

- upstream 明确空/Various Artists/compilation → “群星”；
- 完全未知 → 可保持空；
- 只有具备足够证据时才填某个明确 album artist。

Track/Disc 也经过：

- 页面 metadata；
- album playlist；
- 搜索候选；
- ordinal enrichment

多级补全，不能用列表 index 粗暴当 Track。

## 4. Cookies

管理入口：

`/sns-cookies`

cookies 是敏感登录态，不进 Git。

历史上还有浏览器 Cookie Sync extension，支持多服务器/多平台同步。

Bilibili 后来加入 Cookie 配置，并明确 UI 提示：

> 最好使用闲置 B 站小号的 Cookie，避免大号被封。

YouTube/YT Music 的 cookies 与其它平台文件路径规则以当前 server helper 为准。

## 5. 下载任务 UI

SNS / YouTube 页面都有：

- URL；
- analyze/formats；
- create task；
- progress；
- retry/cancel/delete/clear；
- preview；
- download；
- remark/tags；
- 转发到隧道；
- Telegram target forward；
- 音轨修复（有条件）；
- 前往转码（有条件）。

自动刷新不能破坏用户正在编辑的 UI。

历史修复包括：

- remark input Focus 时暂停对应任务 UI overwrite；
- “已抓取的页面信息”展开状态不能被 refresh 收缩；
- FFmpeg output 展开状态不能被 refresh 收缩。

## 6. 指定片段

`sns-dl` 和 YouTube Premium 都已经有 `downloadSections` 概念。

对于使用 yt-dlp section download 的任务，历史上发现：

- 音频/video timestamp 可能产生 offset；
- 特别是非 M4A/AAC 音频 codec，切片首尾更可能不精确。

YouTube Premium 在“音乐模式 + 指定片段 + 非 M4A/AAC 类音频”场景要求预警用户：

> 剪切结果更可能略有 offset，无法严格吻合期望首尾。

这是 warning，不是阻止用户下载。

## 7. 音轨修正版

### 7.1 为什么存在

它不是“下载一个单独音轨”。

目标是处理部分 `yt-dlp --download-sections` 成品音视频时间轴错位。

用户后来明确预期类似：

`ffmpeg -i INPUT.mp4 OUTPUT.mp4`

让 FFmpeg 重新 decode/mux/encode 并重新对齐 timestamp。

### 7.2 当前服务

`server/audio-track-repair.js`

特点：

- 后台队列；
- API submit 立即返回 job；
- status polling；
- progress；
- 结果另存，不覆盖原文件；
- manifest/cached result；
- force 重新生成；
- cache fingerprint 防源文件变化；
- job TTL 约 6 小时；
- 输出验证 audio/video stream count；
- 错误时保留原文件。

### 7.3 按钮显示条件

历史最终收敛：

- 只有指定 `downloadSections` 的任务才有必要显示；
- `asMusic` 纯音乐任务不显示，因为输入只有音轨，无法解决“音视频 offset”；
- 完整长视频不应显示，避免用户误点后服务器长时间高负载。

因此按钮条件应同时检查任务语义，不是只检查 status=completed。

## 8. Telegram 指定目标转发

两页共享 `client/telegram-target-forward.js`。

详细见 [telegram-bot-content.md](./telegram-bot-content.md)。

从下载模块角度，关键是：

- 转发使用服务器已完成成品；
- 视频 preview 不能默认重新压缩；
- thumbnail 是独立增强；
- target history / remark 是 UI 持久配置；
- 转发失败不能把下载任务本身标成失败。

## 9. 转发到隧道

下载成品可以转为普通 Drop2Tunnel 文件记录。

应优先：

- server asset / existing cache；
- 浏览器缓存；
- 进入普通文件资产链路。

不能因为来源是 SNS，就要求其它每台设备重新跑 yt-dlp。

## 10. 视频转码中心

入口：

- `/video-transcode`
- `/video-transcode-guide.html`

服务端：

- `server/video-transcode.js`

持久文件：

- `video-transcode-profiles.json`
- `video-transcode-tasks.json`
- 独立 task 工作目录。

## 11. Profile 模型

转码不是把完整 shell command 交给用户任意执行。

Profile 是 schema driven：

- id/name/description；
- fields；
- steps；
- conditional args；
- output extension；
- name template。

系统字段：

- `INPUT_FILE`
- `ORIGINAL_INPUT_FILE`
- `OUTPUT_FILE`

允许的 output extension 当前白名单：

- mp4
- mkv
- webm
- mov
- m4v
- mp3
- m4a
- aac
- flac
- wav
- ogg

自定义 profile 经过 validate，step 必须包含合法 input 和 output placeholder。

如果自定义 Profile 没显式写 output extension，服务端会根据步骤 argv 推断默认容器：

- 出现 `libx265`、`hevc_nvenc`、`hevc_qsv`、`libsvt_hevc` → 默认 `mkv`；
- 其它情况 → 默认 `mp4`。

这个推断只决定 Profile 默认值；任务级 `outputExtension` 仍可覆盖。

## 12. 内置 H.265 Profile 当前事实

### 12.1 H.265 均衡转码

当前：

- codec：`libx265`
- CRF default：28
- PRESET default：空；
- preset 空时不发 `-preset`；
- audio：`-c:a copy`；
- Profile 默认输出扩展：**mkv**；
- nameTemplate：`${BASENAME}-h265.${EXT}`。

任务创建时页面还允许用户覆盖本次任务的输出后缀；所选值写入 task 的 `outputExtension`，最终文件名和输出路径都使用该值。

`-movflags +faststart` 仍保留在内置 Profile 参数模板里，但执行时如果最终扩展不是 MP4/MOV/M4V，会从实际 argv 中移除，避免把 MP4 系容器参数误发给 MKV 等格式。

因此默认概念命令更接近：

```text
ffmpeg -i INPUT -c:v libx265 [-crf 28] [-preset ...] -c:a copy OUTPUT.mkv
```

若用户把该任务输出覆盖成 MP4，则会重新保留 `-movflags +faststart`。

### 12.2 H.265 均衡转码并缩放

在基础上增加：

- START/END 类截取参数；
- SCALE；
- 同样 CRF/preset；
- audio copy。

该内置 Profile 的默认 output 同样是 **mkv**，nameTemplate 为 `${BASENAME}-scaled.${EXT}`，并允许任务级覆盖输出后缀。

## 13. Task 执行

### 13.1 浏览器上传输入

普通新任务：

1. create task → status uploading；
2. PUT input；
3. 校验 declared size；
4. 最大约 20 GiB；
5. start → queued；
6. 串行 consumer；
7. FFmpeg；
8. completed。

任务元数据会持久化 `outputExtension`。最终 step 使用任务选择的扩展，中间 step 当前固定使用 MKV 临时文件。

### 13.2 复用 SNS/YouTube 服务器缓存

260924 已验收通过。

下载任务的“前往转码处理”携带：

- source kind；
- source task ID；

video-transcode 页面先通过 admin-protected source API 校验。

创建 source task 时：

- 服务端定位下载成品；
- 优先 hard link 到 transcode task；
- EXDEV/权限/不支持时 copy fallback；
- 原下载成品仍属于原服务；
- 删除转码 task 不删除原下载文件。

这避免几 GB 成品先从服务器下到浏览器再上传一次。

## 14. FFmpeg 执行

`runTask()`：

- 每个 profile step 顺序执行；
- child_process spawn，`shell:false`；
- `-y`；
- stderr 保存最近 log；
- running child 用于 cancel；
- 中间 step 使用工作目录临时文件；
- 最终 step 使用 task 的 `outputExtension` 或 Profile 默认扩展；
- 如果最终容器不属于 MP4/MOV/M4V，内置 Profile 会剔除 `-movflags +faststart`；
- 最终生成 output；
- task phase / progress / log 持久化。

取消：

- 标记 cancelRequested；
- running child `SIGTERM`；
- queued/uploading 则直接 cancelled。

## 15. Task restart

服务启动时：

- uploading / queued / running 历史任务不会假装继续原 child process；
- 会转成 failed，提示 server restart interrupt。

SNS / YouTube 的任务重启策略和 video-transcode 不完全相同；不能为了统一 UI 强行让所有队列采用一种 restart 语义。

## 16. Cache management

video-transcode 提供：

- active bytes；
- finished bytes；
- orphan bytes；
- residual cleanup；
- finished cleanup。

清理 active task 目录必须禁止。

completed task cache 被清理后：

- task 历史可以保留；
- outputPath 失效；
- phase 应显示“结果缓存已清理”。

## 17. 帮助文档

`/video-transcode-guide.html` 的目标是让用户不仅会点 UI，还理解：

- Profile fields；
- placeholder；
- optional args；
- 多 step；
- output；
- input flow；
- server execution；
- FFmpeg command。

每次新增 output extension、field type、source task、step 语义，都应同步帮助文档。

## 18. 安全与资源边界

- 不接受任意 shell string；
- `shell:false`；
- filenames 清理；
- output ext 白名单；
- profile/token validate；
- 后台 admin auth；
- 高负载任务串行；
- 允许 cancel；
- cache cleanup；
- 音轨修复入口严格限定，减少误用长任务。

## 19. 相关测试

重点：

- `tests/sns-download.test.cjs`
- `tests/youtube-premium.test.cjs`
- `tests/audio-track-repair.test.cjs`
- `tests/audio-track-repair-ui.test.cjs`
- `tests/features-260916-2.test.cjs`（H.265 默认 MKV、任务级 MP4 覆盖与 faststart 条件）；
- `tests/features-260925.test.cjs`；
- 260917/260921/260922 等 feature tests。

真实 yt-dlp / ffmpeg / cookies / 网络平台会发生外部变化，因此自动 Mock 通过不等于生产一定可下载；外部依赖异常必须输出足够诊断，但不能泄露 cookies/token。
