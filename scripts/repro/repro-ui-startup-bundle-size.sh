#!/usr/bin/env bash
#
# Deterministic repro for the UI entry-chunk bundle size issue.
#
# The production UI build produces an entry chunk of ~1.77MB (raw), which
# is a cold-start parse/evaluation risk in the Electron renderer process.
# This script builds the UI package, measures chunk sizes, and reports
# whether the entry chunk exceeds the documented budget.
#
# Modes:
#   --expect-issue   PASS when the entry chunk EXCEEDS the budget
#                    (confirms the bloat exists today).
#   (default)        PASS only when the entry chunk is UNDER budget
#                    (validates the optimization).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST_DIR="${REPO_ROOT}/packages/ui/dist/assets"

# Budget: entry chunk raw size in bytes (1.5MB = 1536000 bytes).
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-1536000}"

EXPECT_ISSUE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue       PASS only if the entry chunk exceeds the budget
                       (baseline mode, before optimization).
  --budget BYTES       Override entry-chunk raw-size budget in bytes
                       (default: ${ENTRY_BUDGET_BYTES}).
  -h, --help           Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --budget) ENTRY_BUDGET_BYTES="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

echo "=== UI Bundle Size Repro ==="
echo "Budget: entry chunk < ${ENTRY_BUDGET_BYTES} bytes ($(awk "BEGIN{printf \"%.2f\", ${ENTRY_BUDGET_BYTES}/1048576}")MB)"
echo "Mode:   $(if [[ $EXPECT_ISSUE -eq 1 ]]; then echo '--expect-issue (expect bloat)'; else echo 'default (expect under budget)'; fi)"
echo ""

# --- Build ---
echo "Building @invoker/ui ..."
(cd "$REPO_ROOT" && pnpm --filter @invoker/ui build) >/dev/null 2>&1

if [[ ! -d "$DIST_DIR" ]]; then
  echo "FAIL: dist/assets directory not found after build." >&2
  exit 1
fi

# --- Identify chunks ---
# Entry chunk: the largest .js file that is NOT a known vendor chunk name.
# Vendor chunks from manualChunks config: react, xyflow, xterm.
ENTRY_CHUNK=""
ENTRY_SIZE=0

echo "--- Chunk Report ---"
printf "%-50s %12s %12s\n" "CHUNK" "RAW" "GZIP"
printf "%-50s %12s %12s\n" "-----" "---" "----"

for f in "$DIST_DIR"/*.js; do
  [[ -f "$f" ]] || continue
  basename_f="$(basename "$f")"
  raw_size="$(wc -c < "$f" | tr -d ' ')"
  gzip_size="$(gzip -c "$f" | wc -c | tr -d ' ')"

  raw_human="$(awk "BEGIN{printf \"%.2fKB\", ${raw_size}/1024}")"
  gzip_human="$(awk "BEGIN{printf \"%.2fKB\", ${gzip_size}/1024}")"

  printf "%-50s %12s %12s\n" "$basename_f" "$raw_human" "$gzip_human"

  # Identify entry chunk: skip known vendor chunks
  is_vendor=0
  for vendor in react xyflow xterm; do
    if [[ "$basename_f" == *"${vendor}"* ]]; then
      is_vendor=1
      break
    fi
  done

  if [[ $is_vendor -eq 0 && $raw_size -gt $ENTRY_SIZE ]]; then
    ENTRY_CHUNK="$basename_f"
    ENTRY_SIZE=$raw_size
  fi
done

# Also report CSS chunks
for f in "$DIST_DIR"/*.css; do
  [[ -f "$f" ]] || continue
  basename_f="$(basename "$f")"
  raw_size="$(wc -c < "$f" | tr -d ' ')"
  gzip_size="$(gzip -c "$f" | wc -c | tr -d ' ')"
  raw_human="$(awk "BEGIN{printf \"%.2fKB\", ${raw_size}/1024}")"
  gzip_human="$(awk "BEGIN{printf \"%.2fKB\", ${gzip_size}/1024}")"
  printf "%-50s %12s %12s\n" "$basename_f" "$raw_human" "$gzip_human"
done

echo ""

if [[ -z "$ENTRY_CHUNK" ]]; then
  echo "FAIL: Could not identify entry chunk in $DIST_DIR" >&2
  exit 1
fi

ENTRY_SIZE_HUMAN="$(awk "BEGIN{printf \"%.2fMB\", ${ENTRY_SIZE}/1048576}")"
BUDGET_HUMAN="$(awk "BEGIN{printf \"%.2fMB\", ${ENTRY_BUDGET_BYTES}/1048576}")"

echo "Entry chunk: ${ENTRY_CHUNK}"
echo "Entry size:  ${ENTRY_SIZE} bytes (${ENTRY_SIZE_HUMAN})"
echo "Budget:      ${ENTRY_BUDGET_BYTES} bytes (${BUDGET_HUMAN})"
echo ""

# --- Verdict ---
EXCEEDS_BUDGET=0
if [[ $ENTRY_SIZE -gt $ENTRY_BUDGET_BYTES ]]; then
  EXCEEDS_BUDGET=1
fi

if [[ $EXPECT_ISSUE -eq 1 ]]; then
  if [[ $EXCEEDS_BUDGET -eq 1 ]]; then
    echo "PASS (--expect-issue): Entry chunk exceeds budget as expected."
    exit 0
  else
    echo "FAIL (--expect-issue): Entry chunk is under budget — issue not reproduced."
    exit 1
  fi
else
  if [[ $EXCEEDS_BUDGET -eq 0 ]]; then
    echo "PASS: Entry chunk is within budget."
    exit 0
  else
    echo "FAIL: Entry chunk exceeds budget by $(awk "BEGIN{printf \"%.2fKB\", (${ENTRY_SIZE}-${ENTRY_BUDGET_BYTES})/1024}")."
    exit 1
  fi
fi
