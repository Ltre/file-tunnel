# dev-260815 私人 YouTube Premium 下载

## 一、需求范围

本轮在 `dev/2608A-NEWCODE` 分支增加管理员私用的 YouTube Premium 下载能力：

- 新增受管理鉴权保护的 `/youtube-premium-dl` 页面；
- 使用与公共 SNS 下载完全分离的私人 YouTube Premium Cookie；
- 支持默认和自定义两种抓取方案；
- 自定义模式展示等效于 `yt-dlp -F` 的结构化格式列表，并预选现有默认方案实际命中的 format ID；
- 支持“以音乐形式下载”，对普通 YouTube 视频也可强制生成带元数据和方形封面的 M4A；
- 音乐继续使用现有音频选择、元数据、方形封面和 M4A 写入流程；
- 视频继续使用现有视频/音频选择、下载及 ffmpeg 合并流程；
- 私人任务与普通隧道记录隔离，持久保存、分页展示，并提供进度、取消、成品下载、清除成品、重新抓取和完全删除；
- 浏览器扩展可按服务器选择是否把 YouTube 登录态同步为私人 Premium Cookie。

## 二、工程判断与边界

### 2.1 复用现有下载能力

没有复制第二套 yt-dlp 下载器。公共 SNS 与私人页面继续共用以下底层能力：

- URL 与媒体类型识别；
- `getYtDlpAudioFormatSelector()` 音频默认选择；
- `getYtDlpFormatSelector()` 视频默认选择；
- yt-dlp 进度解析；
- ffmpeg/ffprobe 调用；
- 音乐元数据、文件名、封面裁剪及嵌入逻辑。

私人功能仅通过显式的 `cookiePath`、`formatSelector`、输出上限及取消信号参数注入不同凭据和任务配置。公共 SNS 调用未提供这些参数时保持原行为。

### 2.2 Cookie 隔离

- 公共 YouTube/YT Music：`.tunnel-data/yt-cookies.txt`；
- 私人 YouTube Premium：`.tunnel-data/yt-premium-cookies.txt`。

私人 Cookie 不属于 `SNS_COOKIE_FILES`，不会被公共下载隐式读取。受管理鉴权保护的 `GET /api/sns-cookies` 会返回私人凭据内容供管理输入框核对和覆盖；扩展同步响应、私人任务 JSON、任务 API、下载页面、日志及简化错误中均不写入 Cookie 内容或真实 Cookie 路径。

### 2.3 私人任务隔离

- 历史索引：`.tunnel-data/youtube-premium-tasks.json`；
- 输出目录：`.tunnel-data/youtube-premium-downloads/<taskId>/`；
- 不写入普通隧道历史；
- 不注册为 Telegram/SNS server asset；
- 不自动向在线设备广播或参与 P2P 文件供源。

默认并发数为 1，避免多个 yt-dlp/ffmpeg 私人任务同时挤占服务器资源。可通过 `YOUTUBE_PREMIUM_DOWNLOAD_CONCURRENCY` 调整。

### 2.4 自定义格式校验

服务端重新获取最新格式列表后再校验客户端提交的 format ID，不能只信任页面状态。允许：

- 单独一个纯音频格式；
- 单独一个纯视频格式；
- 一个已经包含音视频的完整格式；
- 一个纯视频格式加一个纯音频格式。

拒绝空选择、超过两个格式、失效 format ID、两个视频或两个音频等冲突组合。单独选择纯音频或纯视频时，页面以黄色建议文字提示成品缺少另一条轨道，但不会阻止任务；视频与音频组合会按编码兼容性给出 MP4 或 MKV 输出建议。

勾选“以音乐形式下载”后，服务端会强制使用音乐处理链路。自动选轨优先使用最高码率 M4A；只要最高 M4A 高于 `136 kbps` 就选择它，当最高 M4A 处于 `120–136 kbps` 的 128K 档或更低时改选最高码率 Opus；没有 Opus 时回退到最高 M4A，再回退到其他纯音频格式。同类格式按音频码率、采样率、总码率和文件大小排序，不依赖固定 format ID。页面禁用纯视频及音视频混合格式，服务端也只接受一个纯音频编号。歌曲名优先使用媒体标题，艺术家和专辑缺失时依次使用创作者、频道或上传者等可用信息，年份缺失时回退到上传年份；视频缩略图作为歌曲封面，经方形裁剪后嵌入最终 M4A。

