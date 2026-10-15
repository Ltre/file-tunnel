# PWA、首页 UI、主题、多语言、通知与性能反馈 — 思维导图

> **源码基线 Commit**：`b1788ca4b219718ad802ed778ed41c081ecad39b`  
> **文档更新时间**：2026-10-16  
> **状态**：现有功能与运行边界  
> **主要参考**：[../pwa-ui.md](./../pwa-ui.md)、[../pwa-ui/localization.md](./../pwa-ui/localization.md)

[返回全景思维导图](./README.md)

```mermaid
mindmap
  root((PWA 与交互))
    PWA 应用壳
      Manifest
        名称和图标
        安装入口
        Standalone 显示
        Android 分享目标
      Service Worker
        App Shell 缓存
        首页导航 network first
        缓存页面回退
        首次无缓存正常等待
        静态资源缓存
        API 与认证请求不盲缓存
        运行时文件资源
        激活新版本
        强制刷新
      生产部署缓存
        内容哈希静态资源
        长缓存 immutable
        HTML 版本重新验证
        Service Worker 不缓存
        运行配置动态读取
        CDN 与离线一致性
    功能首页
      连接设备面板
        在线设备
        最近设备
        汉堡菜单
        资源浏览器入口
        光媒入口
        Telegram 网盘入口
        通知中心入口
        网页工坊入口
      隧道记录区
      协同编辑区
      顶栏设置
      隧道切换
      隧道 QR
    响应式布局
      PC 宽屏三栏
        连接侧边栏
        记录主区
        协同编辑区
        滚动独立
      移动端三栏 Workspace
        连接页
        隧道页
        协同页
        横向手势
        顶栏布局
      平板宽屏
        100dvh 适配
        顶栏几何对齐
        屏幕旋转
        小宽度分屏
      安全区域
        状态栏
        底部导航手势区
        软键盘避让
    主题
      顶栏主题切换
      移动控制中心主题磁贴
      设置页主题选项
      偏好持久化
      字体与对比度
    导航及浮层
      浏览器 History
      文件预览返回
      合辑子级返回
      音乐播放器返回
      设置页返回
      多个浮层 zIndex
      Context Menu
      桌面右键
      Android 长按
      滚动锚点
      刷新后定位
    通知中心
      通知列表
      未读状态
      顶栏入口
      编辑授权处理
      PWA 推送行为
      通知打开目标页面
      页面状态同步
    启动过程
      Script defer 下载
      window TunnelStartup
      DOMContentLoaded 时刻
      IndexedDB 初始化
      CacheStore 初始化
      Session 恢复
      Shell Ready 事件
      Service Worker 注册
      网络资源加载明细
        Resource Timing 观察
        PerformanceObserver
        不 Hook fetch 和 XHR
        资源加载失败提示
        就绪后清理观察器与遮罩
        不影响后续网络交互
      首屏性能诊断
        记录阶段耗时
        生产与开发资源差异
        缓存命中与冷启动区别
    多语言
      语言目录
        中文简体
        中文繁体
        英文
        日语
        其它支持语言共十六种
      用户语言选择
      i18n Catalog
      i18n Runtime
      运行时动态文字替换
      服务端事件文案
      Telegram 消息翻译
      参数化占位文案
      全语言覆盖审计
      未翻译文案检测
      RTL 布局限制
    输入与无障碍
      键盘导航
      焦点管理
      触控滚动
      长按手势
      模态对话框关闭
      ARIA 标签
      提示信息与状态
    浏览器安全边界
      HTTPS 安全上下文
      Android Chromium 权限
      微信内置浏览器阻止
      媒体自动播放限制
      低内存后台挂起
      多标签页数据版本冲突
```

注意：该图概括细节与交互边界；具体调用链、迁移过程、失败回滚及版本差异以链接的模块文档和实际源码为准。
