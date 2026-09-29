# Telegram 虚拟网盘 API v1

面向 MusicoletWeb 等可信服务端应用。基地址：`/api/telegram/disk/v1`；使用应用 Bearer Token。

实现核对日期：2026-09-29。除另行写出完整地址外，本文接口路径均相对于上述基地址。

本文接口是本系统的 HTTP JSON / 文件流协议，不属于 S3 协议。要求 S3 协议的客户端应使用独立的 [S3 对接文档](../telegram-drive-s3-compatible.md)。两套接口复用网盘存储核心、Telegram 上传流水线和按需分片读取能力；S3 网关直接调用这些内部能力，不通过 HTTP 调用本文接口，不能互换鉴权凭据或响应格式。

## 安全和资源模型

- 资源键：user_id + disk_space + path/node_id；app_id 不参与分区。
- user_id 为稳定 UUID。Telegram User ID 是可选登录身份，不再充当主用户 ID。
- disk_space 默认空字符串，对普通 UI 不可见。同一 user_id + disk_space 在不同可信应用间有意共享；它不是应用权限边界。
- access_token 只鉴别后台登记的应用。持有令牌的服务端可指定 user_id，因此管理员只能登记可信应用；不要把应用密钥或令牌交给不可信前端。
- 生产接口必须使用 HTTPS。Bot Token 只通过鉴权请求体提交，不放在业务 URL、日志或可解码令牌中。管理员登记的应用密钥以 scrypt 哈希保存；换取令牌时提供的四项接入参数另外使用 AES-256-GCM 加密缓存，详见下述完整流程。
- 虚拟目录由本系统管理；内部文件节点关联 backend_id、Telegram channel_id、message_id、media_group_id、file_id。普通列表 / 元信息返回公共文件字段，不返回 Bot Token；上传完成结果另外包含 Telegram 来源标注，详见第 6 节。

## 管理员配置

/tgbot →“第三方系统接入 Telegram 网盘”：

- app_id：必填，3–100 位字母、数字、点、下划线或短横线。
- app_secret：新建必填，16–256 位；保存后不回显。修改时留空保留。
- 备注、启用状态。
- passkey_origin：可选，第三方 WebAuthn 页面精确 HTTPS Origin，例如 https://music.example.com，无路径或尾部斜杠。

创建、禁用、删除、重置应用密钥均独立于 Bot 配置和 Webhook。更新或删除应用会撤销现有令牌，但不删除网盘文件及其存储后端映射。

## 1. 应用鉴权

~~~http
POST /api/telegram/disk/v1/auth/token
Content-Type: application/json

{
  "app_id": "musicolet-web",
  "app_secret": "<secret>",
  "tg_bot_token": "123456:<bot-token>",
  "tg_channel": "-1001234567890"
}
~~~

服务端检查 Bot、频道类型及发消息/删消息权限，记录稳定 chat_id。响应：

~~~json
{
  "access_token": "<opaque-random-token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "backend_id": "<uuid>"
}
~~~

后续请求使用：

~~~http
Authorization: Bearer <access_token>
X-Disk-User-Id: <user_id>
X-Disk-Space: musicolet
~~~

user_id、disk_space 也可在 query/body 中传递，Header 优先；省略 disk_space 即为空串。仅未提供 user_id 时可用 tg_user_id，服务端映射为正式 Telegram 身份对应的通用用户。

### 完整调用与凭据查找流程

