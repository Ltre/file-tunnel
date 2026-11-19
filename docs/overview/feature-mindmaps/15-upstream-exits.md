# 上游网络出口、Trojan 节点与任务级路由 — 思维导图

> **源码基线 Commit**：`1da33930cfb0f7022114825e2cb300ce18ff4eae`  
> **文档更新时间**：2026-11-19  
> **主要参考**：[../upstream-exits.md](../upstream-exits.md)、[../admin-security-deployment.md](../admin-security-deployment.md)

[返回全景思维导图](./README.md)

```mermaid
mindmap
  root((上游网络出口管理))
    服务分类
      Telegram
      YouTube
      X / Twitter
      Facebook
      LINE
      Instagram / Threads
      TikTok
      Bilibili
      网易云音乐
      Other
    节点管理
      Trojan 节点 ID
      server / port / password
      TLS SNI
      verifyTls
      备注与 revision
      API 不返回密码
    服务独立策略
      defaultExit
      enabledNodes 显式勾选
      ordered / random
      includeDirect
      各服务独立保存
    任务路由
      SNS / YouTube 任务指定出口
      格式解析 networkTicket
      runTask 上下文隔离
      首个有效内容后锁定
      缓存命中不锁定
      锁定后不自动换节点
      新任务重新选择
    请求接入
      Undici ProxyAgent
      yt-dlp --proxy
      Telegram 远程方法包装
      SNS Markdown publicProxy
      读取可候选重试
      写入不自动重放
    sing-box
      按需启动
      loopback 临时 HTTP 代理
      配置快照共享进程
      引用计数
      空闲约 30 秒停止
      TLS 始终开启
    安全与限制
      upstream-exits.json 私有保存
      API 隐藏节点密码
      日志敏感字段脱敏
      用户主动 IP 测试
      不后台监控出口变化
      Windows x64 / Linux x64
      Linux 原生执行待验证
```

**当前边界：** 这是服务端出站请求的按服务路由，不是用户设备系统 VPN，不改变浏览器 WebRTC ICE。候选只包含明确启用的节点；真实用户节点和所有第三方平台仍需现场验证。
