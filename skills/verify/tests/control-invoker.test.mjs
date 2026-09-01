import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { resolveProve } from '../lib/prove.mjs';
import { runCatalogCheck, REQUIRED_SIDEBAR_TESTIDS } from '../lib/catalog.mjs';
import { runOwner } from '../lib/owner.mjs';
import { resolveRepoRoot, featuresDir } from '../lib/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRoot(__dirname);
const cli = join(repoRoot, 'skills/verify/control-invoker.mjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

// 1) prove --dry-run maps command-palette to the real Playwright spec
{
  const resolved = resolveProve(featuresDir(repoRoot), 'command-palette');
  assert(resolved.ok, `resolveProve failed: ${resolved.error}`);
  assert(
    resolved.command.includes('command-palette-open.spec.ts'),
    `expected command-palette spec, got: ${resolved.command}`,
  );
  const dry = runCli(['prove', 'command-palette', '--dry-run', '--json']);
  assert(dry.status === 0, `prove dry-run failed: ${dry.stderr}`);
  const payload = JSON.parse(dry.stdout);
  assert(payload.command.includes('command-palette-open.spec.ts'), 'CLI dry-run missing spec path');
  console.log('OK prove dry-run maps command-palette');
}

// 2) catalog --check fails when a required sidebar testid is missing
{
  const tmp = mkdtempSync(join(tmpdir(), 'invoker-verify-catalog-'));
  const featuresRoot = join(tmp, 'features');
  mkdirSync(featuresRoot);
  writeFileSync(
    join(featuresRoot, 'incomplete.md'),
    `---
id: incomplete
prove: test -f package.json
testids:
  - app-sidebar
---

# incomplete

## Sub-features

x

## How to get to it (user POV)

x

## Driving it with control-invoker

x

## Gotchas

x
`,
  );
  const result = runCatalogCheck({ featuresRoot, repoRoot });
  assert(!result.ok, 'expected catalog check to fail on incomplete map');
  const missing = REQUIRED_SIDEBAR_TESTIDS.filter((id) => id !== 'app-sidebar');
  for (const id of missing) {
    assert(
      result.errors.some((e) => e.includes(id)),
      `expected error mentioning ${id}, got: ${result.errors.join('; ')}`,
    );
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log('OK catalog --check fails when sidebar testids missing');
}

// 3) owner destructive --dry-run does not hit the API (ran: false)
{
  const result = runOwner({
    repoRoot,
    args: ['cancel', 'fake-task'],
    dryRun: true,
  });
  assert(result.ok, 'dry-run cancel should ok');
  assert(result.dryRun === true, 'expected dryRun');
  assert(result.ran === false, 'destructive dry-run must not run');
  assert(result.destructive === true, 'expected destructive flag');
  const cliResult = runCli(['owner', 'cancel', 'fake-task', '--dry-run', '--json']);
  assert(cliResult.status === 0, `owner dry-run failed: ${cliResult.stderr}`);
  const payload = JSON.parse(cliResult.stdout);
  assert(payload.ran === false, 'CLI owner dry-run must set ran:false');
  console.log('OK owner destructive --dry-run does not hit API');
}

// 4) real catalog --check passes on the committed feature map
{
  const check = runCli(['catalog', '--check', '--json']);
  assert(check.status === 0, `catalog --check failed: ${check.stderr}\n${check.stdout}`);
  const payload = JSON.parse(check.stdout);
  assert(payload.ok === true, 'catalog payload not ok');
  console.log('OK catalog --check on committed feature map');
}

console.log('OK: control-invoker unit tests passed');
