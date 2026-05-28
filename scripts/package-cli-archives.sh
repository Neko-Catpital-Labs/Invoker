#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/packages/cli/package.json').version")"
OUT_DIR="$ROOT/release/cli"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/invoker-cli-package.XXXXXX")"

cd "$ROOT"
pnpm --filter @invoker/cli build
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for platform in darwin linux win32; do
  for arch in x64 arm64; do
    name="invoker-cli-${VERSION}-${platform}-${arch}"
    dir="$STAGE/$name"
    mkdir -p "$dir/dist"
    cp -R packages/cli/dist/. "$dir/dist/"
    cp packages/cli/package.json "$dir/package.json"
    cp packages/cli/README.md "$dir/README.md"
    if [[ "$platform" == "win32" ]]; then
      cat > "$dir/invoker-cli.cmd" <<'CMD'
@echo off
node "%~dp0\dist\index.js" %*
CMD
      (cd "$STAGE" && zip -qr "$OUT_DIR/$name.zip" "$name")
    else
      cat > "$dir/invoker-cli" <<'SH'
#!/usr/bin/env sh
exec node "$(dirname "$0")/dist/index.js" "$@"
SH
      chmod +x "$dir/invoker-cli"
      (cd "$STAGE" && tar -czf "$OUT_DIR/$name.tar.gz" "$name")
    fi
  done
done

echo "CLI archives written to $OUT_DIR"
