# FolderSync / S3 现场诊断

本工具读取当前服务器的加密 S3 凭据，只发送签名请求，不输出 Secret Access Key 或 Authorization。默认只读，不创建 Bucket、目录或文件。需要 Node 24.15+。

```powershell
node tools/diagnose-s3-foldersync.cjs --data-dir .tunnel-data --endpoint https://HOST/S3API --access-key ACCESS_KEY_ID --bucket ACTUAL_BUCKET
```

报告包含服务根 HEAD、ListBuckets、HeadBucket、ListObjects V1/V2 的状态、响应 Content-Type、XML 正文样本、请求编号及耗时；响应可能包含文件名，分享报告前仍须脱敏。远端重定向不会自动携带凭据跟随，公网 HTTPS 校验保持开启。默认每请求超时 20 秒；失败不会自动重放写入。

`--region us-east-1` 指定签名 Region；`--output PATH` 指定报告位置。`--probe-write` 额外创建唯一临时空目录，验证列表后只删除该探针目录。若网络中断导致删除失败，报告会保留该目录的精确 URL，应人工核对并清理；不触及原有文件。

优先使用 `/S3API` 服务根。若检查 `/S3API/{bucket}`，工具会按 path-style 继续追加 Bucket，用于暴露重复路径问题，并不承诺这种填写方式适合 App。App 的实际请求与本工具可能不同，须结合现场记录判断。

[FolderSync 官方文档](https://foldersync.io/docs/help/cloudservices/)仅说明某些 S3 Compatible 服务支持在地址尾部指定 Bucket，不能据此推定所有 App/服务组合的路径行为相同。响应格式以 [S3 REST 错误规范](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/ErrorResponses.html)和 [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)为参考；现场仍应检查完整请求与响应。

要记录 **App 本身**发出的请求，可临时设置环境变量 `D2T_S3_DIAGNOSTICS=1` 后重新启动服务，再在 FolderSync 重现问题。记录位于 `.tunnel-data/s3-diagnostics.log`，最多约 2MB 后轮换一个 `.1` 文件，不采集请求正文、密钥、认证头或未知查询参数。完成后删除该环境变量并重启以停止记录。代理在请求到达 Node 前直接返回的错误不会出现在此日志中，应对照代理日志。

同时提供：FolderSync 版本、服务器 Git 版本、操作时间及填写的地址形式。连接测试通过仅代表探测成功，应继续验证 Bucket 列表、中文多层目录、空目录、创建目录和文件上传下载。不要关闭签名校验或猜测 Bucket 修复连接。
