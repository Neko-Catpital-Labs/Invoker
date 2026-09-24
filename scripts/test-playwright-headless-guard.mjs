#!/usr/bin/env node
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
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
const GUARD_LIB = 'scripts/lib/require-headless-display.sh';
const GUARDED_LAUNCHERS = [
  'scripts/test-suites/optional/40-playwright-app.sh',
  'scripts/test-suites/required/23-fix-intent-repros.sh',
  'scripts/test-suites/required/23d-same-workflow-tracked-fix-vs-recreate.sh',
];

const REQUIRED_TOOLS = ['bash', 'basename', 'dirname', 'mkdir', 'tr'];
const STUBBED_COMMANDS = ['pnpm', 'playwright', 'electron'];

function resolveTool(tool) {
  const found = spawnSync('sh', ['-c', `command -v -- ${tool}`], { encoding: 'utf8' });
  const resolved = (found.stdout ?? '').trim();
  if (found.status !== 0 || !resolved) {
    throw new Error(`test harness needs ${tool} on PATH, but could not resolve it`);
  }
  return resolved;
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

function writeDispatchStub(file, marker) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> "${marker}"\nexit 0\n`, 'utf8');
  chmodSync(file, 0o755);
}

function stageDisplaylessBinDir(fixture, marker) {
  const binDir = path.join(fixture, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const tool of REQUIRED_TOOLS) symlinkSync(resolveTool(tool), path.join(binDir, tool));
  for (const command of STUBBED_COMMANDS) writeDispatchStub(path.join(binDir, command), marker);
  return binDir;
}

function stageLauncherTree(fixture, rel, marker) {
  const root = path.join(fixture, 'repo');
  const copyFromRepo = (relPath) => {
    const dest = path.join(root, relPath);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(ROOT, relPath), dest);
    return dest;
  };
  copyFromRepo(GUARD_LIB);
  const launcher = copyFromRepo(rel);
  const downstream = new Set(
    readFileSync(launcher, 'utf8').match(/scripts\/repro\/[A-Za-z0-9._/-]+\.sh/g) ?? [],
  );
  for (const dep of downstream) writeDispatchStub(path.join(root, dep), marker);
  return { root, launcher };
}

function runLauncherWithoutXvfb(rel, env) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'pw-headless-guard-'));
  const marker = path.join(fixture, 'dispatched');
  const binDir = stageDisplaylessBinDir(fixture, marker);
  const { root, launcher } = stageLauncherTree(fixture, rel, marker);
  const childEnv = {
    ...process.env,
    PATH: binDir,
    DISPLAY: '',
    INVOKER_ALLOW_HEADED_E2E: '',
    GITHUB_EVENT_NAME: '',
    GITHUB_HEAD_REF: '',
    INVOKER_PLAYWRIGHT_RUN_LABEL: 'headless-guard-probe',
    INVOKER_PLAYWRIGHT_FILES: 'e2e/keyboard-navigation.spec.ts',
    ...env,
  };
  const result = spawnSync('bash', [launcher], { cwd: root, encoding: 'utf8', env: childEnv });
  return {
    fixturePath: childEnv.PATH,
    status: result.status,
    stderr: result.stderr ?? '',
    dispatched: existsSync(marker),
    dispatchArgs: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '',
  };
}

const failures = [];

for (const rel of GUARDED_LAUNCHERS) {
  const blocked = runLauncherWithoutXvfb(rel, {});

  const leakedXvfbRun = findXvfbRunOn(blocked.fixturePath);
  if (leakedXvfbRun) {
    failures.push(
      `fixture PATH for ${rel} still exposes xvfb-run (${leakedXvfbRun}); the no-xvfb case is not being tested`,
    );
  }
  if (blocked.dispatched) {
    failures.push(
      `${rel} dispatched its downstream command without a virtual display (headed windows): ${blocked.dispatchArgs}`,
    );
  }
  if (blocked.status === 0) {
    failures.push(`${rel} exited 0 without a virtual display; expected a non-zero refusal`);
  }
  if (!/INVOKER_ALLOW_HEADED_E2E/.test(blocked.stderr)) {
    failures.push(
      `${rel} refusal message does not name the INVOKER_ALLOW_HEADED_E2E=1 headed-mode opt-in`,
    );
  }

  const optedIn = runLauncherWithoutXvfb(rel, { INVOKER_ALLOW_HEADED_E2E: '1' });
  if (!optedIn.dispatched) {
    failures.push(
      `${rel} dispatched nothing under the explicit INVOKER_ALLOW_HEADED_E2E=1 headed-mode opt-in (exit ${optedIn.status}): ${optedIn.stderr.trim()}`,
    );
  }
}

for (const rel of GUARDED_LAUNCHERS) {
  const body = readFileSync(path.join(ROOT, rel), 'utf8');
  if (!body.includes(GUARD_LIB)) {
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
console.log(
  `PASS test-playwright-headless-guard (${GUARDED_LAUNCHERS.length} launchers x 5 behavioral + 2 structural assertions)`,
);
