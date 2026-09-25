#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TARGET="skills/worker-session-mine"

if [[ -e "$TARGET" ]]; then
  echo "prove: expected $TARGET to be absent, but it still exists" >&2
  exit 1
fi

echo "prove: $TARGET is absent"
exit 0