1. 第三方**服务端**发送 `app_id + app_secret + tg_bot_token + tg_channel` 到 `/auth/token`。本系统验证管理员已登记且启用的应用和密钥，再通过该 Bot 查询频道及权限，将频道别名解析为稳定的 `chat_id`。
2. 本系统生成随机、不含业务字段的 `access_token`，有效期默认 3600 秒。服务端缓存以 **SHA-256(access_token)** 为查找键（而非落盘保存明文令牌），关联应用版本、到期时间、存储后端 ID，以及加密凭据包 `{ app_id, app_secret, tg_bot_token, tg_channel }`。其中 `tg_channel` 保存验证后的稳定频道 ID。
3. 凭据包使用 AES-256-GCM 加密并验证完整性，保存在私有数据目录的 `disk.sqlite` 鉴权表；独立密钥位于 `disk-secret.key`。`disk-auth.json` 是旧版迁移来源。管理员应用表中的密钥仍是 scrypt 哈希，不因这项缓存而变成明文；API 响应、业务文件元信息和日志都不回传凭据包。
4. 后续业务请求携带 `Authorization: Bearer <access_token>`、`user_id`、`disk_space` 和业务参数。服务端先计算令牌摘要查找记录，检查到期时间、应用是否启用及版本是否有效，再解密对应凭据包。**新上传和修复使用其中的 Bot Token 与频道调用 Telegram**；`app_id/app_secret` 仅用于本系统鉴权，不发送给 Telegram。
5. 每个文件索引长期关联实际保存时的存储后端以及 `channel_id + message_id/media_group_id + file_id`。读取、删除、公开分享下载使用文件自身关联的后端，不能因为调用方刚换了频道或令牌就改去另一个频道读取旧文件。为此，文件后端的 Bot Token 另有加密持久化映射，其生命周期不限于一小时令牌。虚拟目录重命名/移动只改本系统索引，不重新上传文件。
6. 到期或无效返回下述 HTTP 401 及专用 `code`。第三方重新提交四项接入参数换取令牌；不需再在每个业务请求重复发送 Bot Token。新令牌仍可用原 `user_id + disk_space` 访问同一份网盘。更换应用配置会撤销该应用所有令牌；过期缓存会在后续发放令牌时清理。旧版已发放且尚未到期的令牌兼容原加密后端映射。

`user_id` 是网盘通用用户 UUID，不是手机号或 Telegram 数字 ID。本版仍保留 `tg_user_id` 作为旧调用方的兼容输入，新接入统一使用 `user_id`。`disk_space` 只区分虚拟内容，不是频道选择器；频道取自令牌凭据或文件已有的后端关联。不要将 `access_token` 放在 URL 中。

令牌到期、撤销或无效均返回 HTTP 401：

~~~json
{ "error": "ACCESS_TOKEN_EXPIRED", "code": "ACCESS_TOKEN_EXPIRED" }
~~~

或 ACCESS_TOKEN_INVALID。重新调用鉴权接口，随后重试幂等请求；不确定的非幂等操作先查任务。应用账号错误为 APP_AUTH_INVALID，不应无限重试。

## 2. 用户注册、登录、查询

用户模式为账号名 + Passkey，没有用户密码。Telegram OIDC 仍可用；已登录 Telegram 用户可以添加账号名和 Passkey，保留同一个 user_id 和文件。

| 方法 | 路径 | 请求/响应 |
|---|---|---|
| POST | /passkeys/register/options | 请求 username，返回 flow_id、WebAuthn options |
| POST | /passkeys/login/options | 请求 username，返回 flow_id、WebAuthn options |
| POST | /passkeys/verify | 请求 flow_id、response，返回 identity 和 user_id |
| GET | /users/me | 按指定 user_id 查询通用身份 |

以上 Passkey 接口需要应用 access_token，但不要求 X-Disk-User-Id。username 为 3–64 位字母、数字、下划线、点、短横线，大小写归一。

Web 前端使用标准 navigator.credentials API 或 @simplewebauthn/browser：

~~~js
const response = kind === 'register'
  ? await startRegistration({ optionsJSON: result.options })
  : await startAuthentication({ optionsJSON: result.options });
// 将 { flow_id: result.flow_id, response } 发给应用后端，再由后端调用 verify。
~~~

挑战五分钟、一次有效，验证签名、RP ID、精确 Origin、用户验证标志及签名计数器。注册要求可发现凭据。第三方页面必须部署在管理员登记的 passkey_origin；未登记则使用 API 服务自身 Origin。应用密钥和 Bot Token 只放在应用后端。

Passkey 绑定 RP 域名，不会自动复制到不同 RP。已有其他 RP 的凭据不能冒充当前 RP 的凭据；跨设备使用系统支持的同步 Passkey。丢失唯一 Passkey 且未绑定其它登录方式时，本版没有密码找回后门。

### 本地测试

localhost、回环地址、RFC1918 局域网 IP（10/8、172.16/12、192.168/16）以及 IPv6 ULA/link-local 的直接本地请求继续使用项目原有 Telegram OIDC Mock。必须同时满足本地 Host 和本地 TCP 来源；含代理转发头的请求不启用 Mock。TELEGRAM_OIDC_MOCK_ENABLED=0 可完全关闭。

