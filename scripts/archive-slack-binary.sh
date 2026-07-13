#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/packages/slack-manager/package.json').version")"
PLATFORM="${INVOKER_TARGET_PLATFORM:-$(node -p "process.platform")}"
ARCH="${INVOKER_TARGET_ARCH:-$(node -p "process.arch")}"
RELEASE_DIR="${INVOKER_RELEASE_DIR:-$ROOT/release}"
BINARY="$RELEASE_DIR/invoker-slack-$VERSION-$PLATFORM-$ARCH"

if [ ! -x "$BINARY" ]; then
  echo "Standalone Slack binary not found: $BINARY" >&2
  exit 66
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/invoker-slack-archive.XXXXXX")"
NAME="invoker-slack-$VERSION-$PLATFORM-$ARCH"
mkdir -p "$STAGE/$NAME"
cp "$BINARY" "$STAGE/$NAME/invoker-slack"
chmod +x "$STAGE/$NAME/invoker-slack"
cp "$ROOT/packages/npm-slack/README.md" "$STAGE/$NAME/README.md"

(cd "$STAGE" && tar -czf "$RELEASE_DIR/$NAME.tar.gz" "$NAME")
rm -rf "$STAGE"
echo "$RELEASE_DIR/$NAME.tar.gz"
