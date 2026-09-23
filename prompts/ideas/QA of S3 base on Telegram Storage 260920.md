
问：

	看到Android软件Folder Sync（多级目录文件同步软件）支持添加`S3 Compatible`类型的账户，需要提供`Access key ID`、`Secret access key`、`服务器地址`、`是否服务端加密`参数。为此考虑能不能充分利用网盘API，甚至让网盘支持S3对象存储协议。
	不过想到之前关于以Telegram存储为基础的基础设施的讨论记录 `Make full use of Telegram storage 260920.md`，你评估是否可行，如果可行，应该怎样开发？
	


答（由于AI没有考虑项目具体情况，所以这里的回答不具强参考性，仅作为得出最后结论的铺垫）：
	
	
	可行，而且我认为**值得做**。你之前那份讨论里已经提出过 `Telegram-backed S3-lite`、CAS 内容寻址和统一 Object Store；现在 FolderSync 的实际需求等于给这个方向找到了一个很具体的落地入口。

	FolderSync 当前的 `S3 Compatible` 使用 Amazon S3 Kotlin SDK，能够填写 Access Key、Secret、服务器地址，并支持 path-style、payload signing、SSE 等兼容选项。也就是说，你不需要给 FolderSync 开发 Telegram 专用插件，只需要让现有 Telegram 网盘前面多出一个足够兼容的 **S3 Gateway**。([FolderSync][1])

	## 我建议的整体架构

	不要让 S3 代码直接操作 Telegram Bot API，而是这样分层：

	```text
	FolderSync / rclone / Cyberduck / AWS SDK
						│
						│ S3 REST + AWS Signature V4
						▼
				 S3 Compatible Gateway
						│
			 ┌──────────┴──────────┐
			 │                     │
		 S3 元数据层          Object Storage Core
	 SQLite / PostgreSQL            │
								   │
						 现有 Telegram 网盘 API
								   │
								   ▼
						  Telegram Storage
					  Bot + 托管频道 + file_id
	```

	也就是说：

	> **Telegram 网盘 API 继续作为底层存储能力；S3 只是它上面新增的一套标准协议适配层。**

	不要为了 S3 再写第二套上传、下载、删除 Telegram 文件的代码。

	这也正好符合你之前那份设计中“Telegram Object Store + CAS + Version Store”作为底座，再让不同上层系统复用的思路。

	---

	## 第一版不需要实现完整 AWS S3

	S3 非常庞大，但 FolderSync 实际同步文件只需要其中一小部分。

	第一版建议实现：

	| S3 API          | 用途                |
	| --------------- | ----------------- |
	| `ListBuckets`   | 列出可用网盘空间          |
	| `HeadBucket`    | 测试 bucket 是否存在    |
	| `ListObjectsV2` | 浏览目录、同步扫描         |
	| `PutObject`     | 上传文件              |
	| `GetObject`     | 下载文件              |
	| `HeadObject`    | 获取大小、时间、ETag、MIME |
	| `DeleteObject`  | 删除                |
	| `DeleteObjects` | 批量删除              |
	| `CopyObject`    | 复制/重命名辅助          |
	| `Range GET`     | 断点续传、媒体读取         |

	其中 `ListObjectsV2` 很重要。S3 本身没有真正的目录，目录只是：

	```text
	photos/2026/a.jpg
	photos/2026/b.jpg
	documents/a.pdf
	```

	通过：

	```text
	prefix=photos/
	delimiter=/
	```

	模拟出来。AWS 本身就是这么定义的，所以与你的虚拟网盘目录树非常容易映射。([AWS 文档][2])

	---

	## 数据模型应该这样改

	Telegram 不应该负责“列目录”。

	Telegram 负责的是**文件实体**，SQLite/PostgreSQL 负责快速索引。

	例如：

	```text
	s3_buckets
	-----------
	id
	name
	created_at
	backend_namespace

	s3_objects
	-----------
	bucket_id
	object_key
	object_id
	size
	content_type
	etag
	sha256
	last_modified
	telegram_chat_id
	telegram_message_id
	telegram_file_id
	deleted

	storage_objects
	---------------
	object_id
	sha256
	size
	mime
	telegram_file_id
	telegram_message_id
	telegram_chat_id
	ref_count
	```

	其中：

	```text
	bucket = 逻辑存储空间
	key    = /照片/2026/abc.jpg
	object = 实际文件内容
	```

	一个 S3 key：

	```text
	backup/photos/a.jpg
	```

	最终只需要指向：

	```text
	tg://object/sha256:xxxxxxxx
	```

	这就是你之前讨论中的 CAS。

	相同内容即使出现在：

	```text
	bucket-a/a.zip
	bucket-b/backups/a.zip
	bucket-c/history/a.zip
	```

	也可以只存在一个 Telegram 文件实体。

	---

	## Bucket 不建议直接等同一个 Telegram 频道

	技术上可以：

	```text
	一个 bucket = 一个 Telegram channel
	```

	但我不建议这么做。

	更合理的是：

	```text
	多个 S3 bucket
		   ↓
	逻辑 namespace
		   ↓
	统一 Telegram Storage Pool
		   ↓
	一个或多个托管频道
	```

	例如：

	```text
	photos
	backup
	phone
	documents
	```

	可以都存在同一个 Telegram 托管频道，只由数据库区分。

	以后频道数据太多，再自动分片：

	```text
	storage-001
	storage-002
	storage-003
	```

	上层 S3 完全不知道这些细节。

	---

	## Access Key / Secret 怎么实现

	后台新增：

	```text
	S3 接入管理

	Access Key ID:
	TG3A7DF92...

	Secret Access Key:
	xxxxxxxxxxxxxxxx

	权限:
	Read / Write / Delete

	允许 Bucket:
	*
	```

	S3 Gateway 实现 **AWS Signature Version 4（SigV4）** 校验即可。AWS 已经把 SigV2 淘汰，当前标准应该直接做 SigV4。([AWS 文档][3])

	FolderSync 就填：

	```text
	类型：
	S3 Compatible

	Access key ID:
	TG3A7DF92...

	Secret access key:
	xxxxxxxx

	服务器地址:
	https://s3.example.com

	Region:
	us-east-1

	Use path-style:
	开启

	Server-side encryption:
	第一版关闭
	```

	于是请求就是：

	```text
	https://s3.example.com/photos/DCIM/IMG001.jpg
	```

	也就是 path-style：

	```text
	/{bucket}/{key}
	```

	第一版先别折腾：

	```text
	photos.s3.example.com
	```

	这种 virtual-hosted style。

	---

	## 最大的技术点其实是“大文件”

	这是我认为你开发时最应该提前设计好的地方。

	官方 Bot API 当前普通模式：

	```text
	上传：50 MB
	下载：20 MB
	```

	而自建 **Local Bot API Server**：

	```text
	上传：最高 2000 MB
	下载：无 Bot API 文件大小限制
	```

	Telegram 官方当前就是这样规定的。([Telegram][4])

	所以如果要把它真正当 S3：

	> **强烈建议 Telegram 网盘底层使用 Local Bot API Server。**

	否则 FolderSync 随便一个手机视频就可能突破限制。

	---

	## 更进一步：S3 对象可以突破 Telegram 单文件 2GB

	这一点其实非常有意思。

	S3 对外看到：

	```text
	video.mkv
	8.6 GB
	```

	并不意味着 Telegram 里面也必须存在一个 8.6GB 文件。

	底层完全可以：

	```text
	video.mkv
	│
	├── part-0001    256 MB → Telegram
	├── part-0002    256 MB → Telegram
	├── part-0003    256 MB → Telegram
	...
	└── manifest
	```

	数据库保存：

	```text
	object_id = xxx
	size = 9234176256

	chunks:
	0 → file_id A
	1 → file_id B
	2 → file_id C
	...
	```

	S3 客户端 GET：

	```text
	GET /bucket/video.mkv
	```

	Gateway 再连续流式输出这些 chunk。

	这样：

	> **S3 对象大小可以不再受单条 Telegram document 大小限制。**

	甚至 `Range` 请求：

	```http
	Range: bytes=1073741824-2147483647
	```

	Gateway 只需要找出涉及的 chunk，不必把整个 8GB 文件重新下载。

	这是非常值得做的。

	---

	## S3 Multipart Upload 更应该利用这个模型

	后续应实现：

	```text
	CreateMultipartUpload
	UploadPart
	CompleteMultipartUpload
	AbortMultipartUpload
	```

	AWS 本身就是把多个 part 关联到一个 `UploadId`，最后再完成组合。([AWS 文档][5])

	而你的 Telegram 后端可以天然映射成：

	```text
	S3 UploadPart #1
		   ↓
	Telegram file_id A

	S3 UploadPart #2
		   ↓
	Telegram file_id B

	S3 UploadPart #3
		   ↓
	Telegram file_id C

	CompleteMultipartUpload
		   ↓
	只生成 manifest
		   ↓
	无需重新拼出一个巨大文件
	```

	这个设计非常漂亮，因为**S3 multipart 和 Telegram 分块存储天然吻合**。

	---

	## ETag 和校验也应该认真做

	`PutObject` 返回：

	```http
	ETag: "xxxxxxxx"
	```

	S3 客户端会使用它判断对象是否变化。AWS 明确说明 ETag 并不保证永远等于 MD5，所以你可以把它实现成稳定的内容标识。([AWS 文档][6])

	我建议：

	```text
	内部主索引：
	SHA-256

	单 PUT：
	ETag = MD5 或稳定内容 ETag

	S3 multipart：
	尽量实现 AWS multipart ETag 规则
	```

	这样兼容性最好。

	---

	## 删除恰好可以复用你刚开发的 Telegram 删除策略

	这是另一个很合适的地方。

	S3：

	```http
	DELETE /bucket/a.zip
	```

	对客户端而言，只要求之后：

	```text
	HEAD → 404
	GET  → 404
	LIST → 不再出现
	```

	Telegram 后端是不是物理删除成功，**S3 根本不需要知道**。

	所以：

	```text
	DELETE Object
		  ↓
	先立即在 metadata 标记 deleted
		  ↓
	S3 世界立即认为文件已经不存在
		  ↓
	后台处理 Telegram
	```

	Telegram：

	```text
	<48h
	→ deleteMessage

	>48h
	→ 你现在设计的：
	  editMessageMedia
	  → 1 Byte 占位文件
	  → caption = xxx 已删除
	```

	非常契合。

	这叫：

	```text
	logical delete
	+
	best-effort physical cleanup
	```

	S3 语义不受 Telegram 48 小时限制影响。

	---

	## SSE 第一版我反而建议不做

	FolderSync 有：

	```text
	Server-side encryption
	```

	第一版让用户：

	```text
	关闭
	```

	即可。

	以后如果做，可以在 Gateway 层实现：

	```text
	客户端
	 ↓
	S3 Gateway
	 ↓ AES-256-GCM
	Telegram 存密文
	```

	GET 时透明解密。

	但这涉及：

	```text
	密钥管理
	Range 解密
	CAS 去重
	密文版本
	multipart 加密
	```

	会明显增加复杂度。

	而 FolderSync 自己已经提供客户端文件加密能力，并且可以在文件离开设备前加密。([FolderSync][7])

	所以第一阶段没必要碰 SSE。

	---

	## 性能上要接受一个事实

	它会是：

	> **S3 compatible，而不是 S3 performance compatible。**

	也就是：

	```text
	LIST / HEAD
	非常快
	→ SQLite

	PUT / GET
	比较慢
	→ Telegram

	大文件首次 GET
	慢

	被 CDN / 本地 cache 命中后
	快
	```

	这与之前那份讨论里把 Telegram 定位成“慢速对象存储 + CDN/Gateway”的思路完全一致。

	因此它很适合：

	```text
	手机照片备份
	冷备份
	文档
	软件包
	APK
	媒体归档
	设备同步
	版本快照
	个人文件
	```

	不适合：

	```text
	数据库数据文件实时读写
	高频随机 IO
	大量小对象每秒数千次操作
	```

	---

	## 我建议开发顺序

	1. **先抽象 Object Storage Core**：把现有 Telegram 网盘 API 的上传、下载、删除、metadata、`file_id` 等统一封装，避免 S3 直接依赖 Telegram 细节。

	2. **做最小 S3 Gateway**：SigV4 + `ListBuckets / HeadBucket / ListObjectsV2 / PUT / GET / HEAD / DELETE`，先把 FolderSync 真机跑通；FolderSync 当前明确支持 path-style 和自定义 S3 Compatible 服务器。([FolderSync][1])

	3. **加入 Range、CopyObject、批量删除、zero-byte folder objects**，让 FolderSync/rclone 的文件管理行为完整起来。

	4. **实现 multipart + Telegram chunk manifest**，从此让“一个 S3 对象”不再等同“一个 Telegram 文件”。

	5. **再做 CAS、版本管理、预签名 URL、CDN Gateway、SSE**。这时候它才真正从“Telegram 网盘”升级成你之前讨论的 **Telegram-backed storage infrastructure**。

	如果目标**仅仅是让 FolderSync 能同步**，其实 WebDAV 比 S3 更容易，FolderSync 本身也原生支持 WebDAV。([FolderSync][8])
	但如果你的目标是你前面说的“充分利用 Telegram 存储，建立通用基础设施”，那我会选择 **S3 Compatible**——因为一旦这一层做好，接入的不只是 FolderSync，而是一整个现成的 S3 软件生态。

	[1]: https://foldersync.io/docs/help/cloudservices/?utm_source=chatgpt.com "Add cloud service account - FolderSync Documentation"
	[2]: https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html?utm_source=chatgpt.com "ListObjectsV2 - Amazon S3"
	[3]: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/specify-signature-version.html?utm_source=chatgpt.com "Specifying the Signature Version in request authentication - Amazon Simple Storage Service"
	[4]: https://core.telegram.org/bots/api?utm_source=chatgpt.com "Telegram Bot API"
	[5]: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html?utm_source=chatgpt.com "CreateMultipartUpload - Amazon S3"
	[6]: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html?utm_source=chatgpt.com "PutObject - Amazon S3"
	[7]: https://foldersync.io/docs/help/v2/encryption/?utm_source=chatgpt.com "Encryption - FolderSync Documentation"
	[8]: https://foldersync.io/docs/help/fileprotocols/?utm_source=chatgpt.com "Add file protocol account - FolderSync Documentation"

	
	