自定义页面只对 URL 执行一次格式解析。切换“以音乐形式下载”时复用内存中的同一份格式列表，并原地更新现有 checkbox：勾选后即时切换到最高音质纯音频编号，取消后恢复原默认方案；列表 DOM 不会重建，也不会重复运行 yt-dlp。

### 2.5 任务恢复语义

页面刷新或重新进入时会读取服务端当前任务状态和进度，运行中的任务继续显示。Node.js 进程重启后无法恢复已终止的 yt-dlp 子进程，因此启动时会把遗留的运行态任务标记为“服务重启，未完成的任务已中断”，保留历史记录供管理员重新抓取。

页面中的“缓存”指服务器输出目录中的任务成品，不是浏览器 IndexedDB/OPFS 缓存。“清除缓存”仅删除服务端成品并保留任务记录；成品存在时不显示“重新抓取”，清除成品或任务失败后才交替显示“重新抓取”。重新抓取会使用该任务原有 URL、方案、格式和音乐模式重新排队；“完全删除”同时删除服务端成品和任务历史。运行中的任务必须先取消，不能直接执行上述破坏性操作。

重新抓取提交后，页面立即显示提交结果，并在任务卡内持续区分等待下载槽位、解析链接与格式、抓取媒体、ffmpeg 合并、写入元数据和封面等阶段；下载量、总量、速度及剩余时间仍随任务进度更新。

## 三、服务端改动

### 3.1 私人任务服务

新增 `server/youtube-premium.js`，负责：

- yt-dlp 格式数据归一化；
- 默认实际 format ID 提取；
- 自定义格式组合校验；
- 私人任务排队、串行执行和取消；
- 私人任务成品清理、原配置重新抓取及任务完全删除；
- 任务历史原子写入、倒序分页及重启状态修复；
- API 输出字段白名单；
- 成品和封面文件的目录边界检查。

### 3.2 管理接口

新增并统一使用 `adminAuth.requireAuth`：

- `POST /api/youtube-premium/cookies`：保存或清空私人 Cookie；
- `POST /api/youtube-premium/formats`：解析格式并返回默认勾选结果；
- `GET /api/youtube-premium/tasks`：分页读取任务；
- `GET /api/youtube-premium/tasks/:taskId`：读取单任务；
- `POST /api/youtube-premium/tasks`：创建任务；
- `POST /api/youtube-premium/tasks/:taskId/cancel`：取消任务；
- `POST /api/youtube-premium/tasks/:taskId/clear`：删除服务端成品并保留任务记录；
- `POST /api/youtube-premium/tasks/:taskId/retry`：按原任务配置重新抓取；
- `DELETE /api/youtube-premium/tasks/:taskId`：删除任务记录及服务端成品；
- `GET /api/youtube-premium/tasks/:taskId/file`：下载完成文件；
- `GET /api/youtube-premium/tasks/:taskId/cover`：读取本地任务封面。

格式解析与任务创建额外使用独立速率限制。无效 URL、无效组合及私人 Cookie 缺失会在服务端拒绝。

### 3.3 现有 yt-dlp 封装扩展

现有调用增加可选参数，但保留缺省行为：

- 私人 Cookie 路径；
- 自定义 format selector；
- 自定义合并容器；
- 可取消信号；
- 可选文件大小上限；
- 下载、合并、元数据阶段回调。

私人格式分析禁用公共元数据扫描使用的“忽略无格式错误”回退，避免 Cookie 失效被误报成格式组合错误。

## 四、管理页面

### 4.1 `/sns-cookies`

新增“私人 YouTube Premium”配置区：

- 输入框回显服务端当前保存的完整 Cookie；
- 保存后重新读取并显示已落盘内容；
- 页面同步显示配置状态、大小和更新时间；
- 清空操作需二次确认；
- 与公共 YouTube/YT Music 输入框明确分区。

### 4.2 `/youtube-premium-dl`

新增响应式私人任务页：

