#!/usr/bin/env bash
set -euo pipefail
echo "Remote deployment is intentionally not implemented in the first controlled release toolset." >&2
echo "Use release.sh to build and verify dist first; add SSH/rsync deployment only after local builds are stable." >&2
exit 2