问：
	
	
	
	首先我觉得你的回答并没有基于最新的分支dev/2608C-step2代码作答，会有一些提议不是完全符合我的要求。
	
	不照着你提的`我建议开发顺序`做。
	
	以下是我特别强调的方面：
	
	API服务器地址暂定为本系统HOST下的一个path：/S3API。
	通过S3 API获得到的对象内容地址前缀暂定为本系统HOST下的一个path：/s3
	S3 API的服务端代码不要放在原有的server.js中，而是将主要逻辑放在/server/s3.js中，只在server.js中简单引用/server/s3.js，切忌在server.js中写具体的S3 API逻辑代码，不要跟现有Drop2Tunnel的隧道文件传输链路、Telegram网盘API等业务逻辑耦合。
	如果S3 API代码比较多，要拆分，那么将拆分代码放到/server/s3目录中。

	你还提到最大的技术点是"大文件"，目前网盘不是已经实现了分片上传以及下载时逐个分片边从telegram拉取边下载到客户端吗？你可以看看dev/2608C-step2分支的代码。所以我不打算搭建Local Bot API Server。
	
	这版最低要实现让Folder Sync完美对接本系统开发的S3 API。
	
	我建议的当前需要立即开发的要点有：
		
		1、抽象 Object Storage Core：把现有 Telegram 网盘 API 的上传、下载、删除、metadata、file_id 等统一封装，避免 S3 直接依赖 Telegram 细节。注意，在这一点就要充分利用本系统网盘API已经实现的分片上传及按需加载分片下载。
		2、做最小 S3 Gateway：SigV4 + ListBuckets / HeadBucket / ListObjectsV2 / PUT / GET / HEAD / DELETE，先把 FolderSync 真机跑通；FolderSync 当前明确支持 path-style 和自定义 S3 Compatible 服务器。
		3、支持Range、CopyObject、批量删除、zero-byte folder objects，让 FolderSync/rclone 的文件管理行为完整起来。
	对于CAS、版本管理、预签名 URL、CDN Gateway、SSE，这类使Telegram网盘升级称为之前讨论的Telegram-backed storage infrastructure的构想，可以以后再实现。
	
	你应该结合前面关于网盘适配S3的讨论历史，并按照以上我现在说明的情况以及提的要求，重新梳理，撰写开发指引文档。
	
	
	
	
	
