# sing-box 出口组件

此目录包含 sing-box 1.14.4 的 Windows x64 和 Linux x64 组件。来源为 [SagerNet 官方发行](https://github.com/SagerNet/sing-box/releases/tag/v1.14.4)，许可证分别保留在平台目录。`manifest.json` 记录本次包含文件的 SHA-256。

## 部署

- Windows：`tools/sing-box/win-x64/sing-box.exe`。
- Linux：`tools/sing-box/linux-x64/sing-box`；部署后确保具有执行权限，例如 `chmod +x tools/sing-box/linux-x64/sing-box`。
- 项目最低 Node 版本为 22.16.0；出口 HTTP dispatcher 使用固定的 undici 7.30.2，未要求升级到 Node 24。
- 发布构建会复制该组件目录。使用项目原有依赖安装方式安装 `package-lock.json` 中的依赖。

## 架构与运行机制

`server/upstream-exits.js` 管理配置、任务作用域、HTTP dispatcher 和组件生命周期。yt-dlp 仅在原命令边界附加 `--proxy`；网页读取通过原有公有 DNS 校验的请求边界接入；Telegram 的共同服务边界保留原业务处理。

每个实际使用的节点配置快照启动独立进程，入口仅绑定 `127.0.0.1` 的临时 HTTP 代理端口。TLS 始终启用；节点的“验证 TLS 证书”只控制该 Trojan 节点的证书校验，不关闭目标网站的 HTTPS 校验。HAProxy TCP 透传可使用独立的连接地址和 TLS SNI。

保存配置不会启动进程。任务使用时才启动，同一快照共用进程并分别持有使用计数；配置更新后的任务使用新快照，旧任务继续持有旧实例。最后一个任务释放后，空闲约 30 秒停止。流式响应的使用计数保留至正文结束或流关闭，避免响应头返回后提前停止。

任务通过 AsyncLocalStorage 隔离出口。首次有效内容取得前按配置顺序尝试，取得后保持该任务出口。媒体格式缓存继续按原入口读取和写入，不因配置代理而绕过缓存。上传等写请求保留原有业务的发送确认、正文重建与重试保护，适配器不会擅自重放可能已发送的写请求。

## 配置与敏感数据

配置保存在私有数据目录中的 `upstream-exits.json`，临时运行配置保存在 `upstream-runtime/`。Unix 文件权限为 `0600`，临时目录为 `0700`。管理 API 只返回密码是否已保存，不返回密码正文。不要把这些私有文件提交到仓库。

## 手动测试

节点表单提供出口 IP 测试和自定义页面请求测试。测试使用固定出口，不执行候选切换；页面请求有超时及正文抽样上限。IP 查询仅在用户点击时访问 `api.ipify.org`，不会后台监测出口、推断地区或调整节点顺序。

具体操作见 [中文使用手册](../../docs/guide/Drop2Tunnel-User-Manual.zh-CN.md)。

## 验证范围

本轮在 Windows 上运行真实 sing-box，并通过隔离的 Trojan TLS 服务验证证书校验、HTTP 内容获取、候选切换及组件释放；同时使用 Node 22.16.0 验证相关代码。Linux 组件已包含，Linux 原生进程执行仍需在对应环境验证，不能以 Windows 结果替代。
