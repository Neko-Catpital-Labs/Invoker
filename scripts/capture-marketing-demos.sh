#!/usr/bin/env bash
# Capture real Electron product demos for InvokerWebsite (Orca-style).
# Dense prompt-task fixture + frame-sequence motion for Product cards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEBSITE_DEFAULT="$(cd "$ROOT/../InvokerWebsite" 2>/dev/null && pwd || true)"
OUTPUT_DIR="${MARKETING_OUTPUT_DIR:-${WEBSITE_DEFAULT:+$WEBSITE_DEFAULT/public/demos/generated}}"
if [[ -z "${OUTPUT_DIR}" ]]; then
  OUTPUT_DIR="$ROOT/packages/app/e2e/marketing-demos"
fi

STILL_DIR="$ROOT/packages/app/e2e/marketing-demos"
FRAME_DIR="$ROOT/packages/app/e2e/marketing-frames"

cd "$ROOT"

echo "==> Invoker root: $ROOT"
echo "==> Output dir:   $OUTPUT_DIR"

mkdir -p "$OUTPUT_DIR"
rm -rf "$ROOT/packages/app/test-results"
GREP_FILTER="${MARKETING_GREP:-}"
if [[ -n "$GREP_FILTER" ]]; then
  mkdir -p "$STILL_DIR" "$FRAME_DIR"
  # Partial capture: only clear frames/stills for matching scene names later via test.
else
  rm -rf "$STILL_DIR" "$FRAME_DIR"
  mkdir -p "$STILL_DIR" "$FRAME_DIR"
fi

if [[ ! -f "$ROOT/node_modules/.modules.yaml" ]]; then
  echo "==> Installing workspace dependencies"
  pnpm install --frozen-lockfile
fi

echo "==> Building UI and app"
pnpm --filter @invoker/ui build
pnpm --filter @invoker/surfaces build
pnpm --filter @invoker/app build

echo "==> Capturing marketing demos${GREP_FILTER:+ (filter: $GREP_FILTER)}"
MARKETING_OUTPUT_DIR="$STILL_DIR" \
MARKETING_FRAME_DIR="$FRAME_DIR" \
INVOKER_PLAYWRIGHT_WORKERS=1 \
INVOKER_E2E_HIDE_WINDOW="${INVOKER_E2E_HIDE_WINDOW:-1}" \
INVOKER_E2E_CODEX_DEMO=1 \
INVOKER_E2E_CODEX_DEMO_HOLD_SECS="${INVOKER_E2E_CODEX_DEMO_HOLD_SECS:-20}" \
  pnpm --filter @invoker/app exec playwright test \
    e2e/marketing-product-demo.spec.ts \
    --config playwright.config.ts \
    --workers=1 \
    --timeout=240000 \
    ${GREP_FILTER:+-g "$GREP_FILTER"}

STATIC_SCENES=(control-cloud-agents monitor-execution review-work)
# Animated: prefer frame sequences; fall back to still-hold from poster PNG.
ANIMATED_SCENES=(intervene drive-with-ai workflow-drilldown rebase-intention agent-driven-workflow status-filtering)
# Intervene uses live Codex PTY frames; other product cards use motion sequences.
MOTION_SCENES=(intervene workflow-drilldown rebase-intention agent-driven-workflow status-filtering)

resolve_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then
    command -v ffmpeg
    return 0
  fi
  return 1
}

resolve_cwebp() {
  if command -v cwebp >/dev/null 2>&1; then
    command -v cwebp
    return 0
  fi
  local bundled="$ROOT/../InvokerWebsite/node_modules/webp-converter/bin/libwebp_osx/bin/cwebp"
  if [[ -x "$bundled" ]]; then
    printf '%s\n' "$bundled"
    return 0
  fi
  return 1
}

FFMPEG_BIN="$(resolve_ffmpeg || true)"
CWEBP_BIN="$(resolve_cwebp || true)"
if [[ -z "$FFMPEG_BIN" ]]; then
  echo "ERROR: ffmpeg is required to produce short silent WEBM loops" >&2
  exit 1
