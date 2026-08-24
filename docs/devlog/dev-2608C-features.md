# dev/2608C-step1：隧道审计与独立缓存节点

日期：2026-08-24  
分支：`dev/2608C-step1`  
状态：代码修改完成，未提交、未暂存

## 一、任务恢复与现状检查

本轮从网络中断后的工作区继续。恢复时，后台隧道统计、VClient 控制面、缓存进程和 `/vclient` 页面已经有初步实现，但复核协议路径和进程生命周期后，仍发现以下不能算“完成”的缺口：

1. 普通历史消息已入库，但 `file-asset` 直接文件协议可以绕过传输记录，导致后台少算文件和记录。
2. 富文本编辑器附件与跨隧道转发没有完整保留文件名、MIME、大小等元数据。
3. 未知记录的删除请求会生成没有原始记录的假删除留痕；晚到的普通回调又可能把已删除隧道恢复为未删除状态。
4. 老版本 `devices` 数据尚未迁移到历史成员表，历史设备数会漏掉升级前仍保留的成员。
5. VClient 文件接收在供源设备掉线或中继无后续数据时可能无限等待。
6. 新控制进程接管后，旧进程已建立的数据连接仍可能留在隧道中；管理员停止缓存节点时，如果控制进程离线，也不能保证旧数据连接立即退出。
7. 缓存文件只校验大小，同尺寸损坏文件可能被重新宣告为可用供源。
8. 浏览器会把 VClient 当作普通 WebRTC 对端发起连接，而第一阶段 VClient 只支持 Socket.IO 文件中继，会产生无效协商和超时。

因此，本轮不是只确认已有按钮，而是按“每条协议是否留痕、每种断线是否收敛、缓存内容是否可信”继续完成剩余工作。

## 二、需求 3：持久化隧道审计

### 2.1 数据模型

服务器基础设施 SQLite 增加或完善以下持久化数据：

- `tunnels`：隧道 ID、创建时间、最后活动时间、删除时间、访问配置和备注。
- `tunnel_members`：设备首次出现、最后出现、设备类型，用于历史总设备数；升级时从老 `devices` 表补迁移。
- `transfer_records`：传输记录快照、发送设备、记录类型、创建/更新时间、删除状态。
- `transfer_files`：记录关联的文件 ID、文件名、MIME、声明大小及来源类型。
- `file_assets`：直接文件资产的当前元信息与供源状态。
- `asset_transfer_events`：直接文件、富文本附件等资产协议的不可变事件快照，记录宣告、请求、客户端完成、服务端中继完成或失败等事件。

`asset_transfer_events` 保存事件发生时的文件名、MIME、声明大小、实际中继字节数、源/目标设备、传输 ID、请求 ID、传输方式和时间。后续同一文件的元数据变化不会覆盖已经发生的事件，便于追溯当时看到的内容。

### 2.2 后台指标口径

`/api/sessions` 和后台隧道列表现在提供并显示：

- 隧道 ID；
- 活跃设备数，并区分真实设备和在线缓存节点；
- 历史总设备数，并区分真实设备和缓存节点；
- 最后活动时间；
- 创建时间；
- 传输记录数；
- 传输文件数；
- 唯一文件数（额外辅助审计）；
- 文件占用总大小。

文件总大小按隧道内唯一文件 ID 取已知最大大小后求和，避免同一文件在多条记录中重复引用而重复累计。没有标准历史记录、但通过直接资产协议宣告过的文件，会以 `direct-file:<file_id>` 合成一条只读审计记录，同时计入文件数和总大小，堵住直接协议旁路。

已删除隧道保留审计行，不因普通活动回调被复活。只有确实存在的记录才能被标记删除，未知 ID 不再生成假 tombstone。

### 2.3 前台与服务端上报覆盖

逐条检查并补齐了以下路径：