浏览器测试入口：/api/telegram/drive/oidc/start；身份查询：/api/telegram/drive/me；登出：POST /api/telegram/drive/logout。Mock 用户与正式 Telegram provider 隔离。第三方测试已由 Mock 登录的用户时，使用 /me 返回的 UUID，而不是把模拟数字当成正式 tg_user_id。

## 3. 操作任务

耗时写操作返回 HTTP 202：

~~~json
{ "operation_id": "<uuid>" }
~~~

GET `/operations` 返回 `{ "operations": [...] }`；GET `/operations/{operation_id}` 查询单项。任务仅在所属 user_id + disk_space 中可见，读取任务还受设备标识限制。列表默认省略 result；使用 `/operations?ids=ID1,ID2` 可携带最多 100 个任务 ID 并取得这些任务的 result，或直接查询单项。DELETE `/operations/{operation_id}` 请求取消任务并返回任务对象；不能撤销已经完成的修改，远端清理可能继续进行。

~~~json
{
  "operation_id": "<uuid>",
  "title": "上传 2 个文件：song.flac",
  "type": "upload",
  "status": "running",
  "phase": "telegram-upload",
  "percent": 62.5,
  "processedBytes": 1250,
  "totalBytes": 2000,
  "message": "正在上传到 Telegram：song.flac",
  "errorCode": "",
  "errorMessage": "",
  "createdAt": 1788432000000,
  "startedAt": 1788432000100,
  "updatedAt": 1788432000200,
  "finishedAt": 0
}
~~~

status：queued / running / completed / failed / cancelled。只有 completed 才表示完整成功；业务结果在 result。失败查看 errorCode / errorDetails，不能仅凭 percent=100 判断成功。上传采用整批提交 / 回滚，不返回已成功文件的 result.partialItems；递归删除则可能已经删除部分文件，失败后应重新读取目录再处理剩余项。

上传进度区分“客户端→服务器”和“服务器→Telegram”，两段可交叠进行，不将流量相加。`phase`、`processedBytes`、`totalBytes`、`percent` 表示最近更新的阶段，不保证阶段只切换一次或总体百分比单调增长；客户端分别使用 `clientBytesReceived/clientTotalBytes` 和 `telegramBytesUploaded/telegramTotalBytes` 展示两段累计量。任务还可返回 `clientPartsReceived/clientPartsTotal`、`telegramPartsUploaded`、`queueParts/queueBytes` 及 `folderPath`。Telegram 请求体写入量不代表持久化确认，等待上游 / caption / 索引时百分比可能为 null；只有 status=completed 才表示整批文件已提交。

创建目录仍返回 202；若短时间内已经完成，响应还可含 `status: "completed"` 和 result，调用方可直接应用结果，否则查询 operation_id。不要把带 completed 的响应当成另一种任务。

任务持久化；刷新页面可重新查询。服务重启时未完成任务标记 SERVER_RESTARTED，不伪装成成功。暂存上传两小时未完成会过期。列表保留最近任务，长期归档请由调用方保存业务结果。

## 4. 目录操作

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /list?path=音乐/日本 | 当前目录、面包屑、文件/目录和统计 |
| GET | /search?q=关键词 | 当前用户 / 分区全盘搜索，返回 query、folders、files、summary；目录优先，目录与文件合计最多 500 项 |
| GET | /directories | 全部虚拟目录 |
| GET | /directories/properties?path=音乐 | 目录属性 |
| GET | /tree?path=音乐 | 递归目录与文件 |
| POST | /directories | 逐层创建目录 |
| PATCH | /directories | 重命名/移动目录树 |
| DELETE | /directories?path=音乐&recursive=true | 递归删除，禁止删除根目录 |

创建请求：{"path":"音乐/日本/2026/专辑"}。

重命名请求：{"path":"音乐/日本","name":"J-Pop"}。

移动请求：{"path":"音乐/J-Pop","destinationPath":"归档","name":"日本音乐"}，name 可省略。

/ 和反斜杠均为分隔符，重复分隔符与单点归一；双点、非法字符、超深路径、移入自己或子目录、同名文件冲突均拒绝。目录段最长 100 字符，深度按后台设置且最多 20 层。不会静默覆盖。上传中的目标有预留保护；目标同空间繁忙时返回冲突，请稍后重试。