- URL 输入与默认/自定义分段选择；
- “以音乐形式下载”选项及音乐格式约束；
- 自定义格式自动解析及手动重试；
- 格式类型、容器、分辨率、FPS、编码、码率、采样率、大小、协议和说明；
- 默认 format ID 自动勾选；
- 最终格式、视频、音频和输出容器摘要；
- 音乐模式下非纯音频格式整行及 checkbox 灰显并禁止选择；
- 任务状态、进度、速度、剩余时间、输出信息、取消、下载、清除缓存、重新抓取和完全删除；
- 新建任务后按服务端任务 ID 自动滚动并聚焦对应任务卡，以醒目颜色框标记 2 秒；
- 每页 10 条的倒序分页；
- 每 2 秒刷新可见页面的任务状态。

`/admin` 的扩展配置区域增加入口，并补充换行布局，防止窄屏按钮溢出。

## 五、浏览器扩展

`tools/auto-sync-sns-cookies` 的每台服务器配置新增：

- “同时同步为私人 YouTube Premium Cookie”复选框；
- 默认关闭，避免升级后无意覆盖私人凭据；
- 导入/导出 Base64 配置时保留该选项；
- 仅勾选时才在既有批量同步请求中附加 `youtubePremium`；
- 同一请求继续由该服务器独立的 Bearer 同步密钥鉴权；
- Chrome、Firefox Windows、Firefox Android 共用同一业务实现。

已运行 `npm run build:sns-cookie-extension`，把 Chrome 维护源同步到两个 Firefox 目录。

### 5.1 私人 Cookie 同步回归修复

- 修复勾选私人 Premium 同步但本轮未识别到 YouTube 登录 Cookie 时，扩展静默省略私人凭据、整次操作却仍显示成功的问题；
- 要求服务端明确回执私人 Cookie 已配置，否则扩展报告服务器未升级或未完成保存；
- 同步摘要增加“私人 Premium x/y 台”，便于直接核对每台目标服务器；
- Cookie 去重哈希纳入逐服务器私人同步策略，修改勾选状态后不会被“Cookie 内容未变化”误判为无需同步；
- 增加前台设置页与后台 Service Worker 的协议版本检查，并将三套扩展版本统一升级为 `1.5.0`，避免热更新目录后出现新界面配旧后台；
- 私人同步开启但浏览器没有有效 YouTube 登录 Cookie 时给出明确错误，不再悄悄跳过。

## 六、发布构建

- 发布构建自动复制新 HTML 和 `server/youtube-premium.js`；
- 校验器把 `/sns-cookies`、`/youtube-premium-dl` 识别为动态管理路由，不误判为静态文件缺失；
- 私人管理页不加入 PWA App Shell，避免 Service Worker 预缓存管理鉴权跳转结果；
- 补齐既有构建脚本遗漏的 `client/cache-store.js`，使首页不再引用未压缩源码路径。

## 七、验证记录

已完成：

- `node --check server.js`；
- `node --check server/youtube-premium.js`；
- `npm run test:youtube-premium`：6 项通过（含扩展 Premium 请求体与服务端确认行为测试）；
- `npm run test:p2p:unit`：38 项通过；
- `npm run build:sns-cookie-extension`；
- `npm run deploy:build -- --profile txsl`；
- `npm run deploy:verify -- --profile txsl`；
- `git diff --check`；
- 新增及修改文本文件 LF 行尾检查。

测试没有执行真实 yt-dlp 下载，也没有读取、覆盖或删除 `.tunnel-data` 中的现有 Cookie。由于当前 Windows 权限策略拒绝启动临时本地静态服务器，本轮没有完成真实浏览器截图；页面 DOM、内嵌脚本、响应式 CSS及构建后产物已完成静态检查。

## 八、主要文件

- `server.js`
- `server/youtube-premium.js`
- `pages/admin.html`
- `pages/sns-cookies.html`
- `pages/youtube-premium-dl.html`
- `tests/youtube-premium.test.cjs`
- `tools/auto-sync-sns-cookies/{chrome,firefox-windows,firefox-android}/`
- `tools/auto-sync-sns-cookies/README.zh-CN.md`
- `tools/deploy/build.mjs`
- `tools/deploy/verify.mjs`
- `docs/guide/Drop2Tunnel-Deployment-Guide.zh-CN.md`

## 九、任务恢复、默认画质、预览与转发补充

### 9.1 页面关闭与中断恢复

