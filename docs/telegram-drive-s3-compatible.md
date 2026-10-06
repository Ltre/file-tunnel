# Telegram 网盘 S3 Compatible API

实现核对日期：2026-10-03。

本文用于要求 S3 协议的第三方系统（如 FolderSync）。接受本系统 HTTP JSON / 文件流协议的应用使用独立的 [传统网盘 API 文档](adapter/telegram-disk-api.md)，两套接口的凭据和响应格式不能互换。

S3 与传统 API 是两个协议入口，共用网盘存储核心；`server/s3/routes.js` 调用 `server/object-storage.js`，再复用网盘上传流水线 / 按需分片读取，并非通过 HTTP 调用 `/api/telegram/disk/v1`。传统 API 本身不是 S3 协议，也不是 S3 客户端必须调用的中间接口。

## 1. 入口与资源映射

本节以当前分支实现为准。S3 API 使用 AWS Signature Version 4（SigV4），入口区分大小写：

| 用途 | 地址 | 鉴权 / 功能 |
|---|---|---|
| S3 Endpoint | `https://HOST/S3API` | SigV4，path-style Bucket / 对象操作 |
| 对象读取入口 | `https://HOST/s3/{bucket}/{key}` | 同样必须使用 SigV4，仅 GET / HEAD；不是公开分享链接 |

`/s3/{bucket}/{key}` 是另一个只读 HTTP 入口，不是可直接粘贴到浏览器地址栏的公开下载链接。每次 GET / HEAD 都要由 S3 客户端使用有权访问该 Bucket 的 Access Key / Secret Access Key 生成 SigV4 请求，并携带签名请求头；只有 URL、没有签名头会被拒绝。当前不支持 presigned URL，因此也不能生成无需签名请求头的临时下载链接。`/s3` 与 `/S3API` 使用同一组凭据和 Bucket 映射规则，但 SigV4 覆盖完整请求路径：针对 `/S3API/{bucket}/{key}` 算出的签名不能用于 `/s3/{bucket}/{key}`。两种路径都要结合签名凭据才能确定实际网盘对象。

例如 Bucket `mobile` 中对象 `音乐/专辑/01 Song.flac` 的 API 路径为 `/S3API/mobile/音乐/专辑/01 Song.flac`，客户端按标准 URL 编码并签名。签名必须包含完整挂载路径 `/S3API`（读取入口则为 `/s3`）；不能按 `/mobile/...` 签名后再追加前缀。`mobile` 是下文示例中的 Bucket 别名，名称本身不表示网盘分区。

### 1.1 Bucket、网盘用户与分区

一组 Access Key / Secret Access Key 固定绑定一个网盘用户 UUID（`userId`），其每条 Bucket 映射保存一个 S3 客户端可见的 `bucket` 名称和一个网盘分区名 `diskSpace`。请求 `/S3API/{bucket}/{key}` 时，服务端**先按签名中的 Access Key ID 确定凭据**，再只在该凭据的映射中查找 `bucket`，用凭据的 `userId` 加上映射的 `diskSpace` 定位网盘数据。`diskSpace` 为空字符串表示默认分区。Bucket 名只是可配置的别名，字面内容不会自动决定用户或分区；它不是 Telegram 频道，也不是第三方 `app_id`。

以下均为示例映射，特意让 Bucket 名和分区名不同：

| 签名凭据绑定用户 | Bucket → `diskSpace` | 请求路径 | 实际网盘逻辑位置 |
|---|---|---|---|
| 用户 U1 | `mobile` → `""` | `/S3API/mobile/a.zip` | U1 / 默认分区 / `a.zip` |
| 用户 U1 | `camera` → `family` | `/S3API/camera/2027/b.jpg` | U1 / `family` 分区 / `2027/b.jpg` |
| 用户 U2 的另一组凭据 | `vault` → `archive` | `/S3API/vault/2027/b.jpg` | U2 / `archive` 分区 / `2027/b.jpg` |

斜杠后的 `key` 是分区内的相对目录和文件名：`a.zip` 对应 `a.zip`，不会因 Bucket 映射而改名为 `z.zip`。同一组凭据中的 Bucket 名不得重复。同一分区也可以有多个 Bucket 别名，它们看到的是同一批逻辑文件，不会生成副本。凭据仅能访问其列出的 Bucket，S3 请求不能另传 `user_id` 切换用户；S3 与原生网盘中同一用户、同一分区的文件互相可见。