## 5. 文件操作

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /files/{id} | 文件元信息 |
| PATCH | /files/{id} | {"name":"新名称.flac","folderPath":"目标目录"}，可只填一项 |
| DELETE | /files/{id} | 删除 Telegram 对象后移除索引；失败保留节点 |
| GET | /files/{id}/download | 文件流，响应头 X-Disk-Operation-Id 为读取任务 |
| GET | /files/{id}/stream | inline 文件流，用于音视频 / 图片预览，不创建读取任务 |
| GET | /files/{id}/thumbnail | 已保存的封面图流；无封面时 FILE_THUMBNAIL_NOT_FOUND |
| GET | /files/{id}/check | 异步检查，任务 result.valid 表示可用性 |
| POST | /files/{id}/repair | 完整缓存副本修复，见下文 |

文件名最多 180 字符。文件公共字段：id、kind、name、type、size、folderPath、createdAt、updatedAt、lastCheckedAt、repairedAt、metadata、reviewStatus、reviewUpdatedAt、partCount、mediaIndex、thumbnailAvailable。列表 / 搜索还附带 collaborationId，空值表示该项自身未开启协同。

`download` 与 `stream` 对非空文件均支持单段 `Range: bytes=START-END`、`bytes=START-` 或 `bytes=-SUFFIX`，返回 206 / Content-Range；无 Range 返回 200，非法或多段 Range 返回 416。只读取涉及的 Telegram 分片，不要求先拉取整个文件。`download` 使用 attachment，`stream` 使用 inline；需继续携带原鉴权。第三方应拼接本 API 的 stream 路径，不能把浏览器会话保护的地址直接当作 Bearer 读取地址。

仍处于协同编辑保护范围的文件 / 目录不能直接删除，会返回 COLLABORATION_DISABLE_BEFORE_DELETE；应由所有者先停止相关协同状态。审核已删除文件的读取返回 410 FILE_REMOVED_BY_REVIEW。

修复时请求体为原文件完整二进制：

~~~http
X-Disk-File-Size: 12345678
Content-Type: application/octet-stream
~~~

修复使用当前令牌对应的 Bot/频道；浏览器使用后台指定的当前网盘存储频道。确认上传成功后才替换旧映射。原文件的读取和删除仍使用文件自身记录的存储后端，不会误用最新令牌的频道。

Telegram 可能因消息时限/权限拒绝删除。此时保留失败节点并报告错误；递归删除遇到部分失败时，已成功删除部分生效，其余保留。

## 6. 两阶段上传与原手机路径

~~~http
POST /uploads
Content-Type: application/json

{
  "folderPath": "",
  "files": [
    {
      "source_path": "/storage/emulated/0/Music/Artist/Album/01 Song.flac",
      "type": "audio/flac",
      "size": 12345678
    }
  ],
  "metadata": { "source": "musicolet" }
}
~~~

有 source_path 时按最后一段提取 name，其余段自动创建虚拟目录。否则使用 name 和公共 folderPath，也可为单个文件指定 folderPath。禁止空 basename 或包含双点。

每批 1–100 个逻辑文件；单个逻辑文件限制以响应 uploadLimit 为准，当前为 2000 MiB。网盘固定调用 Telegram 官方 Bot API，不接收调用方指定 API 地址，也不依赖 Local Bot API Server。**每片不超过 20,000,000 字节（20 MB，约 19.07 MiB）**。浏览器使用 Blob.slice() 顺序提交分片，不进行同步全文件复制或编码。服务器单独暂存各片并流式提交 Telegram，已确认分片会释放暂存文件，无需合成另一个完整临时文件。第三方也应使用下述 Content-Range 协议；当前无 Content-Range 的整文件 PUT 只入队为一个 chunk，不能自动生成大文件的全部计划分片，因此仅用于默认单片计划的小文件 / 空文件，大文件必须按计划分片。虚拟目录、列表、移动、重命名、分享、审核和第三方 API 始终只暴露一个逻辑文件。