答：





我重新核对了 `Ltre/file-tunnel` 的 `dev/2608C-step2`。你指出得对：当前代码已经有完整的 **20,000,000 Byte Telegram 分片、客户端→服务器→Telegram 流水线、分片复用、Range 按需读取、分片缓存、48 小时后的占位文件软删除**，所以 S3 适配层不应该再另造一套大文件机制，更不需要 Local Bot API Server。之前关于 Telegram-backed S3/Object Store 的讨论仍可作为方向背景，但本轮范围应严格收缩到你现在指定的三项。

下面这份可以直接作为开发指引交给 Codex。

# Drop2Tunnel Telegram 网盘 S3 Compatible API 开发指引

## 1. 开发基线与目标

本次开发必须以 `Ltre/file-tunnel` 仓库最新的 `dev/2608C-step2` 分支代码为基线，不要按照一个假想的、尚未具备大文件能力的 Telegram 网盘重新设计。

当前版本已经具备成熟的 Telegram 网盘存储链路：

* `server/disk-limits.js` 中使用 `MAX_TELEGRAM_PART_SIZE = 20_000_000`，逻辑文件会拆分为多个 Telegram 物理分片。
* `server/telegram-drive.js` 已维护逻辑文件、目录、分片、`file_id`、`message_id`、offset、size、SHA-256 等索引信息。
* `server/disk-api.js` 已实现客户端分片接收、服务器到 Telegram 的流水上传、上传队列及失败回滚。
* `server/disk-telegram.js` 已实现分片上传、`file_id` 复用、逐分片读取、Range 请求和多分片顺序拼接。
* 下载已经可以根据请求 Range，只读取真正涉及的 Telegram 分片，并通过 `disk-part-cache` 边拉取边向客户端输出。
* Telegram 文件删除已经支持 48 小时以内直接删除、超过期限后用 1 Byte 占位文件替换的软删除逻辑。
* 当前逻辑文件上传上限为 `2000 * 1024 * 1024`，本轮继续沿用现有网盘能力，不搭建 Local Bot API Server。

