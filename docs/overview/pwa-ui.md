# PWA、功能首页 UI、响应式布局与全局交互

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 模块定位

Drop2Tunnel 是 browser/PWA-first 产品。功能首页既要在 PC 宽屏作为三栏工作台，也要在手机/平板上通过横向 workspace、底栏和浮层保持相同功能。

主要涉及：

- `pages/index.html`
- `app.js`
- `styles.css`
- `service-worker.js`
- `manifest.webmanifest`
- 多个 `client/*.css`

UI 改动的最大风险不是单个按钮颜色，而是：

- overflow；
- touch gesture；
- history；
- fixed/absolute stacking；
- viewport height；
- Service Worker 旧版本缓存。

## 2. PWA Manifest

Manifest 由服务端动态支持不同 host/部署环境。

历史上处理过：

- start_url；
- scope；
- Share Target；
- 动态 manifest；
- 安装图标。

不能假设 manifest 永远是一个完全静态 JSON。

## 3. Service Worker

当前 cache name：

`instant-tunnel-v60`

核心 precache 至少包括：

- `/index.html`
- `/manifest.webmanifest`
- `/tunnel-icon.svg`

以及多个 client 模块。

安装时逐个 cache，避免一个非核心资源失败导致整个 SW install 永远失败，是历史上修过的重要问题。

activate 会清理旧 cache。

fetch 根据资源类型采用网络/缓存 fallback；Web ZIP Runtime 又有独立虚拟路径处理。

### 3.1 为什么频繁 bump cache version

多个前端 Bug 最终被发现其实是：

> 浏览器仍运行旧 app.js / client module / Service Worker。

因此提交涉及关键 JS / CSS 时，经常同时更新 SW cache version 和相关 test assertion。

这不是所有改动都必须机械 bump，但如果文件属于 app shell 且现有缓存策略会复用旧响应，就要考虑版本更新。

## 4. 生产缓存与 CDN

生产环境历史上使用 Cloudflare CDN + Nginx reverse proxy。

曾出现：

- Runtime JS 返回 `max-age=1200`；
- 新 SW 已部署，但旧 tab JS 仍在内存；
- 本地没问题，正式域名首次 preview 失败。

对以下文件应尤其谨慎缓存：

- Service Worker；
- Runtime bootstrap；
- 运行时配置；
- 会导致协议版本不匹配的入口 JS。

## 5. 路由页与功能首页

路由页负责：

- 输入朋友给的暗号；
- 最近隧道选择；
- 创建/加入；
- landing nearby。

功能首页才是：

`#appShell`

品牌文案 `🚀Drop2Tunnel-即时传输隧道` 已从功能首页主体移到路由页自己的固定顶栏并居中。该顶栏与功能首页 topbar 不是同一个组件。

## 6. PC / 宽屏三栏

逻辑：

- 左：连接设备；
- 中：传输记录；
- 右：协同编辑。

主要 panel：

- `.left-panel > .panel`
- `.center-panel > .panel`
- `.right-panel > .panel`

260924 人工结果为“勉强验收通过”：

- 三栏统一高度；
- 以右栏视觉高度为参考；
- 各栏内部独立纵向 scroll。

因此这部分仍是需要真机继续打磨的区域，不能写成完全稳定。

## 7. 移动 workspace

手机不是简单把三栏垂直堆叠，而是横向可 Focus 的 workspace。

底栏用于切：

- 连接；
- 传输记录；
- 协同；
- 隧道等。

手势要求：

- 左右 swipe；
- 当前区域 index 与视觉 transform 必须一致；
- 某功能自动 Focus 中栏时也要同步内部状态；
- blocking overlay 打开时不应误触 workspace swipe。

历史严重 Bug：

- 发布网页 ZIP 后自动 Focus 新记录；
- 画面 90% 在中栏、左边露 10% 左栏；
- 状态却认为当前是左栏；
- 一个方向 swipe 完全失效。

因此修改 CSS transform 或 “focusTransferRecordById” 时要联调 `settleMobileWorkspaceView()`。

## 8. Android 平板宽屏边界

宽屏 media query 不代表桌面浏览器。

平板会同时有：

- 宽 viewport；
- touch pointer；
- 浏览器动态地址栏；
- `vh` 与 visual viewport 差异；
- touch inertia。

因此“PC 三栏正常”不能证明 Android 平板宽屏正常。

260925 后提出的高度溢出/底部空白需求不在本源码基线内，后续合入时应回写这里。

## 9. 顶栏入口

功能首页顶栏承载多个“可恢复后台 UI”的入口，例如：

- 网盘 `▤`；
- 网页工坊最小化 `🌐`；
- 音乐 `♪`；
- 管理/设置/其它。

原则：

