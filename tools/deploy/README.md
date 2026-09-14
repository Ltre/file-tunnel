# Drop2Tunnel Deploy Tools

This directory contains the first controlled deployment toolset for Drop2Tunnel.
It is designed to generate deployment snapshots without switching the current
developer working tree.

## Profiles

- `txsl`: Seoul machine, Node.js listens directly on port `80`, no Nginx.
- `txhk`: Tencent Hong Kong machine, Node.js listens on port `4000`, Nginx proxies to it.
- `alyhk`: Alibaba Hong Kong machine, Node.js listens on port `4000`, Nginx proxies to it.

All machine-specific values live in `tools/deploy/profiles/*.json`.

## Build Only (for current branch "dev/2607A-NEWCODE")

```bash
node tools/deploy/build.mjs --profile txsl --out dist --source-branch dev/2607A-NEWCODE
node tools/deploy/verify.mjs --dist dist --profile txsl
```

The build writes to `dist/` and does not overwrite source files.

Generated outputs include:

- `dist/pages/*.html`
- `dist/assets/*.<hash>.min.js`
- `dist/assets/*.<hash>.min.css`
- `dist/service-worker.js`
- `dist/tunnel.config.json`
- `dist/manifest.hosts.json`
- `dist/release.json`
- `dist/build-manifest.json`
- `dist/deploy/*.nginx.conf` when the profile enables Nginx
- `dist/deploy/*.service`

## Release Worktree

Dry run is the default:

```bash
tools/deploy/release.sh --source dev/2607A-NEWCODE --profile txsl
```

Create a deploy-branch commit, but do not push:

```bash
tools/deploy/release.sh --source dev/2607A-NEWCODE --profile txsl --commit
```

Push only when explicitly requested:

```bash
tools/deploy/release.sh --source dev/2607A-NEWCODE --profile txsl --commit --push
```

`release.sh` uses `.deploy-worktrees/<deploy-branch>` and refuses to start if
the current working tree is dirty. It never switches the current working tree.

## Minification Strategy

The first stage is conservative:

- JavaScript is content-hashed and moved to `/assets/`.
- If `terser` is installed, JavaScript uses whitespace/syntax compression and
  local identifier mangling while preserving top-level names.
- If `terser` is not installed but `esbuild` is installed, JavaScript uses
  whitespace/syntax minification without identifier or property-name mangling.
- If neither minifier is available, JavaScript is copied as-is but still
  receives content hashes and long-cache headers.
- CSS extracted from page `<style>` blocks is conservatively minified.
- HTML can use `html-minifier-terser` when installed; otherwise it is only
  rewritten for hashed assets.

Do not enable top-level or property-name mangling for this project without a
separate audit. Socket.IO events, IndexedDB names, localStorage keys, DOM ids,
`data-*` attributes, global functions, and HTML inline handlers are protocol
surfaces.

## Caching

The server should cache hashed assets as:

```text
Cache-Control: public, max-age=31536000, immutable
```

Dynamic or shell resources should revalidate:

```text
/, /service-worker.js, /runtime-config.js, /manifest.webmanifest
Cache-Control: no-cache
```

## Remote Deployment

After running `release.sh` on the deployment server, sync the generated dist
tree into the running Node.js app directory:

```bash
tools/deploy/deploy-remote.sh --profile txhk
tools/deploy/deploy-remote.sh --profile alyhk
```

For each profile this copies from its deployment worktree dist directory:

```text
.deploy-worktrees/<profile.deployBranch>/dist/ -> ~/mydir/nodeapp/file-tunnel/
```

The script uses `rsync -a` and intentionally does not pass `--delete`, so files
that already exist under `~/mydir/nodeapp/file-tunnel/` but are absent from
`dist/` are preserved. Use `--dry-run` to preview changes.

**文件同步后必须安装依赖并重启实际运行的 Node.js 服务。** `deploy-remote.sh`
只同步文件，不会安装依赖或重启进程。在实际部署目录执行：

```bash
cd ~/mydir/nodeapp/file-tunnel # 使用本站实际部署目录
npm ci --omit=dev
```

然后按该站实际采用的 systemd、PM2 或手动启动方式重启服务。
Express 会立即读取更新后的 HTML，但正在运行的 `server.js` 和
已加载的模块仍是旧代码，可能出现 `/tgbot` 展示 OIDC、网盘分区输入框而旧接口
忽略这些字段的情况。新增依赖未安装也会让新版服务启动失败。
有多个实例时须全部更新，并确认使用同一个预期的 `TUNNEL_DATA_DIR`。

重启后访问 `/api/telegram/drive/me`，当前版本应返回 JSON 而非 404；在已登录的
`/tgbot` 中检查 `/api/telegram/config` 返回 `oidcClientId`、
`oidcClientSecretConfigured` 和 `driveChannels`，然后重新填写并保存。
Client Secret 不回显，只通过“已配置”提示确认保留。不要把 Secret 或 Bot Token
放进排查日志。

`rollback.sh` is still a placeholder until a verified rollback flow is added.