本次开发的核心目标不是重新实现 Telegram 存储，而是在现有 Telegram 网盘之上增加一个标准化的 **S3 Compatible Gateway**，首先确保 Android FolderSync 的 `S3 Compatible` 账户能够稳定、完整地对接本系统。

FolderSync 当前的 `S3 Compatible` 类型使用官方 Amazon S3 Kotlin SDK，并支持自定义 Server address、path-style、payload signing、folder objects 等兼容选项，因此实现标准 S3 REST + Signature V4 是正确的接入方向。([FolderSync][1])

---

# 2. 固定 URL 设计

本轮固定采用以下地址：

```text
S3 API Endpoint
https://HOST/S3API

对象内容地址前缀
https://HOST/s3
```

FolderSync 中的 Server address 暂定填写：

```text
https://HOST/S3API
```

并启用：

```text
Use path-style access for all requests
```

因此标准 S3 请求形态应为：

```text
GET    /S3API
HEAD   /S3API/{bucket}
GET    /S3API/{bucket}?list-type=2
PUT    /S3API/{bucket}/{key}
GET    /S3API/{bucket}/{key}
HEAD   /S3API/{bucket}/{key}
DELETE /S3API/{bucket}/{key}
```

需要特别注意：**FolderSync/AWS SDK 的标准对象 GET 仍然必须能够通过 `/S3API/{bucket}/{key}` 工作。**

`/s3/{bucket}/{key}` 定义为本系统提供的对象内容地址形式，它可以和 `/S3API/...` 共用 Object Storage Core，但不要让标准 S3 GetObject 通过 HTTP 302/307 强制跳转到 `/s3`。

原因是 SigV4 会把请求的完整绝对路径纳入 Canonical URI；例如 `/S3API/bucket/a.txt` 与 `/s3/bucket/a.txt` 是两个不同的签名目标。AWS 官方 SigV4 规则明确要求 Canonical URI 使用域名之后的完整绝对路径。([AWS 文档][2])

因此两者职责定义为：

```text
/S3API
    标准 S3 Compatible 协议入口
    FolderSync / rclone / AWS SDK 使用

/s3
    Drop2Tunnel 自身使用的对象内容地址入口
    和 S3 Gateway 共用同一个对象读取 Core
```

标准 `ListObjectsV2` 本身并不会返回每个对象的 HTTP 下载 URL，只返回 Key、Size、ETag、LastModified 等信息。因此 `/s3` 不要通过破坏标准 S3 XML 的方式硬塞进去；本系统自身需要产生对象 URL 时，再统一生成 `/s3/{bucket}/{key}`。

---

# 3. 代码组织硬性要求

S3 API 的具体实现不得写进现有 `server.js`。

建议结构：

```text
server/
├─ object-storage.js
│
├─ s3.js
└─ s3/
   ├─ auth.js
   ├─ sigv4.js
   ├─ routes.js
   ├─ xml.js
   ├─ errors.js
   ├─ credentials.js
   └─ key-utils.js
```

如果 `server/s3.js` 本身能够保持足够简洁，可以减少拆分文件；一旦代码量较大，具体实现必须继续拆入 `/server/s3/`。

`server.js` 中只允许保留依赖注入和路由挂载一类代码，例如概念上：

```js
const { createS3Gateway } = require('./server/s3');

const s3Gateway = createS3Gateway({
    dataDir: SERVER_DATA_DIR,
    objectStorage
});

app.use('/S3API', s3Gateway.api);
app.use('/s3', s3Gateway.content);
```

不要在 `server.js` 内实现：

```text
SigV4
ListBuckets
ListObjectsV2
PutObject
GetObject
Range
CopyObject
DeleteObjects
XML 生成
S3 错误处理
```

S3 模块也不得依赖 Drop2Tunnel 的隧道文件传输链路、Socket.IO、WebRTC、会话文件 Relay 等业务。

正确依赖方向应为：

```text
FolderSync / S3 Client
        ↓
server/s3.js
        ↓
Object Storage Core
        ↓
现有 Telegram 网盘存储层
        ↓
telegram-drive.js
disk-telegram.js
Telegram
```

而不是：

```text
s3.js
  ↓
直接调用 Telegram Bot API
```

---

# 4. 第一项：抽象 Object Storage Core

这是本轮最重要的结构调整。

目前 `server/disk-api.js` 中既包含 HTTP API，又包含大量实际对象存储操作，例如：

```text
上传流水线
Telegram 上传排队
Range 解析
openRemoteRange
readRemote
文件读取
删除
目录操作
上传回滚
```

这些能力不能复制一份到 `s3.js`。

应抽象出一个与 HTTP 协议无关的 Object Storage Core，使：

```text
现有 Telegram 网盘 HTTP API
S3 Compatible API
```

都调用同一个 Core。

建议 Core 至少形成以下语义接口：

```text
listObjects()
statObject()
putObject()
openObject()
deleteObject()
copyObject()
deleteObjects()
createFolderMarker()
deleteFolderMarker()
```

这里的参数应该是逻辑概念：

```text
principal
bucket / diskSpace
key / path
size
contentType
metadata
Readable stream
Range
AbortSignal
```

而不是：

```text
Express req
Express res
Telegram file_id
Telegram message_id
Telegram Bot method
```

S3 层不应知道一个文件在 Telegram 中实际由几个 document 消息组成。

---

# 5. Object Storage Core 必须直接复用当前分片机制

S3 `PutObject` 与当前浏览器网盘上传有一个重要差别：

