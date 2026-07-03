#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SURFACE_TS="$ROOT/packages/surfaces/src/surface.ts"

if node - "$SURFACE_TS" <<'NODE'
const fs = require('node:fs');
const sourcePath = process.argv[2];
const source = fs.readFileSync(sourcePath, 'utf8');
const match = source.match(/export interface WorkflowGatePolicyOp \{(?<body>[\s\S]*?)\n\}/);

if (!match?.groups?.body) {
  console.error('FAIL: WorkflowGatePolicyOp interface was not found');
  process.exit(2);
}

const body = match.groups.body;
if (/ownerTaskId\?\s*:\s*string\b/.test(body)) {
  console.error('FAIL: WorkflowGatePolicyOp still accepts payloads without ownerTaskId');
  process.exit(1);
}

if (!/ownerTaskId\s*:\s*string\b/.test(body)) {
  console.error('FAIL: WorkflowGatePolicyOp does not declare a required ownerTaskId string');
  process.exit(2);
}

console.log('PASS: WorkflowGatePolicyOp requires ownerTaskId for routing');
NODE
then
  exit 0
else
  exit $?
fi
