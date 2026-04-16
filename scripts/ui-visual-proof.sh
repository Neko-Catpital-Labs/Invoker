#!/usr/bin/env bash
set -euo pipefail

# Capture UI screenshots and video for the current working tree state.
#
# This script builds the UI + app, runs Playwright visual-proof tests, and
# saves screenshots + video to an output directory. It does NOT handle git
# checkouts or before/after comparisons — the caller orchestrates that.
#
# Usage:
#   scripts/ui-visual-proof.sh [SUBCOMMAND] [OPTIONS]
#
# Subcommands:
#   capture-before    Capture "before" screenshots to visual-proof/before/
#   capture-after     Capture "after" screenshots to visual-proof/after/
#   validate          Run DOM snapshot tests (fast, no Electron needed)
#   compare           Generate diff images and video (requires ffmpeg)
#   embed             Generate markdown with embedded base64 images
#   --spec <file>     Playwright spec file for capture-before/after (default: visual-proof.spec.ts)
#
# Subcommand details:
#   capture-before:
#     Captures to packages/app/e2e/visual-proof/before/
#     Fails fast if Electron app cannot be built.
#
#   capture-after:
#     Captures to packages/app/e2e/visual-proof/after/
#     Fails fast if Electron app cannot be built.
#
#   compare:
#     Requires before/ and after/ directories exist with matching .png files.
#     Requires ffmpeg for video diff generation.
#     Generates diff/ directory with per-image diffs and side-by-side video.
#     Exit code 1 if before/ or after/ missing, 1 if ffmpeg missing, 0 if success.
#
#   embed:
#     Generates visual-proof/EMBED.md with base64-encoded images.
#     Requires before/ and after/ directories.
#     Exit code 1 if artifacts missing, 0 if success.
#
# Output structure (capture mode):
#   <output-dir>/<label>/
#     ├── empty-state.png
#     ├── dag-loaded.png
#     ├── task-running.png
#     ├── task-complete.png
#     ├── task-panel.png
#     └── walkthrough.webm

SPEC="visual-proof.spec.ts"
RESULTS_DIR="packages/app/e2e/test-results"
SUBCOMMAND=""

usage() {
  sed -n '3,/^$/p' "$0" | sed 's/^# \?//'
  exit 1
}

check_prerequisite_ffmpeg() {
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[visual-proof] ERROR: ffmpeg not found in PATH" >&2
    echo "[visual-proof] Install with: sudo apt-get install ffmpeg (Debian/Ubuntu)" >&2
    echo "[visual-proof]            or: brew install ffmpeg (macOS)" >&2
    exit 1
  fi
}

check_artifacts() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "[visual-proof] ERROR: Required directory not found: $dir" >&2
    return 1
  fi
  local png_count
  png_count=$(find "$dir" -maxdepth 1 -name '*.png' 2>/dev/null | wc -l)
  if [[ "$png_count" -eq 0 ]]; then
    echo "[visual-proof] ERROR: No .png files found in $dir" >&2
    return 1
  fi
  return 0
}