当前网页大文件会主动按约 20 MB 分成多次 HTTP 请求，通过 `Content-Range` 依次送到服务端。

而 S3：

```text
PUT /bucket/file.zip
```

可能以一个连续 HTTP body 发送整个逻辑文件。

因此这里确实需要一个 **stream → 现有分片接收器的适配层**，但绝不能因此重新建立一套 S3 专属 Telegram 分片实现。

正确做法：

```text
FolderSync PUT body
        ↓
Object Storage Core
        ↓
按照现有 file.parts 规划
每 20,000,000 Byte 形成一个现有网盘 chunk
        ↓
继续进入当前 runUploadPipeline
        ↓
diskTelegram.uploadPhysical()
        ↓
Telegram
```

也就是说：

```text
S3 负责把一个连续输入流喂给现有网盘分片流水线

而不是

S3 自己重新实现 Telegram 分片上传
```

最好进一步把 `telegram-drive.js` 当前 `receive()` / `receivePart()` 中共同的“接收并形成 chunk”部分抽成可复用的底层 writer：

```text
Browser Content-Range
        ┐
        ├─→ Shared Chunk Ingest
        │
S3 PUT Stream
        ┘
              ↓
      Existing Upload Pipeline
```

这样网页网盘和 S3 上传最终走完全相同的 Telegram 物理存储链路。

---

# 6. 下载同样必须复用当前按需分片读取

S3 GetObject 不允许重新实现：

```text
把所有 Telegram 分片先下载到服务器
→ 拼成完整临时文件
→ 再发送给 FolderSync
```

现有代码已经解决了这个问题。

Object Storage Core 应把当前：

```text
openRemoteRange()
readRemote()
telegram.parts()
telegram.readPart()
disk-part-cache
```

抽象成类似：

```text
openObject({
    object,
    start,
    end,
    signal
})
```

返回一个 `Readable`。

因此例如客户端请求：

```http
Range: bytes=50000000-60000000
```

服务端应只寻找覆盖该逻辑区间的 Telegram 分片，只读取相应范围，并边读取边发送。

保持当前已有能力：

```text
Telegram Range 支持
        ↓
直接请求对应字节

Telegram/代理不支持 Range
        ↓
沿用当前 sliceFallback
```

S3 层只负责设置标准 HTTP：

```text
200 / 206
Accept-Ranges
Content-Length
Content-Range
Content-Type
ETag
Last-Modified
```

不要把 Telegram 下载细节复制到 `s3.js`。

---

# 7. Bucket 与现有网盘空间的映射

不要把：

```text
S3 Bucket = Telegram Channel
```

两者直接绑定。

当前代码已经有：

```text
user
diskSpace
Telegram storage backend
Telegram channel
```

这些层级。

S3 Bucket 应当只是一个逻辑 namespace，映射到已有网盘 scope：

```text
bucket
    ↓
userId + diskSpace
    ↓
现有 Telegram 网盘
```

建议每个 S3 Credential 明确保存允许访问的 Bucket 映射，例如：

```text
AccessKey A
    photos  → user X / diskSpace "photos"
    backup  → user X / diskSpace "backup"
```

因此：

```text
ListBuckets
```

只能返回当前 Access Key 被授权访问的 Bucket，绝不能把系统中其他用户的 `diskSpace` 枚举出来。

第一版无需实现 `CreateBucket` / `DeleteBucket`；Bucket 可以通过 S3 配置映射预先建立。

---

# 8. S3 Access Key / Secret Key

需要独立实现 S3 Credential。

至少包含：

```text
accessKeyId
secretAccessKey
enabled
userId
bucketMappings
createdAt
updatedAt
```

需要特别注意：

SigV4 服务端验证签名时必须能够重新取得原始 Secret Access Key 或其等价 HMAC key。

因此 Secret 不能只像普通密码那样保存：

```text
scrypt(secret)
```

然后丢弃原值。

建议：

```text
.tunnel-data/s3-credentials.json
.tunnel-data/s3-secret.key
```

Secret 使用 AES-GCM 加密保存，方式可以复用项目现有 `disk-data.js` / `loadKey()` 的安全存储思路。

Access Key 可以明文索引，Secret 必须加密。

---

# 9. SigV4

第一版必须实现 AWS Signature Version 4，不需要支持已经淘汰的 Signature V2。AWS 当前 SDK 默认采用 SigV4。([AWS 文档][3])

实现至少校验：

```text
Authorization
Credential
SignedHeaders
Signature

Host
x-amz-date
x-amz-content-sha256

Credential Scope:
YYYYMMDD / region / s3 / aws4_request
```

必须正确计算：

```text
CanonicalRequest
StringToSign
SigningKey
Signature
```

尤其注意 `/S3API`：

如果真实请求：

```text
https://host/S3API/photos/a.jpg
```

Canonical URI 必须包含：

```text
/S3API/photos/a.jpg
```

不能因为 Express Router mount 在 `/S3API` 后：

```text
req.url = /photos/a.jpg
```

就把 `/S3API` 丢掉。

这里必须使用能够保留原始请求路径的信息，例如：

```text
req.originalUrl
```

并且不能在验签之前对 URI 做错误的 path normalization。

AWS S3 明确规定 Canonical URI 不应随意正规化，例如对象 key 中的双斜线不能自动折叠。([AWS 文档][2])

至少支持：

```text
标准 SHA-256 payload signing
UNSIGNED-PAYLOAD
```

如果 FolderSync 真机测试发现 Amazon Kotlin SDK 使用：

```text
STREAMING-AWS4-HMAC-SHA256-PAYLOAD
aws-chunked
```

则本轮继续实现对应 streaming SigV4，而不是长期要求用户通过“Disable payload signing”绕开。

---

# 10. 第二项：最小 S3 Gateway

本轮至少实现：

```text
ListBuckets
HeadBucket
ListObjectsV2
PutObject
GetObject
HeadObject
DeleteObject
```

## ListBuckets

```http
GET /S3API
```

返回标准 S3 XML：

```xml
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    ...
</ListAllMyBucketsResult>
```

