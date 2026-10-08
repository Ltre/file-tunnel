# FolderSync 接入 Telegram 网盘 S3 API 失败情况

当前代码版本：`b4bedfdca3f36e999fc0c63263f9f08784cfdf75`

使用 Android 端 FolderSync 的 `S3 Compatible` 类型接入 Telegram 网盘 S3 API，在测试连接时发生错误。

分别测试了以下两种服务器地址：

1. **不带 Bucket 后缀**：`https://tun.miku.us/S3API`
2. **带 Bucket 后缀**：`https://tun.miku.us/S3API/userbucket-b3a41105-e8d1-41c1-93f0-6ddd7c3aa6ee`

两种配置返回了不同的错误。

## 一、测试配置

- Bucket：`userbucket-b3a41105-e8d1-41c1-93f0-6ddd7c3aa6ee`
- Region：`us-east-1`
- Access Key ID、Secret Access Key：已填写
- 服务器端加密：未勾选
- 为所有请求使用路径样式存取（Path-style access）：已勾选
- 停用载荷签署：未勾选
- 停用资料夹物件：未勾选

FolderSync 当前配置界面没有单独的 Bucket 输入框，因此分别尝试了上述两种服务器地址。

## 二、情况 1：API 地址不带 Bucket 后缀

**填写地址：**

`https://tun.miku.us/S3API`

**错误现象：**

FolderSync 测试连接失败，服务端返回：

`HTTP 501 Not Implemented`

调用栈显示，错误发生在 FolderSync 读取文件列表期间，涉及 `getObjectMetadata` 和 `checkIfDirectoryExists`。

这说明客户端发起的某个 S3 请求没有得到成功处理。可能涉及对应操作未实现、HTTP 方法或请求路径不匹配等情况，但尚不能仅凭该日志确定具体原因。

### 原始完整错误日志

```text
Service returned error code 501: Not Implemented, Error type: Unknown, Protocol response: HTTP 501 Not Implemented, Request ID: 6ffd7a94c21d521c00335c7f

ena: Service returned error code 501: Not Implemented, Error type: Unknown, Protocol response: HTTP 501 Not Implemented, Request ID: 6ffd7a94c21d521c00335c7f
 at cc5.a(Unknown Source:88)
 at k63.b(Unknown Source:439)
 at j63.invokeSuspend(Unknown Source:12)
 at ip0.resumeWith(Unknown Source:7)
 at kotlinx.coroutines.DispatchedTask.run(Unknown Source:115)
 at kotlinx.coroutines.EventLoopImplBase.processNextEvent(Unknown Source:18)
 at kotlinx.coroutines.BlockingCoroutine.joinBlocking(Unknown Source:23)
 at kotlinx.coroutines.BuildersKtBuildersKt.runBlockingImpl(Unknown Source:14)
 at kotlinx.coroutines.BuildersKt.runBlockingImpl(Unknown Source:0)
 at kotlinx.coroutines.BuildersKtBuilders_concurrentKt.runBlockingK(Unknown Source:39)
 at kotlinx.coroutines.BuildersKt.runBlockingK(Unknown Source:0)
 at kotlinx.coroutines.BuildersKtBuilders_concurrentKt.runBlockingK$default(Unknown Source:6)
 at kotlinx.coroutines.BuildersKt.runBlockingK$default(Unknown Source:0)
 at dk.tacit.android.providers.client.s3.AwsS3Client.getObjectMetadata(Unknown Source:7)
 at dk.tacit.android.providers.client.s3.AwsS3Client.access$getObjectMetadata(Unknown Source:0)
 at dk.tacit.android.providers.client.s3.AwsS3Client$checkIfDirectoryExists$1.invokeSuspend(Unknown Source:23)
 at ip0.resumeWith(Unknown Source:7)
 at kotlinx.coroutines.DispatchedTask.run(Unknown Source:115)
 at kotlinx.coroutines.EventLoopImplBase.processNextEvent(Unknown Source:18)
 at kotlinx.coroutines.BlockingCoroutine.joinBlocking(Unknown Source:23)
 at kotlinx.coroutines.BuildersKtBuildersKt.runBlockingImpl(Unknown Source:14)
 at kotlinx.coroutines.BuildersKt.runBlockingImpl(Unknown Source:0)
 at kotlinx.coroutines.BuildersKtBuilders_concurrentKt.runBlockingK(Unknown Source:39)
 at kotlinx.coroutines.BuildersKt.runBlockingK(Unknown Source:0)
 at kotlinx.coroutines.BuildersKtBuilders_concurrentKt.runBlockingK$default(Unknown Source:6)
 at kotlinx.coroutines.BuildersKt.runBlockingK$default(Unknown Source:0)
 at dk.tacit.android.providers.client.s3.AwsS3Client.checkIfDirectoryExists(Unknown Source:7)
 at dk.tacit.android.providers.client.s3.AwsS3Client.listFiles(Unknown Source:94)
 at dk.tacit.android.foldersync.ui.accounts.AccountDetailsViewModel$testAccount$2.invokeSuspend(Unknown Source:234)
 at ip0.resumeWith(Unknown Source:7)
 at kotlinx.coroutines.DispatchedTask.run(Unknown Source:2)
 at kotlinx.coroutines.internal.LimitedDispatcher$Worker.run(Unknown Source:3)
 at kotlinx.coroutines.scheduling.TaskImpl.run(Unknown Source:2)
 at kotlinx.coroutines.scheduling.CoroutineScheduler.runSafely(Unknown Source:0)
 at kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.executeTask(Unknown Source:33)
 at kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.runWorker(Unknown Source:28)
 at kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.run(Unknown Source:0)
```

