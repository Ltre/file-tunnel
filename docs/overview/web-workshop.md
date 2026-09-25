# 网页工坊与 .html.zip Runtime

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 功能定位与产生背景

网页工坊的原始目标是让隧道中的一个普通 `.html.zip` 文件同时具备：

- 可独立运行的网页包；
- 可离线进入草稿箱编辑；
- 可重新发布为新网页；
- 对原记录有权限时可更新原文件；
- 可引用 ZIP 内多级资源；
- 可从隧道资源浏览器导入图片/音视频等现有文件。

因此它不是“上传一个 ZIP 后 iframe srcdoc 看一下”，而是一个轻量网页项目编辑/运行环境。

早期实现使用 iframe/srcdoc/blob 方式时出现：

- 外部 JS 请求得到但不执行；
- relative path / root path 语义不完整；
- `<script src>` 后 HTML 被吞掉；
- 已更新文件仍预览旧内容；
- 编辑原记录与“创建我的副本”串数据。

后续改成 Service Worker 虚拟目录 Runtime，才使多文件网页的路径、MIME、模块和媒体资源具有接近真实站点的行为。

## 2. 主要实现

- `client/web-workshop.js`：草稿、编辑器、目录树、预览、发布、导入；
- `client/web-zip-runtime.js`：虚拟运行目录、Service Worker 协议、入口验证；
- `service-worker.js`：响应 `/web-zip-runtime/<runtimeId>/...`；
- `pages/web-zip-preview.html`：传输记录中网页 ZIP 的独立运行页；
- `pages/web-workshop-guide.html`：用户编辑手册；
- `app.js`：传输记录入口、编辑授权、发布更新、来源记录 Focus、隧道资源浏览器；
- `client/web-workshop.css`。

## 3. `.html.zip` 基本约定

- 文件后缀：`.html.zip`；
- ZIP 内至少包含一个 HTML；
- 优先使用 `index.html`；
- 找不到 index 时可用找到的第一个 HTML；
- 支持多级目录；
- 文本资源：HTML/CSS/JS/MJS/JSON/TXT/MD/SVG/XML/CSV/YAML 等；
- 媒体和字体以二进制保留。

当前帮助文档建议结构：

```text
my-page.html.zip
├─ index.html
├─ assets/
│  ├─ app.js
│  ├─ style.css
│  └─ cover.webp
└─ pages/
   └─ detail.html
```

## 4. 草稿持久化

浏览器数据库：

- DB：`TunnelWebWorkshop`
- version：1
- object store：`drafts`
- object store：`sandboxes`

草稿保存：

- editor change 后约 350ms autosave；
- `saveChain` 串行化异步保存；
- `draftRevisions` / `savedRevisions` 防止“旧异步保存覆盖新编辑”；
- Ctrl/Command + S 可立即触发；
- preview / publish 前必须 `flushEditorDraft()`，确保当前 textarea buffer 真正进入 archive。

这一机制源于多个真实 Bug：

- 修改一个字符提示“已自动保存”，预览仍是旧内容；
- 拖动文件树时 editor buffer 尚未 commit；
- publish 读到前一个 revision；
- 原文件更新失败但副本发布成功。

修改草稿保存流程时，必须保留“编辑 buffer → revision → ZIP archive”的单向完整性。

## 5. 草稿来源与 publish mode

草稿可能来自：

1. 网页工坊“创建网页”；
2. 导入本机 `.html.zip`；
3. 传输记录“转入草稿箱编辑”；
4. 传输记录“创建我的副本”。

草稿保存：

- `sourceFileId`
- `sourceMessageId`
- `sourceFileInfo`
- `publishMode`
- creator device
- package name
- files
- timestamps
- `webZipHideFrame`

来源传输记录的草稿列表会显示“🔗 原记录”，点击可关闭工坊并 Focus 到原传输记录。

### 5.1 编辑原文件

只有具备更新权限时才允许 update 模式。

发布必须替换原记录对应的文件资产，同时让：

- 本机缓存；
- 其它在线设备；
- 传输记录版本；

看到新版本。

早期严重 Bug 是：更新后的新 ZIP size 被旧 fileInfo.size 覆盖，导致缓存完整性校验失败，或本机仍使用旧 ZIP。

### 5.2 创建副本

副本属于新的文件/记录，不修改原文件。

这一流程一直比 update 稳定，因此它是排查“编辑原文件失败”的重要对照组。

## 6. 编辑权限

在传输记录的菜单中有“编辑此网页”。

不同状态：

### 6.1 无权限

居中小卡片提示未获得权限，并提供：

- 向所有者申请编辑权限；
- 创建我的副本。

### 6.2 非所有者但已授权

