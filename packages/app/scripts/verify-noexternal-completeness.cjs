#!/usr/bin/env node
//
// Guardrail: every @invoker/* runtime dependency of packages/app whose
// package.json main/exports points at raw, unbuilt TypeScript source must
// either be bundled via tsup.config.ts's noExternal, or be explicitly
// listed in KNOWN_SAFE_EXTERNAL below with a reason.
//
// Regression (2026-08-13): @invoker/slack-bug-scan has main: "src/index.ts"
// (never compiled to a dist) and was left off noExternal by omission, not
// by decision. tsup left it external, so at runtime Node's ESM loader tried
// to resolve that raw .ts file's own relative imports directly and crashed
// packages/app/dist/main.js on load -- silently, since Electron's headless
// entrypoint never exited after the crash, it just hung until an external
// caller's timeout killed it. See scripts/test-suites/required/
// 09-headless-cli-boots-smoke.sh for the functional repro of that crash.
//
// This check exists so the NEXT such package is a deliberate exception
// entry, not another silent omission.

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const packageRoot = join(__dirname, '..');

// Packages intentionally left external with a documented reason. Adding an
// entry here is a deliberate decision, not a silent gap -- keep it short and
// specific.
const KNOWN_SAFE_EXTERNAL = {
  '@invoker/cli': 'never imported into the bundle; spawned as a separate subprocess via packages/app/src/cli-helper.ts, pointing at its own independently-built dist',
  '@invoker/surfaces': 'has a real compiled dist (main: dist/index.js); packaged separately into app-build-dist.tgz, see scripts/test-suites/required/08-build-artifact-surfaces-guard.sh',
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const appPackageJson = readJson(join(packageRoot, 'package.json'));
const dependencies = Object.keys(appPackageJson.dependencies ?? {}).filter((name) => name.startsWith('@invoker/'));

const tsupConfigSource = readFileSync(join(packageRoot, 'tsup.config.ts'), 'utf-8');
const noExternalMatch = tsupConfigSource.match(/noExternal:\s*\[([\s\S]*?)\]/);
if (!noExternalMatch) {
  console.error('FAIL: could not find a noExternal: [...] array in packages/app/tsup.config.ts');
  process.exit(1);
}
const noExternal = new Set([...noExternalMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));

const failures = [];

for (const name of dependencies) {
  const pkgJsonPath = join(packageRoot, 'node_modules', name, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    failures.push(`${name}: no packages/app/node_modules/${name}/package.json (run pnpm install?)`);
    continue;
  }

  const depPackageJson = readJson(pkgJsonPath);
  const mainEntry = depPackageJson.main ?? '';
  const isRawTypeScript = /\.tsx?$/.test(mainEntry) && !mainEntry.startsWith('dist/');

  if (!isRawTypeScript) {
    continue; // has a real compiled entry point; safe to leave external either way
  }

  if (noExternal.has(name)) {
    continue; // bundled; safe
  }

  if (name in KNOWN_SAFE_EXTERNAL) {
    continue; // deliberate, documented exception
  }

  failures.push(
    `${name}: main is unbuilt TypeScript source ("${mainEntry}") but the package is neither in `
    + `packages/app/tsup.config.ts's noExternal nor in KNOWN_SAFE_EXTERNAL in this script. Left as-is, `
    + `it will crash packages/app/dist/main.js at runtime the moment any code path touches it -- add it `
    + `to noExternal (bundle it), or to KNOWN_SAFE_EXTERNAL with a reason if it's genuinely never `
    + `imported into the bundle (e.g. spawned as a subprocess like @invoker/cli).`,
  );
}

if (failures.length > 0) {
  console.error('FAIL: packages/app has @invoker/* dependencies unsafe to leave external:\n');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`PASS: all ${dependencies.length} @invoker/* dependencies of packages/app are either bundled, compiled, or a documented exception`);
