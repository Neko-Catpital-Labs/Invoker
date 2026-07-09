#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] problem: serializeWorkerAction forwarded unknown payload values that can break JSON output"
if pnpm --filter @invoker/app exec vitest run src/__tests__/formatter.test.ts -t "normalizes unsafe payload values before JSON output" --reporter=verbose; then
  echo "[repro] PASS: worker action payloads are normalized before JSON formatting"
  exit 0
fi

echo "[repro] FAIL: worker action payload still breaks JSON formatting"
exit 1