## 三、情况 2：API 地址带 Bucket 后缀

**填写地址：**

`https://tun.miku.us/S3API/userbucket-b3a41105-e8d1-41c1-93f0-6ddd7c3aa6ee`

**错误现象：**

FolderSync 测试连接失败，返回：

`Failed to parse response as restXml error`

调用栈显示，错误发生在 FolderSync 的 `listObjectsResponse` 对象列表响应解析过程中。

这表明客户端无法按预期的 S3 REST-XML 错误格式解析服务端响应。可能涉及服务端返回格式不符合 S3 客户端预期，或者请求路径、响应状态与内容不匹配。

由于服务器地址中已经包含 Bucket 后缀，同时启用了 Path-style access，也需要注意客户端实际拼接出的请求路径是否符合服务端路由预期。

这份日志没有给出具体 HTTP 状态码和响应正文，暂时无法确定解析失败的直接原因。

### 原始完整错误日志

```text
Failed to parse response as restXml error

ena: Failed to parse response as restXml error
 at sb7.a(Unknown Source:101)
 at k63.b(Unknown Source:439)
 at j63.invokeSuspend(Unknown Source:12)
 at ip0.resumeWith(Unknown Source:7)
 at kotlinx.coroutines.DispatchedTask.run(Unknown Source:115)
 at kotlinx.coroutines.EventLoopImplBase.processNextEvent(Unknown Source:18)
 at kotlinx.coroutines.BlockingCoroutine.joinBlocking(Unknown Source:23)
 at kotlinx.coroutines.BuildersKtBuildersKt.runBlockingImpl(Unknown Source:14)
 at kotlinx.coroutines.BuildersKt.runBlockingImpl(Unknown Source:0)
 at kotlinx.coroutines.BuildersKtBuilders_concurrentKt.runBlockingK(Unknown Source:39)
 at kotlinx.coroutines.BuildersKt.runBlockingK(Unknown Source:0)
 at kotlinx.coroutines.BuildersKtBuilders_concurrentKt.runBlockingK$default(Unknown Source:6)
 at kotlinx.coroutines.BuildersKt.runBlockingK$default(Unknown Source:0)
 at dk.tacit.android.providers.client.s3.AwsS3Client.listObjectsResponse(Unknown Source:7)
 at dk.tacit.android.providers.client.s3.AwsS3Client.listFiles(Unknown Source:60)
 at dk.tacit.android.foldersync.ui.accounts.AccountDetailsViewModel$testAccount$2.invokeSuspend(Unknown Source:234)
 at ip0.resumeWith(Unknown Source:7)
 at kotlinx.coroutines.DispatchedTask.run(Unknown Source:2)
 at kotlinx.coroutines.internal.LimitedDispatcher$Worker.run(Unknown Source:3)
 at kotlinx.coroutines.scheduling.TaskImpl.run(Unknown Source:2)
 at kotlinx.coroutines.scheduling.CoroutineScheduler.runSafely(Unknown Source:0)
 at kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.executeTask(Unknown Source:33)
 at kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.runWorker(Unknown Source:28)
 at kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.run(Unknown Source:0)
```

## 四、情况汇总

| 测试项目 | 不带 Bucket 后缀 | 带 Bucket 后缀 |
|---|---|---|
| API 地址 | `/S3API` | `/S3API/{Bucket}` |
| 测试结果 | 连接失败 | 连接失败 |
| 错误信息 | HTTP 501 Not Implemented | Failed to parse response as restXml error |
| 调用栈关键位置 | `getObjectMetadata`、`checkIfDirectoryExists` | `listObjectsResponse`、`listFiles` |
| 主要疑点 | S3 操作支持情况、请求方法及路由处理 | S3 REST-XML 响应格式、Bucket 路径处理 |

**目前能够确认的是：**

两种地址配置都无法通过 FolderSync 的 S3 连接测试，但失败环节和错误表现有所不同。

不带 Bucket 后缀时，客户端收到明确的 HTTP 501；带 Bucket 后缀时，客户端无法解析服务端返回的 S3 REST-XML 错误响应。

这两种错误都指向 FolderSync 与现有 S3 API 的兼容性问题，但现有客户端日志尚不足以确定服务端具体根因，也不能直接判断是否存在签名认证问题。

需要结合当前版本的 S3 API 实现及实际 HTTP 请求、响应日志，分别定位两种配置对应的失败原因。