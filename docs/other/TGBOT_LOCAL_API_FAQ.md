
问：

	如何build  Telegram Bot API server


答：

	https://tdlib.github.io/telegram-bot-api/build.html



问：


	telegram bot api文档提到Local Bot API Server  ，bot通过这个local server上传和下载的文件，到底是保存在哪的？要求这个渠道的文件永久由第三方服务器自己管理吗
	
	
	
	
答：



不是。**Local Bot API Server 并不会把 Telegram 的文件托管责任转嫁给你自己的服务器。**

可以把它理解成：

> **你自建的 Local Bot API Server 是 Telegram Bot API 的本地网关/客户端 + 文件缓存层，不是 Telegram 消息附件的最终存储服务器。**

### 上传文件时

例如你的服务器上有：

```text
/data/a.mp4
```

然后通过 Local Bot API Server 的 `--local` 模式发送：

```text
你的程序
  ↓
Local Bot API Server
  ↓
Telegram 核心网络
  ↓
Telegram 文件存储
  ↓
频道 / 用户
```

Local 模式允许上传最大约 2000 MB，还允许直接传**本地文件路径**，这些是官方明确列出的 Local Bot API Server 特性。([GitHub][1])

一旦 Telegram 成功接收这个文件并生成消息：

> **文件正式存储在 Telegram 一侧。**

不要求你继续永久保存 `/data/a.mp4`。

哪怕之后：

```text
你的 Local Bot API Server 关闭
你的 VPS 关机
原始 /data/a.mp4 被删除
```

已经发送到 Telegram 聊天/频道里的那个文件仍然可以由用户正常下载。Telegram Bot API 项目的维护者也明确说明，本地 Bot API 只是让 Bot 通过 HTTP 使用 Telegram API，其他行为与普通 Telegram 用户相同；实际测试也确认经本地 Bot API 上传的大文件最终由 Telegram 保存。([GitHub][2])

---

## 那 Local Bot API Server 为什么磁盘里又会出现 Telegram 文件？

因为**下载方向不一样**。

假设用户发了一个 1 GB 文件给你的 Bot：

```text
Telegram
   │
   │ 文件实际在 Telegram
   ▼
Local Bot API Server
```

当你调用：

```text
getFile(file_id)
```

Local Bot API Server 会：

```text
Telegram
   ↓ 下载
Local Bot API Server 本地磁盘
   ↓
返回本地绝对路径
```

官方 Local 模式特性就是：

> `getFile` 可以返回文件的绝对本地路径，而无需你的 Bot 程序再通过标准 Bot API 的 HTTP 下载接口拉一遍。([GitHub][1])

Telegram Bot API 项目维护者在 2025 年也直接确认：

> Local 模式下调用 `getFile` 会把文件保存到 Bot API Server 本地，并返回完整本地路径。([GitHub][3])

所以：

```text
上传：
你的磁盘 → Telegram
最终持久文件：Telegram

下载：
Telegram → Local Bot API Server磁盘
本地会产生缓存/副本
最终持久文件仍然：Telegram
```

---

# 本地下载文件具体保存在哪里？

Local Bot API Server 有几个相关启动参数：

```bash
--dir
--files-dir
--temp-dir
```

源码中定义：

```text
--dir
server working directory

--files-dir
directory for storing auxiliary files
默认使用 working directory

--temp-dir
HTTP server temporary files
```

也就是说，你可以明确把文件相关数据放到单独磁盘，例如：

```bash
telegram-bot-api \
  --local \
  --api-id=... \
  --api-hash=... \
  --dir=/var/lib/telegram-bot-api \
  --files-dir=/data/telegram-bot-files \
  --temp-dir=/data/telegram-bot-temp
```

源码也明确说明 `--files-dir` 默认就是工作目录，并会在那里创建文件和目录。([GitHub][4])

实际目录下面还会有 TDLib/Bot API 自己的结构，**不要依赖内部子目录名称作为你自己的业务存储协议**。

---

# 一个容易混淆的例子

假设 Telegram 用户：

