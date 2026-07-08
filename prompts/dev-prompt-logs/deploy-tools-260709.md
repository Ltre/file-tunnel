多方面优化前端静态资源加载速度，例如考虑前端代码压缩成min版（尽量缩短变量、函数名）。为了方便区分在不同机器的部署，将在不同机器以master初始建立不同的分支：deploy-txsl(首尔机器部署)、deploy-txhk(麻花疼HK)、deploy-alyhk(阿里HK)。写好不同分支所需的构建部署脚本（例如server监听端口定制、域名、前端代码html/js/css压缩等等），脚本放到tools目录。在某个想发布的分支（例如"dev/2607A"）执行构建部署脚本的基本过程：首先将当前分支（例如"dev/2607A"）强制合并到用于部署的分支（例如"deploy-txsl"），接着，切换到用于部署的分支（例如"deploy-txsl"），开始构建、压缩、改配置信息、升级静态资源链接引用的版本号参数、升级PWA版本号等等。 


评估这个需求，给出做法方面的建议，以及怎样跟codex沟通以达到最好结果







## 总体判断

这个方向是对的，但建议把需求拆成两层：

1. **构建优化**：压缩、拆分、版本化、缓存、PWA 更新。
2. **部署编排**：把指定开发分支生成成某台机器对应的部署快照。

不要让“部署分支”继续承担日常开发，也不要直接在当前开发工作区里反复切换、强制合并、改配置。更稳妥的定位是：

> `deploy-txsl`、`deploy-txhk`、`deploy-alyhk` 是由脚本生成的部署快照分支，而不是人工长期修改的开发分支。

## 从当前代码包看到的关键问题

你现在最值得优先优化的，不只是 minify：

* `app.js` 约 **660KB**。
* `index.html` 约 **147KB**，包含大量内联 CSS 和 HTML。
* 客户端主资源合计超过 **1MB**。
* 服务端当前对 `.html`、`.js`、`.webmanifest`、`.svg` 全部发送 `no-store`，浏览器无法有效复用静态资源。
* Service Worker 对 APP_SHELL 使用偏向重新请求网络的策略。
* `service-worker.js` 中缓存版本仍是手工写死的 `instant-tunnel-v23`。
* `index.html` 依靠 `_reload` 查询参数临时追加 `?v=`，不是稳定的构建版本机制。
* `tunnel.config.json` 写的是端口 `80`，Nginx upstream 写的是 `4000`，`start.sh` 提示的又是 `3000`，部署配置已经出现三套口径。

所以真正的优化优先级应当是：

1. 静态资源缓存策略。
2. gzip/Brotli 压缩。
3. 文件内容哈希和自动版本化。
4. JS/CSS/HTML 压缩。
5. 大文件拆分和延迟加载。
6. 最后才是更激进的变量名、属性名压缩。

Nginx 的 gzip 模块可以显著降低文本资源传输体积，而缓存响应头也可以由 Nginx 按资源类型精确配置。([Nginx][1])

---

# 一、部署分支应该怎样设计

## 不建议直接“强制合并”

例如从 `dev/2607A` 发布到 `deploy-txsl`，不建议使用普通：

```bash
git checkout deploy-txsl
git merge dev/2607A
```

原因是部署分支可能已经存在以前生成的配置、压缩产物和部署提交。不断 merge 会：

* 累积部署专属提交；
* 引入无意义冲突；
* 无法保证部署分支和源分支完全一致；
* 让部署分支历史越来越复杂；
* 可能把旧构建产物继续保留下来。

如果你的真实目标是：

> deploy-txsl 的源码必须精确对应 dev/2607A 当前提交，然后再追加首尔机器部署产物。

那更清晰的行为是：

```bash
git reset --hard <source-commit>
```

然后由脚本生成部署配置和构建产物，再创建一个部署提交。

这不是“合并”，而是“以指定源提交重新生成部署快照”。

## 应使用 Git worktree

发布脚本不要切换当前开发目录。应该用临时 worktree：

```bash
git worktree add ...
```

这样用户仍然可以停留在 `dev/2607A`，构建脚本在另一个目录处理 `deploy-txsl`。Git 官方支持同一仓库同时存在多个工作树，正适合这种发布流程。([Git][2])

建议结构：

