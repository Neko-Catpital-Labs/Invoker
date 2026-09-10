#!/usr/bin/env bash
# Fails while stacked-chain submission reaches a checkout-local headless process
# instead of the live Invoker owner.
set -uo pipefail

fail() { echo "REPRO FAIL: $*" >&2; exit 1; }

if ! command -v invoker-cli >/dev/null 2>&1; then
  echo "UNCHECKED: invoker-cli not on PATH; cannot compare against the live owner." >&2
  exit 3
fi

if ! invoker-cli query workflows --output json >/dev/null 2>&1; then
  echo "UNCHECKED: no live owner responding; this repro compares against one." >&2
  exit 3
fi

target="scripts/submit-workflow-chain.sh"
if [ ! -f "$target" ]; then
  echo "PASS: $target is gone; submission no longer goes through a checkout-local path."
  exit 0
fi

hits=$(grep -c '\./run\.sh --headless' "$target" || true)
if [ "$hits" -gt 0 ]; then
  echo "REPRO HIT: $target reaches Invoker through ./run.sh --headless at $hits call site(s)." >&2
  grep -n '\./run\.sh --headless' "$target" >&2
  echo "The live owner is reached with invoker-cli; a checkout-local headless process writes" >&2
  echo "the database directly and the running owner never sees the workflow." >&2
  exit 1
fi

echo "PASS: $target no longer shells to ./run.sh --headless."