run_capture() {
  local label="$1"
  local output_dir="$2"
  local spec="$3"
  local skip_build="$4"

  CAPTURE_DIR="${output_dir}/${label}"

  echo "[visual-proof] Capturing to ${CAPTURE_DIR}" >&2
  mkdir -p "${CAPTURE_DIR}"

  if [[ "${skip_build}" == "false" ]]; then
    echo "[visual-proof] Building UI and app..." >&2
    pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build || {
      echo "[visual-proof] ERROR: Build failed" >&2
      exit 1
    }
  fi

  echo "[visual-proof] Running Playwright: ${spec}" >&2
  PLAYWRIGHT_EXIT=0
  if [[ "$(uname)" == "Linux" ]]; then
    cd packages/app && CAPTURE_MODE="${label}" CAPTURE_VIDEO=1 \
      xvfb-run --auto-servernum npx playwright test "${spec}" || PLAYWRIGHT_EXIT=$?
  else
    cd packages/app && CAPTURE_MODE="${label}" CAPTURE_VIDEO=1 \
      npx playwright test "${spec}" || PLAYWRIGHT_EXIT=$?
  fi
  cd ../..

  if [[ "${PLAYWRIGHT_EXIT}" -ne 0 ]]; then
    echo "[visual-proof] Playwright exited ${PLAYWRIGHT_EXIT} — collecting any screenshots produced" >&2
  fi

  # Move screenshots from the Playwright-internal capture dir to our output dir.
  PLAYWRIGHT_CAPTURE_DIR="packages/app/e2e/visual-proof/${label}"
  if [[ "${PLAYWRIGHT_CAPTURE_DIR}" != "${CAPTURE_DIR}" ]] && [[ -d "${PLAYWRIGHT_CAPTURE_DIR}" ]]; then
    cp "${PLAYWRIGHT_CAPTURE_DIR}"/*.png "${CAPTURE_DIR}/" 2>/dev/null || true
  fi

  # Copy video from test-results
  find "${RESULTS_DIR}" -name '*.webm' -exec cp {} "${CAPTURE_DIR}/walkthrough.webm" \; 2>/dev/null || true

  echo "[visual-proof] Captured files:" >&2
  ls -la "${CAPTURE_DIR}/" >&2

  SCREENSHOT_COUNT=$(find "${CAPTURE_DIR}" -name '*.png' 2>/dev/null | wc -l)
  if [[ "${SCREENSHOT_COUNT}" -eq 0 ]]; then
    echo "[visual-proof] ERROR: No screenshots captured" >&2
    exit 1
  fi

  echo "[visual-proof] ${SCREENSHOT_COUNT} screenshot(s) captured" >&2
  echo "${CAPTURE_DIR}"
}

subcommand_capture_before() {
  echo "[visual-proof] Running capture-before..." >&2
  run_capture "before" "packages/app/e2e/visual-proof" "${SPEC}" false
}

subcommand_capture_after() {
  echo "[visual-proof] Running capture-after..." >&2
  run_capture "after" "packages/app/e2e/visual-proof" "${SPEC}" false
}

subcommand_compare() {
  echo "[visual-proof] Running compare..." >&2
  check_prerequisite_ffmpeg

  local before_dir="packages/app/e2e/visual-proof/before"
  local after_dir="packages/app/e2e/visual-proof/after"
  local diff_dir="packages/app/e2e/visual-proof/diff"

  check_artifacts "$before_dir" || exit 1
  check_artifacts "$after_dir" || exit 1

  mkdir -p "$diff_dir"

  # Generate per-image diffs
  for before_img in "$before_dir"/*.png; do
    local basename
    basename=$(basename "$before_img")
    local after_img="$after_dir/$basename"
    local diff_img="$diff_dir/$basename"

    if [[ ! -f "$after_img" ]]; then
      echo "[visual-proof] WARNING: No matching after image for $basename" >&2
      continue
    fi

    echo "[visual-proof] Comparing $basename..." >&2
    # ImageMagick compare: red highlights differences
    if command -v compare >/dev/null 2>&1; then
      compare "$before_img" "$after_img" -highlight-color red "$diff_img" 2>/dev/null || {
        echo "[visual-proof] ImageMagick compare failed for $basename, copying after image" >&2
        cp "$after_img" "$diff_img"
      }
    else
      echo "[visual-proof] ImageMagick not found, skipping pixel diff for $basename" >&2
      cp "$after_img" "$diff_img"
    fi
  done

  # Generate side-by-side video comparison if both videos exist
  if [[ -f "$before_dir/walkthrough.webm" ]] && [[ -f "$after_dir/walkthrough.webm" ]]; then
    echo "[visual-proof] Generating side-by-side video comparison..." >&2
    ffmpeg -y \
      -i "$before_dir/walkthrough.webm" \
      -i "$after_dir/walkthrough.webm" \
      -filter_complex "[0:v][1:v]hstack=inputs=2[v]" \
      -map "[v]" \
      "$diff_dir/comparison.webm" 2>&1 | grep -v "^frame=" || true
    echo "[visual-proof] Video comparison saved to $diff_dir/comparison.webm" >&2
  else
    echo "[visual-proof] Skipping video comparison (walkthrough.webm missing)" >&2
  fi

  echo "[visual-proof] Comparison complete: $diff_dir" >&2
  ls -la "$diff_dir/" >&2
}

subcommand_embed() {
  echo "[visual-proof] Running embed..." >&2

  local before_dir="packages/app/e2e/visual-proof/before"
  local after_dir="packages/app/e2e/visual-proof/after"
  local output_md="packages/app/e2e/visual-proof/EMBED.md"

  check_artifacts "$before_dir" || exit 1
  check_artifacts "$after_dir" || exit 1

  {
    echo "# Visual Proof: Before vs After"
    echo ""
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
    echo ""

    for before_img in "$before_dir"/*.png; do
      local basename
      basename=$(basename "$before_img")
      local after_img="$after_dir/$basename"

      if [[ ! -f "$after_img" ]]; then
        continue
      fi

      echo "## $basename"
      echo ""
      echo "### Before"
      echo "![before](data:image/png;base64,$(base64 < "$before_img"))"
      echo ""
      echo "### After"
      echo "![after](data:image/png;base64,$(base64 < "$after_img"))"
      echo ""
    done
  } > "$output_md"

  echo "[visual-proof] Embed markdown generated: $output_md" >&2
}

# Parse subcommand first
if [[ $# -gt 0 ]] && [[ ! "$1" =~ ^-- ]]; then
  SUBCOMMAND="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec)       SPEC="$2"; shift 2 ;;
    --help|-h)    usage ;;
    *)            echo "Unknown option: $1" >&2; usage ;;
  esac
done

# Dispatch to subcommand
case "$SUBCOMMAND" in
  capture-before)
    subcommand_capture_before
    ;;
  capture-after)
    subcommand_capture_after
    ;;
  validate)
    echo "[visual-proof] Running DOM snapshot tests..." >&2
    cd packages/ui && pnpm test -- --run src/__tests__/visual-proof-snapshots.test.tsx
    ;;
  compare)
    subcommand_compare
    ;;
  embed)
    subcommand_embed
    ;;
  "")
    echo "[visual-proof] ERROR: Missing subcommand. Use one of: capture-before, capture-after, validate, compare, embed" >&2
    usage
    ;;
  *)
    echo "[visual-proof] ERROR: Unknown subcommand: $SUBCOMMAND" >&2
    usage
    ;;
esac