| 路径 | 审计来源 | 完成情况 |
| --- | --- | --- |
| 文本、普通文件、文件集合、富文本历史 | 前台 `history-sync` / 服务端历史广播 | 记录和关联文件均持久化 |
| 跨隧道转发 | 服务端转发前验证发送设备属于源隧道 | 保留源资产的文件名、MIME、大小 |
| 直接 `file-asset` 宣告与请求 | 服务端 Socket.IO 事件 | 记录不可变资产事件 |
| 直接文件中继完成 | 服务端按实际转发范围计数 | 记录 `relay-completed` 和实际字节数 |
| 富文本编辑器资产 | 编辑器资产宣告、请求、中继完成 | 记录不可变资产事件，保留 `editor` 类型 |
| 删除记录 | 已有记录的删除事件 | 只更新真实存在记录的删除状态 |

服务端中继的 `bytes_transferred` 是服务端实际观察的中继字节数。P2P 内容本身不经过服务器，服务器只能保存客户端上报的文件身份、声明大小与记录元数据；这是协议事实，不应把客户端声明伪装成服务端做过内容取证。

### 2.4 历史边界

本实现保证升级后的所有受支持协议路径进入审计存储，并迁移老设备成员数据。升级前从未上报、也未留在旧数据库或当前客户端历史中的传输，服务器没有事实来源，无法事后凭空恢复；后台数据从可迁移的旧数据和升级后的新流量开始完整累计。

隧道审计用于运营排查和线索定位，不等同于司法级内容鉴定。若后续需要更强取证能力，应增加服务端内容留存策略、管理员访问审计、可信时间戳、保留期限和隐私合规方案。

## 三、需求 4：独立 VClient 缓存节点

### 3.1 进程架构

缓存节点实现为独立入口 `vclient/index.js`，通过 `npm run vclient` 启动，不嵌入现有 HTTP 服务进程。它在网络协议层是特殊客户端：

- 使用单独的 `/vclient-control` 控制连接获取管理员启用的隧道分配；
- 每个已启用隧道建立隔离的数据连接，以 VClient 设备身份加入隧道；
- 同一个物理 VClient 进程同时承载多个隧道，不为每个隧道重复拉起 OS 进程；
- 每个隧道使用独立稳定 UUID、独立目录和独立资产索引，避免跨隧道文件串用；
- 第一阶段只实现 Socket.IO 文件/编辑器资产中继，不实现 WebRTC DataChannel，符合需求文档的阶段选择。

控制令牌默认由主服务生成在 `.tunnel-data/vclient-control.token`。VClient 支持：

- `VCLIENT_SERVER_URL` 或 `--server`：主服务地址；
- `VCLIENT_DATA_DIR` 或 `--data-dir`：独立缓存目录；
- `VCLIENT_TOKEN` / `VCLIENT_CONTROL_TOKEN`：直接令牌；
- `VCLIENT_TOKEN_FILE` / `VCLIENT_CONTROL_TOKEN_FILE` 或 `--token-file`：令牌文件；
- `VCLIENT_CONTROL_NAMESPACE`：控制命名空间，默认 `/vclient-control`。

在同机默认目录运行时，可直接执行：

```powershell
npm run vclient
```

跨主机部署时，至少需要明确配置主服务 URL、控制令牌或令牌文件，以及持久缓存目录。要实现“全天在线”，应由 systemd、PM2、Windows 服务或同等进程管理器分别守护主服务和 `npm run vclient`；后台按钮只保存/撤销隧道分配，不会违反“独立进程”要求而在主服务内部偷偷派生子进程。

### 3.2 管理后台

每个隧道现在有以下状态和操作：

- 未启用时显示“启用缓存节点”；
- 启用后变为“停止缓存节点”；
- 有启用状态或缓存历史时显示“查看缓存节点”，链接到 `/vclient?sessionId=<隧道ID>`；
- 显示独立进程在线状态、隧道节点状态、已缓存文件数、已缓存字节数和错误信息。

若管理员启用时独立进程尚未连接，启用意图仍会持久化，页面明确提示启动 `npm run vclient`。进程稍后上线会自动领取所有已启用隧道。停止操作即使在控制进程离线时也会强制断开该隧道已有的 VClient 数据连接。

### 3.3 `/vclient` 页面

新页面仅提供当前阶段要求的只读传输记录管理视图：

