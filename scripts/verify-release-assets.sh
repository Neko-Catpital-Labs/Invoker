#!/usr/bin/env bash
# Verify the full Invoker release asset set exists under release/ (or $1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE_DIR="${1:-release}"
version="$(node -p "require('./package.json').version")"
required=(
  "invoker-cli-${version}-linux-x64.tar.gz"
  "invoker-cli-${version}-linux-arm64.tar.gz"
  "invoker-cli-${version}-darwin-x64.tar.gz"
  "invoker-cli-${version}-darwin-arm64.tar.gz"
  "invoker-slack-${version}-linux-x64.tar.gz"
  "invoker-slack-${version}-linux-arm64.tar.gz"
  "invoker-slack-${version}-darwin-x64.tar.gz"
  "invoker-slack-${version}-darwin-arm64.tar.gz"
  "invoker-watcher-${version}-linux-x64.tar.gz"
  "invoker-watcher-${version}-linux-arm64.tar.gz"
  "invoker-watcher-${version}-darwin-x64.tar.gz"
  "invoker-watcher-${version}-darwin-arm64.tar.gz"
  "Invoker-${version}-x86_64.AppImage"
  "Invoker-${version}-arm64.AppImage"
  "Invoker-${version}-amd64.deb"
  "Invoker-${version}-arm64.deb"
  "Invoker-${version}-x64.dmg"
  "Invoker-${version}-arm64.dmg"
  "Invoker-${version}-x64.zip"
  "Invoker-${version}-arm64.zip"
  "SHA256SUMS"
)

missing=0
for asset in "${required[@]}"; do
  if [ ! -f "${RELEASE_DIR}/${asset}" ]; then
    echo "Missing release asset: ${asset}" >&2
    missing=1
  fi
done
exit "$missing"
