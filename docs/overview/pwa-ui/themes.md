# UI 主题、响应式工作区与路由外观

> **源码基线 Commit**：`71e58b07350a0ef3b480fa82272177863de74448`  
> **文档更新时间**：`2026-11-07`  
> 主要源码：`client/themes.css`、`themes-legacy.css`、`themes-blamen.css`、`themes-lusns.css`、`theme-preference.js`、`index.css`，入口 `app.js`、`pages/index.html`。

## 1. 主题体系已进入当前代码

`UI_THEME_IDS` 现为 `lumen`、`orbit`、`classic`、`atelier`、`social`、`blamen`、`lusns`；**默认仍是 Classic**。偏好由 `uiTheme` 本地存储和 `body[data-theme]` 驱动，设置页、快速入口和控制中心要共用同一可用列表，不能只给首页更新选择器而让路由页仍使用另一套配置。

- **Classic / Atelier / Social** 属于保留的历史风格，在 `themes-legacy.css` 等处维护兼容。
- **Lumen / Orbit** 在 `themes.css` 上对首页、网盘、工坊与串流台等真实组件施加设计令牌/覆盖；不得为了换肤修改业务字段、文件缓存状态或授权。
- **Blamen / Lusns** 使用两份**互相独立**的 `themes-blamen.css`、`themes-lusns.css`；主要覆盖首页三栏、记录、输入区、菜单、相关浮层，以及少量网盘/串流指定按钮。不能认为已把全部后台、网盘或媒体库替换为这两套皮肤。
- 加载前同步读取保存偏好，防止 PWA 首帧先显示默认颜色再闪到目标主题；Service Worker 缓存增量时应考虑 CSS/预读脚本及旧版本 PWA 离线升级，但不清除 IndexedDB 业务记录。

## 2. 工作区断点和控制中心

主页面不再在中等宽度盲目纵向堆叠：**≥1100 CSS px** 为三栏（1100—1200 紧凑列），**768—1099 CSS px** 为双栏，**≤767 CSS px** 为移动端选项卡。不能以设备物理分辨率直接判断 CSS 视口，系统字体/DPI/浏览器缩放会改变命中断点。

双栏模式可以从记录栏标题打开协同编辑区域，保留原编辑器 DOM 与内容、发送和同步状态，关闭/改变视口不应复制编辑器实例。控制中心按当前主题配色，但切换隧道的条目在 Blamen/Lusns 下仍保持既定**白底**，不能用新按钮背景直接覆盖整行。

首页历史与记录、设备菜单、媒体悬浮层、后台页面等具备各自滚动和历史层级；主题切换应只修改显示样式，不触发网盘账号切换或隐式媒体暂停。

## 3. 路由、扫码与多端入口

轻量 `/tunnel-entry` 与完整首页复用 `client/tunnel-entry.js/.css`、`tunnel-landing.css`；两种加载模式和已加入/未加入状态在相同主题下使用一致组件，避免“路由状态改变使输入框位置突然跳动”。2026-11-06 后从首页抽出公共 `client/tunnel-code-scanner.js`，轻量页与连接设备菜单共用扫码能力，关闭时停止摄像头轨道；签名隧道参数仍须完整保留。

原有 Android/PC 的返回层、下拉、扫码、横屏全屏、受限文件预览与下载表单布局均保留各自语义，不得通过单纯视觉模板新增授权能力。

## 4. 核对与验证

- 参考 `docs/devlog/dev-2610-UI261026.md` 的 261028-2、261028-3、261029—261031、261101-1；`docs/devlog/dev-2611.md` 的 261102—261106；以及当前代码。
- 回归：`tests/themes-261028-2.test.cjs`、`tests/theme-offline-261028.browser.cjs`、`tests/theme-blamen-lusns.browser.cjs`、`tests/ui-261106.browser.cjs`、`tests/route-261106-3.browser.cjs` 等。
- 开发记录中的浏览器模拟覆盖不同 CSS px 的布局、主题配色和缓存升级，但不能替代真实 Android 平板的导航栏、软键盘、浏览器媒体权限或 GPU 差异验收。本轮未重新运行浏览器回归。
