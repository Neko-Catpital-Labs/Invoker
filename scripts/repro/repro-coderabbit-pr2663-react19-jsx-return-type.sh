#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[repro] Running PR #2663 React 19 JSX namespace regression."

if node - "$repo_root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const files = [
  'packages/ui/src/components/InvokerTerminal.tsx',
  'packages/ui/src/components/LeftStatusColumn.tsx',
];
let failed = false;
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (/:\s*JSX\.Element\b/.test(text)) {
    console.error(`${file} still uses bare JSX.Element`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
NODE
then
  echo "[repro] PASS: reviewed components no longer use bare JSX.Element return types."
else
  status=$?
  echo "[repro] FAIL: React 19 does not expose global JSX.Element for these component return types."
  exit "$status"
fi