- 独立进程在线状态；
- 当前隧道缓存状态；
- 已缓存文件数和大小；
- 文本、普通文件、文件集合、富文本记录列表；
- 集合和富文本附件详情；
- 每个资产的等待供源、请求、重试、接收、完成、失败、中断等状态；
- 分页与定时刷新。

直接资产协议形成的合成审计记录也会出现在此页，因此不会只显示标准历史消息而漏掉直接传输。

### 3.4 生命周期与内容完整性

本轮补齐以下异常收敛：

- 接收任务有空闲超时；供源设备离开、服务端报告不可用或连接中断时，关闭临时文件并释放下载槽，再进入有限重试。
- 文件和编辑器中继在任一端断线时通知对端，不再无限等待。
- 新 VClient 控制进程接管时，旧控制连接收到 `superseded` 并停止全部隧道；控制连接意外丢失时，数据隧道同样暂停，避免失控驻留。
- VClient 心跳会重新核对管理员期望状态；已停止隧道的旧连接会被服务端断开。
- 停止进程时短暂等待正在上传的数据收敛，然后安全退出。
- 缓存文件首次或重启后作为供源前按 SHA-256 校验。即使文件大小一致，只要摘要不匹配也会隔离为 `.corrupt-*` 并重新下载，避免损坏缓存污染其他设备。
- 浏览器识别 `clientType: vclient`，不再对第一阶段 VClient 发起无效 WebRTC 协商；文件与编辑器附件走 Socket.IO 中继。

## 四、修改范围说明

核心修改集中在：

- `server/infra-store.js`：持久审计模型、统计和 VClient 状态；
- `server/file-assets.js`、`server.js`：资产协议留痕、断线收敛和 VClient 数据连接鉴权；
- `server/vclient-control.js`：独立进程控制面和管理员 API；
- `vclient/`：独立多隧道缓存进程、缓存索引、校验和重试；
- `pages/admin.html`、`pages/vclient.html`：后台入口及只读记录页；
- `app.js`：浏览器对特殊客户端的最小协议兼容；
- `tests/infra-store-audit.test.cjs`、`tests/vclient-runtime.test.cjs`、`tests/features-2608C.test.cjs`：回归覆盖。

需求 3、4 横跨持久化、服务端协议、独立进程和两个页面，无法只改一个文件。实现避免重写已有传输协议，优先复用现有历史同步和 Socket.IO 文件资产事件。

## 五、验证记录

### 5.1 语法与页面脚本

已通过：

```text
node --check server.js server/infra-store.js server/file-assets.js server/vclient-control.js vclient/runtime.js vclient/cache-store.js app.js
```

`pages/admin.html`、`pages/vclient.html` 的内嵌脚本已抽取并用 `new Function` 完成语法检查。

### 5.2 自动化回归

已执行：

```text
node --test tests/*.test.cjs
```

结果：102 个测试全部通过，0 失败、0 跳过。

重点覆盖：

- 审计数据库关闭后重开仍保留统计；
- 老设备成员迁移；
- 直接资产计入记录、文件和总大小；
- 不可变事件快照；
- 未知删除不造假记录、晚到回调不复活已删除隧道；
- 一进程多隧道及目录隔离；
- 同尺寸缓存损坏的 SHA-256 隔离；
- 接收空闲超时和供源离开后的任务释放；
- 控制连接被替换/断开后的隧道暂停；
- 富文本附件使用编辑器协议并保留审计元数据；
- 浏览器不对 VClient 发起 WebRTC；
- Admin 指标/按钮和 `/vclient` 只读页面静态契约。

### 5.3 浏览器验收说明

尝试使用内置浏览器访问隔离的本地模拟服务时，本地和局域网地址被浏览器安全策略阻止；策略同时禁止用 `data:` 页面绕过，因此没有伪造“真实浏览器已通过”的结论。页面 DOM、内嵌脚本和交互契约已由自动化覆盖，实际部署后仍建议用管理员登录态做一次人工烟雾测试：启用缓存节点、启动独立进程、查看 `/vclient`，再停止节点并确认设备退出。

