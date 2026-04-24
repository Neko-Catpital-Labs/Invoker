#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="all"
case "${1:-}" in
  --linux) TARGET="linux" ;;
  --mac) TARGET="mac" ;;
  "" ) ;;
  *)
    echo "Usage: bash scripts/package-desktop.sh [--linux|--mac]" >&2
    exit 64
    ;;
esac

pnpm --filter @invoker/ui build
pnpm --filter @invoker/app build

rm -rf packages/app/dist/ui
mkdir -p packages/app/dist/ui
cp -R packages/ui/dist/. packages/app/dist/ui/

mkdir -p release
rm -f release/*.dmg release/*.deb release/*.AppImage release/SHA256SUMS

case "$TARGET" in
  linux)
    pnpm --filter @invoker/app exec electron-builder --linux AppImage deb --publish never
    ;;
  mac)
    pnpm --filter @invoker/app exec electron-builder --mac dmg --publish never
    ;;
  all)
    pnpm --filter @invoker/app exec electron-builder --publish never
    ;;
esac
