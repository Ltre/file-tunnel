# Telegram 虚拟网盘 API v1

面向 MusicoletWeb 等可信服务端应用。基地址：/api/telegram/disk/v1。

## 安全和资源模型

- 资源键：user_id + disk_space + path/node_id；app_id 不参与分区。
- user_id 为稳定 UUID。Telegram User ID 是可选登录身份，不再充当主用户 ID。
- disk_space 默认空字符串，对普通 UI 不可见。同一 user_id + disk_space 在不同可信应用间有意共享；它不是应用权限边界。
- access_token 只鉴别后台登记的应用。持有令牌的服务端可指定 user_id，因此管理员只能登记可信应用；不要把应用密钥或令牌交给不可信前端。
- 生产接口必须使用 HTTPS。Bot Token 只通过鉴权请求体提交，不放在 URL、日志或可解码令牌中。服务端以 AES-256-GCM 加密保存，应用密钥以 scrypt 哈希保存。
- 虚拟目录由本系统管理；内部文件节点关联 backend_id、Telegram channel_id、message_id、media_group_id、file_id。对外文件对象不返回这些内部存储凭据。

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

GET /operations 返回 operations 数组；GET /operations/{operation_id} 查询单项。任务仅在所属 user_id + disk_space 中可见。

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

status：queued / running / completed / failed / cancelled。只有 completed 才表示完整成功；业务结果在 result。失败查看 errorCode，部分成功可能含 result.partialItems。

上传百分比按“客户端→服务器 + 服务器→Telegram”两段字节总量计算。Telegram 侧是写入 HTTP 请求流的字节数，不冒充 Telegram 已落盘确认。等待外部响应时 percent=null，显示具体阶段，lastMeasuredPercent 可用于保留圆环已有进度。成功后才显示完成。

任务持久化；刷新页面可重新查询。服务重启时未完成任务标记 SERVER_RESTARTED，不伪装成成功。暂存上传两小时未完成会过期。列表保留最近任务，长期归档请由调用方保存业务结果。

## 4. 目录操作

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /list?path=音乐/日本 | 当前目录、面包屑、文件/目录和统计 |
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
| GET | /files/{id}/check | 异步检查，任务 result.valid 表示可用性 |
| POST | /files/{id}/repair | 完整缓存副本修复，见下文 |

文件名最多 180 字符。文件公共字段：id、kind、name、type、size、folderPath、createdAt、updatedAt、lastCheckedAt、repairedAt、metadata。

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

每批 1–100 个文件；单文件限制以响应 uploadLimit 为准。默认官方 Bot API 上传上限 50 MiB；管理员配置 Local Bot API Server 后可使用 2 GiB，第三方指定的 Bot 也使用这一可信服务地址。不接受调用方指定任意 API 地址，避免 SSRF。

~~~json
{ "uploadId": "<uuid>", "operation_id": "<uuid>", "uploadLimit": 52428800 }
~~~

可选通知源文件读取阶段：POST /uploads/{uploadId}/phase，JSON {"index":0}。

上传每个文件，index 从零开始，Content-Type 必须用 application/octet-stream，避免 JSON 请求解析器消费文件内容：

~~~http
PUT /uploads/{uploadId}/files/0
Content-Type: application/octet-stream

<exact bytes>
~~~

大小必须与声明一致。完成所有字节后 POST /uploads/{uploadId}/finish，返回 202 operation_id。该 uploadId 的 finish 可重试，在任务保留期内返回同一任务，不重复发往 Telegram。

服务器按最多 10 个文件一组调用 sendMediaGroup；单文件调用 sendDocument。后续组失败时，先前已被 Telegram 确认的文件会保留索引，记录在失败任务 result.partialItems。若请求在 Telegram 已接收但响应丢失时断网，Telegram 不提供发送幂等键；此类未知结果不能保证自动去重，不会无限自动重发。

DELETE /uploads/{uploadId} 可取消未开始远端提交的暂存；远端提交中返回 UPLOAD_IN_PROGRESS，不假装撤销已发送文件。

## 7. 错误和部署约束

| HTTP | 错误码示例 | 处理 |
|---|---|---|
| 401 | ACCESS_TOKEN_INVALID / ACCESS_TOKEN_EXPIRED | 重新换取令牌 |
| 404 | FILE_NOT_FOUND / OPERATION_NOT_FOUND | 不存在或不属于用户/分区 |
| 409 | DISK_NAME_CONFLICT / DISK_BUSY / DISK_UPLOAD_IN_PROGRESS | 不覆盖，修改目标或稍后重试 |
| 422 | DISK_NAME_INVALID / SOURCE_PATH_INVALID / REPAIR_SIZE_INVALID | 修改请求参数 |
| 502 | TELEGRAM_NETWORK_ERROR / STORAGE_BACKEND_UNAVAILABLE | 检查服务器网络、Bot 和频道配置 |

异步业务失败通常仍以 200 返回任务对象，status=failed；必须检查任务状态，而不只是 HTTP。

数据默认在 TUNNEL_DATA_DIR：disk-auth.json、disk-secret.key、disk-operations.json、telegram-drive-*.json、disk-spaces.json 和 disk-spaces/。务必一起备份索引与密钥，使用受限操作系统权限；本版索引只支持单写入服务进程，不能多实例同时写同一数据目录。

官方 getFile 仍有 20 MB 下载限制。浏览器已缓存副本可用于读取/修复；超过限制的在线下载需管理员配置 Local Bot API Server。使用官方 API 时不要把上传成功误认为能随时从 getFile 下载大文件。

参考：[Telegram Bot API](https://core.telegram.org/bots/api)、[SimpleWebAuthn Server](https://simplewebauthn.dev/docs/packages/server)、[Passkey](https://simplewebauthn.dev/docs/advanced/passkeys)。