提示：

- 所有权来自哪个设备；
- 本设备已经授权；

并提供：

- 转入草稿箱编辑；
- 创建我的副本。

### 6.3 所有者

提示本设备为所有者，并提供：

- 转入草稿箱编辑；
- 创建我的副本。

编辑申请使用：

- `web-zip-edit-request`
- `web-zip-edit-response`
- notification center / device notification。

## 7. 编辑器 UI

网页工坊主体：

`#webWorkshop`

编辑内容容器：

`main.web-workshop-content`

顶栏当前包含：

- 返回/关闭；
- “网页工坊”；
- 最小化；
- “使用手册 ↗”；
- “草稿箱”。

### 7.1 包文件名

需求曾要求“顶栏显示当前文件名”，随后被明确推翻。

**当前最终行为：**

- 不在工坊顶栏显示当前 `.html.zip` 名；
- 在 `main.web-workshop-content` 内顶部显示可编辑的包文件名；
- 用户直接编辑；
- blur 或 Enter 时规范化；
- 自动补 `.html.zip`；
- preview / publish 前再次 commit。

要区分：

- 包名：`我的网页.html.zip`
- ZIP 内当前文件：`index.html`

两者不能混淆。

### 7.2 最小化

最小化要求：

- 只隐藏现有 `#webWorkshop` DOM；
- 不销毁 active draft；
- 不销毁 editor / tree / preview 状态；
- 功能首页顶栏显示 `🌐`；
- `🌐` 位于网盘 `▤` 与音乐 `♪` 之间；
- 点击恢复原状态；
- 正常 close 才清除最小化入口。

## 8. 文件树

### 8.1 路径规范

`canonicalPath()`：

- 统一 `/`；
- 禁止 `.`、`..`；
- 禁止控制字符；
- 目录末尾带 `/`。

`pathKey()` 用 locale lowercase 做碰撞判断。

### 8.2 同名与父目录

`normalizeEntries()`：

- 同一规范 path 不允许两个项目；
- 文件不能挡住应存在的 parent directory；
- 自动 materialize parent dirs。

这是为了修复早期“同一目录居然能有同名文件”的基础一致性问题。

### 8.3 无限层级树

当前是递归树形文件列表：

- 每层先目录后文件；
- 目录可展开/收缩；
- 整个目录 row 点击即可 toggle，不要求精确点小三角；
- 保留 `expandedPaths`。

### 8.4 Move

支持 drag/drop 文件/目录改变 ZIP 内路径。

要求：

- move 前用户确认；
- 目录不能移进自己/descendant；
- 目标存在；
- 目标同名检查；
- 目录移动需重写 descendants；
- 当前编辑中的 textarea 先 commit，不能拖完后丢掉尚未保存字符。

## 9. 新建、上传、rename、delete

这些操作都必须走统一 path consistency：

- 新建子目录；
- 新建文件；
- 上传；
- rename；
- delete；
- move。

历史需求要求系统性检查这些 CRUD，而不是每发现一个 duplicate bug 就补一个局部 if。

后续应尽量让所有操作通过同一组：

- canonicalize；
- collision；
- normalize；
- saveDraft。

## 10. 隧道资源导入

260924 已人工验收通过。

入口复用“隧道资源浏览器”的资源清单。

流程：

1. 用户在工坊选择“从隧道资源浏览器导入”；
2. 可搜索、多选；
3. 如果本机没有完整 byte，先走现有来源恢复/cache；
4. 拿到完整数据后写入草稿；
5. 默认集中到 ZIP 内：
   `tunnel-resources/`
6. 同名自动添加 `(2)`、`(3)`；
7. 导入后仍可移动到用户自建目录。

这里的“资源目录”是 ZIP 内目录，不是 Telegram 网盘路径。

## 11. Runtime

浏览器数据库：

- `TunnelWebZipRuntime`
- store：`runtimes`
- default TTL：2 小时；
- protocol：2。

### 11.1 mount

`WebZipRuntime.mount()`：

1. 确认 Service Worker；
2. 清理 expired runtime；
3. 准备文件；
4. 找入口 HTML；
5. 创建 runtime ID；
6. 写 IndexedDB；
7. 生成：
   `/web-zip-runtime/<id>/<entry>?v=<timestamp>`
8. fetch 入口做真实校验；
9. 响应必须带：
   `X-Web-Zip-Runtime: 1`

校验失败会删 runtime record。

### 11.2 MIME

Runtime 根据路径推断：

- `.js/.mjs` → JavaScript；
- CSS；
- HTML；
- image/video/audio；
- font；
- wasm。

这一步是外部 JS 能否真正执行的关键，不能只保证“URL 200”。

