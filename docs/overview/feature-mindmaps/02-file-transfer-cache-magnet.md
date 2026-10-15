# 文件、合辑、P2P、缓存、恢复与磁链 — 思维导图

> **源码基线 Commit**：`b1788ca4b219718ad802ed778ed41c081ecad39b`  
> **文档更新时间**：2026-10-16  
> **状态**：现有功能与运行边界  
> **主要参考**：[../transfer-cache.md](./../transfer-cache.md)、[../transfer-cache/magnet-download.md](./../transfer-cache/magnet-download.md)、[../transfer-cache/folder-archive-directory-mirror.md](./../transfer-cache/folder-archive-directory-mirror.md)

[返回全景思维导图](./README.md)

```mermaid
mindmap
  root((文件与传输))
    文件发送入口
      选择文件
      拖放文件
      系统分享入口
      剪贴板图片发送
      文件夹选择及打包发送
      发送准备占位
        首屏机制
          先发布传输记录
          文件读入缓存异步执行
          大合辑也尽快出现首项
        失败和取消
          显示当前阶段
          保留明确失败状态
        生成文件资产元数据
        本地入库异步处理
        准备过程进度
        发送失败及取消
    单文件与合辑
      单文件
        文件名 MIME 大小
          元数据用途
            MIME 决定预览器
            Size 验证完整字节
            不能仅凭文件名判断同一内容
        备注与来源元数据
        资源详情
        下载与预览
      合辑
        多文件合并一条记录
        拆分多条记录
        单项备注
        合辑备注
        网格缩略图
        子文件导航
        上一项和下一项
        下载全部
          等待缓存齐备
          ZIP 打包
          可提前下载已就绪项
    资产和消息分离
      传输记录仅存引用
      独立 File Asset ID
      文件范围和传输 ID
        关联字段
          requestId
          transferId
          attemptId
        Range
          offset 和 length
          分片 ACK
          旧 attempt 迟到消息不得确认新任务
      源会话及跨会话引用
      跨隧道导入重映射 ID
      同一缓存供多个记录引用
    文件供源发现
      本机已有完整字节
      有效本地文件句柄
      同隧道在线缓存设备
      跨隧道关联来源
      VClient 常驻缓存节点
      Telegram file_id 回源
      Server Asset 回源
      无来源显示待恢复
    P2P 下载
      Socket.IO 信令
      WebRTC DataChannel
      ICE 候选与候选失效
        调试
          STUN 候选
          VPN 和系统代理
          Origin 媒体权限
          selected candidate pair
        概念区别
          TURN ICE relay
          Socket.IO 应用层 Relay
      供源连接创建和复用
        窗口
          共享连接约 1500ms
          DataChannel 约 5000ms
        结果
          第一项可能 Relay
          后续项可复用已建立的 P2P
      数据包分块
      大文件 Range 拆段
      多在线供源并行请求
      基于供源负载的选择
      超时重试与卡住检测
      大媒体 Seek 按需范围读取
      网络代理及 VPN 异常回退
    Socket.IO Relay
      P2P 不可达时降级
        失败场景
          ICE 建连失败
          DataChannel 不就绪
          文件 ACK 超时
        切换
          标记当前 attempt
          不允许 P2P 和 Relay 重复提交成功
      有上限的服务端分块中继
      发送及接收确认
      中继超时清理
        服务器状态
          relay key
          transfer token
          数据块投递及完成 ACK
        释放
          完成
          取消
          超时
      Relay 进度标记
      防止重复下载与僵尸任务
    服务端资源
      原始 Server Asset 元数据
      按范围传输
      准备中资源状态
      资源可用及不可用
      分块任务清理
    浏览器缓存
      IndexedDB 文件记录
      CacheStore
        OPFS 可用性后台探测
          缓存驱动
            OpfsCacheDriver
            IndexedDbBlobDriver
            MemoryTempDriver
            Drop2TunnelCacheStore
          降级
            OPFS 不可用
            Worker 不支持
            不阻塞应用壳出现
        IndexedDB Blob 后备
        内存临时分块
        临时写入与提交
          缓存一致性
            接收过程中保持未完成
            校验收到的总字节数
            完成后才可向其它设备 announce
            失败时回收临时块
        中断时 abort
      完整性判断
        字节长度相符
        完整引用标志
        版本与文件身份相符
        缓存丢失重新供源
      File System Access
        原生文件句柄
        只读权限恢复
        文件移动失效
        文件大小变化检测
        有句柄无需复制全部文件
        源设备上线时仍可向外供源
      缓存保护与回收
        正在传输不清理
        多记录引用不清理
        中断垃圾清理
        删除后闲时孤立资源回收
        手动释放缓存
        浏览器配额清理应对
    文件恢复
      本机优先
      其它在线设备第二候选
      WebRTC 后备 Relay
      Telegram 来源回源
        选择顺序
          浏览器供源优先
          无可用设备再由 Node getFile
        完整成功
          校验字节长度
          写入本机 CacheStore
          新设备可成为普通供源
      重获完整字节写本机缓存
      公告新供源者
      拉取失败不伪装完整
      强制拉取卡住保护
    目录与 ZIP
      文件夹 ZIP 创建
        路径标准化
        文件树展开
        文件夹结构保留
        ZIP 输出下载
      ZIP 解包
        路径安全校验
        拒绝越界路径
      本机目录镜像
        目录句柄授权
        目录签名
          目录镜像
            对照本地快照
            有变化时生成 Snapshot ZIP
            远端应用后 skipSignature 防回环
        本机快照生成
        远端镜像快照应用
        仅限已有目录镜像语义
    自定义磁链
      非 BitTorrent 协议
        边界
          Drop2Tunnel 自定义 Magnet URL
          Registry 做供源发现
          不接入 BitTorrent DHT
          常规 BT 客户端无法直接使用
      自定义 Magnet URL
      创建分享引用
      注册表及有效期
      独立下载器页面
        临时下载设备
        Magnet 专用缓存
        当前浏览器 TunnelDB 复用
        在线种子设备发现
        Relay first 下载策略
        下载进度
      磁链缓存列表
        持续保留下载缓存
        查看已有磁链
        再次下载
        清理缓存
      种子离线与过期
        过期清理
        刷新在线种子
        无可用种子提示
    资源管理器
      全隧道资源清单
      文件与引用记录关联
      按媒体类型筛选
      按本机缓存筛选
      按 Telegram 来源筛选
      外部句柄状态
      转到引用位置
      清理垃圾缓存
      Telegram 防失联检测及修复
        执行前提
          用户主动点击资源管理器按钮
          启动和页面打开不自动批扫
        修复途径
          本地完整缓存
          File System Access 句柄
          其它在线设备完整副本
        只能用户主动点击
        核验旧 file_id
        可用本机或在线副本补修
        public 别名迁移数字 ID
          过渡
            从字典解析旧 @public
            通过 getChat 验证数字 ID
            更新同 fileId 所属记录
            只改来源不改文件字节
            失败时保留旧名称
        不强制重新下载完整缓存
    备份导入
      元数据备份
      完整二进制备份
      导入保留历史时间
      导入追加当前时间
      跨隧道文件 ID 安全重映射
        避免混淆
          新隧道与旧隧道资产标识独立
          导入时重建引用关系
          相同缓存必须验证内容与来源
      已有缓存复制与再利用
      备份文件自动识别
      大任务 Loading 防误操作
    进度与错误
      总进度抽屉
      供源路径标签
      点击定位消息
      下载中断图标
      收发状态超时
      资源不存在与权限失效
      多设备同时请求去重
```

注意：该图概括细节与交互边界；具体调用链、迁移过程、失败回滚及版本差异以链接的模块文档和实际源码为准。