```text
用户A
→ 给 Bot 发 movie.mp4
```

Telegram 已经保存：

```text
Telegram Cloud
└── movie.mp4
```

你的程序收到：

```json
{
    "file_id": "BQACAg..."
}
```

这时候你的服务器**不一定已经有完整 movie.mp4**。

调用：

```text
getFile(BQACAg...)
```

才会让 Local Bot API Server 获取这个文件。

之后可能得到：

```json
{
    "file_path": "/data/telegram-bot-files/123456789/documents/file_123.mp4"
}
```

那么：

```text
/data/telegram-bot-files/...
```

就是**你机器上的本地副本**。

但 Telegram 云端仍然有自己的正式副本。

---

# 这个本地副本需要永久保留吗？

**不需要。**

而且我建议你把它理解成：

> **Telegram Bot API Server 管理的本地缓存，而不是你的永久文件仓库。**

官方没有给你一个“这个路径下的媒体文件保证永久保存”的 API 契约。

事实上，社区里已经有人提出：

```text
大量 getFile
→ 文件全部落本地磁盘
→ 磁盘容易越来越大
```

甚至有人专门讨论通过 cron 清理闲置文件。([GitHub][5])

所以如果你的业务确实需要永久保存一份自己的文件：

```text
getFile
↓
取得 Local Bot API 的文件路径
↓
复制/移动到你自己管理的目录
```

例如：

```text
Telegram API内部缓存：
/data/telegram-api/...

自己的正式存储：
/data/drop2tunnel/assets/...
```

这两个概念不要混。

---

# 对 Drop2Tunnel 来说尤其重要

例如 Telegram Bot 收到：

```text
用户 → Telegram Bot → Drop2Tunnel
```

我建议模型是：

```text
Telegram
│
│ file_id
│
▼
Local Bot API Server
│
│ getFile
▼
Bot API 本地缓存
│
├──────────────► 浏览器设备A
│
├──────────────► 浏览器设备B
│
└──────────────► Drop2Tunnel server asset
```

如果你只是需要：

> “设备在线的时候，可以从 Telegram 恢复这个文件”

那么甚至可以**不永久保存服务器文件**。

保存：

```text
file_id
file_unique_id
文件名
MIME
大小
Telegram message_id
chat_id
```

即可。

需要时：

```text
file_id
↓
Local Bot API getFile
↓
重新从 Telegram 下载
```

这样 Telegram 本身就相当于一个远程 provider。

---

## 更进一步，你甚至可以这样设计

你的 provider 列表：

```text
asset ABC
├─ Browser A        在线，有缓存
├─ Browser B        离线，历史有缓存
├─ Node cache       当前无缓存
└─ Telegram         file_id 可恢复
```

设备请求时：

```text
Browser A在线
→ P2P取

否则 Node有缓存
→ Node取

否则 Telegram file_id仍有效
→ Local Bot API getFile
→ Node临时缓存
→ 提供给设备
```

完成以后：

```text
Browser B也获得完整文件
↓
Browser B成为provider
```

而 Node 的 Telegram 下载副本则可以以后清掉。

这个架构其实非常适合你现在的 provider 思路。

---

# 有两个东西不要混淆

### `file_path`

Local Bot API 返回的：

```text
/data/.../file.mp4
```

这是**本机路径**。

如果 Bot 程序和 `telegram-bot-api` 不在同一台机器：

```text
机器A：
Node.js Bot

机器B：
telegram-bot-api
/data/file.mp4
```

机器 A 不能直接：

```js
fs.readFile('/data/file.mp4')
```

因为路径属于机器 B。这个坑社区里也有人实际踩过。([GitHub][3])

### `file_id`

这是 Telegram 的文件标识。

后续可以：

```text
再次发送
getFile
重新下载
```

它不是本地路径。

---

# 最终可以这样理解

```text
                    Telegram Cloud
                   【正式文件存储】
                         ▲
                         │
                         │ Telegram协议
                         │
               Local Bot API Server
             【网关 + TDLib + 本地缓存】
                    ▲          │
                    │          │ getFile缓存
                    │          ▼
               Drop2Tunnel   本地磁盘
                    │       【可清缓存】
                    ▼
               Browser设备
```