## 12. External script 历史 Bug

旧网页样例里出现过：

```html
<script src="assets/app.js">
<p>后面的内容</p>
```

因为外链 script 没有 `</script>`，浏览器按 HTML parsing 规则会把后面的内容吞到 script element 中。

当前 Runtime `repairExternalScriptTags()` 会对常见漏闭合情况兼容插入 `</script>`，恢复后续 HTML。

但编辑手册仍要求用户写标准：

```html
<script src="assets/app.js"></script>
```

兼容修复不是鼓励生成非法 HTML。

## 13. ZIP 内资源路径

最终需求强调“灵活兼容”。

支持：

```html
<link href="assets/style.css">
<link href="/assets/style.css">
<script src="./assets/app.js"></script>
<script src="/assets/app.js"></script>
<img src="../shared/a.png">
```

语义：

- relative path：相对当前 HTML；
- `..`：ZIP 内父目录；
- leading `/`：**当前网页包入口根目录**，不是 Drop2Tunnel 站点根；
- absolute network URL：真实网络请求，受 CORS/联网限制。

## 14. Service Worker 接管

这是网页 ZIP 最脆弱的历史边界之一。

正式环境曾出现：

- 第一次预览长时间“正在启动网页 ZIP 运行服务…”；
- 然后“运行服务尚未更新”；
- 刷新旧标签页后就正常。

后来确认某些报错来自：

- 标签页仍运行旧 Runtime JS；
- CDN/static cache 保留旧脚本；
- waiting SW 未接管当前 page。

当前 Runtime：

- register SW with `updateViaCache:'none'`；
- ping controller；
- 要求 protocol >= 2 和 externalScriptMime；
- 对 waiting worker 发 activate；
- 对 active 发 claim；
- 等 controllerchange/updatefound；
- 最多约 30s readiness。

因此修改 SW 时：

- 更新应用壳 cache version；
- 不要让 CDN 长缓存 Runtime/SW；
- 测“旧标签页 → 部署新版本 → 首次预览”；
- 不要只测全新隐身窗口。

## 15. Preview 与独立运行页

### 15.1 工坊 Preview

使用当前 draft snapshot mount Runtime。

预览不会发布到隧道。

### 15.2 已发布文件独立页

传输记录直接点击 `.html.zip` 应进入独立 URL，例如：

`/web-zip-preview/<fileId>?name=...&v=...`

不是把整个网页工坊 UI 打开。

编辑入口在记录菜单“编辑此网页”。

## 16. 隐藏网页 ZIP 框架

当前草稿支持 Checkbox：

`发布后隐藏 网页ZIP框架`

260924 已验收。

勾选后：

- publish metadata 保存该值；
- 独立运行页不显示外层 Header 等框架；
- ZIP 页面占满窗口。

重新导入编辑原 ZIP 时应保留该配置。

## 17. 用户手册

工坊顶栏有：

`使用手册 ↗`

新 Tab 打开：

`/web-workshop-guide.html`

手册至少覆盖：

- 包格式；
- 目录；
- resource path；
- JS/CSS；
- draft/preview/publish；
- sandbox；
- 权限；
- import tunnel resource；
- hide-frame。

每次改变 Runtime 路径语义、manifest 或 publish 配置，应同步更新手册。

## 18. 运行隔离

网页 ZIP 不应默认获得 Drop2Tunnel 主页面的：

- DOM；
- Cookie；
- JS 全局对象；
- 敏感 token。

功能目标是“运行用户网页包”，不是“让网页包获得宿主页插件权限”。

后续若增加 bridge API，应单独设计 capability，不要让 sandbox 直接同源无限制访问。

## 19. 当前尚未纳入基线的后续需求

截至 `b422e...` 源码，后续对话里出现但尚未属于本基线实现的需求，例如：

- package `manifest.json`；
- “是否全屏浮层打开，而非新 Tab”；
- 从文件树拖媒体到编辑器光标自动生成标签；
- 更完整目录 context menu；
- 资源导入 cancel / source offline 状态修复。

更新本文时应在这些功能真正合入目标代码后再移到“当前行为”。

## 20. 回归检查

重点测试：

- `tests/features-260916-2.test.cjs`
- `features-260917-*.test.cjs`
- `features-260918-*.test.cjs`
- `features-260921-*.test.cjs`
- `features-260922-1.test.cjs`

必须手测的组合：

- new draft → edit → preview → publish；
- existing ZIP → no edit → preview/publish；
- existing ZIP → edit → preview/publish；
- copy → edit/publish；
- external JS/CSS；
- nested paths；
- old SW page after deployment；
- minimize/restore；
- update original then both devices open new content。