**当前实现的限制：请求路径本身不是全局唯一的对象标识。**不同凭据允许重复使用同一个 Bucket 名。例如，若 U1 的凭据把 `camera` 映射到 `family`，U2 的凭据也把 `camera` 映射到 `archive`，同一请求路径 `/S3API/camera/2027/b.jpg` 用 U1 的 Access Key 签名会访问 U1 / `family`，用 U2 的 Access Key 签名会访问 U2 / `archive`。因此必须连同签名凭据理解请求指向，不能仅凭 URL 路径判断是哪一份文件。修改凭据绑定用户或 Bucket 映射也会改变后续请求所指向的逻辑位置，不搬迁已有文件。若要求 URL 路径单独且长期唯一定位一份数据，需要另行设计全局 Bucket 唯一性和映射变更规则；当前代码没有实现。当前也不提供 S3 CreateBucket / DeleteBucket，Bucket 由接入配置中的映射建立。

### 1.2 上传存储后端与已有文件

`userId + diskSpace` 决定文件在网盘中的逻辑归属；“上传存储后端”决定需要向 Telegram 发送新文件内容时使用哪组 Bot 凭据、目标频道和 Bot API 地址。每条 Bucket 映射可以留空 `backendId`，使用服务器当前配置的 Bot Token、当前启用的网盘托管频道和 Bot API 地址；也可以指定一个已经保存的后端 ID。Bucket 名或分区名都不决定 Telegram 频道。

后台“已有后端”下拉框读取网盘已保存的后端记录（`disk_backends`）；这些记录主要由传统网盘 API 换取令牌时，按 Bot Token、频道和 Bot API 地址组合登记。它们不是“托管频道”清单，后台 S3 页面也没有新建后端、核对历史文件与后端对应关系或迁移文件的流程。**现阶段普通 S3 接入请保持“默认网盘后端”**；显式后端 ID 是供已明确掌握相应 Bot/频道配置的现有接入复用的能力，不应仅凭下拉框里出现一个频道 ID 就选择它。第三方 S3 客户端不会取得 Bot Token。

新对象上传和 CopyObject 目标需要写入 Telegram 时使用目标 Bucket 映射指定的后端；文件索引会保存实际使用的 `backendId` 和 `channelId`。已有文件的读取和删除按文件自身记录的物理后端处理，更改 Bucket 映射的后端或切换当前托管频道不会迁移旧文件。对于未记录显式 `backendId` 的默认后端文件，读取时使用文件记录的旧 `channelId` 和服务器**当前**配置的 Bot Token；更换 Bot 或撤销它对旧频道的访问权限，可能导致旧文件无法读取或清理。命中共享 Content 的上传可能复用已有 Telegram 内容，不必重新发送消息；0 Byte 对象和目录 marker 也不发送文件内容。

## 2. 管理第三方接入与凭据

### 2.1 后台界面

管理员从 `/admin` 的“扩展配置 → S3 API 第三方接入”进入 `/s3-management`。每个第三方应用、设备或用途单独建立一组 Access Key / Secret Access Key，便于独立停用和轮换。

- **备注**：用于辨认第三方，例如“FolderSync · 手机 A”；最长 160 字符，可以修改。
- **绑定网盘账号**：选择已经建立的网盘用户 UUID，不是 Telegram 数字 User ID。管理页同时显示账号名称和 UUID。
- **Bucket → 网盘分区**：为所选用户填写 S3 Bucket 别名并选择其默认分区或已存在的命名分区；Bucket 名与分区名不要求相同，映射规则见第 1.1 节。
- **上传存储后端**：每条映射独立选择；普通接入保持“默认网盘后端”。“已有后端”及旧文件读取规则见第 1.2 节。
- **启用 / 停用**：对新 S3 请求立即生效，不删除网盘用户、对象或已建立的映射。
- **修改**：可以修改备注、绑定用户、Bucket 映射和启用状态；不会搬迁已有文件或改变文件所有权。若其他管理操作已经更新该凭据，过期表单会被拒绝，需要刷新再编辑。
- **轮换 Secret**：Access Key ID 保持不变，生成新 Secret，原 Secret 对新请求立即失效。需要同步更新第三方客户端；新 Secret 只在本次生成后的卡片中显示，不会在以后查看列表时恢复显示。

