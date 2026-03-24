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
  cleanup <slug>            Delete draft release after PR merge
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

  NWO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  BRANCH=$(git branch --show-current)
  SLUG=$(echo "$BRANCH" | sed 's|/|-|g; s|^-||')
  TAG="vp-${SLUG}"

  git push -u origin HEAD

  gh release create "${TAG}" --draft --title "Visual proof: ${SLUG}" --notes "Auto-generated visual proof"

  TMPDIR=$(mktemp -d)
  for mode in before after; do
    for f in "${PROOF_DIR}/${mode}"/*.png; do
      [[ -e "$f" ]] && cp "$f" "${TMPDIR}/${mode}--$(basename "$f")"
    done
    for f in "${PROOF_DIR}/${mode}"/*.webm; do
      [[ -e "$f" ]] && cp "$f" "${TMPDIR}/${mode}--$(basename "$f")"
    done
  done

  gh release upload "${TAG}" ${TMPDIR}/*

  rm -rf "${TMPDIR}"

  BASE_URL="https://github.com/${NWO}/releases/download/${TAG}"

  BODY="## Visual Proof
"
  for state in "${STATES[@]}"; do
    STATE_NAME=$(echo "${state}" | sed 's/-/ /g; s/\b\(.\)/\u\1/g')
    BODY+="
<details open>
<summary>${STATE_NAME}</summary>

| Before | After |
|--------|-------|
| ![before](${BASE_URL}/before--${state}.png) | ![after](${BASE_URL}/after--${state}.png) |

</details>
"
  done

  BODY+="
<details>
<summary>Video Walkthroughs</summary>

- [Before walkthrough](${BASE_URL}/before--walkthrough.webm)
- [After walkthrough](${BASE_URL}/after--walkthrough.webm)

</details>
"

  gh pr create --title "${TITLE}" --base "${BASE}" --body "${BODY}"
}

cleanup_command() {
  local SLUG="$1"
  if [[ -z "${SLUG}" ]]; then
    echo "Error: slug is required"
    usage
  fi
  gh release delete "vp-${SLUG}" --yes --cleanup-tag
  echo "Cleaned up visual proof release vp-${SLUG}"
}

case "${1:-}" in
  before)  capture "before" ;;
  after)   capture "after" ;;
  pr)      shift; pr_command "$@" ;;
  cleanup) cleanup_command "${2:-}" ;;
  *)       usage ;;
esac
