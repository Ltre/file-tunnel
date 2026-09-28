# Telegram 网盘 S3 Compatible API

当前分支提供 SigV4 path-style 入口 `https://HOST/S3API`，以及同样需要 SigV4 的对象读取入口 `https://HOST/s3/{bucket}/{key}`。Bucket 是现有网盘用户与分区的映射，不是 Telegram 频道。上传沿用网盘的 20,000,000 Byte 分片接收、Telegram 队列、去重和失败回滚；下载沿用按需 Range 分片读取。

## 建立凭据

先在网盘中建立用户，取得网盘用户 UUID。管理员在服务器执行：

```powershell
node tools/s3-credentials.cjs --data-dir .tunnel-data --create --user-id 用户UUID --bucket backup= --bucket photos=photos
```

`bucket=` 的等号后是网盘分区名；空值表示默认分区。可重复 `--bucket`。如需独立 Bot 存储后端，可加 `--backend-id 后端UUID`（将应用于该凭据的全部 Bucket）。命令只在创建时输出一次 Secret Access Key，务必立即安全保存；`.tunnel-data/s3-credentials.json` 中仅保存 AES-256-GCM 密文，密钥在 `.tunnel-data/s3-secret.key`。这两个文件必须一起备份，且不得公开。

查看非敏感凭据及停用：

```powershell
node tools/s3-credentials.cjs --data-dir .tunnel-data --list
node tools/s3-credentials.cjs --data-dir .tunnel-data --disable AccessKeyID
```

凭据文件每次请求重新读取，停用立即生效。请将 S3 入口放在 HTTPS 反向代理之后，确保代理**不改写原始路径和查询字符串**、允许大请求流与 Range，并保留 `Host`、`Authorization`、`x-amz-*` 请求头。

## FolderSync

- 类型：S3 Compatible；Server address：`https://HOST/S3API`。
- 填写上面生成的 Access Key ID 和 Secret Access Key；Region 选 `us-east-1`。
- 启用 **Use path-style access for all requests**。
- 关闭 **Server-side encryption**；可以保留文件夹对象功能。
- 使用标准 payload signing；本服务支持普通 SHA-256、`UNSIGNED-PAYLOAD` 和不带 trailer 的 `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`。若 FolderSync 实际请求使用其它 trailer/checksum 变体，需依据真机请求日志补齐，不应长期通过关闭签名规避。

支持 ListBuckets、HeadBucket、ListObjectsV2、Put/Get/Head/DeleteObject、Range、CopyObject、DeleteObjects、0 Byte 文件及文件夹 marker、GetBucketLocation。S3 Multipart Upload API、匿名访问、presigned URL、SSE、ACL、版本控制目前不提供。现有网盘路径模型无法无损表达的 S3 Key（如连续 `/`、路径段前后空格、非法字符）会返回 `InvalidObjectName`，不会悄悄改名。对象上限沿用网盘的 2000 MiB。

### 上线核验

在测试环境先用真实 FolderSync 设备确认：连接、列表、多级目录、超过 20 MB 上传、Range 下载、覆盖、重命名/复制、批量删除、0 Byte 文件、中文/日文/空格等 Key、服务重启后读取。若代理开启请求体缓存或超时过短，应调整代理配置。自动化测试不会代替 FolderSync 真机验收。
