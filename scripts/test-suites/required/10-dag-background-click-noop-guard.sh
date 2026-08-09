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
const ts = require('typescript');

const filePath = path.join('packages', 'ui', 'src', 'App.tsx');
const src = fs.readFileSync(filePath, 'utf8');
const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findHandleDagSurfaceClick(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handleDagSurfaceClick') {
    return node.initializer;
  }

  return ts.forEachChild(node, findHandleDagSurfaceClick);
}

function unwrapExpression(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function expressionMatches(node, expectedKind) {
  return unwrapExpression(node).kind === expectedKind;
}

function calleeName(node) {
  const expression = unwrapExpression(node.expression);
  return ts.isIdentifier(expression) ? expression.text : null;
}

const handleDagSurfaceClick = findHandleDagSurfaceClick(sourceFile);
if (!handleDagSurfaceClick) {
  console.error(`FAIL: could not find "handleDagSurfaceClick" in ${filePath}`);
  process.exit(1);
}

if (!ts.isCallExpression(handleDagSurfaceClick) || calleeName(handleDagSurfaceClick) !== 'useCallback') {
  console.error('FAIL: handleDagSurfaceClick is not initialized with useCallback(...)');
  process.exit(1);
}

const forbidden = new Map([
  ['setSelectedTaskId', ts.SyntaxKind.NullKeyword],
  ['setSelectedWorkflowId', ts.SyntaxKind.NullKeyword],
  ['setWorkflowSelectionDismissed', ts.SyntaxKind.TrueKeyword],
]);
const found = [];

function inspect(node) {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    const expectedArgumentKind = forbidden.get(name);
    if (
      expectedArgumentKind !== undefined &&
      node.arguments.length > 0 &&
      expressionMatches(node.arguments[0], expectedArgumentKind)
    ) {
      found.push(node.getText(sourceFile));
    }
  }

  ts.forEachChild(node, inspect);
}

inspect(handleDagSurfaceClick.arguments[0] ?? handleDagSurfaceClick);

if (found.length > 0) {
  console.error('FAIL: handleDagSurfaceClick must be a no-op on background click (closing an open context menu excluded).');
  console.error(`Found forbidden call(s): ${found.join(', ')}`);
  console.error('This exact regression shipped before (#5067, silently reverting #4982) and was re-fixed by #7222.');
  console.error('If background click should clear selection again, that is an explicit product decision: update this guard deliberately, do not delete it.');
  process.exit(1);
}

console.log('PASS: handleDagSurfaceClick has no forbidden selection-clearing calls');
EOF
