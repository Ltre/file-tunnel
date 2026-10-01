# 线上 Engine.IO 高危漏洞修复

本工具针对 **GHSA-2gc4-cqfq-p2gv / CVE-2026-102599**，用于单独修补正式或灰度环境的 Engine.IO 依赖，不要求同时发布其它业务代码。

官方公告：<https://github.com/advisories/GHSA-2gc4-cqfq-p2gv>。

受影响版本为 `engine.io >=6.6.0 <6.6.10`；`6.6.10` 已修复，本次项目锁文件使用 `6.6.11`。恶意客户端可利用已有会话升级时协议版本不一致的情况，导致 Node 进程崩溃。该漏洞影响服务端，浏览器刷新不能修复。

## 推荐的正常发布方式

如果准备发布已经修复的完整项目版本：先等上传、下载和转码任务结束，停止本站所有 Node 服务实例，在**实际部署目录**安装修复后的锁文件，然后启动服务：

```bash
npm ci --omit=dev
```

确认 `npm ls socket.io engine.io` 显示修复版本，并确认运行进程已经重启。仅复制新 `package-lock.json`，或在旧进程仍运行时安装依赖，都不能保证正在运行的服务已经获得补丁。

## 单独热修复旧业务版本

将 `repair-engineio-security.cjs` 和本说明复制到服务器项目的 `tools/` 目录。脚本只使用 Node 内置模块；按该部署版本要求使用兼容的 Node 和 npm，当前项目要求 Node `>=24.15`。

使用该项目通常采用的部署账号执行，避免混用 root/其它账号导致后续 npm 操作遇到依赖文件权限问题。服务器需有暂存空间安装生产依赖；临时安装期间原依赖和备份会同时存在。

### 1. 只读检查

进入**实际运行 `server.js` 的部署目录**，执行：

```bash
node tools/repair-engineio-security.cjs
```

也可从其它位置指定部署目录：

```bash
node tools/repair-engineio-security.cjs --project-dir "C:\Users\Administrator\.openclaw\workspace\tunnel"
```

默认不联网、不写文件、不停止服务，输出包括：

- `runtimePath`：Socket.IO 实际解析到的 Engine.IO 位置；支持 npm 嵌套安装位置。
- `engines`：锁文件版本和磁盘实际安装版本，避免只看锁文件而漏掉旧安装。
- `needsRepair`：是否检测到本次公告的受影响版本。

`needsRepair: false` 只表示磁盘上的这些版本未命中本次公告，不能证明仍在运行的 Node 进程已经重新加载依赖，也不表示没有其它漏洞。

### 2. 停止服务及自动重启

等正在进行的任务结束后再维护。终止长上传可能导致任务失败或进入既有恢复/回滚流程；本工具不会更改这些业务行为。

停止正式环境、灰度环境的对应服务；如果二者共享同一部署目录或 `node_modules`，必须全部停止。不要结束其它无关 Node 服务。

按实际管理方式选择操作，以下名称是示例：

```bash
# PM2：stop，修复后再 start。不要只 kill 后任由守护程序拉起。
pm2 stop <本站应用名>

# systemd
sudo systemctl stop <本站服务名>
```

Windows 手动运行 `node server.js` / `npm start`：在所属终端停止该进程，确认派生的 Node 子进程也已退出。Windows 服务、NSSM、计划任务等：停止对应服务/任务及其自动拉起机制。不要执行全局 `taskkill /IM node.exe`。

`--service-stopped` 是操作者的明确声明。脚本还会检查指定端口在 IPv4/IPv6 本机回环地址上是否仍有监听，但端口检查无法证明所有后台进程、容器及不同端口的实例均已停止，需要操作者确认。

### 3. 执行修复

`--port` 必须是 **Node 实际监听端口**，不是 Cloudflare、Nginx 或 IIS 对外端口。例如 Node 直接监听 80：

```bash
node tools/repair-engineio-security.cjs --apply --service-stopped --port 80
```

Node 在反向代理后监听 4000：

```bash
node tools/repair-engineio-security.cjs --apply --service-stopped --port 4000
```

脚本依次执行：

1. 检查清单、锁文件、实际安装位置及停服状态，取得独占维护锁。
2. 在 `.dependency-maintenance/engineio-XXXXXX/stage` 中复制清单，并运行定向的 `npm update engine.io --package-lock-only --ignore-scripts`。
3. 核对升级计划：只接受同一 `6.6.x` 系列的安全补丁，禁止降级、改变其它依赖及修改 `package.json`。
4. 在隔离目录执行 `npm ci --omit=dev --ignore-scripts`，验证下载包的锁文件完整性；不在生产目录重新安装整棵依赖树，不运行依赖安装脚本。
5. 使用独立 Node 子进程及随机本机端口验证：错误/缺失 `EIO` 升级被拒绝，正常轮询、WebSocket 升级、文本与二进制传输可用。
6. 备份原清单及待替换 Engine.IO 的完整目录，记录 SHA-256 校验值；再次检查停服及文件未被并发修改。
7. 只替换目标 Engine.IO 目录及锁文件，再用新子进程验证实际部署目录。失败时自动恢复备份，保持服务停止。
8. 输出备份路径，并执行生产依赖的 npm 审计。审计网络不可用会标记 `unavailable`，不会伪报 0 漏洞；其它无关漏洞不会使已验证的安全补丁被撤回。

