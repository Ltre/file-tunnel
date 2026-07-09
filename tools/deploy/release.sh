#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tools/deploy/release.sh --source <branch-or-sha> --profile <txsl|txhk|alyhk> [--dry-run]
  tools/deploy/release.sh --source <branch-or-sha> --profile <txsl|txhk|alyhk> --commit
  tools/deploy/release.sh --source <branch-or-sha> --profile <txsl|txhk|alyhk> --commit --push

Defaults:
  --dry-run is enabled unless --commit is passed.
  --push is ignored unless --commit is also passed.
EOF
}

SOURCE=""
PROFILE=""
DO_COMMIT=0
DO_PUSH=0
DO_FETCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --dry-run) DO_COMMIT=0; shift ;;
    --commit) DO_COMMIT=1; shift ;;
    --push) DO_PUSH=1; shift ;;
    --no-fetch) DO_FETCH=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$SOURCE" || -z "$PROFILE" ]]; then
  usage
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to release from a dirty working tree. Commit or stash changes first." >&2
  exit 1
fi

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

if [[ "$DO_FETCH" -eq 1 ]]; then
  git fetch origin --prune
fi

SOURCE_SHA="$(git rev-parse "$SOURCE")"
SHORT_SHA="${SOURCE_SHA:0:8}"
WORKTREE_DIR=".deploy-worktrees/${DEPLOY_BRANCH}"

mkdir -p .deploy-worktrees
if [[ -d "$WORKTREE_DIR/.git" || -f "$WORKTREE_DIR/.git" ]]; then
  git -C "$WORKTREE_DIR" reset --hard "$SOURCE_SHA"
  git -C "$WORKTREE_DIR" clean -fdx
else
  rm -rf "$WORKTREE_DIR"
  git worktree add -B "$DEPLOY_BRANCH" "$WORKTREE_DIR" "$SOURCE_SHA"
fi

node "$WORKTREE_DIR/tools/deploy/build.mjs" \
  --profile "$PROFILE" \
  --out dist \
  --source-branch "$SOURCE" \
  --source-commit "$SOURCE_SHA"

node "$WORKTREE_DIR/tools/deploy/verify.mjs" --dist dist --profile "$PROFILE"

if [[ "$DO_COMMIT" -ne 1 ]]; then
  echo "Dry run complete. Worktree left at: ${WORKTREE_DIR}"
  echo "No commit or push was performed."
  exit 0
fi

git -C "$WORKTREE_DIR" add dist
if git -C "$WORKTREE_DIR" diff --cached --quiet; then
  echo "No dist changes to commit for ${DEPLOY_BRANCH}."
else
  git -C "$WORKTREE_DIR" commit -m "deploy(${PROFILE}): build ${SOURCE} at ${SHORT_SHA}"
fi

if [[ "$DO_PUSH" -eq 1 ]]; then
  EXPECTED_REMOTE_SHA="$(git rev-parse --verify "origin/${DEPLOY_BRANCH}" 2>/dev/null || true)"
  if [[ -z "$EXPECTED_REMOTE_SHA" ]]; then
    git -C "$WORKTREE_DIR" push origin "$DEPLOY_BRANCH"
  else
    git -C "$WORKTREE_DIR" push --force-with-lease="${DEPLOY_BRANCH}:${EXPECTED_REMOTE_SHA}" origin "$DEPLOY_BRANCH"
  fi
else
  echo "Commit complete. Push was not performed."
fi
