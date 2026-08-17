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

# Resolve the Invoker checkout that owns this doctor script. Prefer an
# explicit override, then a live git checkout (works across layouts and
# worktrees), then the source checkout recorded by the last
# `setup-agent-skills.sh` install — needed when running from a machine-level
# skill install (e.g. ~/.claude/skills/invoker-plan-to-invoker/scripts),
# which ships outside any git repository and can't resolve via git.
repo_root="${INVOKER_REPO_ROOT:-}"
if [[ -z "$repo_root" ]]; then
  repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [[ -z "$repo_root" ]]; then
  invoker_home="${INVOKER_DB_DIR:-$HOME/.invoker}"
  manifest="$invoker_home/bundled-skills.json"
  if [[ -f "$manifest" ]] && command -v node &>/dev/null; then
    repo_root="$(node -e '
      const fs = require("node:fs");
      try {
        const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (typeof manifest.sourceRepoRoot === "string") process.stdout.write(manifest.sourceRepoRoot);
      } catch {}
    ' "$manifest" 2>/dev/null || true)"
  fi
fi

if [[ -z "$repo_root" || ! -d "$repo_root/packages/app" ]]; then
  echo "Error: could not determine repository root from $script_dir" >&2
  echo "Set INVOKER_REPO_ROOT to an Invoker checkout, or reinstall skills with 'bash scripts/setup-agent-skills.sh' so ~/.invoker/bundled-skills.json records the source checkout." >&2
  exit 1
fi
abs_file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"

cd "$repo_root/packages/app"
exec node "$script_dir/validate-plan.mjs" "$abs_file"