仅返回当前 Access Key 有权访问的 Bucket。

## HeadBucket

```http
HEAD /S3API/{bucket}
```

有权限：

```text
200
```

不存在：

```text
404 NoSuchBucket
```

无权限：

```text
403 AccessDenied
```

不要泄露其他账户 Bucket 是否存在。

## ListObjectsV2

```http
GET /S3API/{bucket}?list-type=2
```

需要实现：

```text
prefix
delimiter
max-keys
continuation-token
start-after
encoding-type
```

尤其是：

```text
delimiter=/
```

FolderSync 浏览多级目录时需要正确返回：

```text
Contents
CommonPrefixes
```

AWS `ListObjectsV2` 本身就是通过 `prefix + delimiter + CommonPrefixes` 表达对象存储中的目录结构。([AWS 文档][4])

排序必须稳定。

Continuation Token 应为服务端生成的 opaque token，不要让客户端依赖内部数据库索引。

## PutObject

```http
PUT /S3API/{bucket}/{key}
```

必须：

```text
读取 Content-Length
校验逻辑文件大小
流式接收 body
进入 Object Storage Core
由 Core 按现有 20 MB 规划形成网盘分片
直接进入现有 Telegram 上传流水线
```

不能先把完整 1GB 文件写到一个临时文件后再重新切分。

需要边接收边形成现有 chunk，并保持当前上传 backpressure。

响应至少：

```text
200
ETag
```

### 覆盖已有对象

S3 的：

```text
PUT same bucket + same key
```

语义是覆盖，不是：

```text
409 DISK_NAME_CONFLICT
```

因此 Object Storage Core 必须支持“安全替换”。

正确流程应接近：

```text
上传新内容
    ↓
Telegram 完整确认
    ↓
生成新逻辑对象
    ↓
原子切换 key → 新对象
    ↓
再删除旧 Telegram 对象
```

绝不能先删除旧文件再开始上传新文件，否则中途失败会造成数据丢失。

旧 Telegram 对象清理失败时，应进入清理重试，不应把已经成功存储的新对象回滚掉。

## GetObject

```http
GET /S3API/{bucket}/{key}
```

直接调用 Object Storage Core 的 Range reader。

完整读取：

```text
200
```

Range：

```text
206
```

无效 Range：

```text
416
Content-Range: bytes */TOTAL
```

## HeadObject

不能访问 Telegram 下载接口，只读取本地索引 metadata。

返回：

```text
Content-Length
Content-Type
ETag
Last-Modified
Accept-Ranges: bytes
```

## DeleteObject

调用 Object Storage Core 的删除操作。

Telegram 底层继续完全沿用当前实现：

```text
< 48 小时
deleteMessage

>= 48 小时
editMessageMedia
→ 1 Byte placeholder
→ caption 标记已删除
```

S3 层不应知道这些 Telegram 细节。

成功返回：

```text
204 No Content
```

---

# 11. 第三项：FolderSync 完整文件管理行为

在最小 Gateway 工作后，本轮继续实现：

```text
Range
CopyObject
DeleteObjects
zero-byte folder objects
```

## Range

不是新增底层能力。

直接把现有网盘 Range reader 暴露为标准 S3 GetObject Range 即可。

重点测试：

```text
bytes=0-999
bytes=20000000-
bytes=-1048576
跨 Telegram 分片边界的 Range
```

## CopyObject

```http
PUT /S3API/{destinationBucket}/{destinationKey}
x-amz-copy-source: /sourceBucket/sourceKey
```

CopyObject 是 FolderSync/rclone 进行移动、重命名等行为时的重要基础。

不要：

```text
Telegram → 下载完整文件 → S3 Server → 重新上传 Telegram
```

当前 `disk-telegram.js` 已经有通过已有 `file_id` 再次 `sendDocument` / `sendMediaGroup` 的复用能力。

因此同一 Telegram backend 内 CopyObject 应：

```text
读取 source 的 parts
        ↓
复用各 part.fileId
        ↓
向 Telegram 创建新的独立消息
        ↓
形成 destination logical object
```

这样：

```text
不重新传输文件字节
但 destination 有自己的 Telegram message_id
```

因此以后删除 source 不会把 destination 一并破坏。

本轮不引入 CAS/ref_count 共享消息模型。

跨不同 Bot backend 时，由于 Telegram `file_id` 是 Bot 相关的，不能假定能够直接复用；这种情况应走 Core 的流式 copy fallback，而不是让 S3 层自己处理 Telegram。

## DeleteObjects

支持：

```http
POST /S3API/{bucket}?delete
```

解析标准 DeleteObjects XML，一次批量删除多个 Key。

需要返回标准：

```xml
<DeleteResult>
    <Deleted>...</Deleted>
    <Error>...</Error>
</DeleteResult>
```

不要因为某一个对象删除失败就丢失其他对象的成功结果。

## zero-byte folder objects

FolderSync 可能使用：

```text
folder/
```

这种 0 Byte 对象模拟目录。

当前 Telegram 网盘本身已经有真正的虚拟目录索引，因此不要为了一个 0 Byte folder marker 往 Telegram 上传一个毫无意义的 0 Byte document。

应由 Object Storage Core 处理：

```text
PUT folder/
→ 建立目录 / folder marker metadata

HEAD folder/
→ 200 + Content-Length: 0

GET folder/
→ 200 + 空 body

DELETE folder/
→ 删除 marker 语义
```

需要区分：

```text
S3 folder marker
```

和：

```text
当前网盘真实目录树
```

因为 S3 中删除：

```text
folder/
```

这个 marker 不代表递归删除：

```text
folder/a.txt
folder/b.txt
```

因此不能简单调用当前 `removeDirectory(..., recursive=true)`。

---

# 12. 普通 0 Byte 文件

同样建议 metadata-only。

例如：

```text
empty.txt
size = 0
```

没有必要为了表达 0 Byte 对象向 Telegram 上传 document。

Object Storage Core 应允许：

```text
size = 0
parts = []
```

并让：

```text
GET → 空流
HEAD → Content-Length: 0
DELETE → 只删除索引
```

---

