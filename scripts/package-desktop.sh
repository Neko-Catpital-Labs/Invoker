#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="all"
MAC_ARCH=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --linux)
      TARGET="linux"
      ;;
    --mac)
      TARGET="mac"
      ;;
    --x64)
      MAC_ARCH="x64"
      ;;
    --arm64)
      MAC_ARCH="arm64"
      ;;
    *)
      echo "Usage: bash scripts/package-desktop.sh [--linux|--mac] [--x64|--arm64]" >&2
      exit 64
      ;;
  esac
  shift
done

if [ -n "$MAC_ARCH" ] && [ "$TARGET" != "mac" ]; then
  echo "--x64/--arm64 requires --mac" >&2
  exit 64
fi

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
    if [ -n "$MAC_ARCH" ]; then
      pnpm --filter @invoker/app exec electron-builder --mac dmg "--$MAC_ARCH" --publish never
    else
      pnpm --filter @invoker/app exec electron-builder --mac dmg --publish never
    fi
    ;;
  all)
    pnpm --filter @invoker/app exec electron-builder --publish never
    ;;
esac
