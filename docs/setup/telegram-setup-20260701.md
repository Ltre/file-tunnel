Telegram 支持已经是**完整 webhook 入站方案**，不是需要你自己再写 bot 轮询。代码里做了这些事：

1. `tunnel.config.json` 新增 `telegramBot` 配置块，默认是关闭状态。
2. 服务端启动时读取 `telegramBot.enabled / token / webhookSecret / maxFileSize`。
3. Webhook 入口是：

```text
POST /api/telegram/webhook/:secret?
```

如果配置了 `webhookSecret`，URL 里的 `:secret` 必须匹配，否则返回 `403 invalid-secret`。

4. 用户给 bot 发文件时，如果文件说明文字里带 5 位隧道暗号，就直接发送到该隧道；如果没带暗号，bot 会先缓存这个待处理文件，然后提示用户回复 5 位隧道暗号。
5. 代码支持 Telegram 的 `document / video / audio / photo` 四类消息。
6. 服务端会把 Telegram 文件下载到 `.tunnel-data/telegram-assets`，然后生成一条 `Telegram Bot` 发出的文件记录，广播到对应隧道。

---

## 一、先确认你服务器跑的是这个版本

在服务器仓库里：

```bash
git fetch origin dev/2607A
git switch dev/2607A
git log --oneline -5
```

确认能看到：

```text
3d50eb42 feat: 完善合辑全屏预览切换、隧道备注同步、首页滑动导航、桌面布局优化与 Telegram Bot 入站收文件
```

如果你想精确跑这个 commit：

```bash
git switch dev/2607A
git reset --hard 3d50eb42fa7ab477d3fd293abb1009fe746f39f8
```

---

## 二、找 BotFather 创建 Telegram Bot

在 Telegram 里找：

```text
@BotFather
```

执行：

```text
/newbot
```

它会给你一个 token，形如：

```text
123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Telegram 官方文档也说明，每个 bot 都会获得唯一 token，Bot API 请求格式是：

```text
https://api.telegram.org/bot<token>/METHOD_NAME
```

([Telegram API][1])

---

## 三、修改 `tunnel.config.json`

你的 commit 里默认配置是这样：

```json
{
  "debugLogsEnabled": false,
  "serverPort": 80,
  "telegramBot": {
    "enabled": false,
    "token": "",
    "webhookSecret": "",
    "maxFileSize": 20971520
  }
}
```

改成类似：

```json
{
  "debugLogsEnabled": false,
  "serverPort": 80,
  "telegramBot": {
    "enabled": true,
    "token": "123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "webhookSecret": "tg_你的随机长字符串",
    "maxFileSize": 20971520
  }
}
```

建议 `webhookSecret` 不要用短的，比如：

```bash
openssl rand -hex 24
```

生成：

```text
8c9a7f4d6f4d0bb0b6e2c1a9f0f8e2d7c6b5a4e3c2d1
```

然后配置：

```json
"webhookSecret": "8c9a7f4d6f4d0bb0b6e2c1a9f0f8e2d7c6b5a4e3c2d1"
```

---

## 四、重启 file-tunnel 服务

因为代码是在服务端启动时读取配置：

```js
const projectConfig = loadProjectConfig();
```

所以改完 `tunnel.config.json` 后必须重启。

如果你是直接跑：

```bash
npm install
npm start
```

如果你是 pm2：

```bash
pm2 restart file-tunnel
```

或者：

```bash
pm2 restart server
```

按你的 pm2 进程名来。

---

## 五、确认你的服务有公网 HTTPS 地址

Telegram webhook 需要 Telegram 服务器能访问你的 URL。官方 `setWebhook` 说明是 Telegram 会向你的 HTTPS URL 发送 POST 请求，支持端口是 `443 / 80 / 88 / 8443`。([Telegram API][1])

假设你的 file-tunnel 对外地址是：

```text
https://tunnel.example.com
```

那么 webhook URL 应该是：

```text
https://tunnel.example.com/api/telegram/webhook/8c9a7f4d6f4d0bb0b6e2c1a9f0f8e2d7c6b5a4e3c2d1
```

如果你目前只是：

```text
http://ip:端口
```

那公网 Telegram webhook 大概率不可用。最好用 Nginx/Caddy 反代成 HTTPS 域名。

---

## 六、设置 Telegram webhook

在服务器上执行：

```bash
TG_TOKEN='123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
WEBHOOK_URL='https://tunnel.example.com/api/telegram/webhook/8c9a7f4d6f4d0bb0b6e2c1a9f0f8e2d7c6b5a4e3c2d1'

