#!/usr/bin/env bash
# Repro: CodeRabbit PR #3476 — daily e2e status checkout must not persist
# GITHUB_TOKEN credentials into .git/config. The workflow only needs repository
# reads from checkout; issue writes go through actions/github-script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/daily-e2e-status.yml"

if awk '
  function close_checkout() {
    if (!in_checkout) {
      return
    }
    found = 1
    if (uses_checkout && persist_false) {
      ok = 1
    } else if (!uses_checkout) {
      fail = "Checkout step does not use actions/checkout@v4."
    } else {
      fail = "Checkout step persists GitHub credentials; set persist-credentials: false."
    }
    in_checkout = 0
    uses_checkout = 0
    persist_false = 0
  }

  /^      - name:/ {
    close_checkout()
    if ($0 == "      - name: Checkout") {
      in_checkout = 1
    }
    next
  }

  in_checkout && /^[[:space:]]*uses:[[:space:]]*actions\/checkout@v4[[:space:]]*$/ {
    uses_checkout = 1
  }

  in_checkout && /^[[:space:]]*persist-credentials:[[:space:]]*false[[:space:]]*$/ {
    persist_false = 1
  }

  END {
    close_checkout()
    if (!found) {
      fail = "workflow has no Checkout step."
    }
    if (fail) {
      print "[repro] FAIL: " fail > "/dev/stderr"
      exit 1
    }
    if (!ok) {
      print "[repro] FAIL: Checkout step missing credential persistence guard." > "/dev/stderr"
      exit 1
    }
  }
' "$WORKFLOW"; then
  echo "[repro] PASS: daily e2e checkout disables persisted GitHub credentials."
  exit 0
fi

exit 1
