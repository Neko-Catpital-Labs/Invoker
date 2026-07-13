#!/usr/bin/env bash
# Local maintainer cut from master: desktop DMG/zip + invoker-slack SEA binary.
#
# Usage:
#   bash scripts/local-macos-release-build.sh
#   bash scripts/local-macos-release-build.sh --arch arm64
#   bash scripts/local-macos-release-build.sh --skip-pull
#
# Writes commit-named copies under local-builds/<short-sha>/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCH="arm64"
SKIP_PULL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --skip-pull)
      SKIP_PULL=1
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Usage: bash scripts/local-macos-release-build.sh [--arch arm64|x64] [--skip-pull]" >&2
      exit 64
      ;;
  esac
done

if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x64" ]; then
  echo "--arch must be arm64 or x64" >&2
  exit 64
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script builds macOS desktop artifacts; run it on a Mac." >&2
  exit 64
fi

if [ "$SKIP_PULL" -eq 0 ]; then
  REMOTE="upstream"
  if ! git remote get-url upstream >/dev/null 2>&1; then
    REMOTE="origin"
  fi
  git fetch "$REMOTE" master
  git checkout master
  git merge --ff-only "$REMOTE/master"
fi

pnpm install --frozen-lockfile

pnpm run "dist:desktop:mac:${ARCH}"
pnpm run dist:slack

SHA="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./packages/app/package.json').version")"
PLATFORM="$(node -p "process.platform")"
OUT="local-builds/$SHA"
mkdir -p "$OUT"

cp "release/Invoker-${VERSION}-${ARCH}.dmg" "$OUT/Invoker-master-${SHA}-${ARCH}.dmg"
cp "release/Invoker-${VERSION}-${ARCH}.zip" "$OUT/Invoker-master-${SHA}-${ARCH}.zip"

SLACK_BIN="release/invoker-slack-${VERSION}-${PLATFORM}-${ARCH}"
SLACK_TGZ="${SLACK_BIN}.tar.gz"
cp "$SLACK_BIN" "$OUT/invoker-slack-master-${SHA}-${PLATFORM}-${ARCH}"
chmod +x "$OUT/invoker-slack-master-${SHA}-${PLATFORM}-${ARCH}"
cp "$SLACK_TGZ" "$OUT/invoker-slack-master-${SHA}-${PLATFORM}-${ARCH}.tar.gz"

(
  cd "$OUT"
  shasum -a 256 ./*
)

cat <<EOF

Local cut ready under $OUT

Desktop (unsigned):
  xattr -cr $OUT/Invoker-master-${SHA}-${ARCH}.dmg
  open $OUT/Invoker-master-${SHA}-${ARCH}.dmg

Slack binary:
  $OUT/invoker-slack-master-${SHA}-${PLATFORM}-${ARCH} --version

Published path (after a tagged release):
  npm i -g @neko-catpital-labs/invoker-slack
EOF