- 最小化 ≠ 关闭；
- 只有对应模块有可恢复状态时显示临时入口；
- click 应恢复原 DOM/state，而不是重新初始化造成上下文丢失。

## 10. 隧道控制中心

移动端 Focus 到“隧道”后再次点击会打开控制中心浮层。

包含：

- 切换隧道；
- 多个功能磁贴；
- 磁贴可拖动排序；
- order 记忆。

入口包括网页工坊、主题等。

每个磁贴的关闭语义独立。例如：

- 网页工坊：进入后关闭控制中心；
- 主题：切下一个主题，但保持控制中心打开。

## 11. 主题系统

最终形态：

### 11.1 顶栏主题按钮

- 点击立即 cycle 到下一主题；
- 同时从按钮向下展开竖向菜单；
- 列出所有主题；
- 当前主题高亮；
- 选择任意主题；
- 点击空白关闭。

### 11.2 移动控制中心主题磁贴

- 点击立即 cycle；
- 不关闭控制中心；
- 不打开顶栏竖条。

### 11.3 设置页

旧的 `#themeSwitcher` 完整组件不再放功能首页，迁入隧道设置页。

## 12. Overlay 层级

当前常见 overlay：

- file preview；
- fullscreen；
- music；
- resource browser；
- Telegram drive；
- Web workshop；
- notification center；
- settings；
- dialog；
- remote preview selector；
- loading。

历史 Bug 多次来自：

- backdrop z-index 比主体高；
- full screen 下 position containing block 变了；
- transform 创建新 stacking context；
- 菜单计算 viewport 错。

因此新增 overlay 应明确：

- portal 到哪里；
- fixed vs absolute；
- z-index ownership；
- backdrop；
- safe-area；
- mobile keyboard；
- parent transform。

## 13. Context Menu

桌面：

- right click；
- 三点；
- 底部菜单 trigger。

移动：

- long press；
- 双指 gesture（部分网盘历史需求）；
- bottom sheet。

菜单关闭应支持：

- 再点 trigger；
- 点击外部；
- Esc；
- 选择 action。

外部 click listener 要防止 trigger 自己的 pointerdown 把刚打开菜单立即关掉。

## 14. 滚动

移动端必须保留浏览器自然 momentum。

历史上网盘列表由于 pointer handler / preventDefault 过度拦截，出现：

> 手指离屏立即停止，没有惯性。

后续实现了自定义/恢复惯性处理。

原则：

- 只在真正 drag item 时阻止 scroll；
- 普通单指 scroll 不要被 selection gesture 抢走；
- touch-action 与 passive listener 必须谨慎。

## 15. 通知中心

`client/notification-center.js`：

- localStorage key `tunnelDeviceNotifications:v1`；
- Overlay `#notificationCenter`；
- 未读 count badge；
- 清空已读；
- history back；
- notification action。

当前已用于网页 ZIP 编辑申请：

- approve；
- reject。

Service Worker notification click 也会把用户导航到 notification data URL。

## 16. Loading / 后台任务

项目有多套任务型 UI：

- 主文件传输 progress drawer；
- Telegram 网盘 centered loading + task list；
- downloader list；
- FFmpeg list。

“后台执行”不等于丢状态。

例如网盘：

- centered loading 可以切后台；
- 再从任务列表点 running task 恢复；
- 多任务可左右切。

全局 UI 设计应遵守同样原则：长任务必须可离开当前 modal 后再回来。

## 17. 国际化

已有 `client/i18n.js`、`client/i18n-catalog.js`、`server/i18n.js` 等。

历史上曾有一次“翻译严重错乱”的错误提交，后续重建成稳定的 16 语言体系。

新增主要用户可见字符串时应检查：

- 是否需要 i18n key；
- 服务端错误 code 是否由客户端本地化；
- 中文 admin-only 页面是否刻意不国际化。

不要自动把 selector / DOM 名称翻译。

## 18. Accessibility / Input

当前系统同时支持：

- mouse；
- touch；
- keyboard；
- drag/drop；
- screen size changes。

最低要求：

- button 真正可 focus；
- Esc 对 modal 有意义；
- input 不被 auto refresh 重建；
- mobile 不因为 synthetic mouse event 再触发一次；
- no hover-only critical action；
- context menu 有按钮替代入口。

## 19. 相关回归测试

UI 相关自动测试覆盖：

- `tests/features-2608B.test.cjs`
- `tests/features-2608C.test.cjs`
- 各 2609 feature test；
- `tests/disk-client.test.cjs`
- `tests/disk-image-preview.test.cjs`
- `tests/control-center-drive.test.cjs`

但 CSS / viewport / touch inertia 很多无法完全靠 Node test 证明，最终仍需要：

- PC Chrome；
- Android 手机；
- Android 平板宽屏；
- resize；
- PWA standalone；
- 部署后的旧 SW 标签页。