分区下拉框只显示当前用户的默认分区，以及该用户已有使用记录或文件 / 目录的命名分区；页面不提供新建分区操作。如果只有“默认分区”，可先通过已鉴权的传统网盘 API，以该用户 UUID 和所需 `disk_space` 发起业务请求：服务端在处理请求时登记该用户使用的分区，不必先上传文件；随后刷新本页即可选择。S3 客户端本身不需要调用传统 API。

创建结果和轮换结果中的 Secret 只在当前页面暂时显示，不写入浏览器持久缓存；请及时复制并保存。管理页列出 Endpoint、Region、path-style 和 SigV4 配置信息；关闭 Secret 卡片或离开页面后不再显示 Secret。停用、轮换和改动映射不会强制终止已经通过鉴权的请求，请在敏感权限切换前安排客户端停止正在进行的传输。

管理页面及 `/api/admin/s3-credentials` 均使用现有后台登录鉴权。写入接口还检查请求来源，禁止其它网站跨站提交管理操作。这些后台 JSON 接口只用于管理配置，不属于 S3 对象协议，也不替代 SigV4 鉴权。

页面中的“接入手册”打开 `/s3-api-guide`，由服务器直接读取本篇 `docs/telegram-drive-s3-compatible.md` 并渲染为可阅读的页面，不维护第二份手册内容。部署包必须包含这份 Markdown；手册链接及代码按安全规则渲染，不执行 Markdown 中的 HTML / JavaScript。

### 2.2 命令行

先在网盘中建立用户，取得网盘用户 UUID；不是 Telegram 数字 User ID。管理员在服务器项目目录执行：

~~~powershell
node tools/s3-credentials.cjs --data-dir .tunnel-data --create --user-id "<网盘用户UUID>" --remark "FolderSync 手机" --bucket "mobile=" --bucket "camera=photos"
~~~

- 可重复 `--bucket bucket=diskSpace`；等号左侧是 S3 Bucket 别名，右侧是所绑定用户的网盘分区名，留空右侧表示默认分区。示例中 `mobile` 指向默认分区，`camera` 指向 `photos` 分区；两侧名称无需相同。Bucket 名称为 3–63 位小写字母、数字、点或短横线，首尾为字母 / 数字，不能含连续两个点、IPv4 格式或 AWS 保留的前后缀，同一凭据下不得重复。新建及修改映射遵循这项约束，已有记录的读取和停用保持兼容。保留前缀为 `xn--`、`sthree-`、`amzn-s3-demo-`；保留后缀为 `-s3alias`、`--ol-s3`、`.mrap`、`--x-s3`、`--table-s3`、`-an`。参考 [AWS Bucket 命名规则](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html)。
- 可选 `--backend-id "<后端UUID>"` 将同一个已保存的上传后端应用于本次创建的全部 Bucket；与后台页面逐条映射选择不同。普通接入请省略，使用默认网盘后端；旧对象的读取 / 删除仍使用文件自身关联的后端，详见第 1.2 节。
- 可选 `--remark` 设置第三方备注。命令行允许预先填写尚未在后台下拉框出现的命名分区；这只保存 Bucket 映射，不会创建文件。后台界面限定为用户已登记或已有内容的分区，避免误绑定。
- 创建结果含 `accessKeyId`、`secretAccessKey`、`userId`、`bucketMappings`、备注和状态等。Secret Access Key **只在创建或轮换的当次结果中输出**，立即安全保存。
- `.tunnel-data/s3-credentials.json` 保存映射及 AES-256-GCM 加密 Secret，独立密钥位于 `.tunnel-data/s3-secret.key`。两者一起备份，不得公开。S3 凭据配置目前仍使用该独立文件，不在 `disk.sqlite` 中。

查看非敏感凭据 / 映射和停用：

~~~powershell
node tools/s3-credentials.cjs --data-dir .tunnel-data --list
node tools/s3-credentials.cjs --data-dir .tunnel-data --disable "<AccessKeyID>"
node tools/s3-credentials.cjs --data-dir .tunnel-data --enable "<AccessKeyID>"
node tools/s3-credentials.cjs --data-dir .tunnel-data --rotate "<AccessKeyID>"
~~~

`--data-dir` 显式指定目录优先；省略时使用 `TUNNEL_DATA_DIR`，未设置该环境变量则使用当前执行目录的 `.tunnel-data`。请确保该目录与服务端实际使用的目录一致。

