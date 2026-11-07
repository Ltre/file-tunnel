# 串流控制台：已合入功能与边界思维导图

> **当前源码锚点**：`71e58b07350a0ef3b480fa82272177863de74448`  
> **文档更新时间**：2026-11-07  
> 详见 [streaming-console.md](../streaming-console.md)；原需求对照见 [12-planned-streaming-console.md](./12-planned-streaming-console.md)。

```mermaid
mindmap
  root((串流控制台已实现))
    设备与身份
      设备专属注册与密钥
      本机与登录用户身份
      网盘源仍需原账号授权
      隧道源仍需原成员grant
    节目与持久化
      streaming-console.json
      创建与台号
      节目单和配置版本
      来源抽样核验
      封面与节目简介
      本机草稿
      保存冲突与恢复
    来源
      网盘文件与目录授权
      隧道消息和引用
      浏览器本机文件
      授权失效不可继续读
      不能永久存储正文
    观看
      设备观看心跳
      服务端权威播放时钟
      Range与来源票据
      全屏与可拖动小窗
      逐节目定位与预读
      本机缓冲和全台暂停不同
    媒体字节
      按需HTTP Range
      本机与隧道短时供源
      安全上下文可试局域网P2P
      失败回退原通道
      短期缓存而非永久副本
    可见性和授权
      初始offline
      public与受邀访问
      订阅和取消订阅
      定向与通用邀请
      撤销与过期
      设备和用户黑名单
      观看与控制分权
    操控
      同节目统一时钟
      播放暂停跳转
      轮播与循环
      关闭观看可改变全台状态
      保存失败保留编辑
    前端与集成
      streaming-console.js
      streaming-player.js
      streaming-app-adapter.js
      streaming-cache.js
      streaming-peers.js
      streaming-i18n.js
      邀请Markdown海报
      主题与移动端布局
    限制
      不等于浏览器普通文件P2P
      跨境长期播放未正式验收
      真人移动设备需验收
      来源删除时必须安全失效
      原型中未实现项仍属规划
```

**持久化边界：** 频道/设备/播放编排写入 `streaming-console.json`，不是 `disk.sqlite`；网盘数据、隧道历史和媒体库候选仍归原系统。部分历史规划（比如独立长期 CDN 存储、真正通用实时屏幕广播或全球端到端持续可用保证）不因为原型图存在就变成当前能力。

**验收边界：** 有 Node、隔离浏览器、合成视频与构建测试记录，但真实 Android、不同网络代理/浏览器、Telegram 正式账号及跨境长时间播放必须单独验证。
