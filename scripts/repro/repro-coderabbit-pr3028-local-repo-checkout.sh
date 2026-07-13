#!/usr/bin/env bash
# Repro: CodeRabbit PR #3028 (Data Integrity, Major) — `[repo:foo] exec local:` must
# run inside the resolved repo checkout. Before the fix, the raw-command path returned
# before the repo checkout prep and `runLocalCommand()` fell back to `this.workingDir`/
# `process.cwd()`, so a repo-tagged command ran against the wrong checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] problem: '[repo:foo] exec local:' ignored the resolved repo checkout"
if pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-surface-workflows.test.ts \
  -t "resolved repo checkout" --reporter=verbose; then
  echo "[repro] PASS: raw local commands run in the resolved repo checkout dir"
  exit 0
fi

echo "[repro] FAIL: raw local command still runs against the default working dir"
exit 1
