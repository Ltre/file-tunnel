# Drop2Tunnel 部署工具

本目录包含 Drop2Tunnel 第一阶段的受控部署工具集。

它的设计目标是：在不切换当前开发工作树的情况下，生成可用于部署的快照。

## 部署配置

* `txsl`：首尔机器，Node.js 直接监听 `80` 端口，不使用 Nginx。
* `txhk`：腾讯云香港机器，Node.js 监听 `4000` 端口，由 Nginx 反向代理。
* `alyhk`：阿里云香港机器，Node.js 监听 `4000` 端口，由 Nginx 反向代理。

所有与具体机器相关的配置值，统一存放在：

```text
tools/deploy/profiles/*.json
```

## 仅执行构建

```bash
node tools/deploy/build.mjs --profile txsl --out dist --source-branch dev/2607A
node tools/deploy/verify.mjs --dist dist --profile txsl
```

构建产物会写入 `dist/` 目录，不会覆盖任何源代码文件。

生成的内容包括：

* `dist/pages/*.html`
* `dist/assets/*.<hash>.min.js`
* `dist/assets/*.<hash>.min.css`
* `dist/service-worker.js`
* `dist/tunnel.config.json`
* `dist/manifest.hosts.json`
* `dist/release.json`
* `dist/build-manifest.json`
* 当部署配置启用 Nginx 时，生成 `dist/deploy/*.nginx.conf`
* `dist/deploy/*.service`

## 使用工作树生成发布版本

默认执行的是演练模式，不会真正提交或推送：

```bash
tools/deploy/release.sh --source dev/2607A --profile txsl
```

创建部署分支提交，但不推送到远程仓库：

```bash
tools/deploy/release.sh --source dev/2607A --profile txsl --commit
```

只有在明确指定时才推送：

```bash
tools/deploy/release.sh --source dev/2607A --profile txsl --commit --push
```

`release.sh` 会使用以下目录作为部署工作树：

```text
.deploy-worktrees/<部署分支名称>
```

如果当前开发工作树存在未提交修改，脚本会拒绝启动。

该脚本绝不会切换当前开发工作树所在的分支。

## 压缩策略

第一阶段采用较为保守的压缩策略：

* JavaScript 文件会根据内容生成哈希值，并移动到 `/assets/` 目录。
* 如果已经安装 `terser`，JavaScript 会进行空白字符、语法压缩和局部标识符压缩，但会保留顶层名称。
* 如果没有安装 `terser`，但已经安装 `esbuild`，JavaScript 会进行空白字符和语法层面的压缩，但不会压缩标识符名称，也不会压缩对象属性名。
* 如果两个压缩器都不可用，JavaScript 会保持原样复制，但仍会生成内容哈希文件名，并应用长期缓存响应头。
* 页面 `<style>` 标签中的 CSS 会被提取出来，并进行保守压缩。
* 如果已经安装 `html-minifier-terser`，则可以使用它压缩 HTML；否则只会重写 HTML 中的资源引用，使其指向带哈希值的静态资源。

在没有进行独立专项审计之前，不要为本项目启用顶层名称压缩或对象属性名压缩。

以下内容都属于项目的协议接口或稳定标识，不能被随意改名：

* Socket.IO 事件名称
* IndexedDB 数据库、对象仓库和索引名称
* localStorage 键名
* DOM 元素 ID
* `data-*` 属性
* 全局函数
* HTML 内联事件处理器引用的函数

## 缓存策略

服务器应当为带内容哈希的静态资源设置以下缓存响应头：

```text
Cache-Control: public, max-age=31536000, immutable
```

动态资源和应用外壳资源应当要求浏览器重新验证：

```text
/, /service-worker.js, /runtime-config.js, /manifest.webmanifest
Cache-Control: no-cache
```

## 远程部署

`deploy-remote.sh` 和 `rollback.sh` 在第一阶段中仅作为占位脚本存在。

在本地构建验证流程达到足够稳定、可靠且可重复的程度之前，不要把以下远程操作加入正式发布流程：

* SSH
* rsync
* systemd 服务控制
