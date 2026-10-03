import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function newestSourceMtime(repoRoot, packageName) {
  const src = join(repoRoot, 'packages', packageName, 'src');
  if (!existsSync(src)) return null;
  const result = spawnSync('find', [src, '-type', 'f', '(', '-name', '*.ts', '-o', '-name', '*.tsx', ')'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  let newest = 0;
  for (const line of result.stdout.trim().split('\n')) {
    const m = fileMtimeMs(line);
    if (m != null && m > newest) newest = m;
  }
  return newest || null;
}

export function runDoctor(opts) {
  const { repoRoot, skipCliDoctor = false } = opts;
  const checks = [];
  let ok = true;

  const uiDist = join(repoRoot, 'packages/ui/dist/index.html');
  const appMain = join(repoRoot, 'packages/app/dist/main.js');
  const uiExists = existsSync(uiDist);
  const appExists = existsSync(appMain);
  checks.push({ name: 'ui-build', ok: uiExists, detail: uiExists ? uiDist : 'missing packages/ui/dist/index.html — run pnpm --filter @invoker/ui build' });
  checks.push({ name: 'app-build', ok: appExists, detail: appExists ? appMain : 'missing packages/app/dist/main.js — run pnpm --filter @invoker/app build' });
  if (!uiExists || !appExists) ok = false;

  if (uiExists) {
    const srcM = newestSourceMtime(repoRoot, 'ui');
    const distM = fileMtimeMs(uiDist);
    const stale = srcM != null && distM != null && srcM > distM + 1000;
    checks.push({
      name: 'ui-freshness',
      ok: !stale,
      detail: stale ? 'packages/ui/src is newer than dist — rebuild before proving UI' : 'ui dist is fresh enough',
    });
    if (stale) ok = false;
  }

  if (appExists) {
    const srcM = newestSourceMtime(repoRoot, 'app');
    const distM = fileMtimeMs(appMain);
    const stale = srcM != null && distM != null && srcM > distM + 1000;
    checks.push({
      name: 'app-freshness',
      ok: !stale,
      detail: stale ? 'packages/app/src is newer than dist — rebuild before proving UI' : 'app dist is fresh enough',
    });
    if (stale) ok = false;
  }

  const playwrightCli = join(repoRoot, 'packages/app/node_modules/@playwright/test/cli.js');
  const playwrightOk = existsSync(playwrightCli) || existsSync(join(repoRoot, 'node_modules/@playwright/test'));
  checks.push({
    name: 'playwright',
    ok: playwrightOk,
    detail: playwrightOk ? 'playwright package present' : 'missing @playwright/test — run pnpm install',
  });
  if (!playwrightOk) ok = false;

  const featuresRoot = join(repoRoot, 'skills/verify/references/features');
  const featuresOk = existsSync(featuresRoot);
  checks.push({
    name: 'feature-map',
    ok: featuresOk,
    detail: featuresOk ? featuresRoot : 'missing skills/verify/references/features',
  });
  if (!featuresOk) ok = false;

  if (!skipCliDoctor) {
    const doctor = spawnSync('invoker-cli', ['doctor', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    });
    const cliOk = doctor.status === 0;
    checks.push({
      name: 'invoker-cli-doctor',
      ok: cliOk,
      detail: cliOk
        ? (doctor.stdout.trim() || 'invoker-cli doctor passed')
        : (doctor.stderr.trim() || doctor.stdout.trim() || `invoker-cli doctor exited ${doctor.status}`),
    });
    if (!cliOk) ok = false;
  }

  return { ok, checks };
}
