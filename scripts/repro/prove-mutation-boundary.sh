#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT_DIR"

mkdir -p "$TMP_DIR/packages/custom/src" "$TMP_DIR/packages/app/src"
cat > "$TMP_DIR/packages/custom/src/owner.ts" <<'TS'
export function ownerInternal(repo: { updateTask(id: string, patch: unknown): void }) {
  repo.updateTask('allowed-task', { status: 'pending' });
}
TS
cat > "$TMP_DIR/packages/app/src/bad.ts" <<'TS'
export function appBypass(orchestrator: { retryTask(id: string): void }) {
  orchestrator.retryTask('bad-task');
}
TS
cat > "$TMP_DIR/allowlist.json" <<'JSON'
[
  {
    "file": "packages/custom/src/owner.ts",
    "match": "\\brepo\\.updateTask\\s*\\(",
    "reason": "Fixture owner internal may write through its repository port."
  }
]
JSON

set +e
node scripts/check-mutation-boundary.mjs --root "$TMP_DIR" --allowlist "$TMP_DIR/allowlist.json" > "$TMP_DIR/fail.out" 2> "$TMP_DIR/fail.err"
FAIL_STATUS=$?
set -e
if [[ "$FAIL_STATUS" -eq 0 ]]; then
  echo "expected checker to fail on non-allowlisted app orchestrator mutation" >&2
  exit 1
fi
node --input-type=module - "$TMP_DIR/fail.err" <<'NODE'
import { readFileSync } from 'node:fs';
const err = readFileSync(process.argv[2], 'utf8');
if (!err.includes('packages/app/src/bad.ts:2')) throw new Error('failure did not report bad fixture file and line');
if (!err.includes('app-layer-orchestrator-mutation')) throw new Error('failure did not report orchestrator mutation check id');
if (!err.includes('orchestrator.retryTask(')) throw new Error('failure did not report matched pattern');
if (!err.includes('Allowlist format:')) throw new Error('failure did not include allowlist guidance');
if (err.includes('packages/custom/src/owner.ts')) throw new Error('allowlisted owner fixture should not be reported');
NODE

cat > "$TMP_DIR/allowlist.json" <<'JSON'
[
  {
    "file": "packages/custom/src/owner.ts",
    "match": "\\brepo\\.updateTask\\s*\\(",
    "reason": "Fixture owner internal may write through its repository port."
  },
  {
    "file": "packages/app/src/bad.ts",
    "match": "\\borchestrator\\.retryTask\\s*\\(",
    "reason": "Fixture-only migration seam used to prove allowlist pass behavior."
  }
]
JSON
node scripts/check-mutation-boundary.mjs --root "$TMP_DIR" --allowlist "$TMP_DIR/allowlist.json" > "$TMP_DIR/pass.out"
node --input-type=module - "$TMP_DIR/pass.out" <<'NODE'
import { readFileSync } from 'node:fs';
const out = readFileSync(process.argv[2], 'utf8');
if (!out.includes('mutation boundary check passed')) throw new Error('allowlisted fixture did not pass');
NODE

node scripts/check-mutation-boundary.mjs > "$TMP_DIR/real-repo.out"
node --input-type=module - "$TMP_DIR/real-repo.out" <<'NODE'
import { readFileSync } from 'node:fs';
const out = readFileSync(process.argv[2], 'utf8');
if (!out.includes('mutation boundary check passed')) throw new Error('real repo checker did not pass');
NODE

echo "mutation boundary proof passed"