```text
项目主目录/
  当前仍停留在 dev/2607A

项目主目录/.deploy-worktrees/
  deploy-txsl/
  deploy-txhk/
  deploy-alyhk/
```

---

# 二、建议的 tools 目录结构

```text
tools/
  deploy/
    release.sh
    build.mjs
    verify.mjs
    deploy-remote.sh
    rollback.sh

    profiles/
      txsl.json
      txhk.json
      alyhk.json

    templates/
      nginx.conf.tpl
      systemd.service.tpl
      tunnel.config.json.tpl

    README.md
```

每台机器一个 profile：

```json
{
  "id": "txsl",
  "deployBranch": "deploy-txsl",
  "domain": "tun.miku.us",
  "serverPort": 4000,
  "pwaName": "Drop2Tunnel（首尔）",
  "pwaShortName": "Dr2T 首尔",
  "nginxListenPort": 80,
  "remoteHost": "your-server-alias",
  "remotePath": "/opt/drop2tunnel",
  "systemdService": "drop2tunnel-txsl"
}
```

另外两个：

```text
txhk → deploy-txhk → tun-txhk.miku.us
alyhk → deploy-alyhk → tun-alyhk.miku.us
```

密码、私钥、Telegram Token、管理员密钥等绝不能写进 profile 或部署分支。它们应留在服务器上的：

```text
/etc/drop2tunnel/txsl.env
/etc/drop2tunnel/txhk.env
/etc/drop2tunnel/alyhk.env
```

由 systemd 的 `EnvironmentFile=` 加载。

---

# 三、完整构建发布流程

建议命令：

```bash
./tools/deploy/release.sh \
  --source dev/2607A \
  --profile txsl \
  --push
```

脚本依次执行：

### 1. 发布前检查

* 检查当前 Git 仓库有效。
* 检查 `dev/2607A` 存在。
* 检查源分支没有未提交改动。
* 执行 `git fetch origin`。
* 获取源提交 SHA。
* 检查 profile。
* 检查 Node.js 和 npm 版本。

### 2. 建立临时 worktree

```bash
git worktree add \
  -B deploy-txsl \
  .deploy-worktrees/deploy-txsl \
  origin/deploy-txsl
```

首次不存在时，从 `master` 或源提交建立。

### 3. 对齐源分支

在 worktree 中：

```bash
git reset --hard <dev-2607A-source-sha>
git clean -fdx
```

这里必须明确列出不能删除的服务器运行数据。实际上更理想的是：数据库、上传缓存、配置都放在仓库外部，部署目录本身可以完全替换。

### 4. 生成机器配置

根据 `txsl.json` 生成：

```text
tunnel.config.json
nginx/file-tunnel.conf
systemd/drop2tunnel.service
manifest.webmanifest
runtime deployment metadata
```

不要用 `sed` 在源码里到处搜索替换域名和端口。应由模板或配置读取完成。

### 5. 构建到 dist

不要直接覆盖源码文件：

```text
源码：
app.js
index.html
client/media.js

构建输出：
dist/index.html
dist/assets/app.a8f319c2.min.js
dist/assets/media.17d81c03.min.js
```

建议每次构建生成：

```json
{
  "buildId": "txsl-20260709-053010-a24e91b",
  "profile": "txsl",
  "sourceBranch": "dev/2607A",
  "sourceCommit": "a24e91b...",
  "builtAt": "2026-07-09T05:30:10+08:00"
}
```

文件名可以是：

```text
dist/release.json
```

### 6. 自动升级所有缓存版本

构建过程自动完成：

* 静态资源文件内容哈希；
* HTML 引用更新；
* Service Worker APP_SHELL 更新；
* Service Worker cache name 更新；
* PWA 构建版本更新；
* `release.json` 更新；
* 页面可选地显示构建版本；
* 删除源码中手工维护的 `v23`。

Service Worker 脚本内容发生字节变化时，浏览器才会识别为新版本；缓存名称应跟随构建版本变化，但 Service Worker 自身 URL 不应每次改名。([web.dev][3])

### 7. 构建检查

至少执行：

```bash
node --check server.js
node --check app.js
node --check service-worker.js
npm test
npm run verify:dist
```

还应检查：

