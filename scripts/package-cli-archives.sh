#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/packages/cli/package.json').version")"
OUT_DIR="$ROOT/release"

cd "$ROOT"
mkdir -p "$OUT_DIR"

node scripts/build-cli-standalone.mjs
bash scripts/archive-cli-binary.sh

echo "CLI archives written to $OUT_DIR"
