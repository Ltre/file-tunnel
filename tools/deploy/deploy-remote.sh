#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tools/deploy/deploy-remote.sh [--profile txhk|alyhk] [--dry-run]
  tools/deploy/deploy-remote.sh --source-dir <dist-dir> --target-dir <app-dir> [--dry-run]

Default:
  profile: txhk
  source-dir: .deploy-worktrees/<profile.deployBranch>/dist
  target-dir: ~/mydir/nodeapp/file-tunnel

This script intentionally does not pass --delete to rsync. Files that already
exist in the target directory but are not present in dist are preserved.
EOF
}

PROFILE="txhk"
SOURCE_DIR=""
TARGET_DIR="$HOME/mydir/nodeapp/file-tunnel"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
    --target-dir) TARGET_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ -z "$SOURCE_DIR" ]]; then
  PROFILE_JSON="tools/deploy/profiles/${PROFILE}.json"
  if [[ ! -f "$PROFILE_JSON" ]]; then
    echo "Profile not found: $PROFILE_JSON" >&2
    exit 1
  fi
  DEPLOY_BRANCH="$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(p.deployBranch || '')" "$PROFILE_JSON")"
  if [[ -z "$DEPLOY_BRANCH" ]]; then
    echo "Profile ${PROFILE} does not define deployBranch." >&2
    exit 1
  fi
  SOURCE_DIR=".deploy-worktrees/${DEPLOY_BRANCH}/dist"
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Source dist directory does not exist: $SOURCE_DIR" >&2
  echo "Run tools/deploy/release.sh first." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

RSYNC_ARGS=(
  -a
  --human-readable
  --info=stats2,progress2
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  RSYNC_ARGS+=(--dry-run)
fi

echo "Syncing dist:"
echo "  from: ${SOURCE_DIR%/}/"
echo "  to:   ${TARGET_DIR%/}/"
echo "  mode: rsync archive, no --delete"

rsync "${RSYNC_ARGS[@]}" "${SOURCE_DIR%/}/" "${TARGET_DIR%/}/"