~~~json
{
  "uploadId": "<uuid>", "operation_id": "<uuid>",
  "uploadLimit": 2097152000, "partSize": 20000000,
  "uploadQueueCheck": true,
  "queue": { "queuedParts": 0, "queuedBytes": 0, "pendingParts": 0, "pendingBytes": 0, "uploadedParts": 0, "receivedParts": 0, "totalParts": 1 },
  "files": [{ "logicalFileId": "<uuid>", "partCount": 1 }]
}
~~~

可选通知源文件读取阶段：POST /uploads/{uploadId}/phase，JSON {"index":0}。

上传每个文件，index 从零开始，Content-Type 必须用 application/octet-stream，避免 JSON 请求解析器消费文件内容：

~~~http
PUT /uploads/{uploadId}/files/0
Content-Type: application/octet-stream

<exact bytes>
~~~

大小必须与声明一致。完成所有字节后 POST /uploads/{uploadId}/finish，返回 202 operation_id。该 uploadId 的 finish 可重试，在任务保留期内返回同一任务，不重复发往 Telegram。

浏览器及第三方分片调用方在同一路由携带 `Content-Range: bytes START-END/TOTAL`，按 offset 从 0 顺序发送。默认计划中，除末片外长度必须为 partSize，末片为剩余字节；TOTAL 是逻辑文件总大小。可在初始化的每个 files 项中提供 `parts: [{ "byteStart": 0, "byteEnd": 999, "size": 1000 }, ...]` 自定义连续分片边界，各片不超过 partSize，合计必须等于 size，最多 10000 片。不接受缺片、重叠、乱序、重复或长度不符的分片；这类失败需要重新创建上传任务，队列满的 503 例外见下文。空文件使用不带 Content-Range 的空 PUT。初始化 JSON 中的 size 始终是原始逻辑文件大小，不能据此判断传输是否分片。

当前上传流水线一次选择最多 2 个连续分片、合计最多 40,000,000 字节；底层 transport 另有每 Album 最多 10 项的上限。多条使用 sendMediaGroup，单条使用 sendDocument，实际是否组成 Album 取决于分片到达和复用情况。收到明确 413 时拆小重试；429 遵循 retry_after 有限重试，不重复发送结果未知的网络超时请求。115,384,320 字节文件默认拆成 6 片，但不保证固定产生 3 个 Album。跨 Album 的分片保存同一 `logicalFileId`、`partIndex`、`partCount`、`offset`、分片大小、原始文件总大小、messageDate 和媒体类型。**批量上传必须等本任务全部文件成功后才统一提交索引、展示文件；失败整批回滚**，已确认消息进入清理 / 恢复流程。若请求在 Telegram 已接收但响应丢失时断网，Telegram 不提供发送幂等键，此类未知结果不能保证自动去重。

每个物理分片（含 album 内每条消息）的 caption 记录 `user_id`、`disk_space`、文件名 `name`、`channel_id`、`logical_file_id`、分片序号/总片数和原始总大小。**新上传不写 `path` 字段**，目录位置以网盘索引为准。新传二进制的分片发送后再通过 editMessageCaption 补齐 `file_id`、`message_id`、`album_id`；已验证 file_id 的复用路径不会额外执行这一补注步骤。补注等待不计入文件字节进度，文件改名同步时可显示 `telegram-caption` 阶段。

下载、预览和转发时，服务端先校验分片序号、数量、offset、总大小，再按 `partIndex` 顺序逐片调用官方 getFile 并流式拼接，校验每片实际下载字节数；响应长度和文件名仍是原始逻辑文件。检测会验证全部分片。文件 / 目录移动及目录重命名只更新索引，不因路径变化编辑 Telegram caption；文件重命名仍同步该逻辑文件全部分片的 `name`。

caption 受 Telegram 1024 字符限制，完整目录路径保存于逻辑索引。上传补备注失败不会丢失已保存文件，warnings 包含 TELEGRAM_CAPTION_UPDATE_FAILED。文件重命名先持久化索引和 captionSyncPending，然后逐片更新备注；失败返回 TELEGRAM_CAPTION_SYNC_PENDING，服务器每分钟重试，重启后保留待同步标记。