凭据每次请求重新读取，停用后新请求立即失效；不会删除网盘用户或对象。CLI 与后台配置修改共用短时独占锁和原子替换，配置忙时拒绝修改并提示重试，避免两个进程互相覆盖。若进程异常退出留下 `s3-credentials.json.lock`，先停止所有使用该数据目录的进程并确认没有配置写入，再清理残留锁文件；不要删除凭据 JSON 或 `s3-secret.key`。S3 不使用 `/auth/token`，无需向客户端提供 Bot Token、应用密钥或网盘 Bearer Token。

## 3. FolderSync 配置

| 配置项 | 设置 |
|---|---|
| 存储类型 | S3 Compatible |
| Server address / Endpoint | `https://HOST/S3API` |
| Access Key ID / Secret Access Key | 凭据工具创建的值 |
| Region | 推荐统一使用 `us-east-1` |
| Use path-style access for all requests | 开启 |
| Server-side encryption | 关闭 |
| 文件夹对象 / folder marker | 可以保留 |

使用标准 payload signing。当前支持普通 SHA-256、`UNSIGNED-PAYLOAD`、不带 trailer 的 `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`；不支持其它 trailer / checksum 签名变体。标准 PUT 提供 `Content-Length`；签名分块 PUT 提供 `x-amz-decoded-content-length`，每个签名块最多 20,000,000 字节。不要把 S3 Multipart Upload 与该签名分块格式或网盘内部 Telegram 分片混为一谈。

客户端若默认启用 S3 Multipart Upload，应关闭或将其阈值调整到不会使用该 API；遇到客户端不能关闭的未支持功能时需核对请求，不能通过关闭鉴权规避。

## 4. 支持的操作

以下路径相对于 `/S3API`，均需 SigV4；响应采用 S3 XML / 对象流，而不是原生 API 的 JSON 任务协议。

| 方法 | 路径 / 参数 | 操作与说明 |
|---|---|---|
| GET | `/` | ListBuckets，仅返回当前凭据映射的 Bucket |
| HEAD | `/{bucket}` | HeadBucket，返回 `x-amz-bucket-region` |
| GET | `/{bucket}?location` | GetBucketLocation；us-east-1 返回空 LocationConstraint |
| GET | `/{bucket}?list-type=2` | ListObjectsV2 |
| PUT | `/{bucket}/{key}` | PutObject，成功返回 200 与 ETag |
| GET | `/{bucket}/{key}` | GetObject，支持单段 Range |
| HEAD | `/{bucket}/{key}` | HeadObject，返回大小、类型、ETag、Last-Modified 等 |
| DELETE | `/{bucket}/{key}` | DeleteObject，成功返回 204 |
| PUT | `/{bucket}/{key}` + `x-amz-copy-source` | CopyObject，请求体为空；来源也必须位于本凭据可访问的 Bucket |
| POST | `/{bucket}?delete` | DeleteObjects，请求为 Delete XML；逐项结果在响应中 |

DeleteObjects 请求体最多 1 MiB，含 1–1000 个 Object/Key；`<Quiet>true</Quiet>` 省略成功项，但仍返回失败项。不支持 DOCTYPE / ENTITY 或携带版本 ID 的扩展 XML。

ListObjectsV2 支持 `prefix`、`delimiter`、`max-keys`（最多 1000）、`start-after`、`continuation-token` 和 `encoding-type=url`。`delimiter=/` 返回目录 CommonPrefixes；分页使用响应中的 `NextContinuationToken`，不要自行构造或跨 Bucket / prefix / delimiter 复用。

对象读取支持 `Range: bytes=START-END`、`bytes=START-` 和 `bytes=-SUFFIX`，返回 206、`Content-Range` 与实际 `Content-Length`；无 Range 返回 200。不支持一个请求中的多段 Range。按需读取所需 Telegram 分片，不要求先下载并合并整个大文件。普通 GET 与 `/s3` 读取入口均不允许匿名访问。

PutObject 的 `Content-Type` 和合规的 `x-amz-meta-*` 元数据会保留；GET / HEAD 回传对象元数据。可校验 payload SHA-256 和 `Content-MD5`。不要假定所有从普通网盘创建的文件 ETag 都等于文件 MD5；没有 S3 内容摘要的旧文件可使用分片索引生成的标识。

## 5. 对象、覆盖与底层上传语义