### 5.4 Git 状态

- 当前分支：`dev/2608C-step1`；
- 本轮没有执行 `git add`；
- 本轮没有执行 `git commit`；
- `git diff --check` 通过。

工作区还包含同一批未提交的 YouTube Premium 需求修改，以及用户已有的 `prompts/dev-prompt-logs/dev-2608B.md` 修改；本轮没有回滚、提交或暂存这些内容。

## 六、建议提交日志

Title：

```text
feat: 完善隧道审计与独立缓存节点
```

Description：

```text
- 持久化隧道成员、传输记录、文件元数据及直接资产协议事件，补齐后台审计统计和旧成员迁移
- 新增独立 VClient 多隧道缓存进程、Admin 启停/查看入口及 /vclient 只读记录页
- 完善中继断线收敛、控制面单实例、缓存 SHA-256 校验和浏览器特殊客户端兼容
- 增加审计持久化、缓存完整性、进程生命周期及页面契约回归测试
```

---

## 七、YouTube Premium 封面状态与专辑作者补丁（2026-08-24）

### 7.1 本轮约束

本轮只处理两个已明确的小问题：

1. “编辑歌曲元信息”重新打开时，预览必须来自歌曲成品中的内嵌封面，而不是任务列表使用的方形参考封面；编辑器与 Telegram 转发可以复用封面数据，但不能覆盖或丢失方形封面。
2. 指定歌曲 `https://music.youtube.com/watch?v=XnWxihjgR-E` 的专辑作者为空，需要在有专辑证据时恢复真实专辑作者，同时继续保护“群星”和未知专辑作者场景。

修改控制在 `pages/youtube-premium-dl.html`、`server.js` 和两份相关回归测试内，没有重构 YouTube Premium 服务或跨文件改写整套下载流程。

### 7.2 内嵌封面读取根因

歌曲封面写入函数只替换 M4A 成品里的 attached picture，故意不调用 `setCoverPath`；这是为了保留下载阶段已经抓取、裁切好的方形封面。此前编辑浮层初始化却直接使用公开任务字段 `task.cover`，而该字段正是外层列表和 Telegram“正方形”选项使用的 `coverPath`，所以自定义内嵌封面虽然写入成功，重新打开浮层仍会显示旧方形图。

修复方式：

- 新增只读 `GET /api/youtube-premium/tasks/:taskId/song-cover`。
- 服务端用 ffprobe 找出 `attached_pic` 流，再用 ffmpeg 抽取为临时 JPEG；响应完成立即清理临时文件。
- 编辑浮层打开后并行读取该接口，初始预览只显示成品文件内嵌封面；读取失败时显示明确错误，不再用任务方形图冒充。
- 保持当前封面时不上传图片，也不会触发二次封面写入。

### 7.3 与 Telegram 封面数据互通

页面增加按任务 ID 隔离的轻量封面资源槽，分别保存：

- `squareUrl`：既有方形封面 URL；
- `originalBlob/originalDataUrl`：按需取得的原尺寸图；
- `embeddedBlob/embeddedDataUrl`：当前歌曲文件内嵌封面；
- `uploadedBlob/uploadedDataUrl`：两个浮层共享的用户上传图。

两处功能共享图片资源，不强行同步 Base/Pro/Ultimate 三个独立下拉框的选择值：

- 元信息编辑器上传的自定义图，可以在 Telegram 的“使用自定义封面”中直接复用。
- Telegram 上传的自定义图，可以在元信息编辑器选择“上传...”时复用；同时提供“重新选择上传文件”按钮。
- Telegram 打开时也会读取歌曲当前内嵌封面，页面重新加载后仍可把已经写入歌曲的封面当作自定义封面使用。
- 原尺寸图在两处之间缓存复用，避免同一页面会话中重复抓取。
- 自定义图、内嵌图、原尺寸图从不写入或替换 `squareUrl/coverPath`；因此上传自定义封面后，原方形裁切结果仍保留，选择“正方形”不需要重新抓取和裁剪。

### 7.4 指定歌曲专辑作者根因

