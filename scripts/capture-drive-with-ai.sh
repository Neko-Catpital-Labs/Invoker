#!/usr/bin/env bash
# Capture Drive with AI: Claude mock → submit to invoker → Invoker Plan graph.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEBSITE_DEFAULT="$(cd "$ROOT/../InvokerWebsite" 2>/dev/null && pwd || true)"
OUTPUT_DIR="${MARKETING_OUTPUT_DIR:-${WEBSITE_DEFAULT:+$WEBSITE_DEFAULT/public/demos/generated}}"
if [[ -z "${OUTPUT_DIR}" ]]; then
  OUTPUT_DIR="$ROOT/packages/app/e2e/marketing-demos"
fi

STILL_DIR="$ROOT/packages/app/e2e/marketing-demos"
FRAME_DIR="$ROOT/packages/app/e2e/marketing-frames"
SCENE=drive-with-ai

cd "$ROOT"

echo "==> Invoker root: $ROOT"
echo "==> Output dir:   $OUTPUT_DIR"

mkdir -p "$OUTPUT_DIR" "$STILL_DIR" "$FRAME_DIR"
rm -rf "$FRAME_DIR/$SCENE"
rm -f "$STILL_DIR/${SCENE}.png"

if [[ ! -f "$ROOT/node_modules/.modules.yaml" ]]; then
  echo "==> Installing workspace dependencies"
  pnpm install --frozen-lockfile
fi

if [[ ! -f "$ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building UI and app"
  pnpm --filter @invoker/ui build
  pnpm --filter @invoker/surfaces build
  pnpm --filter @invoker/app build
fi

echo "==> Capturing $SCENE"
MARKETING_OUTPUT_DIR="$STILL_DIR" \
MARKETING_FRAME_DIR="$FRAME_DIR" \
INVOKER_PLAYWRIGHT_WORKERS=1 \
INVOKER_E2E_HIDE_WINDOW="${INVOKER_E2E_HIDE_WINDOW:-1}" \
  pnpm --filter @invoker/app exec playwright test \
    e2e/marketing-drive-with-ai.spec.ts \
    --config playwright.config.ts \
    --workers=1 \
    --timeout=240000

FFMPEG_BIN="$(command -v ffmpeg)"
CWEBP_BIN="$(command -v cwebp || true)"
if [[ -z "${CWEBP_BIN}" ]]; then
  CWEBP_BIN="$ROOT/../InvokerWebsite/node_modules/webp-converter/bin/libwebp_osx/bin/cwebp"
fi
if [[ ! -x "$FFMPEG_BIN" ]]; then
  echo "ERROR: ffmpeg is required" >&2
  exit 1
fi
if [[ ! -x "$CWEBP_BIN" ]]; then
  echo "ERROR: cwebp is required" >&2
  exit 1
fi

poster_src="$STILL_DIR/${SCENE}.png"
frames="$FRAME_DIR/${SCENE}"
out_webm="$OUTPUT_DIR/${SCENE}.webm"
out_webp="$OUTPUT_DIR/${SCENE}.webp"

if [[ ! -f "$poster_src" ]]; then
  echo "ERROR: missing poster $poster_src" >&2
  exit 1
fi

frame_count=$(find "$frames" -maxdepth 1 -name 'frame-*.png' 2>/dev/null | wc -l | tr -d ' ')
if (( frame_count < 8 )); then
  echo "ERROR: expected motion frames in $frames, found $frame_count" >&2
  exit 1
fi

echo "==> Encoding motion frames for $SCENE ($frame_count frames @10fps)"
"$FFMPEG_BIN" -y -framerate 10 -pattern_type glob -i "$frames/frame-*.png" \
  -vf "scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2,setsar=1" \
  -an -c:v libvpx-vp9 -b:v 2200k -pix_fmt yuv420p \
  "$out_webm"

"$CWEBP_BIN" -q 85 "$poster_src" -o "$out_webp" >/dev/null

size_webm=$(wc -c < "$out_webm" | tr -d ' ')
size_webp=$(wc -c < "$out_webp" | tr -d ' ')
if (( size_webm < 10240 || size_webp < 10240 )); then
  echo "ERROR: output assets too small (webm=$size_webm webp=$size_webp)" >&2
  exit 1
fi

echo "==> Ready: $out_webm ($size_webm bytes), $out_webp ($size_webp bytes)"
ls -la "$out_webm" "$out_webp"