所以你问的：

> **“这个渠道的文件要求永久由第三方服务器自己管理吗？”**

答案明确是：

**不要求。**

Local Bot API Server 上传成功以后，Telegram 自己保存正式文件；你自己的服务器无需为了维持 Telegram 消息中的文件可用性而永久保存上传源文件。反方向通过 `getFile` 下载时，本地会形成副本/缓存，但这也不应被视为唯一永久存储。Telegram 服务器上的文件即使你的 Local Bot API Server 停机，Telegram 用户侧仍可访问。([GitHub][2])

对于 Drop2Tunnel，我甚至建议：**把 Telegram `file_id` 视为一种远程持久 provider，Node.js 本地文件视为可清理缓存，而不是把 Telegram Bot 文件全部永久复制一遍到自己的服务器。**

[1]: https://github.com/tdlib/telegram-bot-api?utm_source=chatgpt.com "GitHub - tdlib/telegram-bot-api: Telegram Bot API server · GitHub"
[2]: https://github.com/tdlib/telegram-bot-api/issues/402?utm_source=chatgpt.com "Does Local Bot API Server store files on the local server? · Issue #402 · tdlib/telegram-bot-api"
[3]: https://github.com/tdlib/telegram-bot-api/issues/717?utm_source=chatgpt.com "Broken downloaded files · Issue #717 · tdlib/telegram-bot-api"
[4]: https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/telegram-bot-api.cpp?utm_source=chatgpt.com "telegram-bot-api/telegram-bot-api/telegram-bot-api.cpp at master · tdlib/telegram-bot-api · GitHub"
[5]: https://github.com/tdlib/telegram-bot-api/issues/141?utm_source=chatgpt.com "Add `offset` and `limit` parameters to `getFile` method · Issue #141 · tdlib/telegram-bot-api"





问：





	那么telegram让第三方搭建local api server的目的是什么？为了减少自己压力？还是给第三方一些网络上的方便？第三方能获得什么利益？能否审计经过local api server的流量？
	
	
	
	
答：




更准确地说，**Telegram 提供 Local Bot API Server，主要是给 Bot 开发者更多部署自由和突破官方 Bot API 网关的限制，不是官方公开宣称的“帮 Telegram 分担服务器压力”机制。**

Telegram 官方自己写得很直白：绝大多数 Bot 用官方 `api.telegram.org` 就够了；只有需要额外能力时，才建议切到自建 Local Bot API Server。它列出的收益包括：下载文件不受普通 Bot API 文件大小限制、上传最高 2000 MB、直接用本地文件路径上传、Webhook 可用 HTTP/任意本地 IP/任意端口、连接数可大幅提高、`getFile` 可直接返回本地绝对路径。([Telegram][1])

所以第三方最直接得到的是这些利益：

* **大文件能力更强**：官方 Bot API 的常规文件限制更严格，本地模式可上传到 2GB，下载文件也没有 Bot API 层面的大小限制。([Telegram][1])
* **减少自己程序与远程 Bot API 网关之间的绕路**：如果 Node.js 和 Local Bot API 在同一台服务器，发送本地文件时可以直接给路径，不需要你的程序先把几百 MB 数据通过 HTTP multipart 再上传给 `api.telegram.org`。
* **下载也方便**：`getFile` 后直接得到 Local Bot API Server 上的本地路径，不需要再执行一次 Bot API HTTP 文件下载。([GitHub][2])
* **Webhook 自由度更高**：内网 HTTP、本地 IP、任意端口都能用。
* **可控性更强**：磁盘位置、网络出口、代理、日志、资源限制、部署位置都由自己掌控。
* **适合高负载 Bot**：本地模式的 `max_webhook_connections` 可以到 100000。([GitHub][2])

但它并没有把 Telegram 本身替掉。

实际链路更像：

