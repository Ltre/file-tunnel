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
        安装信息
          名称与图标
          Standalone 显示
          启动地址和应用范围
          Android 系统分享入口
        名称和图标
        安装入口
        Standalone 显示
        Android 分享目标
      Service Worker
        路由
          应用壳导航
          静态依赖缓存
          ZIP Runtime 虚拟资源
          动态 API 不盲目缓存
        更新
          Activate 生命周期
          旧标签页兼容
          强制刷新资源
        App Shell 缓存
        首页导航 network first
          回退
            有缓存时网络最长约等待一秒
            超时直接打开缓存应用壳
            后台仍可尝试更新
            第一次无缓存不保证秒开
        缓存页面回退
        首次无缓存正常等待
        静态资源缓存
          产物
            资源文件 hash
            immutable 对象长缓存
            HTML 不永久缓存
            部署后老缓存可安全失效
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
        功能
          在线设备列表
          当前隧道成员
          设备资料
          已关注联系人
          快捷操作汉堡菜单
          离线设备状态提示
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
        分区
          设备与功能入口
          中央隧道时间线
          右侧协同编辑
        布局
          每栏独立滚动
          宽度变化下保持可用
        连接侧边栏
        记录主区
        协同编辑区
        滚动独立
      移动端三栏 Workspace
        三个页面
          连接设备
          当前隧道
          协同编辑
        触控
          横向滑动
          顶栏切换
          返回键优先关闭浮层
        连接页
        隧道页
        协同页
        横向手势
        顶栏布局
      平板宽屏
        100dvh 适配
          边界
            浏览器地址栏收缩
            Android 平板横竖屏
            分屏模式
            键盘占用高度
            避免内容被底部遮挡
        顶栏几何对齐
        屏幕旋转
        小宽度分屏
      安全区域
        状态栏
        底部导航手势区
        软键盘避让
    主题
      顶栏主题切换
        同步位置
          PC 顶栏按钮
          移动控制中心磁贴
          设置页面
          偏好持久化
      移动控制中心主题磁贴
      设置页主题选项
      偏好持久化
      字体与对比度
    导航及浮层
      浏览器 History
        页面状态
          返回优先关闭弹层
          保存预览和合辑当前位置
          避免跳出 PWA
          独立路由与主首页区分
      文件预览返回
      合辑子级返回
      音乐播放器返回
      设置页返回
      多个浮层 zIndex
        层级
          预览和全屏
          网盘文件菜单
          编辑器和工坊
          音乐播放队列
          对话框与通知
        关闭
          Escape 及浏览器返回按栈顺序
      Context Menu
        输入方式
          桌面右键
          Android 长按
          键盘菜单键
        边界
          触发位置避免越界
          点击外部关闭
          不吞掉普通点击
      桌面右键
      Android 长按
      滚动锚点
      刷新后定位
    通知中心
      展示
        未读角标
        通知历史列表
        处理入口
        查看源目标记录
      交互
        处理后状态回写
        页面切换后保持通知状态
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
        阶段
          IndexedDB 打开
          CacheStore 初始化
          会话恢复
          其它本地状态读取
          tunnel-shell-ready 通知
        诊断
          window.TunnelStartup 阶段标记
      Service Worker 注册
      网络资源加载明细
        实现
          Resource Timing
          PerformanceObserver
          仅展示已完成资源和当前等待项
        约束
          不 Hook fetch
          不劫持 XHR
          不拦截 WebSocket
          Shell Ready 后移除观察器和遮罩
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
          对比
            首次无 SW 缓存
            后续缓存命中
            更新后重新取静态资源
            不把加载动画当网络性能提升
    多语言
      机制
        i18n Catalog
        localization runtime
        服务端语言字段
        动态 UI 文字处理
        完整语言覆盖审计
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
        检查
          固定文案匹配
          参数化文案键
          未翻译检测
          替换后 UI 排版检查
          新功能必须注册词条
      未翻译文案检测
      RTL 布局限制
    输入与无障碍
      键盘导航
      焦点管理
      触控滚动
      长按手势
      模态对话框关闭
      ARIA 标签
        辅助
          可聚焦的按钮
          模态焦点管理
          控制状态可读
          键盘可以完成主要操作
      提示信息与状态
    浏览器安全边界
      HTTPS 安全上下文
      Android Chromium 权限
      微信内置浏览器阻止
        限制
          部分系统 API 不可用
          提示选择支持的浏览器
          不假定拥有摄像头或文件系统权限
      媒体自动播放限制
      低内存后台挂起
      多标签页数据版本冲突
```

注意：该图概括细节与交互边界；具体调用链、迁移过程、失败回滚及版本差异以链接的模块文档和实际源码为准。
