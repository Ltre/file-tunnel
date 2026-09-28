# 网盘上传现场诊断收集

在灰度服务器的项目目录运行，服务可以继续工作，不需要停服或重启。现有服务器已经自动记录 `.tunnel-data/disk-upload.log`，达到 10 MB 后轮转到 `disk-upload.log.1`；本工具只读取这些文件和任务状态，生成一个可提供给排查人员的诊断 JSON。

## 这次灰度上传怎么收集

1. 部署本轮上传修复后，重复测试混合文件上传和大文件上传，记下开始测试的时间。
2. 失败后立即执行以下命令，默认收集最近两小时；如果测试更久，把 120 改成需要的分钟数：

   ```bash
   node tools/collect-tgdisk-diagnostics.cjs --data-dir .tunnel-data --minutes 120
   ```

3. 终端会输出生成文件的 `output` 路径，默认在 `.tunnel-data/diagnostics/tgdisk-*.json`。从服务器下载这个 JSON 文件，一次提供整份文件即可，毋须逐行复制日志。请同时说明哪个上传失败、客户端提示什么，以及测试大致开始/失败时间。

在还未部署本轮修复的旧灰度版本上，也可单独复制本脚本到 `tools` 后执行；可以导出已有日志，但不会补回旧版本没有记录的细节。

## 精确限定测试时间或任务

时间必须带时区标记，避免把服务器 UTC 与本地时间混淆：

```bash
node tools/collect-tgdisk-diagnostics.cjs --data-dir .tunnel-data --since "2026-09-28T12:00:00+08:00" --until "2026-09-28T14:00:00+08:00"
```

只收集一个上传的相关请求与任务状态：

```bash
node tools/collect-tgdisk-diagnostics.cjs --data-dir .tunnel-data --upload-id "上传任务的uploadId"
```

也支持 `--operation-id "operation_id"`。两种 ID 选项均可重复使用，按任一指定任务匹配；指定任务且没有指定时间时，会读取目前保留的全部相关日志。`--since` 与 `--minutes` 不可同时使用。可用 `--output ./tgdisk-diagnostics.json` 指定输出，已有文件不会覆盖。

## 包含内容与边界

- 当前和上一份轮转日志中的浏览器接收、队列等待、Telegram 请求/响应、重试、确认、索引提交和回滚事件，按时间排序并去掉重复行。
- 对应上传任务的状态、字节/分片进度、错误码、脱敏错误细节与目录。优先只读查询 SQLite；仅在没有 SQLite 时读取旧 `disk-operations.json`。
- 优先读取部署包 `release.json` 的来源提交、分支、构建编号；没有这份元信息时读取 Git 提交与分支。也包含收集脚本自身的 Node 版本和操作系统，此 Node 版本是收集进程的版本，不冒充服务进程；两种版本来源都不可用时，请另外注明部署版本。`deploy:build` 生成的部署包会附带本脚本和说明文档。
- 不导出认证库、用户/分享密钥、文件正文、消息 caption、请求正文和请求头；对日志里的 URL、Bot token、Bearer 和敏感字段再次脱敏。仍保留任务 ID、文件 ID、文件名和目录等定位信息，分享前可自行检查。
- 按读取时的文件大小取得快照；读取期间新产生的日志可能留待下次导出。未完成的末行会忽略并给出警告。SQLite 状态读取失败仍可以导出日志，并明确警告，不回退到可能过期的旧 JSON。
- 日志轮转只保留两份，已经丢弃的日志无法恢复。大型测试应在失败后马上导出；诊断导出文件需要用户在排查结束后手动清理。