删除逐片执行：发送不足 **47 小时 57 分钟**使用 deleteMessage；达到该边界使用 editMessageMedia 替换为 1 Byte document，caption 改为“文件名 已删除”。此阈值在官方 48 小时限制前预留 3 分钟，逐片以调用时的时间判断；旧索引消息年龄不准导致 Telegram 拒绝删除时也尝试替换。占位文件首次使用时上传，file_id 按 Bot/API 地址隔离保存在 `disk.sqlite` 的占位映射中（旧 `tg-1byte-file.id` 可迁移），以后及重启后复用。已不存在的消息和已替换内容按幂等成功处理；某片失败仍尝试其余片，并保留逻辑索引供重试。媒体替换仍受 Telegram 的消息类型和编辑权限限制；修改频道消息不等同于擦除 Telegram 已保存的历史文件引用。

新上传文档设置 disable_content_type_detection=true，同时兼容旧服务返回 video/audio/animation 等媒体字段，避免有效文件被误判为 TELEGRAM_UPLOAD_RESULT_INVALID。真正无效的响应仅记录安全的返回数量和媒体字段类型到 errorDetails，不记录 Bot token、URL 或原始 Telegram 消息。

创建响应含 `uploadQueueCheck: true` 和 `queue` 快照时，支持分片的客户端应在队列满（`pendingParts >= 5` 或 `pendingBytes >= 100000000`）时先 GET `/uploads/{uploadId}/queue`，按返回的 `ready`、`queue`、`retryAfterMs` 等待，再发送下一片。成功 PUT 返回新队列快照。满队列 PUT 会立即返回 HTTP 503 `UPLOAD_BACKPRESSURE`，此请求未接受文件分片，可以等待后重发；该信号不代表 Telegram 429。

DELETE `/uploads/{uploadId}` 表示用户主动取消，会中止流水线并尝试回滚。浏览器网络 / 请求失败使用 POST `/uploads/{uploadId}/failure`，JSON `{ "errorCode": "UPLOAD_CLIENT_NETWORK_ERROR", "reason": "Failed to fetch" }`；服务端返回 202，保留最初错误并异步执行原有清理，不将失败标为用户取消。`UPLOAD_CLIENT_REQUEST_FAILED` 表示其它客户端失败。对已结束任务再次上报不覆盖其结果；网络错误后的分片不能盲目重发，因为可能已经被接受。