```text
你的 Bot 程序
      │
      │ HTTP Bot API
      ▼
你的 Local Bot API Server
      │
      │ Telegram/TDLib/MTProto
      ▼
Telegram 数据中心
      │
      ▼
Telegram 用户
```

Telegram 用户的客户端**不会直接连接你的 Local Bot API Server**。社区对这个架构的解释也很明确：Local Bot API Server 本质是 Telegram API/TDLib 前面的一层 REST API 适配器，用户客户端和 Bot API Server 之间的通信仍经过 Telegram 官方服务器。([GitHub][3])

所以“Telegram是不是为了省自己压力”这件事，我会这么判断：

> **可能有一点间接减压效果，但不是主要公开目的。**

比如你自己承担了：

* HTTP Bot API 接入；
* multipart 文件接收；
* 文件临时缓存；
* webhook 调度；
* 一部分 Bot API 网关计算。

Telegram官方 `api.telegram.org` 的确不用再替你处理这些具体 Bot API HTTP 请求。

但核心重活依然没卸掉：

```text
消息路由
Telegram账号状态
频道/群组
文件最终存储
Telegram数据中心传输
MTProto
用户端下载
```

这些仍然由 Telegram 负责。

因此它不是：

```text
Telegram：
“你自己帮我存文件、帮我服务用户”
```

而更像：

```text
Telegram：
“如果标准 REST 网关限制不够用，
你可以自己运行这一层网关，
然后直接和 Telegram 后端协议交互。”
```

---

## 那能不能审计经过 Local Bot API Server 的流量？

**能，而且能看得非常深。**

但要分两段链路。

### 1. Bot 程序 ↔ Local Bot API Server

这一段你完全控制。

官方 Local Bot API Server 本身只接受 HTTP；如果要跨机器安全访问，需要自己在前面加 TLS termination proxy。([GitHub][2])

比如：

```text
Node.js
   │
   │ HTTP
   ▼
127.0.0.1:8081
telegram-bot-api
```

这里你可以审计：

* 调用了哪个 Bot API 方法；
* `sendMessage`
* `sendDocument`
* `sendPhoto`
* `getUpdates`
* `getFile`
* 请求时间；
* HTTP body；
* 文件大小；
* 文件内容；
* Telegram `chat_id`；
* `message_id`；
* `file_id`；
* API 返回结果；
* 错误代码；
* 延迟。

例如前面套 Nginx：

```text
Node.js
↓
Nginx
↓
telegram-bot-api
```

就可以记录访问日志。

甚至由于 telegram-bot-api 是开源的，你完全可以改源码：

```cpp
收到 sendDocument
→ 记录方法
→ 记录 chat_id
→ 记录文件名
→ 记录大小
→ 再继续处理
```

所以如果你说的“审计”是：

> 我自己运营 Local Bot API Server，能不能知道我的 Bot 实际传了什么？

答案是：

**可以。**

---

## 2. Local Bot API Server ↔ Telegram

这一段就不一样了。

底层走 Telegram 的协议栈，MTProto 在传输前对消息进行加密，Telegram 官方协议文档明确说明，消息会先经过加密层，然后再通过 TCP、HTTP、WebSocket 等 transport 发送。([Telegram][4])

所以如果你只是：

```bash
tcpdump
wireshark
```

监听网卡：

```text
Local Bot API Server
        ↕
Telegram DC
```

你通常只能直接看到：

* Telegram 数据中心 IP；
* TCP/网络连接；
* 时间；
* 数据包大小；
* 总流量；
* 上传/下载方向；
* 连接持续时间。

你不能靠普通抓包直接看到：

```text
sendMessage 文本内容
chat_id
文件原始内容
```

因为 MTProto payload 是加密的。([Telegram][5])

---

# 但因为 Local Bot API Server 是你自己运行的，所以仍然能“应用层审计”

这是很关键的区别。

虽然：

```text
网卡抓包
→ MTProto密文
```

但是：

```text
telegram-bot-api进程内部
```

必须经历：

