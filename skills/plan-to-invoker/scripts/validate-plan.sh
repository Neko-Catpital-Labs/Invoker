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

# validate-plan.mjs resolves its own `yaml` runtime (a plain 'yaml' import,
# which works when this script is running from inside the invoker-cli npm
# install -- see packages/npm-cli/package.json's real dependency on yaml --
# falling back to a resolvable Invoker checkout otherwise). No cwd change
# or repo-root resolution needed here at all.
exec node "$script_dir/validate-plan.mjs" "$abs_file"
