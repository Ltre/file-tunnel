# Telegram Bot、中转、指定目标转发与内容管理

> **源码基线**：`dev/2609-s1@b422e438fe50f78fdacd84ac1dff34a30a3d43ba`

## 1. 模块定位

Telegram 在 Drop2Tunnel 中不是单一功能，至少有四种不同用途：

1. Telegram Bot 把私聊/群/频道内容转入隧道；
2. 普通隧道文件的 Telegram `file_id` 兜底与换绑；
3. Telegram 虚拟网盘的实际文件托管；
4. SNS / YouTube Premium 下载成品转发到指定 Telegram 目标；
5. 后台 `/telegram-content` 对 Bot 已知 Chat 的消息浏览、发送与管理。

本文主要描述 1、4、5；虚拟网盘见 [telegram-drive.md](./telegram-drive.md)。

这些用途不能混淆。例如“网盘托管频道”应从内容管理 Chat 中过滤，避免 Bot 自己归档产生递归内容。

## 2. Bot 配置与 Webhook

管理页：

- `/tgbot`
- `pages/tgbot.html`

服务端配置相关 API：

- `GET /api/telegram/config`
- `POST /api/telegram/config`
- `GET /api/telegram/webhook-config`
- `POST /api/telegram/webhook-config`
- `POST /api/telegram/webhook/:secret?`

历史上曾把“保存 Bot Token”与 Telegram `setWebhook` 隐式绑定，导致多个测试服务器只要保存配置就可能抢走生产 Bot 的 Webhook。2026-08-21 后明确拆分：

- 保存配置只处理本地配置及必要验证；
- Webhook 读取/设置是独立显式动作；
- 更换/清空本地 Token 不应偷偷删除远端 Webhook；
- 设置当前服务器为 Webhook 前必须提示会影响原服务器；
- webhook secret 不应在管理 UI 中泄露。

这是长期安全边界，后续不要把“保存配置 = 自动 setWebhook”恢复回来。

## 3. 隧道中转模式

Bot 支持：

- `/tunnel A1B2C`：进入某个隧道中转模式；
- `/leave_tunnel`：离开。

历史上中转绑定已做持久化，Node 重启后需要恢复。

中转模式下：

- 普通文本进入指定隧道；
- 文件、图片、视频、音频、语音、动画、video note 等可形成普通传输记录；
- Telegram `media_group_id` 聚合为一个合辑；
- 单文件 caption / album caption 应原样作为传输记录备注；
- 已经绑定隧道时不应再把 caption 中偶然出现的 5 位字符串误解析成短码。

未绑定模式才会从命令/caption/后续消息寻找目标短码。

## 4. Telegram 入站文件与隧道文件模型

入站 Telegram 文件最终仍需映射成 Drop2Tunnel 的文件记录。

重要信息：

- Telegram `file_id`；
- `file_unique_id`；
- message/chat；
- 原始文件名/MIME/大小；
- album；
- caption。

`file_id` 会作为以后设备间恢复失败时的备选来源。

但是 Telegram 不能恢复已经在所有来源都不存在的内容；`file_id` 也会因 Bot 变化而失效。

## 5. Telegram 文件连续性 / 防失联

资源管理器可以检查当前记录绑定的 Telegram 文件是否仍可读。

如果旧 `file_id` 失效，但仍有：

- 当前浏览器完整缓存；
- 本机有效文件句柄；
- 其它在线浏览器副本；

则可重新上传到当前 Bot，并换绑新的 Telegram 定位信息。

设计初衷是：

> Telegram 是额外恢复层，不应该变成唯一副本后才发现 Bot 已经不可访问。

## 6. SNS / YouTube Premium 指定 Telegram 目标转发

后台：

- `/sns-dl`
- `/youtube-premium-dl`

已完成任务可以通过“转发到指定的 Telegram 目标”打开 `div.telegram-target-forward-menu`。

相关客户端：

- `client/telegram-target-forward.js`
- `client/telegram-target-forward.css`

服务端：

- `GET /api/telegram-forward-targets`
- `PATCH /api/telegram-forward-targets`
- `POST /api/telegram-forward-targets/delete`
- `POST /api/sns-dl/tasks/:taskId/telegram-forward`
- `POST /api/youtube-premium/tasks/:taskId/telegram-forward`

### 6.1 交互

当前历史需求明确：

- 菜单再次点 trigger 可关闭；
- 点击菜单外空白也应关闭；
- 最近 Telegram 目标会持久化；
- 历史目标支持备注编辑；
- 备注 Input 放在目标历史 row 内；
- caption 可以自定义。

### 6.2 目标语义

历史上尝试过接受 Telegram 私有邀请链接，并将邀请链接映射到 chat ID；后续 2026-09-21 的实现明确删除“不可靠的通用私有邀请链接识别”，当前应以源码支持的公开用户名/数字 chat ID 等形式为准。

因此旧 Prompt 中“支持任意 `t.me/+...`”不能直接写成当前保证能力。修改时应以 `normalizeTelegramForwardTarget` 当前实现为准。

### 6.3 视频预览

“支持视频预览”不是压缩视频的开关。

需求目标：

- 原视频字节尽量不重新编码；
- 以 Telegram 能识别为视频消息的方式发送；
- 保留原比例预览区域；
- 生成/发送缩略图，使未播放时有封面和播放按钮。

2026-09-21 已补了视频封面缩略图链路。

### 6.4 图片预览的历史收敛