# 13. Key 到现有网盘路径的映射

原则上：

```text
bucket/foo/bar.jpg

→

diskSpace 对应的：
folderPath = foo
name = bar.jpg
```

但是必须注意：

S3 Object Key 的合法字符范围比当前 `telegram-drive.js` 的 `normalizeSegment()` 更宽。

因此绝对不能：

```text
偷偷修改文件名
自动删除字符
自动折叠 //
自动 trim 后继续保存
```

如果第一版尚未实现完整的 S3 key 映射层，那么遇到当前网盘 path model 无法表达的 Key，应明确返回：

```text
InvalidObjectName
```

而不是产生一个和客户端原始 Key 不一致的对象。

FolderSync 真机验收必须覆盖：

```text
中文
日文
空格
括号
#
+
%
Unicode
多层目录
长文件名
```

如果实际 FolderSync 文件集出现当前网盘不能表示的合法 S3 key，再增加一个“外部 S3 key → 内部安全 path”的可逆映射层，但不要为了本轮开发先大幅修改整个 Telegram 网盘路径规则。

---

# 14. ETag

Object Storage Core 应为 S3 对象提供稳定 ETag。

对于 S3 单次 PUT，可以在接收 body 的同时计算：

```text
MD5
```

以及现有逻辑继续计算的：

```text
SHA-256
```

S3 对外返回：

```text
ETag: "..."
```

Telegram 内部 chunk 的 SHA-256 继续用于现有分片校验/复用。

不要把 Telegram：

```text
file_id
file_unique_id
message_id
```

直接当成 S3 ETag。

CopyObject 可以继承源对象的内容 ETag。

---

# 15. S3 XML 与错误响应

FolderSync 使用正式 AWS SDK，所以不要返回 Drop2Tunnel 原有 JSON 错误：

```json
{"error":"FILE_NOT_FOUND"}
```

S3 Router 必须转换为标准 XML，例如：

```xml
<Error>
    <Code>NoSuchKey</Code>
    <Message>The specified key does not exist.</Message>
    <RequestId>...</RequestId>
</Error>
```

至少正确映射：

```text
NoSuchBucket
NoSuchKey
AccessDenied
InvalidAccessKeyId
SignatureDoesNotMatch
InvalidArgument
InvalidRange
EntityTooLarge
InvalidObjectName
InternalError
NotImplemented
```

HEAD 请求按照 S3/HTTP 习惯不要返回错误 body。

建议所有请求生成：

```text
x-amz-request-id
```

方便 FolderSync 日志与服务端日志对应。

---

# 16. SSE 本轮不实现

CAS、Versioning、Presigned URL、CDN Gateway、Server-side Encryption 等属于以后把 Telegram 网盘进一步升级为 Telegram-backed storage infrastructure 的内容，本轮不展开。

FolderSync 的：

```text
Server-side encryption
```

本轮要求关闭。

如果客户端发送：

```text
x-amz-server-side-encryption
```

服务端应明确返回：

```text
NotImplemented
```

不要静默忽略，否则用户会误以为文件已经使用 SSE。

---

# 17. `/s3` 对象内容入口

实现：

```text
GET  /s3/{bucket}/{key}
HEAD /s3/{bucket}/{key}
```

它和 S3 GetObject 必须调用相同：

```text
Object Storage Core.openObject()
```

因此同样支持：

```text
Range
ETag
Last-Modified
Content-Type
Content-Length
```

第一版 `/s3` 不做匿名公开，也不在本轮实现 presigned URL。

它只是为本系统预留统一对象内容地址：

```text
https://HOST/s3/{bucket}/{key}
```

以后 CDN、网页托管、媒体源站等功能可以直接建立在这一层之上，而不需要再次接触 Telegram 存储实现。

---

# 18. server.js 需要注意的两个现有中间件

当前 `server.js` 在业务路由前已经有：

```js
app.use(rateLimit(RATE_LIMIT));
app.use(express.json({ limit: '2mb' }));
```

其中 `express.json()` 只应处理 JSON，不得让任何新的全局 body parser 提前读取 S3 PUT body。

S3 的：

```text
PutObject
```

必须直接消费原始 Node request stream。

`DeleteObjects` 的 XML body 则由 S3 模块自身限制大小后解析。

另外当前全局 RATE_LIMIT 已专门跳过 Telegram Drive 的大文件/高频接口。`/S3API` 和 `/s3` 同样会产生大量 PUT、Range、HEAD、LIST 请求，因此必须避免被普通网页的全局计数器误伤。

可以在 `server.js` 中做非常简单的路由级 bypass 配置，但具体 S3 rate limit 规则必须留在 `server/s3.js` 或 `/server/s3/` 中。

这属于路由 wiring，不属于把 S3 API 逻辑写回 `server.js`。

---

# 19. FolderSync 第一版推荐配置

完成后使用 Android FolderSync：

```text
Account type:
S3 Compatible

Access key ID:
本系统生成的 Access Key

Secret access key:
本系统生成的 Secret Key

Server address:
https://HOST/S3API

Use path-style access for all requests:
开启

Server-side encryption:
关闭

Disable folder objects:
关闭

Region:
us-east-1
```

`Disable payload signing` 不应作为最终兼容方案。

可以临时用于定位问题，但最终开发目标是正常处理 FolderSync 实际产生的 SigV4 请求。

FolderSync 官方目前明确支持自定义 S3 Compatible Server address、path-style、payload signing 和 folder objects 相关选项。([FolderSync][1])

---

# 20. FolderSync 必须完成的真机验收

本轮是否完成，不以“curl 能 PUT 一个文件”为准，而以 FolderSync 真机使用结果为准。

至少验证：

