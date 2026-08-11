#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/packages/watcher/package.json').version")"
PLATFORM="${INVOKER_TARGET_PLATFORM:-$(node -p "process.platform")}"
ARCH="${INVOKER_TARGET_ARCH:-$(node -p "process.arch")}"
RELEASE_DIR="${INVOKER_RELEASE_DIR:-$ROOT/release}"
BINARY="$RELEASE_DIR/invoker-watcher-$VERSION-$PLATFORM-$ARCH"

if [ ! -x "$BINARY" ]; then
  echo "Standalone Watcher binary not found: $BINARY" >&2
  exit 66
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/invoker-watcher-archive.XXXXXX")"
NAME="invoker-watcher-$VERSION-$PLATFORM-$ARCH"
mkdir -p "$STAGE/$NAME"
cp "$BINARY" "$STAGE/$NAME/invoker-watcher"
chmod +x "$STAGE/$NAME/invoker-watcher"

(cd "$STAGE" && tar -czf "$RELEASE_DIR/$NAME.tar.gz" "$NAME")
rm -rf "$STAGE"
echo "$RELEASE_DIR/$NAME.tar.gz"
