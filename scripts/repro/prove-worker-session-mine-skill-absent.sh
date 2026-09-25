#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -e skills/worker-session-mine || -L skills/worker-session-mine ]]; then
  echo "prove: skills/worker-session-mine still exists; the skill was not removed" >&2
  exit 1
fi

echo "prove: skills/worker-session-mine is absent"
