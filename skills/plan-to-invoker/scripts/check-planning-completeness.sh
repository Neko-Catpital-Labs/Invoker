#!/usr/bin/env bash
# Fail-closed planning completeness gate (Goal / Motivation / Safety invariant /
# repoUrl / Verify / no REPLACE_ME). Same gate for Slack, terminal, Linear, chat-submit.
# Usage: bash check-planning-completeness.sh <plan.yaml>
# Exit 0 = complete, Exit 1 = gaps
set -euo pipefail

file="${1:?Usage: check-planning-completeness.sh <plan.yaml>}"
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
abs_file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
exec node "$script_dir/check-planning-completeness.mjs" "$abs_file"