- 对象大小上限为 **2000 MiB（2,097,152,000 字节）**；0 Byte 普通文件和以 `/` 结尾的目录 marker 均支持。
- Key 使用 ZIP / 网盘式相对路径，支持中文、日文和文件名内部空格；UTF-8 总长度最多 1024 字节，目录最多 20 层，文件名最多 180 字符。路径段前后空白、连续 `/`、`.` / `..`、反斜杠及网盘非法名称会返回 `InvalidObjectName`，不会静默归一化改名；目录层级还受后台设置限制。
- S3 连续 PUT 请求体通过现有对象核心切成最多 20,000,000 字节的 Telegram 分片，复用原有网盘串行上传队列、分片哈希 / file_id 复用校验、逻辑文件关联、失败回滚及恢复清理。仍在每片接收完整后再发送 Telegram，收到合法分片消息确认后释放该片正文；不切入下面说明的可选渐进式上传。
- **S3 PUT 仍等待 Telegram 确认及索引提交后才返回成功**，不会返回原生网盘的 202 operation_id。原生 API 的 `/uploads/:id/queue` 是其客户端分片协议，不是 S3 API，也不会把一个 S3 PUT 改成异步操作。
- 覆盖先完成新对象上传 / 校验，再切换 Logical 引用；上传失败保留旧对象。同用户、同 Bot 的 CopyObject 直接引用源 Content，不重新 sendDocument/sendMediaGroup 或上传封面；跨 Bot 按现有读取 / 上传链路复制，不支持跨用户 Copy。
- S3 没有独立 RenameObject；客户端重命名通常使用 CopyObject 后 DeleteObject。删除文件以及覆盖目标（含 CopyObject 的目标覆盖）受现有协同编辑保护，受保护对象会返回 AccessDenied。
- 文件路径、名称和 MIME 等属于 Logical；新 Content caption 只保存物理排障信息。移动和改名不修改共享 caption。DELETE/覆盖只释放目标引用；最后引用和在途租约释放后由后台 outbox 清理，S3 删除成功不表示 Telegram 消息已同步删除。

### 共享 Content Object

已知完整 payload SHA-256 且命中健康 Content 的 PUT，先接收和验证实际全部请求体、大小及可选 MD5，再建立引用，命中时不新发 Telegram 正文消息。仍需发送 HTTP PUT 正文，不能把声明 hash 当作持有证明。候选损坏时改用已经验证的暂存正文构建新对象。

UNSIGNED-PAYLOAD / 无完整 SHA 的 PUT 保持逐片上传，到 EOF 后才取得可信 key 并 canonicalize；可能产生只属于该候选的重复消息及补偿。命中的内容身份、权限、读取 revision、缓存版本及迁移说明见 [共享 Content Object](telegram-drive-content-objects.md)。0 Byte 普通对象引用不含消息的空 Content；目录 marker 不建立 Content。SigV4、ETag 和同步响应语义不变。

### 与可选渐进式上传的边界

原生 JSON API 的 `POST /uploads` 已增加可选 `progressive: true`。浏览器默认显式启用；传统第三方 API 省略时继续旧流水线；**S3 PutObject、CopyObject、SigV4、ETag 及同步成功响应语义保持原实现**，不接受该 JSON 参数，也不会自动改为渐进式任务或原生 SSE 事件协议。现有 S3 请求仍可与浏览器任务同时运行，但共享 Telegram 后端的带宽及上游限制，隔离协议不等于隔离物理资源。

渐进式模式在 Node 持续落盘期间从首片已有字节启动 sendDocument，先取得临时 file_id/message_id，再按逻辑文件用 file_id 提交 2–10 项最终 Album（单片保留原消息）；最终索引保存新 message_id/media_group_id，不把临时 ID 当成最终关联。该模式使用 XHR 实际正文上传进度与约 250ms 的 `/uploads/{uploadId}/progress` SSE 快照，并保留任务轮询，两段网络进度交叠显示字节与速率。正文 100% 后仍需最终分组和短事务整批提交，不表示完成；这些字段和端点属于原生 API，不是 S3 扩展。

该模式默认在当前 API 实例限制 20 个活跃任务，进程内上传调度上限全局 4 / 每 Bot 4 / 每 Bot+Chat 2，并采用基础 1000ms pacing、Album 数量成本和 429 退避；这些新准入及渐进式调度规则不替换 S3 原有流水线。两种模式的 pending 队列阈值仍为 5 片或 100,000,000 字节，**100MB 不表示磁盘总占用上限**：渐进式已确认正文保留到该逻辑文件 finalize，超大文件的暂存仍可接近文件大小。