fi
if [[ -z "$CWEBP_BIN" ]]; then
  echo "ERROR: cwebp is required to produce WebP stills for the website" >&2
  exit 1
fi

echo "==> Assembling assets into $OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

assembled_static=()
assembled_animated=()

for scene in "${STATIC_SCENES[@]}" "${ANIMATED_SCENES[@]}"; do
  src="$STILL_DIR/${scene}.png"
  if [[ ! -f "$src" ]]; then
    if [[ -n "$GREP_FILTER" ]]; then
      echo "==> Skipping missing still $src (partial capture)"
      continue
    fi
    echo "ERROR: missing still $src" >&2
    exit 1
  fi
  "$CWEBP_BIN" -q 85 "$src" -o "$OUTPUT_DIR/${scene}.webp" >/dev/null
done

is_motion_scene() {
  local candidate="$1"
  local s
  for s in "${MOTION_SCENES[@]}"; do
    if [[ "$s" == "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

for scene in "${ANIMATED_SCENES[@]}"; do
  poster_src="$STILL_DIR/${scene}.png"
  out_webm="$OUTPUT_DIR/${scene}.webm"
  frames="$FRAME_DIR/${scene}"

  if [[ ! -f "$poster_src" ]]; then
    if [[ -n "$GREP_FILTER" ]]; then
      echo "==> Skipping missing animated poster $poster_src (partial capture)"
      continue
    fi
    echo "ERROR: missing still $poster_src" >&2
    exit 1
  fi

  if is_motion_scene "$scene" && [[ -d "$frames" ]] && compgen -G "$frames/frame-*.png" >/dev/null; then
    frame_count=$(find "$frames" -maxdepth 1 -name 'frame-*.png' | wc -l | tr -d ' ')
    # Continuous cursor captures prefer ~10fps; sparse keyframe scenes stay readable at 2fps.
    if (( frame_count >= 24 )); then
      fps=10
    else
      fps=2
    fi
    echo "==> Encoding motion frames for $scene ($frame_count frames @ ${fps}fps + 3s end hold)"
    "$FFMPEG_BIN" -y -framerate "$fps" -pattern_type glob -i "$frames/frame-*.png" \
      -vf "scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=3" \
      -an -c:v libvpx-vp9 -b:v 1800k -pix_fmt yuv420p \
      "$out_webm" >/dev/null 2>&1
  else
    echo "==> Encoding still-hold loop for $scene (5s + 3s end hold)"
    "$FFMPEG_BIN" -y -loop 1 -i "$poster_src" -t 8 \
      -vf "scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2,setsar=1" \
      -an -c:v libvpx-vp9 -b:v 1200k -pix_fmt yuv420p -r 8 \
      "$out_webm" >/dev/null 2>&1
  fi

  if [[ ! -s "$out_webm" ]]; then
    echo "ERROR: failed to write $out_webm" >&2
    exit 1
  fi
  assembled_animated+=("$scene")
done

for scene in "${STATIC_SCENES[@]}"; do
  if [[ -f "$OUTPUT_DIR/${scene}.webp" ]]; then
    assembled_static+=("$scene")
  fi
done

echo "==> Verifying asset sizes"
failures=0
for scene in "${assembled_static[@]}"; do
  size=$(wc -c < "$OUTPUT_DIR/${scene}.webp" | tr -d ' ')
  if (( size < 10240 )); then
    echo "ERROR: ${scene}.webp is too small ($size bytes)" >&2
    failures=1
  fi
done
for scene in "${assembled_animated[@]}"; do
  for ext in webp webm; do
    size=$(wc -c < "$OUTPUT_DIR/${scene}.${ext}" | tr -d ' ')
    if (( size < 10240 )); then
      echo "ERROR: ${scene}.${ext} is too small ($size bytes)" >&2
      failures=1
    fi
  done
done

if (( failures )); then
  exit 1
fi

if [[ -n "$GREP_FILTER" && ${#assembled_static[@]} -eq 0 && ${#assembled_animated[@]} -eq 0 ]]; then
  echo "ERROR: partial capture produced no assets" >&2
  exit 1
fi

echo "==> Marketing demos ready in $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"
