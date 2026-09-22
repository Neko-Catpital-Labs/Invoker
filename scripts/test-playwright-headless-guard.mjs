#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'test-suites', 'optional', '40-playwright-app.sh');

function runWithoutXvfb(env) {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'pw-headless-guard-'));
  const marker = path.join(stubDir, 'pnpm-invoked');
  const pnpmStub = path.join(stubDir, 'pnpm');
  writeFileSync(pnpmStub, `#!/bin/sh\necho "$@" > "${marker}"\nexit 0\n`, 'utf8');
  chmodSync(pnpmStub, 0o755);
  const result = spawnSync('bash', [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      INVOKER_PLAYWRIGHT_RUN_LABEL: 'headless-guard-probe',
      INVOKER_PLAYWRIGHT_FILES: 'e2e/keyboard-navigation.spec.ts',
      ...env,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    playwrightLaunched: existsSync(marker),
    launchArgs: existsSync(marker) ? readFileSync(marker, 'utf8') : '',
  };
}

const failures = [];

const blocked = runWithoutXvfb({});
if (blocked.playwrightLaunched) {
  failures.push(
    `no-xvfb run launched Playwright anyway (headed windows): ${blocked.launchArgs.trim()}`,
  );
}
if (blocked.status === 0) {
  failures.push(`no-xvfb run exited 0; expected a non-zero refusal`);
}
if (!/INVOKER_ALLOW_HEADED_E2E/.test(blocked.stderr)) {
  failures.push(`refusal message does not name the INVOKER_ALLOW_HEADED_E2E opt-out`);
}

const optedIn = runWithoutXvfb({ INVOKER_ALLOW_HEADED_E2E: '1' });
if (!optedIn.playwrightLaunched) {
  failures.push(`explicit INVOKER_ALLOW_HEADED_E2E=1 opt-in was still blocked`);
}

const GUARDED_LAUNCHERS = [
  'scripts/test-suites/optional/40-playwright-app.sh',
  'scripts/test-suites/required/23-fix-intent-repros.sh',
  'scripts/test-suites/required/23d-same-workflow-tracked-fix-vs-recreate.sh',
];
for (const rel of GUARDED_LAUNCHERS) {
  const body = readFileSync(path.join(ROOT, rel), 'utf8');
  if (!body.includes('scripts/lib/require-headless-display.sh')) {
    failures.push(`${rel} does not source the shared headless-display guard`);
  }
  if (!body.includes('invoker_require_headless_display')) {
    failures.push(`${rel} does not call invoker_require_headless_display`);
  }
}

if (failures.length > 0) {
  console.error('FAIL test-playwright-headless-guard');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS test-playwright-headless-guard (3 behavioral + ${GUARDED_LAUNCHERS.length * 2} launcher assertions)`);
