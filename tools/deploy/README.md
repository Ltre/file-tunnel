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

`rollback.sh` is still a placeholder until a verified rollback flow is added.
