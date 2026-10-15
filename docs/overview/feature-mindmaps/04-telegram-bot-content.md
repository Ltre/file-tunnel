# Telegram Bot、中转、内容管理与来源迁移 — 思维导图

> **源码基线 Commit**：`b1788ca4b219718ad802ed778ed41c081ecad39b`  
> **文档更新时间**：2026-10-16  
> **状态**：现有功能与运行边界  
> **主要参考**：[../telegram-bot-content.md](./../telegram-bot-content.md)、[../telegram-drive.md](./../telegram-drive.md)

[返回全景思维导图](./README.md)

```mermaid
mindmap
  root((Telegram Bot 与内容))
    Bot 管理
      tgbot 管理页面
      Bot Token 独立管理员配置
        本地保存
          POST /api/telegram/config
          不自动 setWebhook
          更换 Token 不暗中删除远端 Webhook
      Webhook secret 生成
      Telegram Webhook 注册
        独立操作
          GET /api/telegram/webhook-config
          POST /api/telegram/webhook-config
          更改前警示可能抢占生产 Bot
      指令注册
      API 地址及网络代理
      凭据不暴露到客户端
    入站隧道中转
      隧道关联
        tunnel 短码指令
          命令
            /tunnel 五位短码
            /leave_tunnel
          持久化
            Chat 与隧道对应关系
            重启恢复中转
        leave tunnel 退出
        未绑定时通过 caption 指定短码
          行为
            只有未绑定才解析
            已绑定时不误读 caption 中的数字
            无效短码不能误中转
        后续文字输入短码
        Chat 绑定持久化
      消息类型
        文本
        富文本内容
        图片
        视频
        音频
        文档
        语音
        动画
        视频消息
        Telegram album 媒体组
          聚合
            media_group_id
            多媒体合成一条隧道合辑
            成员顺序及备注 Caption 保留
      记录元数据
        caption 保留
        album caption 合并
        原 Telegram file_id
          关联
            file_unique_id
            数字 Chat ID
            message_id
            MIME 文件名大小
          限制
            file_id 与当前 Bot 相关
            不是永恒可用的下载 URL
        message_id
        数字 chat_id
        媒体大小和类型
    历史文件防失联
      file_id 直接 getFile
      不靠 public 猜测文件所属 Chat
      在线供源优先于 Bot 回源
      Bot 下载成功验证大小
      更新本机完整缓存
      用户主动触发资源检查修复
      本机完整副本协助重新上传
      旧文件关联新 file_id
      不能从失效且无副本的文件凭空恢复
    Chat 字典
      数字 Chat ID 映射
        检查
          非零十进制整数
          同一 ID 仅一条
          private 后 ID 不变
          不能从 public 名称反猜 ID
        负数频道群组
        正数私聊
        只接收非零十进制
      public 主名称规范化
        t me URL 转统一格式
        小写用户名
        禁止邀请链接和消息链接
      历史 public 别名
        规范化
          公开 t.me 路径
          小写 @username
        拒绝
          邀请与消息链接
          重复占用的用户名
        改名保留旧名称
        重名占用冲突拒绝
        单条别名数量限制
      保存控制
        写入
          telegram-chat-dictionary.json
          不属于网盘用户 SQLite
          临时文件原子重命名
        限制
          最多 500 条
          每条最多 20 别名
          备注最多 100 字符
          revision 冲突不覆盖
        与保存 Bot 配置独立
        原子替换 JSON
        乐观版本冲突
        读取错误不清空文件
      来源解析
        public 名称查数字 ID
        ID 反查名称仅用于显示
        getChat 数字 ID 校验
          认证
            字典判断历史同一 Chat
            getChat 验证映射数字 ID
            返回不一致拒绝
          缓存
            成功五分钟
            失败三十秒冷却
            按 Bot 和 API URL 隔离
        返回 Chat 不一致拒绝
        验证五分钟缓存
        失败三十秒冷却
        新上传目标解析 ID 才能继续
      前端渐进迁移
        触发
          用户主动点击防失联检查
          不在 PWA 启动后自动扫描
        变更
          本机 telegramChatId
          单文件记录
          合辑相关记录
          不能写回旧 public
        防失联按钮主动执行
        不因页面打开自动扫描
        找到可信映射即替换来源
        相同文件关联记录同步更新
        完整回源仍是兜底
      SQLite 托管频道离线迁移
        停服 change tgdisk channel id 工具
        只改可信来源字段
        旧 ID 不等于新的内容归属证明
    SNS 链接识别与转发
      Telegram caption 提取 URL
      YouTube 和音乐链接
      TikTok Instagram Facebook
      Threads LINE Twitter X
      识别列表或多链接
      先识别元数据不自动下载
      按需获取完整文件
      转发指定 Telegram Chat
      视频预览与远端响应
      转发生成新文件记录
    Telegram 歌曲分享
      Base 频道
      Pro 频道
      Ultimate 频道
      文件与 Caption
      任务进度回报
      已修复音轨版本选择
    内容管理后台
      Telegram Content 页面
      Chat 发现
      Chat 列表及消息归档
      三天本地缓存
        消息浏览
          并发请求去重
          双向分页
          DOM 长列表裁剪
          恢复滚动锚点
      搜索浏览消息正文
      图文与媒体信息
        Telegram 消息组织
          尽量让正文成为首个附件 Caption
          避免文本和媒体拆成多条独立消息
          本地归档保存远端指针
      托管频道排除策略
        排除
          public 主名称
          历史别名
          字典中数字 ID
          防止存储消息被重复归档
        public 名称判断
        字典数字 ID 判断
        改私有不误采集
    群组和频道成员管理
      禁止新成员
      成员权限限制
      移除成员
      设置管理员
      修改管理员权限
        交互
          输入 User ID
          读取既有管理员权限
          仅开放 Bot 能授予的权限
          删除管理员只是撤权并非踢出群
      移除管理员
    私聊停服
      停用
        停止对指定私聊用户提供服务
        停服提示一天最多一次
        支持恢复服务
      禁止私聊或停服策略
      单个 Chat 状态
      拒绝策略与恢复
    Webhook 订阅
      指定事件通知
      入站过滤
      安全校验
      重复事件防护
    限制
      Telegram 权限仍需 Bot 成员资格
      public 变 private 不改变数字 ID
      已缓存第三方数据不可撤回
      Telegram API 429 和网络故障
      Token 及服务端数据权限保护
```

注意：该图概括细节与交互边界；具体调用链、迁移过程、失败回滚及版本差异以链接的模块文档和实际源码为准。