- 创建任务请求启用 `keepalive`，服务端在返回任务 ID 前已将任务原子写入 `youtube-premium-tasks.json`；关闭下载页不会取消已进入服务端队列或正在运行的 yt-dlp 任务。
- 页面重新打开后继续按服务端任务 ID 读取状态。Node.js 意外重启时，遗留的等待中、解析中、下载中、合并中和元数据处理任务会自动重置为等待中并重新排队，不再直接标记为永久失败。
- 成品下载端点使用稳定 URL、ETag、`Accept-Ranges: bytes` 与私有可重验证缓存策略。浏览器下载过程中关闭页面不会删除服务端成品；浏览器下载管理器可继续传输，或在重新打开页面后从同一入口继续/重新获取。
- 未额外把整个成品复制进页面 IndexedDB/OPFS。服务端成品会一直保留到管理员主动执行“清除缓存”或“完全删除”，避免为了断点保障再占用一份浏览器空间。

### 9.2 默认视频轨选择

- 默认模式与实际下载统一使用同一个确定后的 format selector，不再在执行下载时重新套用旧选择器。
- 优先选择 1080p AVC 中码率最高的纯视频轨。
- 没有 1080p AVC 时，在最高 1440p 范围内从 AV1/VP9 轨道中按分辨率、码率、FPS 和文件大小择优；仍不可用时才依次降级到较低分辨率 AVC 和其他视频轨。
- 音频轨继续复用既有默认音频策略，最终容器按实际音视频编码组合选择 MP4 或 MKV。

### 9.3 成品预览

- 已完成任务增加“预览”按钮，视频使用原生视频控件，音乐使用封面和原生音频控件。
- 预览与下载复用同一个 Range 文件端点；预览使用内联响应，不生成额外文件副本。
- 预览关闭时立即暂停媒体并释放元素 URL，避免最小化浮层后继续占用网络和解码资源。

### 9.4 转发到隧道

- 已完成任务增加“发到隧道”按钮；目标列表复用管理员会话接口，并优先选中上次转发目标。
- 服务端把 Premium 成品以硬链接登记为现有 server asset；文件系统不支持硬链接时才回退复制。
- 转发记录复用现有隧道历史写入、在线设备广播、server asset 拉取及客户端成为供源端的流程，不修改 P2P/Socket.IO 链路策略。
- Premium 转发资产不会在首台客户端确认缓存后立即删除服务端副本，保证其他设备及后续恢复仍有来源。

### 9.5 本轮验证

- `node --check server.js`、`node --check server/youtube-premium.js` 通过；
- `npm run test:youtube-premium`：8 项通过；
- `npm run test:p2p:unit`：38 项通过；
- `npm run deploy:build -- --profile txsl` 与 `npm run deploy:verify -- --profile txsl` 通过；
- 桌面端与 375px 移动端浏览器检查通过，无横向溢出，预览和转发浮层尺寸正常；
- 没有执行真实 yt-dlp 下载，也没有读取、修改或删除 `.tunnel-data` 中的 Cookie。

### 9.6 下载按钮语义修正

- 任务页无法可靠读取浏览器下载管理器中是否保留了可续传的临时文件，因此不再以“下载 / 继续下载”混合文案暗示客户端已确认断点状态。
- 成品按钮统一显示为“下载”；HTTP Range 与稳定 ETag 继续作为服务端能力保留，实际断点恢复由浏览器下载管理器处理。

### 9.7 默认视频轨优先级调整

- 本节替代 9.2 中原有的“1080P AVC 优先”策略。
- 默认视频轨以画面短边为分辨率档位，最高选择到 1440P；按档位从高到低降级，同一档位优先 AV1/VP9，再选择 AVC，2160P 不参与候选或兜底。
- 实际顺序为：1440P AV1/VP9、1080P AV1/VP9、1080P AVC、720P AV1/VP9、720P AVC，并按相同规则继续向较低档位降级。1440P AVC 不会抢占 1080P 档位。
- 同档位、同编码组内继续按视频码率、FPS 和文件大小择优；音乐音轨、自定义格式选择及下载执行流程保持不变。
- 4K 及更高分辨率媒体编号仍完整保留在自定义格式列表中并允许手动选择；1440P 上限仅约束“默认”方案。