* HTML 引用的所有文件存在；
* APP_SHELL 中所有资源存在；
* 没有引用源目录 JS；
* 没有旧 hash；
* 没有旧端口或旧域名；
* profile 和 deploy branch 一致；
* `release.json` 中源 SHA 正确；
* 服务器可启动；
* `/`、`/runtime-config.js`、`/manifest.webmanifest`、`/socket.io/` 可访问。

### 8. 创建部署提交和标签

```bash
git add -A
git commit -m "deploy(txsl): build dev/2607A at a24e91b"
git tag "deploy-txsl-20260709-053010-a24e91b"
```

### 9. 推送部署分支

由于这里重写了部署分支历史，不要裸用 `--force`，应校验远端旧提交并使用显式 lease：

```bash
git push \
  --force-with-lease=deploy-txsl:<expected-remote-sha> \
  origin deploy-txsl
```

`--force-with-lease` 会在远端分支不再是预期状态时拒绝覆盖，比直接 `--force` 更安全。([Git][4])

### 10. 发布到服务器

服务器不要直接运行 Git 工作目录，建议使用版本目录：

```text
/opt/drop2tunnel/
  releases/
    txsl-20260709-053010-a24e91b/
    txsl-20260708-221500-b8c6132/
  current -> releases/txsl-20260709-053010-a24e91b
  shared/
    data/
    uploads/
    logs/
    .env
```

发布完成后：

```bash
ln -sfn releases/<new-build> current
systemctl restart drop2tunnel-txsl
curl health check
```

如果健康检查失败：

```bash
ln -sfn releases/<previous-build> current
systemctl restart drop2tunnel-txsl
```

至少保留最近 2～3 个发布版本，否则仍打开旧页面的客户端可能请求不到旧 hash 文件。

---

# 四、静态资源优化的正确做法

## 1. 缓存比 minify 更优先

当前服务端把所有 `.js` 都设置为 `no-store`。即使将 660KB 压成 300KB，用户每次仍需要重新下载。

建议：

```text
/index.html
/service-worker.js
/runtime-config.js
/manifest.webmanifest
    Cache-Control: no-cache

/assets/app.a8f319c2.min.js
/assets/main.26ba31cf.min.css
/assets/media.17d81c03.min.js
    Cache-Control: public, max-age=31536000, immutable
```

带内容 hash 的资源可以长期缓存；内容变化后文件名自然变化。

## 2. JS 压缩策略

esbuild 可以分别压缩：

* 空白；
* 语法；
* 标识符名称。

但官方也明确说明，任何 JavaScript minifier 都不能保证对全部特殊代码 100% 安全。([esbuild][5])

对当前 Drop2Tunnel，建议第一阶段：

```js
minifyWhitespace: true
minifySyntax: true
minifyIdentifiers: true
```

但必须遵循：

* 可以压缩函数内部局部变量和局部函数名。
* 第一版不要开启顶层全局名称压缩。
* 不要压缩对象属性名。
* 不要改 DOM ID。
* 不要改 Socket.IO 事件名。
* 不要改 API 路由。
* 不要改 IndexedDB store/index/key 名。
* 不要改 localStorage key。
* 不要改翻译 key。
* 不要改消息 JSON 字段。
* 不要改由字符串动态调用的函数名称。

Terser 支持顶层名称压缩、保留名单和属性压缩，但属性压缩本身具有较高风险，应只对明确标注或特定正则匹配的私有属性使用。([GitHub][6])

对于你现在大量依靠普通 `<script>` 和全局变量交互的代码，建议：

### 第一阶段

```text
单文件压缩
不打包
不压缩顶层全局名称
不压缩属性名
```

### 第二阶段

把前端逐步改成 ES Module 后：

```text
模块化
bundle
tree shaking
代码拆分
顶层局部标识符压缩
```

不要第一步就同时做“大规模模块化 + bundle + aggressive mangle”，否则回归风险很高。

## 3. HTML 和 CSS

可以使用 `html-minifier-terser`，但采用保守配置：

```js
{
  collapseWhitespace: true,
  conservativeCollapse: true,
  removeComments: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  useShortDoctype: true,
  removeOptionalTags: false,
  removeAttributeQuotes: false,
  removeEmptyElements: false
}
```