使用当前 yt-dlp 对公开链接做了真实元数据复现：

```text
视频 ID：XnWxihjgR-E
歌曲：ボーイフレンド
专辑：サマー・イン・ブルー
单曲艺术家：Yuri Kunizane
频道：Yuri Kunizane - Topic
album_artist：原始单曲响应没有该字段
```

随后遍历 YouTube Music 专辑搜索的首个匹配专辑，确认：

```text
专辑：Album - Summer in Blue
播放列表：OLAK5uy_n2VlxbpMqN9Jm-2up1Oig_cNzSjJf81ew
目标歌曲位于第 3 首
该专辑条目均来自 Yuri Kunizane - Topic
```

现有新鲜解析逻辑能够用这组专辑条目确认 `Yuri Kunizane`，而不是从单曲艺术家字段盲猜。真正遗漏发生在持久元数据缓存的再次富化：只要缓存中的 Track 和 Disc 已齐全，函数就提前返回，即使 `album_artist` 仍为空；而且再次富化的输入没有携带专辑名，无法发起专辑匹配。

修复方式：

- 提前返回条件改为 Track、Disc、Album artist 三者都存在。
- 重新富化时补传专辑名、已有专辑作者和单曲艺术家上下文。
- 将专辑遍历得到的 `album_artist` 同时回填到 `songMetadata.album_artist` 和 `referenceInfo.albumArtist`。
- 仍然不把单曲艺术家直接复制为专辑作者；只有显式 `album_artist`、编译/群星证据或命中包含目标视频的专辑条目时才填写。

这使旧缓存中的空专辑作者也会在下次加载格式时得到修复，不要求管理员手工删除整个持久缓存。

### 7.5 验证

专题回归：

```text
node --test tests/youtube-premium.test.cjs tests/youtube-album-artist-regression.test.cjs tests/telegram-cover-regression.test.cjs tests/features-2608B.test.cjs
```

结果：49/49 通过。

全量回归：

```text
node --test tests/*.test.cjs
```

结果：103/103 通过，0 失败、0 跳过。

另外用临时文件执行了真实媒体烟雾测试：生成一段带 `attached_pic` 的 M4A，按新接口相同的 ffprobe 流索引和 ffmpeg `-map 0:<stream.index>` 方式抽取封面，成功得到 JPEG；临时目录随后已清理。

新增/更新覆盖：

- 编辑浮层初始化调用歌曲内嵌封面接口，且不再把 `task.cover` 当作当前内嵌封面。
- 服务端只提取 `attached_pic`，并保持封面写入逻辑不调用 `setCoverPath`。
- 上传封面在元信息编辑器与 Telegram 之间按任务复用。
- 方形封面使用独立槽位，不被自定义封面覆盖。
- Track/Disc 已存在但专辑作者为空的旧缓存仍会继续富化。
- 指定视频的专辑条目 fixture 能确认 `Yuri Kunizane`，同时保留群星和歧义保护。

### 7.6 本补丁建议提交日志

Title：

```text
fix: 修复歌曲内嵌封面预览与专辑作者回填
```

Description：

```text
- 编辑歌曲元信息时直接读取成品内嵌封面，并与 Telegram 转发共享原图和自定义封面资源
- 独立保留方形裁切封面，避免上传自定义图片后重复抓取和裁剪
- 修复旧缓存 Track/Disc 已齐时跳过专辑作者富化的问题，补全指定 YT Music 歌曲的专辑作者
- 增加内嵌封面、共享封面状态及缓存专辑作者回填的回归测试
```

---

## 八、服务器 Shell 推送、专辑核验提速与 Telegram 内嵌封面（2026-08-25）

### 8.1 任务边界与现状核对

本轮在 `dev/2608C-step1` 上继续修改，不提交、不暂存，并保留用户已有的 `prompts/dev-prompt-logs/dev-2608B.md` 工作区修改。需求分为四条独立链路：

