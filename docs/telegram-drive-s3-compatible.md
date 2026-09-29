# Telegram 网盘 S3 Compatible API

实现核对日期：2026-09-29。

本文用于要求 S3 协议的第三方系统（如 FolderSync）。接受本系统 HTTP JSON / 文件流协议的应用使用独立的 [传统网盘 API 文档](adapter/telegram-disk-api.md)，两套接口的凭据和响应格式不能互换。

S3 与传统 API 是两个协议入口，共用网盘存储核心；`server/s3/routes.js` 调用 `server/object-storage.js`，再复用网盘上传流水线 / 按需分片读取，并非通过 HTTP 调用 `/api/telegram/disk/v1`。传统 API 本身不是 S3 协议，也不是 S3 客户端必须调用的中间接口。

## 1. 入口与资源映射

本节以当前分支实现为准。S3 API 使用 AWS Signature Version 4（SigV4），入口区分大小写：

| 用途 | 地址 | 鉴权 / 功能 |
|---|---|---|
| S3 Endpoint | `https://HOST/S3API` | SigV4，path-style Bucket / 对象操作 |
| 对象读取入口 | `https://HOST/s3/{bucket}/{key}` | 同样必须使用 SigV4，仅 GET / HEAD；不是公开分享链接 |

例如 Bucket `backup` 中对象 `音乐/专辑/01 Song.flac` 的 API 路径为 `/S3API/backup/音乐/专辑/01 Song.flac`，客户端按标准 URL 编码并签名。签名必须包含完整挂载路径 `/S3API`（读取入口则为 `/s3`）；不能按 `/backup/...` 签名后再追加前缀。

Bucket 是 **Access Key 所绑定的网盘用户 UUID 与分区的映射**，不是 Telegram 频道，也不是第三方 `app_id`。`backup=` 表示该用户的默认分区；`photos=photos` 表示名为 photos 的分区。凭据仅能访问其列出的 Bucket，不能通过请求另一个 `user_id` 切换用户。S3 对象和原生网盘中同一用户、同一分区的文件互相可见。

## 2. 建立、查看与停用凭据

先在网盘中建立用户，取得网盘用户 UUID；不是 Telegram 数字 User ID。管理员在服务器项目目录执行：

~~~powershell
node tools/s3-credentials.cjs --data-dir .tunnel-data --create --user-id "<网盘用户UUID>" --bucket "backup=" --bucket "photos=photos"
~~~

- 可重复 `--bucket bucket=diskSpace`；Bucket 名称为 3–63 位小写字母、数字、点或短横线，首尾为字母 / 数字，不能含连续两个点，同一凭据下不得重复。
- 可选 `--backend-id "<后端UUID>"` 指定已存在的存储后端，应用于该凭据全部 Bucket；省略时使用默认网盘上传后端。旧对象的读取 / 删除仍使用文件自身关联的后端。
- 创建结果含 `accessKeyId`、`secretAccessKey`、`userId`、`bucketMappings`。Secret Access Key **只在创建时输出一次**，立即安全保存。
- `.tunnel-data/s3-credentials.json` 保存映射及 AES-256-GCM 加密 Secret，独立密钥位于 `.tunnel-data/s3-secret.key`。两者一起备份，不得公开。S3 凭据配置目前仍使用该独立文件，不在 `disk.sqlite` 中。

查看非敏感凭据 / 映射和停用：

~~~powershell
node tools/s3-credentials.cjs --data-dir .tunnel-data --list
node tools/s3-credentials.cjs --data-dir .tunnel-data --disable "<AccessKeyID>"
~~~

凭据每次请求重新读取，停用后新请求立即失效；不会删除网盘用户或对象。S3 不使用 `/auth/token`，无需向客户端提供 Bot Token、应用密钥或网盘 Bearer Token。

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
- S3 连续 PUT 请求体通过现有对象核心切成最多 20,000,000 字节的 Telegram 分片，复用网盘串行上传队列、分片哈希 / file_id 复用校验、逻辑文件关联、失败回滚及恢复清理。
- **S3 PUT 仍等待 Telegram 确认及索引提交后才返回成功**，不会返回原生网盘的 202 operation_id。原生 API 的 `/uploads/:id/queue` 是其客户端分片协议，不是 S3 API，也不会把一个 S3 PUT 改成异步操作。
- 覆盖先完成新对象上传 / 校验，再切换索引并安排旧消息清理；上传失败保留旧对象。同 Bot 复制可复用已验证的 Telegram file_id，跨存储后端按现有读取 / 上传链路复制。
- S3 没有独立 RenameObject；客户端重命名通常使用 CopyObject 后 DeleteObject。删除文件以及覆盖目标（含 CopyObject 的目标覆盖）受现有协同编辑保护，受保护对象会返回 AccessDenied。
- 文件路径以网盘索引为准，移动不再修改 Telegram caption 中的 `path`；新上传不写该字段，文件重命名仍保留名称同步机制。

## 6. 未提供的功能与错误处理

当前不提供 Create / Delete Bucket、ListObjects v1、S3 Multipart Upload API、匿名访问、presigned URL、SSE、ACL、对象版本控制、Object Lock、对象标签和非 STANDARD 存储类别。兼容能力以本节操作表为准，不能把它当作完整 AWS S3 服务。

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

实现位置：`server/s3/routes.js`、`server/s3/sigv4.js`、`server/s3/credentials.js`、`server/object-storage.js`；共用上传 / 读取适配位于 `server/disk-api.js`，凭据工具为 `tools/s3-credentials.cjs`。设计背景见 [Implementation Guide](<../prompts/ideas/Telegram Drive S3-Compatible API Implementation Guide (260920).md>)，实际支持范围以上述当前实现为准。
