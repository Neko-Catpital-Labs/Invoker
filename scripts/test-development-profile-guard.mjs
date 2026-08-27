#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const launcher = join(root, 'scripts', 'with-invoker-development-profile.mjs');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const appPackage = JSON.parse(readFileSync(join(root, 'packages', 'app', 'package.json'), 'utf8'));
const doors = [
  ['root:dev', rootPackage.scripts.dev],
  ['root:dev:hot', rootPackage.scripts['dev:hot']],
  ['root:dev:cli', rootPackage.scripts['dev:cli']],
  ['app:start', appPackage.scripts.start],
  ['app:dev', appPackage.scripts.dev],
];

const failures = [];
for (const [name, command] of doors) {
  if (!command.includes('with-invoker-development-profile.mjs')) failures.push(`${name} bypasses the shared launcher`);
}

function profileFor(sourceRoot) {
  const env = { ...process.env };
  delete env.INVOKER_DB_DIR;
  const result = spawnSync(process.execPath, [launcher, '--source-root', sourceRoot, '--print-env'], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) failures.push(`profile dry-run failed for ${sourceRoot}: ${result.stderr.trim()}`);
  return result.status === 0 ? JSON.parse(result.stdout) : {};
}

const first = profileFor(root);
const second = profileFor(resolve(root, '..'));
const productionHome = join(homedir(), '.invoker');
for (const key of ['INVOKER_DB_DIR', 'INVOKER_USER_DATA_DIR', 'INVOKER_IPC_SOCKET', 'INVOKER_REPO_CONFIG_PATH', 'INVOKER_ENV_PATH', 'INVOKER_LOG_PATH']) {
  if (!first[key] || first[key] === productionHome || !first[key].startsWith(`${productionHome}/dev/`)) {
    failures.push(`${key} is missing or not contained by the isolated development namespace`);
  }
}
if (first.INVOKER_PROFILE_ID === second.INVOKER_PROFILE_ID) failures.push('distinct source roots share one profile id');
if (first.INVOKER_API_PORT === '4100' || first.INVOKER_WEB_PORT === '4200') failures.push('development uses a production port');
if (first.INVOKER_DISABLE_AUTONOMOUS_WORKERS !== '1' || first.INVOKER_DISABLE_AUTO_RUN_ON_STARTUP !== '1') failures.push('development safety defaults are not enabled');

const collision = spawnSync(process.execPath, [launcher, '--print-env'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, INVOKER_DB_DIR: productionHome },
});
if (collision.status === 0 || !collision.stderr.includes('production profile')) failures.push('production collision did not fail closed');

const exception = spawnSync(process.execPath, [launcher, '--production-owner-service', '--print-env'], { cwd: root, encoding: 'utf8' });
if (exception.status !== 0 || JSON.parse(exception.stdout).INVOKER_PRODUCTION_OWNER_SERVICE !== '1') failures.push('exact production-owner service exception dry-run failed');

const rejectedException = spawnSync(process.execPath, [launcher, '--production-owner-service', '--', 'invoker-cli', 'query', 'workflows'], { cwd: root, encoding: 'utf8' });
if (rejectedException.status === 0) failures.push('production exception accepted a non-owner command');

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`PASS: ${doors.length}/${doors.length} developer launchers use isolated worktree profiles; production collisions and broad exceptions are rejected\n`);
