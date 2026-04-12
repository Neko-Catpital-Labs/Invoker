#!/usr/bin/env bash
# Build the TypeScript validator to JavaScript
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"

cd "$script_dir"
pnpm exec tsup --config "$script_dir/tsup.config.ts"