```text
Telegram密文
↓
TDLib/MTProto解密
↓
Telegram Update对象
↓
Bot API JSON
↓
你的程序
```

也就是说，如果你控制这个进程：

> **你当然有机会在解密后记录 Bot 能看到的内容。**

因为否则它根本没办法生成：

```json
{
  "update_id": 123,
  "message": {
    "chat": {...},
    "text": "hello"
  }
}
```

给你的 Bot。

同样上传方向：

```text
你的 HTTP 请求
↓
Local Bot API Server看到明文
↓
转换成Telegram API调用
↓
MTProto加密
↓
Telegram
```

所以如果你修改开源代码，在加密前/解密后打日志，理论上可以做到非常完整的审计。

---

# 如果“第三方”不是你自己，而是别人替你搭 Local API Server

那风险就很大。

例如：

```text
你的 Bot
↓
某个第三方提供的
https://telegram-api.example.com
↓
Telegram
```

这家第三方理论上可以看到你的：

* Bot token；
* Bot API 方法；
* Bot 发出的消息；
* Bot 收到的 update；
* 用户发给 Bot 的文本；
* 图片；
* 视频；
* 文档；
* chat_id；
* user_id；
* file_id；
* 文件内容。

因为它就在 Bot API 的明文处理路径上。

甚至 Bot token 本身通常就出现在 Bot API URL 路径中，例如：

```text
/bot123456:ABCDEF/sendMessage
```

2026 年 telegram-bot-api 项目里甚至有人专门提出，反向代理或 HTTP 客户端如果直接记录 URL，可能把 Bot token 写进日志，因此自建时应特别注意访问日志脱敏。([GitHub][6])

所以：

> **Local Bot API Server 是高信任组件。**

最好：

```text
你自己的机器
+
127.0.0.1
+
自己的 Node.js
+
自己的 telegram-bot-api
```

而不是使用陌生第三方公共服务。

---

# 对你这种 Drop2Tunnel 场景，它最大的真正价值

其实不是“帮 Telegram 省服务器”。

而是：

```text
Drop2Tunnel Node.js
       │
       │ 本地路径
       ▼
telegram-bot-api
       │
       ▼
Telegram
```

例如有一个 1.5GB 文件：

普通 Bot API：

```text
Node.js
↓ multipart HTTP
公网
↓
api.telegram.org
```

Local Bot API：

```text
Node.js：
/data/file.mkv

↓ 只告诉它路径

telegram-bot-api：
直接读 /data/file.mkv
↓
自己传给Telegram
```

这样你自己的应用逻辑就轻松很多。

下载也是：

```text
getFile
↓
telegram-bot-api自己从Telegram拉
↓
/data/telegram-bot-api/...
↓
Drop2Tunnel直接读取本地文件
```

避免了：

```text
getFile
↓
得到HTTP URL
↓
Node.js再次HTTP下载
↓
自己保存
```

所以它本质上是在你的业务程序和 Telegram 核心网络之间增加了一个：

> **本地、高权限、高性能、可观测的 Telegram Bot API 网关。**

而不是一个帮 Telegram 承担永久文件托管的 CDN 节点。

[1]: https://core.telegram.org/bots/api?utm_source=chatgpt.com "Telegram Bot API"
[2]: https://github.com/tdlib/telegram-bot-api/blob/master/README.md?utm_source=chatgpt.com "telegram-bot-api/README.md at master · tdlib/telegram-bot-api · GitHub"
[3]: https://github.com/tdlib/telegram-bot-api/issues/1?utm_source=chatgpt.com "Bot api server general questions · Issue #1 · tdlib/telegram-bot-api"
[4]: https://core.telegram.org/mtproto/transports?utm_source=chatgpt.com "Transport protocols"
[5]: https://core.telegram.org/mtproto?utm_source=chatgpt.com "﻿MTProto Mobile Protocol"
[6]: https://github.com/tdlib/telegram-bot-api/issues/876?utm_source=chatgpt.com "Consider more \"private\" way of sending a bot token · Issue #876 · tdlib/telegram-bot-api · GitHub"