curl -X POST "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${WEBHOOK_URL}\",\"allowed_updates\":[\"message\",\"edited_message\"],\"drop_pending_updates\":true}"
```

成功应该返回：

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

查看状态：

```bash
curl "https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo"
```

重点看：

```json
"url": "https://tunnel.example.com/api/telegram/webhook/...",
"last_error_message": ""
```

如果 `last_error_message` 有内容，通常是 HTTPS、反代、路径、端口、证书或服务没启动的问题。

---

## 七、实际使用方式

你的隧道页面里先确认有 5 位短码，例如：

```text
A7K9P
```

然后 Telegram 里有两种用法。

### 方式 1：文件说明文字里直接写暗号

给 bot 发送/转发文件，caption 写：

```text
A7K9P
```

服务端会直接把文件发布到这个隧道。

代码里是从 `message.text || message.caption` 提取 5 位暗号。

### 方式 2：先发文件，再回复暗号

先把文件发给 bot。

bot 会回：

```text
已收到文件。请回复 5 位隧道暗号，我会把文件发送到该隧道。
```

然后你回复：

```text
A7K9P
```

它就会把刚才那份文件发送到对应隧道。

成功后 bot 会回复：

```text
已发送到隧道 A7K9P：文件名
```

代码里确实有这个成功提示。

---

## 八、浏览器端会发生什么

Telegram 文件会先存在服务端：

```text
.tunnel-data/telegram-assets
```

然后服务端把它作为 `serverAsset` 发到隧道：

```js
isServerAsset: true,
serverAssetUrl: `/api/server-assets/${assetId}`
```

浏览器收到消息后，会通过：

```text
/api/server-assets/:assetId
```

拉取文件并存入 IndexedDB。这个下载接口在服务端已经实现。

所以你在隧道里看到的效果应该是：

```text
Telegram Bot 发送了一个文件
```

参与这个隧道的所有在线设备都会收到。

---

## 九、建议你用这个最小接入清单

```bash
# 1. 更新到包含 Telegram 支持的版本
git fetch origin dev/2607A
git switch dev/2607A
git reset --hard 3d50eb42fa7ab477d3fd293abb1009fe746f39f8

# 2. 修改 tunnel.config.json
vim tunnel.config.json

# 3. 重启服务
npm install
npm start
```

另一个终端设置 webhook：

```bash
TG_TOKEN='你的bot token'
SECRET='你的webhookSecret'
DOMAIN='https://你的域名'

curl -X POST "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${DOMAIN}/api/telegram/webhook/${SECRET}\",\"allowed_updates\":[\"message\",\"edited_message\"],\"drop_pending_updates\":true}"

curl "https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo"
```

---

## 十、几个容易踩坑的点

`maxFileSize` 默认是 `20971520`，也就是 20MB。代码会先看 Telegram 上报大小，再看实际下载后的大小，超过都会拒绝。

`webhookSecret` 是 URL 路径密钥，不是 Telegram 官方 `secret_token` 请求头。也就是说你设置 webhook 时，必须把 secret 放在 URL 后面：

```text
/api/telegram/webhook/你的secret
```

这个版本没有看到自动调用 `setWebhook` 的代码，所以你需要手动跑一次 `curl setWebhook`。

另外，`.tunnel-data/telegram-assets` 目前看是临时服务端资产目录，但这版代码没有看到定期清理逻辑。文件多了以后建议后续加 TTL 清理，或者用系统定时任务清旧文件。

[1]: https://core.telegram.org/bots/api "Telegram Bot API"
