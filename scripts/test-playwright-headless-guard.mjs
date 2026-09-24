#!/usr/bin/env node
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  symlinkSync,
  accessSync,
  constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'test-suites', 'optional', '40-playwright-app.sh');

const REQUIRED_TOOLS = ['bash', 'basename', 'dirname', 'mkdir', 'tr'];

function resolveTool(tool) {
  const found = spawnSync('sh', ['-c', `command -v -- ${tool}`], { encoding: 'utf8' });
  const resolved = (found.stdout ?? '').trim();
  if (found.status !== 0 || !resolved) {
    throw new Error(`test harness needs ${tool} on PATH, but could not resolve it`);
  }
  return resolved;
}

function makeDisplaylessBinDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-headless-guard-'));
  for (const tool of REQUIRED_TOOLS) symlinkSync(resolveTool(tool), path.join(dir, tool));
  return dir;
}

function findXvfbRunOn(pathValue) {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'xvfb-run');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function runWithoutXvfb(env) {
  const binDir = makeDisplaylessBinDir();
  const marker = path.join(binDir, 'pnpm-invoked');
  const pnpmStub = path.join(binDir, 'pnpm');
  writeFileSync(pnpmStub, `#!/bin/sh\necho "$@" > "${marker}"\nexit 0\n`, 'utf8');
  chmodSync(pnpmStub, 0o755);
  const childEnv = {
    ...process.env,
    PATH: binDir,
    INVOKER_ALLOW_HEADED_E2E: '',
    INVOKER_PLAYWRIGHT_RUN_LABEL: 'headless-guard-probe',
    INVOKER_PLAYWRIGHT_FILES: 'e2e/keyboard-navigation.spec.ts',
    ...env,
  };
  const result = spawnSync('bash', [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: childEnv });
  return {
    fixturePath: childEnv.PATH,
    status: result.status,
    stderr: result.stderr ?? '',
    playwrightLaunched: existsSync(marker),
    launchArgs: existsSync(marker) ? readFileSync(marker, 'utf8') : '',
  };
}

const failures = [];

const blocked = runWithoutXvfb({});

const leakedXvfbRun = findXvfbRunOn(blocked.fixturePath);
if (leakedXvfbRun) {
  failures.push(
    `fixture PATH still exposes xvfb-run (${leakedXvfbRun}); the no-xvfb case is not being tested`,
  );
}

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
console.log(`PASS test-playwright-headless-guard (4 behavioral + ${GUARDED_LAUNCHERS.length * 2} launcher assertions)`);
