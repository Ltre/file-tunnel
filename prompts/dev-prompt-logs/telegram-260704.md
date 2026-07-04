我看了代码，Telegram 接入现在是这样的：

1. 后台 `/tgbot` 填的 `bot token` 和 `webhook secret` 会保存到：
   [telegram-bot.json](D:/Workspace/github/Ltre/file-tunnel/.tunnel-data/telegram-bot.json)

2. 服务端 webhook 接收地址是：
   `POST /api/telegram/webhook/:secret?`

   也就是如果你的公网域名是 `https://tun.miku.us`，secret 是 `abc123`，那 webhook URL 应该是：

   ```text
   https://tun.miku.us/api/telegram/webhook/abc123
   ```

3. 当前代码没有自动调用 Telegram 的 `setWebhook`，所以你后台填完 token/secret 后，还需要手动向 Telegram 注册 webhook。

在 Windows PowerShell 里执行：

```powershell
$TG_TOKEN = "你的bot token"
$SECRET = "你后台填的webhook secret"
$WEBHOOK = "https://tun.miku.us/api/telegram/webhook/$SECRET"

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$TG_TOKEN/setWebhook" `
  -ContentType "application/json" `
  -Body (@{
    url = $WEBHOOK
    allowed_updates = @("message", "edited_message")
  } | ConvertTo-Json)
```

然后验证：

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo"
```

重点看返回里的：

```json
"url": "https://tun.miku.us/api/telegram/webhook/你的secret",
"last_error_message": ""
```

使用方式：

```text
/tunnel 12345
```

其中 `12345` 是隧道五位暗号。成功后，之后直接给 bot 发文本、转发文件、发图片/视频/音频，都会进入这个隧道。

退出当前隧道中转模式：

```text
/leave_tunnel
```

我也注意到一个小问题：`server.js` 和 `tgbot.html` 里部分中文提示已经乱码了，比如 bot 回复文案，但主流程不受影响。后面可以单独修文案编码。