1. 从服务器 Shell 指定本地文件/合辑、备注、隧道短码或长 ID，推送给该隧道的 VClient 缓存节点；
2. 修复 `XnWxihjgR-E` 的专辑作者、Track 序号，并解释 HEAD 相比旧版的额外耗时；
3. Telegram 图文封面增加“使用缓存歌曲文件的元数据之封面”；
4. `sendAudio.thumbnail` 必须来自缓存歌曲文件本身的内嵌封面，并满足 Bot API 缩略图约束。

### 8.2 HEAD 抓取变慢和序号错误的根因

对比 `0c57a525994cdf501f3de99ef36646d5d6cee658` 与旧线上版本 `db7d6f8d1aed604d57b8f56e32d9bd2253abbf6f`，并逐段核对附件中的两次服务端日志后，确认不是基础音频格式选择整体退化，而是后加的专辑作者修复与旧序号兜底产生了叠加回归：

- HEAD 在新鲜解析中先调用 `enrichYoutubeMusicOrdinalMetadata`；当专辑搜索超时、`album_artist` 仍为空时，又立即调用缓存修复函数，重复同一轮专辑搜索。
- 附件日志中每轮专辑搜索都耗尽 45 秒，两轮合计额外等待约 90 秒；这正是 HEAD 明显慢于旧版的主要增量。旧版只做第一轮，因此即使同样存在 45 秒超时和错误兜底，表面耗时也较短。
- 旧逻辑在没有原生值、也没有匹配到专辑时强行写 `Track=1`、`Disc=1`。这不是抓到了正确序号，而是用一个看起来合法的值掩盖失败。
- 更严重的是，这些 `1` 已经进入旧缓存。后续即使专辑遍历找到了真正的第 3 首，`currentTrack || derivedTrack` 仍会让旧 `1` 压住新结果。

修复策略：

- 新鲜解析只执行一次专辑核验，并写入 `musicAlbumLookupCompleted` 标记；同一分析对象不再进入第二轮缓存修复。
- 专辑搜索使用“专辑名 + 单曲结构化艺术家”缩小候选集。单曲艺术家只参与检索，不直接当作专辑作者证据；最终专辑作者仍必须来自匹配专辑条目的 Topic 频道，避免把群星合辑误写成某一首歌的艺术家。
- 专辑核验共享一个总时限，默认 12 秒、最大 15 秒，可用 `YOUTUBE_MUSIC_ALBUM_LOOKUP_TIMEOUT_MS` 调整；搜索和最多 3 个候选遍历共同消耗这一个预算，不再每个子请求各等 45 秒。
- 老缓存没有核验标记时，历史 `Track=1`、`Disc=1` 被视为旧版占位值并重新验证。能匹配专辑则写真实 Track；不能验证则清空，不继续保留伪造的 `1`。
- Disc 只接受原生正整数；无法取得时按需求留空。

### 8.3 指定歌曲的真实验证

本轮再次使用当前 yt-dlp 对指定歌曲关联专辑做联网验证：

```text
搜索：https://music.youtube.com/search?q=サマー・イン・ブルー Yuri Kunizane#albums
搜索耗时：约 2.1 秒
命中 browse ID：MPREb_Vo6hJMDSJ0T
展开专辑耗时：约 3.4 秒
专辑播放列表：OLAK5uy_n2VlxbpMqN9Jm-2up1Oig_cNzSjJf81ew
XnWxihjgR-E 的位置：第 3 首
专辑条目 Topic 频道：Yuri Kunizane - Topic
```

因此当前证据链会得到：`Track=3`、`album_artist=Yuri Kunizane`、`Disc` 留空。实测搜索加展开约 5.5 秒，位于新的 12 秒总预算内；如果线上网络异常，最坏情况也会在总预算到期后留下空值，而不是再阻塞第二个 45 秒或伪造序号。

### 8.4 服务器 Shell 到 VClient 的推送接口

新增 `npm run vclient:push`，用法包括：

```text
npm run vclient:push -- --tunnel <5位短码或长ID> --file <文件> --remark <备注>
npm run vclient:push -- --tunnel <短码或长ID> --file <文件1> --file <文件2> --name <合辑名>
npm run vclient:push -- --tunnel <短码或长ID> --collection <目录> --name <合辑名>
```

