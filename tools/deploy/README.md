# Drop2Tunnel Deploy Tools

This directory contains the first controlled deployment toolset for Drop2Tunnel.
It is designed to generate deployment snapshots without switching the current
developer working tree.

## Profiles

- `txsl`: Seoul machine, Node.js listens directly on port `80`, no Nginx.
- `txhk`: Tencent Hong Kong machine, Node.js listens on port `4000`, Nginx proxies to it.
- `alyhk`: Alibaba Hong Kong machine, Node.js listens on port `4000`, Nginx proxies to it.

All machine-specific values live in `tools/deploy/profiles/*.json`.

## Build Only

```bash
node tools/deploy/build.mjs --profile txsl --out dist --source-branch dev/2607A
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
tools/deploy/release.sh --source dev/2607A --profile txsl
```

Create a deploy-branch commit, but do not push:

```bash
tools/deploy/release.sh --source dev/2607A --profile txsl --commit
```

Push only when explicitly requested:

```bash
tools/deploy/release.sh --source dev/2607A --profile txsl --commit --push
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

`deploy-remote.sh` and `rollback.sh` are placeholders in this first stage. Keep
remote SSH/rsync/systemd actions out of the flow until local build verification
is boringly reliable.