### 9.8 同分辨率编码优先级

- 默认视频轨在每个短边分辨率档位内按 `AV1 → VP9 → AVC` 选择，再降级到下一档分辨率；本节替代 9.7 中将 AV1/VP9 合并择优及跳过 1440P AVC 的描述。
- 同编码、同档位存在多个候选时，继续按视频码率、FPS 和文件大小择优；不会仅因 VP9 文件更大而覆盖 AV1。
- 4K 及更高分辨率仍不参与默认选择，但继续完整保留给自定义模式手动选择。

## 十、成品文件信息与隧道转发副本

### 10.1 文件信息

- 已完成且仍有服务端成品的任务增加“文件信息”按钮；点击后在独立浮层中读取最终文件，而不是仅展示下载前的媒体编号信息。
- 文件信息包含文件名、大小、MIME type、封装格式、时长、分辨率、帧率、音视频编码与码率、视频 Profile、像素格式、采样率及声道等实际可用字段。
- 音乐文件的内嵌封面流会从视频信息中排除，避免把封面尺寸误报成歌曲视频分辨率；历史已完成任务无需重新抓取即可查看。

### 10.2 转发到隧道

- 转发时从 Premium 服务端成品异步复制出一份独立隧道资产；不使用硬链接，复制完整后才写入并广播目标隧道记录。
- 目标隧道客户端识别 `youtube-premium` 来源后，不再等待并不存在的浏览器供源设备，直接读取已经就绪的服务器副本并写入本机 IndexedDB/OPFS；缓存校验完成后继续按既有逻辑宣告为供源端。
- 此路径不会重新执行 yt-dlp，也不改变普通 Telegram/SNS server asset 的 peer-first 与原链接兜底策略。

### 10.3 原尺寸封面

- 每条 Premium 任务增加“原尺寸封面”按钮，不要求任务成品仍在服务端；点击后按该任务原 URL 和私人 Premium Cookie 独立执行 `yt-dlp --no-playlist --skip-download --write-thumbnail`。
- 不使用 `--convert-thumbnails`，保留 YouTube 返回图片的原始尺寸与格式；下载动作不会覆盖音乐任务已经裁切、内嵌的方形封面。
- 封面只写入请求专属临时目录，HTTP 下载响应结束后立即清理；页面显示获取中、成功和失败状态，并阻止同一任务重复发起请求。

## 十一、Premium 成品浏览器缓存

### 11.1 缓存策略与状态

- 下载选项区新增默认勾选的“缓存文件到浏览器”；服务端任务完成后，当前页面按任务顺序读取成品，并把响应分块交给首页同款 `Drop2TunnelCacheStore` 写入器。
- `Drop2TunnelCacheStore` 的提交结果保存在 Premium 专用 IndexedDB 中，不混入隧道的 `TunnelDB.files`；缓存驱动、完整性判断及 IndexedDB/OPFS 引用格式与功能首页保持一致，不再另建 `CacheStorage` 缓存体系。
- 任务行显示“等待缓存到浏览器”“缓存中 N%”“已缓存到浏览器”“已清除浏览器缓存”“未启用浏览器缓存”或失败详情；手动清除后写入轻量状态标记，不会被默认自动缓存立即反向覆盖。
- 每条任务按服务端完成时间与文件大小形成缓存版本。重新抓取产生新版本时会清理旧版本；浏览器主动淘汰缓存后，页面会在读取时识别并按当前选项重新排队。

### 11.2 预览、下载与转发边界

- 预览和页面“下载”在命中浏览器缓存时读取本地 Blob，不再重复访问 Premium 文件接口；未缓存或缓存已失效时才回退服务端文件 URL。
- “发到隧道”先校验当前浏览器中的完整缓存；命中时直接读取该 Blob，缺失时先从 Premium 服务端成品接口补齐浏览器缓存，再执行转发。
- 转发由浏览器上传已校验的缓存副本。服务端按任务完成版本和文件大小校验上传流，写入新的独立隧道资产后再创建记录；不再从 Premium 成品路径做服务器内部复制，不使用硬链接，也不会再次执行 yt-dlp。
- Nginx 部署模板同步设置 `client_max_body_size 1g`，避免反代环境按默认小请求体限制拦截浏览器缓存副本上传。