曾提出“支持图片预览，但提醒不发送原图”的选项；后续提交明确删除了该选项及对应逻辑。因此它是已被收敛掉的历史需求，不应在新 UI 中重新出现，除非用户再次明确提出。

## 7. Telegram Song Share

当前还有歌曲专用 Telegram 分享链路：

- `POST /api/telegram/song-share`
- `GET /api/telegram/song-share/:jobId`

YouTube Premium 歌曲元数据、内嵌封面、原尺寸封面、自定义封面与 Telegram `sendAudio` 的缩略图曾经过多轮修正。

高风险点：

- 歌曲 artist 与 album artist 不能混为一谈；
- “群星 / Various Artists / compilation”语义不能被单曲 artist 覆盖；
- 自定义封面、原图、裁切方图是不同资源；
- 上传进度不能因为封面和音频并行/串行而错误累计。

## 8. `/telegram-content` 内容管理

入口：

- `/telegram-content`
- `pages/telegram-content.html`
- `client/telegram-content.js`
- `server/telegram-content-manager.js`

当前服务端 API：

- `GET /api/telegram-content/chats`
- `GET /api/telegram-content/chats/:chatId/management`
- `GET /api/telegram-content/chats/:chatId/members/:userId`
- `PATCH /api/telegram-content/chats/:chatId/policy`
- `POST /api/telegram-content/chats/:chatId/actions`
- `GET /api/telegram-content/chats/:chatId/messages`
- `POST /api/telegram-content/chats/:chatId/messages`
- `PUT /api/telegram-content/chats/:chatId/attachments`
- `GET /api/telegram-content/messages/:messageId/media`

## 9. Chat 发现与消息归档

需求来源于“Bot 明明已经能读取群/频道消息，但后台页面没有出现新 Chat”。

当前 manager 会观察 Telegram updates，建立 known chat，并处理：

- 私聊；
- 群；
- supergroup；
- channel；
- message / channel_post；
- 成员变更等。

2026-09-22 又补了 Webhook `allowed_updates` 管理和新消息轮询。

客户端有：

- Chat 列表；
- 当前 Chat 标题/元信息；
- Message 列表；
- 锚点/分页；
- composer；
- attachments；
- management 区。

### 9.1 三天本地缓存

2026-09-21 为 Chat archive 增加约三天缓存、并发去重和双向分页，避免每次进入长 Chat 都从头抓取。

长消息 DOM 需要裁剪，同时保存 browse anchor，不能因为裁剪导致滚动跳跃。

## 10. Telegram 消息正文与媒体存储

内容管理后来做了一个重要收敛：

- 消息正文/附件归档可以借助网盘托管频道；
- 本地只保存远端指针；
- 托管频道本身必须从普通内容管理 Chat 观察中排除，避免递归“Bot 归档自己的归档消息”。

发送图文时，历史需求要求正文尽量作为第一个附件 caption，而不是先发一条文本、再发一条媒体，避免 Telegram 侧被拆成两条消息。

## 11. 群 / 频道管理

当前 `telegram-content-manager.js` 提供管理状态和 action。

历史需求：

### 11.1 禁止新用户

“停止接受新用户进群/进频道”开启后，新加入成员应被 remove + ban。

实现时要区分：

- 群成员 join；
- channel member update；
- Bot 自身权限；
- 管理员不能操作超出 Bot 权限范围的动作。

### 11.2 限制用户权限

仅群适用。

输入 Telegram User ID，选择需要限制的权限。

### 11.3 移除用户

输入 User ID，可选择是否 ban。

### 11.4 设置/编辑管理员

流程要求：

1. 输入 User ID；
2. 先查询该用户当前是否管理员；
3. 如果是，渲染已有管理员权限；
4. UI 显示 Bot 自己可授予的最大权限范围；
5. 不能让用户勾选 Bot 自身没有的权限；
6. 提交相应 `promoteChatMember` 语义。

### 11.5 移除管理员

把目标管理员权限降回普通成员权限，而不是把用户删除出群。

## 12. 私聊停服

私聊 Chat 提供：

- `停止服务该用户`
- `恢复服务该用户`

停服后对该用户的新消息每天最多提醒一次：

`该bot已停止服务`

这里的目标是“停服但不造成每条消息都刷一次提示”。

## 13. Webhook subscriptions

内容管理页面会同步需要的 webhook subscriptions。修改 Telegram Bot 更新类型时需要检查：

- 原有 tunnel Bot update；
- chat/message archive；
- member updates；
- channel posts；

不要因为只想新增一个 `allowed_update` 就覆盖掉其它子系统需要的 update 类型。

## 14. 安全边界

- Bot Token 不应输出到日志；
- webhook secret 不展示；
- 管理 API 必须受管理员认证；
- Telegram 用户 ID / Chat ID 都是外部输入；
- media 下载和发送应有大小/超时限制；
- 网盘 storage chat 不作为普通管理 Chat 暴露；
- 用户输入 caption/remark 不能作为命令或路径直接拼接 shell。

## 15. 相关测试

重点：

- `tests/telegram-cover-regression.test.cjs`
- `tests/features-260921-*.test.cjs`
- `tests/features-260922-1.test.cjs`
- `tests/youtube-premium.test.cjs`
- `tests/sns-download.test.cjs`
- 与 tgbot / Telegram 的版本回归测试。

人工验收与自动测试冲突时，应记录真实环境差异，例如正式 Bot 权限、群类型、Webhook 真实配置，而不是只相信 Mock。