该工具支持压缩内联 CSS 和 JS，但你这个项目内联脚本很多，建议先把主要脚本和 CSS提取成独立文件，再分别压缩，不要让 HTML minifier 同时承担复杂 JS 压缩。([GitHub][7])

## 4. 拆分主文件

`app.js` 约 660KB，仅做 minify 仍然会在首页一次性解析大量当前根本用不到的功能。

建议后续拆成：

```text
core.js
tunnel.js
transfer.js
rich-text.js
media-player.js
voice-call.js
resource-manager.js
settings.js
admin-client.js
```

可延迟加载的功能：

* 音乐播放器；
* 图片/视频高级预览；
* 富文本版本对比；
* 管理员权限设置；
* 资源管理器；
* Telegram 配置；
* QR 码库；
* 压缩包/目录功能。

例如用户第一次打开播放器时才加载：

```js
await import('/assets/media-player.<hash>.js');
```

这通常比单纯继续缩短变量名更有实际收益。

---

# 五、三个部署分支的建议定位

```text
master
  稳定开发基线

dev/2607A
  当前功能开发

deploy-txsl
  由 dev/2607A + txsl profile 自动生成

deploy-txhk
  由 dev/2607A + txhk profile 自动生成

deploy-alyhk
  由 dev/2607A + alyhk profile 自动生成
```

部署分支上禁止人工开发，只允许出现类似提交：

```text
deploy(txsl): build dev/2607A at a24e91b
deploy(txsl): build dev/2607A at c42bd73
```

每个部署提交都必须记录：

* 源分支；
* 源提交；
* 构建编号；
* 目标机器；
* 域名；
* Node 监听端口；
* 构建时间。

---

# 六、怎样跟 Codex 沟通效果最好

不要只写：

```text
优化加载速度，压缩前端代码，并写部署脚本。
```

Codex 很可能会：

* 直接覆盖源码；
* 激进压缩全局函数；
* 压缩对象属性导致协议断裂；
* 切换你当前分支；
* 直接执行强制推送；
* 手工替换 Service Worker 版本；
* 只做 minify，不改缓存；
* 忽略 PWA 和旧客户端版本兼容。

应明确要求它：

1. 先审计，后修改。
2. 构建输出到 `dist/`，不覆盖源码。
3. 不实际 push、SSH 或重启服务。
4. 发布脚本默认 `--dry-run`。
5. 不压缩协议和持久化相关名称。
6. 使用 worktree，不切换当前工作区。
7. 所有机器差异来自 profile。
8. 自动生成 hash、Service Worker 和 release metadata。
9. 提交完整测试报告。
10. 分阶段实施，避免一次重构全部前端。

下面这份可以直接交给 Codex：

请基于我提供的完整 Drop2Tunnel/file-tunnel 代码包，实现“前端构建优化 + 多机器部署分支生成脚本”。开始修改前必须完整阅读项目结构、server.js、app.js、全部 HTML、client 目录、service-worker.js、manifest.hosts.json、tunnel.config.json、start.sh 和 nginx 配置。

## 一、目标

需要支持三个部署目标：

1. txsl

   * 分支：deploy-txsl
   * 用途：首尔机器部署
   * 域名：从 profile 配置读取

2. txhk

   * 分支：deploy-txhk
   * 用途：腾讯香港机器部署
   * 域名：从 profile 配置读取

3. alyhk

   * 分支：deploy-alyhk
   * 用途：阿里云香港机器部署
   * 域名：从 profile 配置读取

开发分支例如 dev/2607A。执行发布脚本时，需要以指定开发分支的准确 commit 为源，生成目标部署分支。

部署分支是自动生成的部署快照分支，禁止依赖人工修改。

## 二、重要安全要求

1. 不要在执行脚本时切换用户当前工作目录所在的 Git 分支。
2. 使用 git worktree 在临时目录中处理部署分支。
3. 不要直接执行 git push、SSH、rsync、systemctl 或远程部署，除非用户显式传入 --push 或 --deploy。
4. 默认使用 --dry-run。
5. 禁止使用裸 git push --force。
6. 如需改写部署分支，使用带明确远端预期 SHA 的：
   git push --force-with-lease=<branch>:<expected-sha>
