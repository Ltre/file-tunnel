# SNS、YouTube Premium、Cookie 同步、音轨修复与转码 — 思维导图

> **源码基线 Commit**：`b1788ca4b219718ad802ed778ed41c081ecad39b`  
> **文档更新时间**：2026-10-16  
> **状态**：现有功能与运行边界  
> **主要参考**：[../download-transcode.md](./../download-transcode.md)、[../download-transcode/sns-cookie-sync.md](./../download-transcode/sns-cookie-sync.md)

[返回全景思维导图](./README.md)

```mermaid
mindmap
  root((下载与音视频处理))
    通用 SNS 解析
      识别 URL
        YouTube
        YouTube Music
        TikTok
        Instagram
        Facebook
        Threads
        Twitter X
        LINE
        其它 yt dlp 支持站点
      URL 形式
        单视频
        多链接
        列表
        带来源备注
      元数据探测
        标题
        时长
        格式
        字幕可用性
        不在识别阶段自动下载
    通用 SNS 下载器
      任务创建
      选格式及下载模式
      下载中状态
      yt dlp 子进程
      FFmpeg 音视频合并
      下载进度及错误输出
      任务取消
      服务器临时工作目录
      成品 Server Asset 登记
      缓存清理
      到隧道文件记录
    YouTube Premium
      独立后台入口
      视频模式
        码流与分辨率
        H264 优先
        AV1 后备
        音轨选择
        视频音频合并
      音乐模式
        只选音频
        M4A AAC 选择
        歌曲 metadata
        标题与歌手
        专辑与封面
      片段范围下载
        起止时间输入
        截断校验
        剪切成品
      Cookies
        私人高级账号 Cookie
        与公共 SNS Cookie 隔离
        不在前台暴露 Token
    Cookie 管理
      SNS Cookies 页面
      平台 Cookie 文件
      浏览器扩展
        Chrome
        Firefox Windows
        Firefox Android
      多服务器推送
        独立服务器配置
        独立同步 Token
        定时或浏览器事件触发
        导入导出配置
      Token 管理
        与管理员会话不同
        重载和协议版本
      Cookie 过期
        站点风控
        重新提取
        安全保存权限
    下载任务管理
      状态
        等待
        执行
        完成
        失败
        取消
      运行日志
      缓存文件详情
      任务列表
      删除与清理
      已完成成品预览
      保存至 Telegram 网盘
        选择账号分区目录
        Pending Save 防重复
        缓存保护
      转发到隧道
      指定 Telegram Chat 转发
        目标频道选择
        消息 Caption
        预览图片或视频
        进度及结果反馈
    音轨修复
      何时出现修正版按钮
      检测不兼容音频轨
      原始成品不丢失
      生成可播放修正版
      修正版重新预览
      修正版重新转发
    视频转码中心
      输入来源
        浏览器文件上传
        SNS 成品缓存
        YouTube 成品缓存
      编码 Profile
        H265 均衡转码
        H265 均衡转码并缩放
        输出容器 MKV
        指定扩展名覆盖
        音频与视频参数
      任务执行
        参数验证
        资源并发限制
        FFmpeg 进程
        标准错误与进度
        暂存输出
        完成产物
      取消及重启
        任务持久化
        重启失败状态
        未完成文件清理
      格式约束
        非 MP4 容器不加 faststart
        不支持的参数报错
        禁止越界文件路径
    运维与依赖
      yt dlp
      yt dlp ejs
      deno
      FFmpeg
      网络代理
      外站访问限制
      Cookies 保密
      临时空间配额
      成品与上传 Pin 清理债务
```

注意：该图概括细节与交互边界；具体调用链、迁移过程、失败回滚及版本差异以链接的模块文档和实际源码为准。