需要提前保存音视频封面时，可在 finish 前 PUT `/uploads/{uploadId}/files/{index}/thumbnail`，请求体为图片字节，Content-Type 使用 image/*，`X-Disk-Thumbnail-Size`（或 Content-Length）声明 1–2,097,152 字节大小；同文件只接受一次。封面随任务上传并保存关联，后续通过 thumbnail 接口读取。服务端不保证替所有第三方上传自动提取封面，调用方可在初始化 files 项中携带已有 mediaIndex。

最终 GET `/operations/{operation_id}` 的 result 包含 `{ "ok": true, "items": [...], "warnings": [...] }`。items 除公共文件字段外还返回 `telegramFileId`、`telegramFileUniqueId`、`telegramChatId`、`telegramMessageId`、`telegramPartFileIds`、`serverAssetUrl`，用于来源关联，不包含 Bot Token。**serverAssetUrl 当前指向 `/api/telegram/drive/files/{id}/stream`，要求浏览器网盘会话；传统 API 调用方应改用本基地址的 `/files/{id}/stream` 并携带 Bearer / 用户 / 分区。**

## 7. 公开分享

已登录浏览器在 `/api/telegram/drive` 下调用；第三方在本 API v1 下调用，继续携带令牌、用户和空间：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /shares | 创建分享，返回 HTTP 201 和 share 对象 |
| GET | /shares | 当前用户与空间的分享列表，含已停止项 |
| DELETE | /shares/{share_id} | 停止分享，不删除源文件或 Telegram 消息 |

~~~json
{
  "items": [
    { "kind": "file", "id": "<网盘文件UUID>" },
    { "kind": "directory", "path": "音乐/专辑" }
  ]
}
~~~

每次 1–100 个选择项，支持单文件、多文件、目录；禁止分享整盘根目录，展开后最多 10000 个文件及 10000 个目录。创建响应直接返回分享对象，其中 `url` 是相对本站地址 `/disk-share/<随机分享口令>`，调用方加上本站可信 Origin 即可展示公开链接。对象还包含 id、title、createdAt、stoppedAt、fileCount、directoryCount；列表接口返回 `{ "shares": [...] }`。

持有链接者无需登录，页面可以递归浏览分享目录。匿名接口为 `GET /api/telegram/disk-shares/{token}?path=<分享内路径>` 和 `GET /api/telegram/disk-shares/{token}/files/{file_id}/download`，仅允许分享白名单内的文件。不会接收调用者指定的 owner/backend，也不返回 Bot 凭据、真实频道或私有元信息。

分享保存创建时选中文件 ID、目录结构和名称的快照：源目录后来新增的内容**不会自动公开**；原文件移动/重命名不扩大分享范围，源文件删除后不可再下载。停止后新请求返回 404 `SHARE_NOT_FOUND`；等待上游读取时也会在输出首字节前再检查一次。已下载的副本、已经开始输出的响应无法远程收回。

链接本身就是访问凭据，持有者可以继续转发，公开页面不是登录保护页。确认分享前应提示用户这一点。返回内容标记 no-store、no-referrer、noindex，并对匿名 API 按 IP 限流。分享不会复制文件到另一个频道；大逻辑文件同样由服务端逐片读取并合并。

## 8. 错误和部署约束

| HTTP | 错误码示例 | 处理 |
|---|---|---|
| 401 | ACCESS_TOKEN_INVALID / ACCESS_TOKEN_EXPIRED | 重新换取令牌 |
| 404 | FILE_NOT_FOUND / OPERATION_NOT_FOUND | 不存在或不属于用户/分区 |
| 409 | DISK_NAME_CONFLICT / DISK_BUSY / DISK_UPLOAD_IN_PROGRESS | 不覆盖，修改目标或稍后重试 |
| 422 | DISK_NAME_INVALID / SOURCE_PATH_INVALID / REPAIR_SIZE_INVALID | 修改请求参数 |
| 416 | 空正文、Content-Range: bytes */SIZE | 文件读取 Range 无效 |
| 502 | TELEGRAM_NETWORK_ERROR / STORAGE_BACKEND_UNAVAILABLE | 检查服务器网络、Bot 和频道配置 |
| 503 | PASSKEY_SERVER_UNAVAILABLE | 部署缺少服务端 Passkey 依赖，执行 npm ci 后重启 |
| 503 | UPLOAD_BACKPRESSURE | 当前分片未接受；查询队列后重试，不重新创建整个任务 |
| 429 | AUTH_RATE_LIMIT | 鉴权 / Passkey 接口按 IP 每分钟最多 20 次，稍后重试 |

异步业务失败通过 GET `/operations/{operation_id}` 通常仍以 200 返回任务对象，status=failed；必须检查任务状态，而不只是 HTTP。同步 JSON 错误通常包含 error、code、errorDetails；AUTH_RATE_LIMIT 和 UPLOAD_BACKPRESSURE 等直接响应例外只含其特定字段。来源与底层错误诊断以 errorDetails 为准。

数据默认位于 `TUNNEL_DATA_DIR`（未设置时为 `.tunnel-data`）。当前网盘共享元数据使用 Node 内置 SQLite，主库 `disk.sqlite` 采用 WAL 和短事务；旧 `disk-auth.json`、`disk-operations.json`、`disk-shares.json`、`telegram-drive-*.json` 等是迁移来源，不是当前主库。请使用 SQLite 一致性备份，或停服后备份整个数据目录；不能在运行中仅复制 `disk.sqlite` 而忽略 WAL。`disk-secret.key` 等密钥也需一起备份。数据库事务不覆盖 Telegram 网络上传全程；不要据此假定全部进程内队列及后台任务支持多个 Node 实例同时运行。

### Passkey 资源与 Telegram 登录排障