7. 发布前检查源分支、工作区状态、Node/npm 版本和 profile 合法性。
8. 任何步骤失败必须立即终止，不得继续提交或部署。
9. 不得把密码、私钥、Token、TOTP secret 或其它机密写入 Git。
10. 构建产物不得覆盖原始开发源码。

## 三、tools 目录

在 tools/deploy 下建立：

* release.sh
* build.mjs
* verify.mjs
* deploy-remote.sh
* rollback.sh
* README.md
* profiles/txsl.json
* profiles/txhk.json
* profiles/alyhk.json
* templates/nginx.conf.tpl
* templates/systemd.service.tpl
* templates/tunnel.config.json.tpl

profile 至少包含：

* id
* deployBranch
* domain
* serverPort
* nginxListenPort
* pwaName
* pwaShortName
* remoteHost
* remotePath
* systemdService

所有机器差异必须来自 profile，不允许在脚本中大量 if/else 硬编码机器名称。

## 四、发布流程

release.sh 支持：

./tools/deploy/release.sh 
--source dev/2607A 
--profile txsl 
--dry-run

以及：

./tools/deploy/release.sh 
--source dev/2607A 
--profile txsl 
--push

执行过程：

1. git fetch。
2. 解析源分支准确 commit SHA。
3. 检查工作区和 profile。
4. 创建部署 worktree。
5. 让部署分支准确对齐源 commit，不使用普通 merge 累积历史。
6. 清理旧构建产物。
7. 根据 profile 生成配置。
8. 执行构建。
9. 执行语法检查、静态引用检查和启动冒烟测试。
10. 生成 release.json。
11. 创建部署提交。
12. 可选创建部署 tag。
13. 只有显式 --push 时才推送。
14. 清理临时 worktree。

部署提交信息示例：

deploy(txsl): build dev/2607A at a24e91b

## 五、构建输出

构建结果输出到 dist/，不得覆盖源码。

生成内容示例：

dist/index.html
dist/assets/app.<content-hash>.min.js
dist/assets/i18n.<content-hash>.min.js
dist/assets/file-assets.<content-hash>.min.js
dist/assets/media.<content-hash>.min.js
dist/assets/main.<content-hash>.min.css
dist/service-worker.js
dist/manifest.webmanifest
dist/release.json
dist/build-manifest.json

build-manifest.json 必须记录源码资源到构建资源的映射。

release.json 至少包含：

* buildId
* profile
* sourceBranch
* sourceCommit
* builtAt
* domain
* serverPort

## 六、压缩规则

JS 可以使用 esbuild 或 Terser。

第一阶段采取保守压缩：

* 压缩空白。
* 压缩语法。
* 压缩函数内部局部变量和局部函数名。
* 不开启危险的对象属性名压缩。
* 不压缩顶层、跨文件依赖的全局函数名，除非已证明安全并加入统一 reserved 列表。
* 不修改通过字符串访问的名称。

严禁改名或破坏：

* Socket.IO 事件名。
* API 路由。
* JSON 字段。
* localStorage key。
* IndexedDB 数据库名、object store 名、index 名和 key。
* DOM id。
* HTML class 与 JS/CSS 之间的引用。
* data-* 属性。
* 翻译 key。
* Service Worker message type。
* 文件类型、消息类型和权限名称。
* window 上公开的方法。
* HTML 内联事件所引用的方法。
* 动态调用的函数名。

不要开启全局 property mangling。

为生产构建生成 source map，但不要默认公开 source map；可以输出到单独目录供服务器管理员调试。

## 七、HTML 和 CSS

1. 尽量把 index.html 中的大型 CSS 提取到独立 CSS 文件。
2. 压缩 CSS。
3. 使用保守的 HTML 压缩配置。
4. 不删除可能影响布局的文本空白。
5. 不删除可选标签。
6. 不激进移除属性引号。
7. 不破坏内联 SVG、模板字符串、富文本模板或 PWA share target。
8. HTML 中所有 JS/CSS 引用必须自动替换为 content hash 文件名。

## 八、缓存策略

修改服务端和 Nginx 配置：

带 content hash 的静态资源：

Cache-Control: public, max-age=31536000, immutable

以下资源不得使用长期 immutable：

* index.html
* service-worker.js
* runtime-config.js
* manifest.webmanifest

这些资源使用 no-cache 或适当的短缓存，保证会重新验证。

API、Socket.IO 和动态配置不得被静态缓存。

