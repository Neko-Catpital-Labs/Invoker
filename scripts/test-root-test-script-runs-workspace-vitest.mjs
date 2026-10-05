#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const rootScriptTests = readFileSync(new URL('./run-root-script-tests.sh', import.meta.url), 'utf8');

for (const scriptName of ['test', 'test:high-resource']) {
  const command = rootPackage.scripts?.[scriptName];
  assert(typeof command === 'string', `package.json scripts.${scriptName} must be defined`);
  assert(
    command.includes('bash scripts/workspace-test.sh'),
    `package.json scripts.${scriptName} must run "bash scripts/workspace-test.sh" (which runs the `
      + 'required Vitest suite for every package via `pnpm -r test`), so a chain of one-off shell/node '
      + 'validators can never silently replace it',
  );
}

assert(
  !/\nnode scripts\/test-bundled-skill-categories\.mjs\b/.test(rootScriptTests),
  'run-root-script-tests.sh must not wire the bundled-skill category inventory directly; that docs-scope check forces skill markdown changes into tooling-policy PRs',
);
assert(
  rootScriptTests.includes('test-bundled-skill-categories.mjs'),
  'run-root-script-tests.sh must document the bundled-skill category inventory exclusion so the unwired-test scan does not pull it back in accidentally',
);

console.log('Root package.json test scripts still run the required workspace Vitest suite.');
