#!/usr/bin/env bash
# Validate an Invoker YAML plan file.
# Usage: bash validate-plan.sh <plan.yaml>
# Exit 0 = valid, Exit 1 = errors (printed to stderr)
set -euo pipefail

file="${1:?Usage: validate-plan.sh <plan.yaml>}"

# Call typed validator (ESM .mjs - no compilation needed).
# Resolve to the physical script dir so this works via canonical path or symlink.
script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
abs_file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"

# validate-plan.mjs resolves its own `yaml` runtime — preferring the copy
# vendored at ./vendor/yaml (see scripts/vendor-plan-doctor-deps.sh), which
# is what makes this self-sufficient wherever skills/ ends up copied (a
# machine-level skill install, or an invoker-cli/invoker-slack release
# tarball, neither of which carry packages/app/node_modules alongside it).
# No cwd change needed once that vendored copy is present.
if [[ -f "$script_dir/vendor/yaml/index.js" ]]; then
  exec node "$script_dir/validate-plan.mjs" "$abs_file"
fi

# Vendor copy missing (e.g. a hand-edited skill directory): fall back to
# resolving a real Invoker checkout, same override order validate-plan.mjs
# itself uses for its own INVOKER_REPO_ROOT fallback.
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
  echo "Error: could not resolve a yaml runtime — no $script_dir/vendor/yaml/index.js and no repository root from $script_dir" >&2
  echo "Run 'bash scripts/vendor-plan-doctor-deps.sh' to restore the vendored copy, or set INVOKER_REPO_ROOT to an Invoker checkout." >&2
  exit 1
fi

exec node "$script_dir/validate-plan.mjs" "$abs_file"