启用 gzip，覆盖：

* text/css
* application/javascript
* application/json
* application/manifest+json
* image/svg+xml

如机器支持 Brotli，可以生成可选配置，但不能假设所有服务器都安装了 Brotli 模块。

## 九、PWA 和 Service Worker

1. 不再手工维护 instant-tunnel-v23。
2. cache name 根据 buildId 自动生成。
3. APP_SHELL 根据 build-manifest.json 自动生成。
4. Service Worker URL 保持稳定，不生成 service-worker-v123.js。
5. 每次构建必须保证 service-worker.js 内容变化。
6. 清理旧版本本项目缓存，但不得删除其它项目缓存。
7. 保留现有 PWA share target 能力。
8. 测试升级场景，避免新 Service Worker 控制旧页面时找不到资源。
9. 部署方案应建议保留最近至少两个构建版本的 hashed assets。
10. 不得只靠查询参数 ?v= 手工刷新资源。

## 十、性能优化

在不大规模重写业务逻辑的前提下：

1. 统计构建前后所有 HTML、JS、CSS 的原始尺寸和 gzip 尺寸。
2. 输出性能报告。
3. 识别可以延迟加载的功能。
4. 第一轮不要强行把整个 app.js 重构成 ES Modules。
5. 可以先保持现有脚本执行顺序，逐文件安全压缩。
6. 对二维码、媒体播放器、富文本历史、资源管理器等非首屏模块提出后续懒加载建议。
7. 不要为了减少文件数量把所有代码无条件合并成单个巨大 bundle。

## 十一、配置统一

当前项目可能存在 tunnel.config.json、Nginx upstream 和 start.sh 提示端口不一致的问题。

必须统一：

* Node serverPort。
* Nginx upstream port。
* 启动脚本提示。
* systemd ExecStart。
* runtime-config。
* 健康检查端口。

所有值由 profile 单一来源生成。

## 十二、验证要求

至少执行：

* npm ci
* 所有 JS 文件 node --check
* 构建脚本自身语法检查
* HTML 构建引用完整性检查
* build-manifest 检查
* Service Worker APP_SHELL 检查
* profile schema 检查
* 启动服务冒烟测试
* 首页 HTTP 检查
* runtime-config.js 检查
* manifest.webmanifest 检查
* Socket.IO 路径检查
* 管理页面检查
* PWA share 路径检查

另外扫描 dist：

* 不得遗留旧域名。
* 不得遗留错误端口。
* 不得引用不存在文件。
* 不得引用源码 JS。
* 不得包含私钥、Token 或密码。
* 不得存在未替换的模板变量。
* 不得存在语法错误。

## 十三、交付说明

完成后输出：

1. 修改文件清单。
2. 新增脚本使用方法。
3. 三个 profile 的字段说明。
4. 构建前后体积对比。
5. 实际执行过的测试及结果。
6. 未执行的测试及原因。
7. Git 分支重写和推送的风险说明。
8. 回滚方式。
9. 后续代码拆分建议。

先进行完整审计，再开始修改。不得仅做简单 minify，也不得在没有回归验证的情况下开启危险的顶层或属性名压缩。

最好把这个需求单独作为一轮实施，不要和“16 种语言补全”混在同一个 Codex 任务中。两者都会大量修改 `index.html`、`app.js`、`client/i18n.js` 和资源引用，同时进行会显著提高冲突与漏测概率。

[1]: https://nginx.org/en/docs/http/ngx_http_gzip_module.html "Module ngx_http_gzip_module"
[2]: https://git-scm.com/docs/git-worktree "Git - git-worktree Documentation"
[3]: https://web.dev/articles/service-worker-lifecycle "The service worker lifecycle  |  Articles  |  web.dev"
[4]: https://git-scm.com/docs/git-push "Git - git-push Documentation"
[5]: https://esbuild.github.io/api/ "esbuild - API"
[6]: https://github.com/terser/terser "GitHub - terser/terser:  JavaScript parser, mangler and compressor toolkit for ES6+ · GitHub"
[7]: https://github.com/terser/html-minifier-terser "GitHub - terser/html-minifier-terser: actively maintained fork of html-minifier - minify HTML, CSS and JS code using terser - supports ES6 code · GitHub"
