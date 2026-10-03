#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

skill_dir="skills/""worker-session-mine"
if [[ -e "$skill_dir" || -L "$skill_dir" ]]; then
  echo "prove: ${skill_dir} still exists; the skill was not removed" >&2
  exit 1
fi

echo "prove: ${skill_dir} is absent"
