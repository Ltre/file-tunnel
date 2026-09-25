# SNS Cookie 管理与浏览器自动同步扩展

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 功能定位

yt-dlp 对多个 SNS 平台常需要有效登录 Cookie。手工不断导出 `cookies.txt` 对多服务器部署很麻烦，因此项目增加了一套管理员 Cookie 管理页和浏览器自动同步扩展。

服务端/页面：

- `/sns-cookies`
- `pages/sns-cookies.html`
- `server.js`

扩展：

- `tools/auto-sync-sns-cookies/chrome/`
- `tools/auto-sync-sns-cookies/firefox-windows/`
- `tools/auto-sync-sns-cookies/firefox-android/`
- `tools/auto-sync-sns-cookies/build.mjs`
- `tools/auto-sync-sns-cookies/README.zh-CN.md`

## 2. 支持的平台

扩展当前读取：

- YouTube / YT Music：`youtube.com`
- TikTok：`tiktok.com`
- Facebook：`facebook.com`
- Instagram：`instagram.com`
- Threads：`threads.com` / `threads.net`，并可能读取共享的 Instagram 登录态
- LINE：`line.me`
- Twitter / X：`twitter.com` / `x.com`

服务器会把内容转换/保存为相应 Netscape cookies.txt 文件。

## 3. 为什么需要浏览器扩展

普通网页 JavaScript 无法读取 HttpOnly Cookie。

扩展拥有对指定 SNS 域名的 cookie 权限，因此可以读取真实浏览器登录态，包括 yt-dlp 常需要的 HttpOnly 值，再转换成 Netscape 格式。

这不是让 Drop2Tunnel 服务端远程登录用户浏览器，而是管理员主动安装扩展并配置目标服务器。

## 4. 多浏览器实现

### Chrome

- Manifest V3；
- `chrome/` 也是公共 JS/HTML 的主要维护源。

### Firefox Windows

- Manifest V3；
- 公共 JS/HTML 由 build script 同步。

### Firefox Android

- Manifest V2 event page；
- 原因是 Firefox Android 对后台 Service Worker 能力不同。

构建：

`npm run build:sns-cookie-extension`

不要直接修改 Firefox 公共复制文件后忘记回写 Chrome 源，否则下次 build 会覆盖。

## 5. 多服务器

扩展允许保存多台 Drop2Tunnel Server。

每台 server 独立保存：

- base URL；
- sync token；
- 是否同步 private YouTube Premium；
- enabled；
- sync interval 等。

因此同一个浏览器登录态可以同时供多台自托管实例使用。

## 6. 同步 Token

管理页 API：

- `GET /api/sns-cookie-sync`
- `POST /api/sns-cookie-sync/token`
- `DELETE /api/sns-cookie-sync/token`

生成 token 后：

- 明文只给管理员保存到扩展；
- 服务端配置只保存 SHA-256 hash；
- 验证时对 Authorization Bearer 做 SHA-256，并用 timing-safe compare。

同步接口：

- `POST /api/sns-cookie-sync`：批量
- `POST /api/sns-cookie-sync/:platform`：单平台

同步接口有独立 rate limit。

## 7. Token 与 Admin Session 的区别

生成/撤销 token 必须先有管理员 Session。

扩展后续同步不携带 admin browser cookie，而使用专门的 Bearer sync token。

这样可以：

- 撤销自动同步，不需要改管理员 TOTP；
- 不把长时间 admin session cookie 放进扩展；
- 每台服务器独立 rotation。

## 8. 公共 Cookie 与私人 YouTube Premium Cookie

这是两套不同用途。

### 公共 SNS Cookie

供：

- SNS 抓取；
- 普通 YouTube/YT Music 获取链路。

### Private Premium Cookie

只供：

`/youtube-premium-dl`

每台 server 可以单独勾选：

> 同时同步为私人 YouTube Premium Cookie

它不会和公共 `yt-cookies.txt` 共用同一个逻辑凭据，也不会从服务端回传给扩展。

## 9. 自动触发

当前扩展行为：

- 默认约每 15 分钟检查一次；
- Cookie 内容未变化且刚同步过，不重复上传；
- 受支持平台 Cookie 变化后延迟约 1 分钟同步；
- 很久未打开的平台重新打开后，在页面稳定数秒后同步；
- 没有可用 Cookie 的平台跳过，不会用空内容删除服务端已有配置。

## 10. 配置导入导出

扩展支持 Base64 配置导入/导出。

包含：

- server URL；
- sync token；
- private Premium toggle；
- enabled；
- interval 等。

不包含实际 SNS Cookie。

重要：

> Base64 是编码，不是加密。

导出内容仍包含 sync token，必须按 secret 对待。

## 11. 扩展重载与协议版本

历史上发生过：

- Options 页面已经是新版；
- background service worker 仍然运行旧代码；
- 用户以为新选项已生效，实际后台协议没更新。

因此当前前后台会检查同步协议版本，并在不匹配时要求用户重新加载扩展。

升级源码后需要在浏览器扩展管理页执行 reload。

## 12. SNS Cookie 管理页

`/sns-cookies` 受管理员认证保护。

页面支持：

- 查看各平台 Cookie 状态；
- 保存；
- 清空；
- YouTube Premium private cookie；
- 重新读取；
- 生成/复制/撤销同步 token；
- 查看平台使用提示。

Bilibili 后来加入 SNS 下载能力，UI 需求明确提示最好使用闲置 B 站小号 Cookie，降低主账号风险。实际支持列表与文件映射仍以当前 `SNS_COOKIE_FILES` 为准。

## 13. 安全边界

扩展只应请求：

- 已列出的 SNS host permissions；
- 用户明确配置的 Drop2Tunnel server origin。

必须避免：

- 读取无关网站 Cookie；
- 在 console 打印 Cookie；
- 把同步 token 放 URL query；
- 将 private Premium credential 返回普通 API；
- 删除扩展中的 server 条目时误以为服务端 token 自动撤销。

从扩展删除 server 只停止发送；真正 revoke 仍要在对应服务器 `/sns-cookies` 操作。

## 14. Cookie 的不稳定性

自动同步减少手工导出成本，但不保证：

- YouTube 不轮换 Cookie；
- IP 改变后仍接受；
- 不触发机器人验证；
- 账号不会被平台风控。

下载错误仍要把“Cookie 失效/不完整”与程序内部错误分开诊断。

## 15. 历史演进

2026-08-14 前后：

- 从单服务器手工 Cookie，扩展到多服务器/多平台；
- 增加 Base64 config backup；
- 修复 Chrome 首次 Origin permission 弹窗导致 server config 丢失；
- 增加 Firefox Windows / Android；
- 加入 private Premium 单独同步。

后续修改下载平台时，应同步考虑：

1. `SNS_COOKIE_FILES`
2. `/sns-cookies` UI
3. extension host permissions
4. extension platform mapping
5. build copies
6. redaction / error labels。