渐进式完整来源在 finish、SHA-256 和授权检查通过后，可在重启时继续未完成步骤并复用已确认分组；不完整浏览器来源会明确中断，结果未知不会盲重发，临时消息清理失败不回滚已经提交的有效文件。S3 的旧流水线重启中断及回滚行为继续原逻辑，不因此获得浏览器断线续传或未知结果自动恢复能力。详细字段、恢复条件及 `TELEGRAM_TEMP_CLEANUP_PENDING` 警告见 [传统网盘 API 的上传章节](adapter/telegram-disk-api.md#6-创建分片上传与原手机路径)。

## 6. 未提供的功能与错误处理

当前不提供 Create / Delete Bucket、ListObjects v1、S3 Multipart Upload API、匿名访问、presigned URL、SSE（S3 服务端加密）、ACL、对象版本控制、Object Lock、对象标签和非 STANDARD 存储类别。兼容能力以本节操作表为准，不能把它当作完整 AWS S3 服务。

错误响应为 S3 XML，包含 Code、Message、RequestId；响应头 `x-amz-request-id` 可用于关联问题。HEAD 错误不带正文。

| HTTP | Code 示例 | 处理 |
|---|---|---|
| 403 | InvalidAccessKeyId / AccessDenied | 核对凭据是否启用及授权范围 |
| 403 | SignatureDoesNotMatch | 核对完整 Endpoint 路径、Host、编码、签名头及代理改写 |
| 403 | RequestTimeTooSkewed | 校准客户端 / 服务端时间；当前容许偏差 15 分钟 |
| 404 | NoSuchBucket / NoSuchKey | 检查凭据映射和对象路径 |
| 400 | InvalidObjectName / InvalidArgument | 修改 Key 或请求格式 |
| 400 | IncompleteBody / XAmzContentSHA256Mismatch / BadDigest | 检查长度、传输是否完整及摘要 |
| 409 | OperationAborted | 同名 / 修改冲突，先检查对象状态再处理 |
| 413 | EntityTooLarge | 检查对象上限及签名块大小 |
| 416 | InvalidRange | 修改 Range；响应可附 `Content-Range: bytes */SIZE` |
| 501 | NotImplemented | 关闭客户端未支持的操作 / 特性 |
| 503 | SlowDown | 遵循 Retry-After，降低请求频率 |
| 500 | InternalError | 结合请求 ID 和服务器日志排查底层错误 |

S3 路由独立限流，目前按 IP 每 15 分钟最多 10000 次，触发时返回 `SlowDown` 和 `Retry-After: 60`。DeleteObjects 即使 HTTP 成功也必须检查各项 Error。PUT / COPY 遇到结果未知的断连，应先通过 HEAD / 列表确认当前对象；不能仅因客户端未收到响应就反复发送。

## 7. 部署与上线核验

S3 入口放在 HTTPS 反向代理后；代理需保留原始路径、查询参数、Host、Authorization、`x-amz-*`、Range 及长度相关头，不重写 `/S3API` 前缀。允许大请求流、关闭不必要的请求体缓存，并为等待 Telegram 确认的大对象 PUT 设置足够长的请求超时。原生客户端分片的队列探测不会消除 S3 单个 PUT 自身的长请求。

先在测试环境通过真实 FolderSync 设备确认：连接、列表与分页、多级目录、超过 20 MB 上传、跨分片 Range 下载、覆盖、复制 / 重命名、批量删除、0 Byte 文件、目录 marker、中文 / 日文 / 空格 Key，以及服务重启后读取。自动化测试不代替客户端真机和公网代理验收。

实现位置：`server/s3/routes.js`、`server/s3/sigv4.js`、`server/s3/credentials.js`、`server/object-storage.js`；后台管理位于 `server/s3/admin.js` 和 `client/s3-management.js`，安全手册渲染位于 `server/s3/guide.js`。共用上传 / 读取适配及分区登记位于 `server/disk-api.js`；已保存后端的登记和解析位于 `server/disk-auth.js`，默认后端由 `server.js` 传入；凭据工具为 `tools/s3-credentials.cjs`。设计背景见 [Implementation Guide](<../prompts/ideas/Telegram Drive S3-Compatible API Implementation Guide (260920).md>)，实际支持范围以上述当前实现为准。