- 源码部署应在当前 package-lock.json 对应目录执行 `npm ci` 后重启，确保 `@simplewebauthn/browser` 和 `@simplewebauthn/server` 都已安装。发布包中的 `/client/simplewebauthn.js` 优先解析构建清单内的已打包资源，不再仅依赖运行时解析浏览器 npm 包。若两者都缺失，返回可执行的 JS 错误提示（503），不返回含服务器路径的 HTML 堆栈。
- 前台区分“非 HTTPS”“浏览器不支持 Passkey”“Passkey 脚本缺失”，不再把脚本 500 一律误报为浏览器/HTTPS 问题。仍需实际支持通行密钥的浏览器和设备；修好脚本不等于获得用户的硬件认证。
- 正式 Telegram 登录继续使用弹窗 OIDC + PKCE，不打断首页传输；localhost/LAN 保留原安全边界内的 Mock。出现 Telegram 页面“已发送通知，请确认”时，还没有进入本站回调阶段，本站不能代 Telegram 发送该确认通知，也不能通过 Mock 冒充正式登录成功。
- 服务端增加 `[网盘 OIDC]` 阶段日志，以 `traceId` 短跟踪号关联：开始授权、收到回调并交换令牌、身份验证完成，以及后续清理发现的授权等待过期。日志不记录手机号、授权 code、state、Token 或 Secret；前台等待超过一分钟给出通知检查与 Passkey 备用提示。先区分没有回调，还是已有回调但验签/换令牌失败。
- 管理员检查 BotFather 中的精确正式 Redirect URI `/api/telegram/drive/oidc/callback` 以及 HTTPS Trusted Origin，保留截图和上述无敏感信息日志。若 Telegram 客户端持续收不到通知，需要向 Telegram 排查该授权阶段；不能据此直接判定为本站回调地址故障。参见 [Telegram 官方登录文档](https://core.telegram.org/bots/telegram-login)。

官方 getFile 标注单个 Telegram 文件下载上限为 20 MB，因此网盘采用保守的 20,000,000 字节分片。sendDocument 上传上限为 50 MB，Album 支持 2–10 项，deleteMessage 仅允许发送不足 48 小时的消息。参见 [Telegram Bot API](https://core.telegram.org/bots/api#getfile)、[删除规则](https://core.telegram.org/bots/api#deletemessage)、[媒体替换](https://core.telegram.org/bots/api#editmessagemedia)。40,000,000 字节批次是本系统的保守请求大小策略，不宣称是官方 Album 总量上限。浏览器缓存仍可减少重复读取，并继续作为防失联修复来源。

参考：[Telegram Bot API](https://core.telegram.org/bots/api)、[SimpleWebAuthn Server](https://simplewebauthn.dev/docs/packages/server)、[Passkey](https://simplewebauthn.dev/docs/advanced/passkeys)。

## 2026-09-06 补充：设备任务、直达入口与上传诊断

- `/disk` 直接打开网盘，`/?disk=1` 也可使用；页面直达不改变原有登录和 API 鉴权。发布构建同步包含 `/disk` 页面映射。
- 浏览器在请求和下载中携带 `X-Disk-Device-Id`（本机 localStorage 随机标识，8–120 位字母数字、下划线或连字符）。`read` 任务只有相同用户、分区和设备可以查询；无设备标识的历史读取任务不再全局展示。上传等逻辑文件操作仍按原有用户和分区范围共享。设备标识不是身份凭据。
- 公共分享页初始请求只返回目录元信息，不自动缓存文件。列表加载采用页内提示，15 秒超时后可重试；响应 `Server-Timing: share-metadata;dur=...` 表示服务端目录解析耗时。文件内容在用户点击预览或下载时读取。
- 公共分享的浏览器缓存自写入起 7 天到期；访问过期项时删除并重新读取，打开分享页时顺带清理过期分享缓存。普通网盘文件缓存不受该期限影响。
- 服务端上传日志同时写 console 和 `.tunnel-data/disk-upload.log`，单文件达到约 10 MiB 时轮换为 `.1`。按 `uploadId`、`operationId`、逻辑 `fileId` 检索；批次附带每个分片的文件 ID、序号、总数和大小。不记录 Bot Token、Cookie、完整 Bot URL、文件正文或分享令牌。
- `browser.receive-*` 记录 Content-Range、Content-Length、收到字节、耗时及 10 秒心跳；`upload.handoff` 表示暂存完成进入 Telegram 阶段。`telegram.request/headers/response` 记录方法、请求大小、响应状态、重试次数和耗时；`telegram.progress` 区分请求体生成字节与此前 Telegram 确认字节。`telegram.part-confirmed` 才表示收到合法的分片消息响应。`telegram.network-error` 记录失败阶段、底层 code/causeCode/syscall；`telegram.cleanup-*` 记录失败后半成品清理结果。
- 请求体进度不是 Telegram 持久化确认。网络失败时不盲目重发非幂等上传；明确 413 时拆小批次、明确 429 时有限重试的既有策略保持不变。
