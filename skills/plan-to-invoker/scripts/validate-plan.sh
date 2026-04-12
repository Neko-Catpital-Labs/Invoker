#!/usr/bin/env bash
# Validate an Invoker YAML plan file.
# Usage: bash validate-plan.sh <plan.yaml>
# Exit 0 = valid, Exit 1 = errors (printed to stderr)
set -euo pipefail

file="${1:?Usage: validate-plan.sh <plan.yaml>}"

# Call typed validator (ESM .mjs - no compilation needed)
# Run from packages/app directory so ESM can resolve 'yaml' from local node_modules
# Resolve to the physical script dir so this works via canonical path or symlink.
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Resolve repo root from git so this works across layouts/worktrees.
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "Error: could not determine repository root from $script_dir" >&2
  exit 1
fi
abs_file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"

cd "$repo_root/packages/app"
exec node "$script_dir/validate-plan.mjs" "$abs_file"