当前 npm 仓库将解析到 `6.6.11`；将来同系列更新可能解析到更高安全补丁，以输出版本为准。已有安全版本重复执行为 `already-safe`，不会反复修改依赖。

脚本不会启动生产服务，不修改代理环境变量、Socket.IO 配置、项目业务文件、`.tunnel-data`、SQLite 或 Telegram 数据。npm 使用当前环境及 `.npmrc` 的 registry/proxy 配置，不会为了网络问题改变项目代理控制策略。

### 4. 重启并验证站点

成功输出应包括：

```json
{
  "mode": "applied",
  "needsRepair": false,
  "requiresServiceRestart": true,
  "backupDir": "实际部署目录/.dependency-maintenance/engineio-XXXXXX"
}
```

随后按原管理方式启动服务：

```bash
pm2 start <本站应用名>
# 或
sudo systemctl start <本站服务名>
# 手动启动环境按原命令执行 npm start，不要同时启动第二份实例。
```

在实际部署目录检查：

```bash
npm ls socket.io engine.io
npm audit --omit=dev
node tools/repair-engineio-security.cjs
```

确认所有本站 Node 进程的 PID/启动时间已经更新，然后打开站点，确认隧道 Socket 连接正常、两台设备能建立连接和传输小文件。集群、多台机器和容器副本要逐个处理；一台服务器修补成功不会自动更新其它实例。

脚本的隔离探测验证依赖行为，不会代替真实站点登录、CORS、反向代理和跨设备传输验收。

## 回滚及异常恢复

备份目录包含 `repair.json`、原 `package.json`、原 `package-lock.json` 和 `original/` 下的原 Engine.IO 目录，必须保留至站点验收完成。

失败时脚本尽可能自动回滚。需要手工回滚时，保持所有服务停止，使用本次输出的**完整备份目录**：

```bash
node tools/repair-engineio-security.cjs --rollback "实际部署目录/.dependency-maintenance/engineio-XXXXXX" --service-stopped --port 80
```

回滚前会校验备份、当前清单和依赖。如果之后又部署过其它版本、修改过锁文件或依赖，工具会拒绝覆盖；不要强行把旧备份盖到新版本上。回滚会恢复原版本，可能恢复漏洞，应保持维护状态，排查后重新修补。

若断电、强制结束脚本或异常重启导致 `maintenance.lock` 残留：

1. 确认对应维护进程不再运行，并停止所有本站服务及自动重启。
2. 查看 `.dependency-maintenance/engineio-*/repair.json`。`applying` 或 `rollback-failed` 表示可能有未完成的替换。
3. 确认无维护进程后，手动移除 `.dependency-maintenance/maintenance.lock`；若存在未完成替换，先执行上述 `--rollback`，然后重新修复。
4. 不要直接删除 `original/` 或未完成操作的备份。

正常执行后自动清理临时安装目录。若 Windows 文件锁导致临时目录清理失败，脚本会输出位置，确认服务停止后可清理该 `stage` 目录及标出的临时副本；原备份必须保留。npm 下载缓存位于 `.dependency-maintenance/npm-cache`，不属于网盘文件缓存。

## 工具拒绝修复时

- **仍有端口监听**：停止正确的 Node 实例及守护程序；若填的是代理端口，改填 Node 内部端口。
- **清单与锁文件不一致**：核对部署目录和文件版本，不要在混合版本上强行安装。
- **npm 更新涉及其它依赖**：当前旧版本可能需要配套依赖升级；工具不做扩大修改。改用经过测试的完整修复版本，按正常发布流程安装锁文件。
- **override 阻止升级**：核对已有 overrides；不要绕过约束或盲目执行 `npm audit fix --force`。
- **npm 网络失败**：生产依赖尚未修改；检查 npm registry、代理及下载权限后重试。
- **EPERM/EACCES**：检查停止状态、文件权限、杀毒软件或文件占用。不要删除 `.tunnel-data`，也不必为了本补丁重建数据库。
- **旧锁文件 v1、workspaces、shrinkwrap、依赖符号链接**：本工具拒绝这种布局。使用正常版本发布流程处理，不会擅自重构依赖树。

确认备份不再需要后，可按服务器常规维护方式清理本工具的备份和 npm 缓存。未来发布时也必须使用包含安全补丁的项目锁文件，否则旧发布包执行 `npm ci` 会重新安装漏洞版本。