设计要点：

- `--collection` 读取目录直属普通文件；重复 `--file` 也生成合辑记录。单文件最大 1GB，单合辑最多 500 个文件，与现有文件资产协议上限一致。
- 命令使用 `.tunnel-data/vclient-control.token`（或 `VCLIENT_TOKEN` / `VCLIENT_TOKEN_FILE` / `--token-file`）鉴权，以临时的 `server-shell` 内部客户端加入隧道。
- 服务端只允许通过控制令牌认证的 `server-shell` 获得发送权限；目标隧道必须已经存在且已启用缓存节点，避免长 ID 输入错误时意外创建隧道。
- 先登记文件资产，再写普通文件/合辑传输记录；VClient 看到记录后沿用既有 Socket.IO relay 请求文件。
- Shell 按 240KB 分块发送，输出每个文件的进度。只有 `file-asset-relay-complete` 已得到 VClient 的完整性校验和落盘确认，命令才报告成功并退出。
- 多个隧道仍由既有独立 VClient 进程复用；本接口不会在主服务内创建第二套缓存实现。

README 已补充操作示例与令牌、服务器地址、超时参数说明。

### 8.5 Telegram 内嵌封面

Base、Pro、Ultimate 三个图文封面下拉框均新增独立选项“使用缓存歌曲文件的元数据之封面”。该选项调用既有只读 `song-cover` 接口取得当前 M4A attached picture；“使用自定义封面”只读取显式上传槽，不再把内嵌封面冒充成自定义上传。

`sendAudio.thumbnail` 不受三个图文封面下拉框影响，服务端每次发送前直接从该任务的缓存歌曲成品提取 attached picture，再生成 JPEG thumbnail。根据 Telegram Bot API 当前约束，ffmpeg 使用保持比例的最大 `320x320` 缩放，并逐级降低 JPEG 质量直到严格小于 `200000` 字节；生成后及异常时都清理临时图片。

这保证：

- 图文记录仍可分别选择方形、内嵌、原尺寸、自定义封面；
- 音频消息的 `thumbnail` 始终忠实反映缓存歌曲文件当前元数据中的封面；
- 修改歌曲内嵌封面后，无需同步覆盖任务的方形封面，下一次 Telegram 音频发送会自动使用新内嵌图。

### 8.6 测试记录

已完成：

```text
node --check server.js
node --check server/youtube-premium.js
node --check scripts/vclient-push.js
node --test tests/youtube-premium.test.cjs tests/youtube-album-artist-regression.test.cjs tests/telegram-cover-regression.test.cjs tests/vclient-shell-push.test.cjs
```

专题测试 33 项通过。Shell 测试包含真实本地 Socket.IO 协议烟雾测试：创建临时文件、解析短码、加入模拟 VClient 隧道、写入消息、分块中继，并在接收端完成确认后退出；测试临时目录已清理。

全量回归：

```text
node --test tests/*.test.cjs
```

结果：107/107 通过，0 失败、0 跳过。首次全量执行发现旧的 `features-2608B` 契约仍断言“失败时强写 Track=1”；已将该断言更新为新的“无法验证则留空”诊断语义，再次执行后全绿。

还执行了目标文件范围的 `git diff --check`，没有新增空白错误。用户原有 `prompts/dev-prompt-logs/dev-2608B.md` 修改本身含历史尾随空格，本轮未触碰、未格式化该文件。

### 8.7 本轮建议提交日志

Title：

```text
feat: 增加 VClient Shell 推送并修复歌曲专辑核验
```

Description：

```text
- 新增服务器 Shell 单文件/合辑推送命令，通过受控文件中继等待 VClient 确认缓存落盘
- 合并并限时执行 YouTube Music 专辑核验，修复重复搜索、旧 Track/Disc 占位值及专辑作者空缺
- Telegram 图文增加歌曲内嵌封面选项，sendAudio 缩略图改为读取缓存歌曲元数据封面
- 补充 Shell 协议、专辑证据、封面来源与 Telegram 尺寸约束回归测试
```
