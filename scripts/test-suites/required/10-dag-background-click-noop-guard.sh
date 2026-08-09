#!/usr/bin/env bash
# Guardrail: clicking the workflow graph's empty background must stay a no-op
# for task/workflow selection. This behavior shipped (#4982), was silently
# reverted by an unrelated PR that also flipped the one e2e assertion covering
# it so CI stayed green through the regression (#5067), and was re-fixed
# (#7222/#7223). This checks the literal handler source, independent of any
# e2e test, so a reintroduced clear-on-click call fails loudly and immediately
# instead of depending on a Playwright assertion nobody notices got flipped.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

node - <<'EOF'
const fs = require('fs');
const path = require('path');

const filePath = path.join('packages', 'ui', 'src', 'App.tsx');
const src = fs.readFileSync(filePath, 'utf8');

const startMarker = 'const handleDagSurfaceClick = useCallback(';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error(`FAIL: could not find "${startMarker}" in ${filePath}`);
  process.exit(1);
}

let depth = 0;
let end = -1;
for (let i = startIdx + startMarker.length - 1; i < src.length; i += 1) {
  const ch = src[i];
  if (ch === '(') depth += 1;
  else if (ch === ')') {
    depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
if (end === -1) {
  console.error('FAIL: could not find the end of the handleDagSurfaceClick useCallback(...) call');
  process.exit(1);
}

const body = src.slice(startIdx, end + 1);
const forbidden = ['setSelectedTaskId(null)', 'setSelectedWorkflowId(null)', 'setWorkflowSelectionDismissed(true)'];
const found = forbidden.filter((call) => body.includes(call));

if (found.length > 0) {
  console.error('FAIL: handleDagSurfaceClick must be a no-op on background click (closing an open context menu excluded).');
  console.error(`Found forbidden call(s): ${found.join(', ')}`);
  console.error('This exact regression shipped before (#5067, silently reverting #4982) and was re-fixed by #7222.');
  console.error('If background click should clear selection again, that is an explicit product decision: update this guard deliberately, do not delete it.');
  process.exit(1);
}

console.log('PASS: handleDagSurfaceClick has no forbidden selection-clearing calls');
EOF
