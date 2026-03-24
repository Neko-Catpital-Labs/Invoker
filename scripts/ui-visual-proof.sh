#!/usr/bin/env bash
set -euo pipefail

PROOF_DIR="packages/app/e2e/visual-proof"
RESULTS_DIR="packages/app/e2e/test-results"
STATES=("empty-state" "dag-loaded" "task-running" "task-complete" "task-panel")

usage() {
  cat <<EOF
Usage: scripts/ui-visual-proof.sh <command> [options]
Commands:
  before                    Capture baseline screenshots (run on base branch)
  after                     Capture changed screenshots (run after UI changes)
  pr --title <t> --base <b> Upload proof and create PR
  embed --base <b> --feature <f> --slug <s>  Capture and upload proof, output markdown to stdout
EOF
  exit 1
}

capture() {
  local mode="$1"
  echo "Capturing ${mode} state..."
  mkdir -p "${PROOF_DIR}/${mode}"
  pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build
  cd packages/app && CAPTURE_MODE="${mode}" CAPTURE_VIDEO=1 \
    xvfb-run --auto-servernum npx playwright test visual-proof.spec.ts
  cd ../..
  find ${RESULTS_DIR} -name '*.webm' -exec cp {} "${PROOF_DIR}/${mode}/walkthrough.webm" \;
  echo "Captured files:"
  ls -la "${PROOF_DIR}/${mode}/"
}

pr_command() {
  local TITLE=""
  local BASE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) TITLE="$2"; shift 2 ;;
      --base)  BASE="$2"; shift 2 ;;
      *)       echo "Unknown option: $1"; usage ;;
    esac
  done
  if [[ -z "${TITLE}" || -z "${BASE}" ]]; then
    echo "Error: --title and --base are required"
    usage
  fi

  # Build PR body with local image paths — create-pr.mjs uploads them to R2
  BODY_FILE=$(mktemp --suffix=.md)

  echo "## Visual Proof" > "${BODY_FILE}"
  echo "" >> "${BODY_FILE}"
  for state in "${STATES[@]}"; do
    STATE_NAME=$(echo "${state}" | sed 's/-/ /g; s/\b\(.\)/\u\1/g')
    BEFORE_IMG="${PROOF_DIR}/before/${state}.png"
    AFTER_IMG="${PROOF_DIR}/after/${state}.png"
    cat >> "${BODY_FILE}" <<SECTION
<details open>
<summary>${STATE_NAME}</summary>

| Before | After |
|--------|-------|
| ![before](${BEFORE_IMG}) | ![after](${AFTER_IMG}) |

</details>

SECTION
  done

  BEFORE_VIDEO="${PROOF_DIR}/before/walkthrough.webm"
  AFTER_VIDEO="${PROOF_DIR}/after/walkthrough.webm"
  cat >> "${BODY_FILE}" <<SECTION
<details>
<summary>Video Walkthroughs</summary>

- [Before walkthrough](${BEFORE_VIDEO})
- [After walkthrough](${AFTER_VIDEO})

</details>
SECTION

  # create-pr.mjs handles: git push, R2 image upload, PR creation via REST API
  node scripts/create-pr.mjs --title "${TITLE}" --base "${BASE}" --body-file "${BODY_FILE}"

  rm -f "${BODY_FILE}"
}

embed_command() {
  local BASE=""
  local FEATURE=""
  local SLUG=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base)    BASE="$2"; shift 2 ;;
      --feature) FEATURE="$2"; shift 2 ;;
      --slug)    SLUG="$2"; shift 2 ;;
      *)         echo "Unknown option: $1" >&2; usage ;;
    esac
  done
  if [[ -z "${BASE}" || -z "${FEATURE}" || -z "${SLUG}" ]]; then
    echo "Error: --base, --feature, and --slug are required" >&2
    usage
  fi

  ORIG_BRANCH=$(git branch --show-current)

  echo "Checking out base branch: ${BASE}" >&2
  git checkout "${BASE}" >&2
  capture "before" >&2

  echo "Checking out feature branch: ${FEATURE}" >&2
  git checkout "${FEATURE}" >&2
  capture "after" >&2

  echo "Restoring original branch: ${ORIG_BRANCH}" >&2
  git checkout "${ORIG_BRANCH}" >&2

  # Copy files to temp directory with proper naming
  TMPDIR=$(mktemp -d)
  for mode in before after; do
    for f in "${PROOF_DIR}/${mode}"/*.png; do
      [[ -e "$f" ]] && cp "$f" "${TMPDIR}/${mode}--$(basename "$f")"
    done
    for f in "${PROOF_DIR}/${mode}"/*.webm; do
      [[ -e "$f" ]] && cp "$f" "${TMPDIR}/${mode}--$(basename "$f")"
    done
  done

  echo "Uploading assets to R2" >&2
  URL_MAP=$(node scripts/upload-pr-images.mjs ${TMPDIR}/*)

  rm -rf "${TMPDIR}"

  echo "## Visual Proof"
  echo ""
  for state in "${STATES[@]}"; do
    STATE_NAME=$(echo "${state}" | sed 's/-/ /g; s/\b\(.\)/\u\1/g')
    BEFORE_URL=$(echo "$URL_MAP" | jq -r ".\"before--${state}.png\"")
    AFTER_URL=$(echo "$URL_MAP" | jq -r ".\"after--${state}.png\"")
    echo "<details open>"
    echo "<summary>${STATE_NAME}</summary>"
    echo ""
    echo "| Before | After |"
    echo "|--------|-------|"
    echo "| ![before](${BEFORE_URL}) | ![after](${AFTER_URL}) |"
    echo ""
    echo "</details>"
    echo ""
  done

  BEFORE_VIDEO=$(echo "$URL_MAP" | jq -r ".\"before--walkthrough.webm\"")
  AFTER_VIDEO=$(echo "$URL_MAP" | jq -r ".\"after--walkthrough.webm\"")

  echo "<details>"
  echo "<summary>Video Walkthroughs</summary>"
  echo ""
  echo "- [Before walkthrough](${BEFORE_VIDEO})"
  echo "- [After walkthrough](${AFTER_VIDEO})"
  echo ""
  echo "</details>"
}

case "${1:-}" in
  before)  capture "before" ;;
  after)   capture "after" ;;
  pr)      shift; pr_command "$@" ;;
  embed)   shift; embed_command "$@" ;;
  *)       usage ;;
esac