```text
1. 新建 S3 Compatible 账户并验证成功。

2. 正常 ListBuckets。

3. 打开 Bucket 并浏览多级目录。

4. 创建目录。

5. 上传小文件。

6. 上传 >20 MB 文件，确认实际进入现有 Telegram 多分片链路。

7. 上传较大文件，确认服务器不会先缓存完整文件后再二次切分。

8. 下载多分片文件。

9. 下载过程中 Range / 断点读取正常。

10. 只读取文件中间的一段时，确认不会把全部 Telegram 分片拉下来。

11. 覆盖同名文件。

12. CopyObject。

13. FolderSync 的重命名/移动操作正常。

14. 删除单文件。

15. DeleteObjects 批量删除。

16. 创建及删除 zero-byte folder marker。

17. 0 Byte 普通文件。

18. Unicode / 中文 / 日文 / 空格文件名。

19. Telegram 消息超过 48 小时后的 S3 DeleteObject 仍能成功完成逻辑删除。

20. 服务重启后 Bucket、Object、ETag、目录和分片索引全部保持一致。
```

另外应查看 FolderSync debug log，确认没有持续出现：

```text
SignatureDoesNotMatch
MalformedXML
NotImplemented
301 / 307 redirect loop
404 bucket
Range error
```

如果 FolderSync 在初始化或浏览过程中实际调用了本指引未列出的简单 S3 metadata API，例如：

```text
GetBucketLocation
```

则应根据真实 FolderSync 请求补齐该接口。

“最小 S3 API 列表”是开发基线，不是为了少写一个接口而让 FolderSync 出现兼容性异常。

---

# 21. 自动化测试

建议增加：

```text
tests/s3-sigv4.test.cjs
tests/s3-gateway.test.cjs
tests/s3-object-storage.test.cjs
```

重点覆盖：

```text
SigV4 官方测试向量
/S3API 前缀参与签名
URL 编码
Unicode Key
query 参数排序
SignedHeaders
错误 Secret
过期 x-amz-date
ListObjectsV2 pagination
delimiter + CommonPrefixes
Range 跨 Telegram 分片
PutObject overwrite
CopyObject
DeleteObjects
0 Byte object
folder marker
```

还必须保留现有 Telegram 网盘 API 回归测试。

本次抽象 Object Storage Core 后：

```text
/api/telegram/drive
/api/telegram/disk/v1
```

原有行为不得回归。

---

# 22. 本轮明确不做

以下内容只保留未来扩展空间，本轮不要因为架构畅想把工作范围扩大：

```text
CAS 全局内容寻址存储
S3 Versioning
Presigned URL
CDN Gateway
Server-side Encryption
完整 AWS IAM
ACL
Object Lock
Lifecycle
Replication
静态网站 Hosting
Local Bot API Server
S3 Multipart Upload API
```

注意：

这里“不实现 S3 Multipart Upload API”并不意味着不支持大文件。

当前 Drop2Tunnel 已经有自己的：

```text
逻辑文件
    ↓
20 MB Telegram physical parts
```

FolderSync 即使通过一个普通 PutObject 上传大文件，Object Storage Core 也应边读取该 PutObject stream，边转换为现有 Telegram 分片。

因此 S3 Multipart Upload 与 Telegram physical multipart 是两个完全不同的概念，不要混淆。

---

# 23. 本轮实施顺序

严格按照本次确定的三项执行，不采用此前提出的其他开发顺序。

### 1、Object Storage Core

先把现有 Telegram 网盘：

```text
上传
分片
读取
Range
metadata
删除
复制
backend
file_id
```

封装到 S3 和现有 Disk API 都可以复用的 Core 中。

这一阶段完成后，现有网盘功能必须保持正常。

### 2、最小 S3 Gateway

完成：

```text
SigV4
ListBuckets
HeadBucket
ListObjectsV2
PutObject
GetObject
HeadObject
DeleteObject
```

并开始 FolderSync 真机测试。

### 3、补齐 FolderSync 文件管理能力

完成：

```text
Range
CopyObject
DeleteObjects
zero-byte folder objects
```

然后根据 FolderSync 实际日志补齐它真实需要、但当前清单遗漏的轻量 S3 metadata 操作，直到 FolderSync 可以作为普通 S3 Compatible 存储稳定使用。

---

# 24. 最终架构边界

本次开发完成后的结构应当是：

```text
                   FolderSync
                       │
                       │ S3 Compatible
                       ▼
                 /S3API
                       │
                 server/s3.js
                       │
                       ▼
              Object Storage Core
                ▲             ▲
                │             │
     Existing Disk API        │
 /api/telegram/drive          │
 /api/telegram/disk/v1        │
                │             │
                └──────┬──────┘
                       ▼
              telegram-drive.js
                       │
                disk-telegram.js
                       │
                       ▼
                   Telegram
```

同时：

```text
/s3/{bucket}/{key}
        │
        └────────→ Object Storage Core.openObject()
```

S3 层只负责：

```text
S3 协议
SigV4
XML
HTTP/S3 状态码
Bucket/Key 映射
```

Telegram 网盘层继续负责：

```text
20 MB physical chunks
上传流水线
file_id
message_id
Telegram API
Range 分片读取
缓存
Telegram 删除策略
```

这条边界必须保持清晰，不能让 `/server/s3.js` 最后演变成第二套 `disk-api.js + disk-telegram.js`。

这里有一个我认为非常关键的修正：**`/S3API` 和 `/s3` 可以同时保留，但 FolderSync 的标准 GetObject 不能被重定向到 `/s3`**，否则容易直接破坏 SigV4；`/s3` 应作为 Drop2Tunnel 自身的统一内容入口。AWS 的签名规则对完整路径敏感，这个边界最好从第一版就定死。([AWS 文档][2])

另外，当前分支里已经存在 `file_id` 分片复用和 chunk cache，所以 `CopyObject` 也不必走“Telegram 下载→重新上传文件字节”的笨路径；这一点也应该在实现时充分利用现有代码。

[1]: https://foldersync.io/docs/help/cloudservices/?utm_source=chatgpt.com "Add cloud service account - FolderSync Documentation"
[2]: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html?utm_source=chatgpt.com "Signature Calculations for the Authorization Header: Transferring Payload in a Single Chunk (AWS Signature Version 4) - Amazon Simple Storage Service"
[3]: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/specify-signature-version.html?utm_source=chatgpt.com "Specifying the Signature Version in request authentication - Amazon Simple Storage Service"
[4]: https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html?utm_source=chatgpt.com "ListObjectsV2 - Amazon S3"
