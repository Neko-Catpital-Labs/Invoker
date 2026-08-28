#!/usr/bin/env node
//
// Guardrail: every @invoker/* runtime dependency of packages/app whose
// package.json main/exports points at raw, unbuilt TypeScript source must
// either be bundled via tsup.config.ts's noExternal (exactly once), or be
// explicitly listed in KNOWN_SAFE_EXTERNAL below with a reason.
//
// Regression (2026-08-13): @invoker/slack-bug-scan has main: "src/index.ts"
// (never compiled to a dist). Left external, at runtime Node's ESM loader
// tries to resolve that raw .ts file's own relative imports directly and
// crashes packages/app/dist/main.js on load -- silently, since Electron's
// headless entrypoint never exits after the crash, it just hangs until an
// external caller's timeout kills it. See scripts/test-suites/required/
// 09-headless-cli-boots-smoke.sh for the functional repro of that crash.
//
// This package was independently added to and removed from noExternal
// across three separate automated CI-regression fixes (#8986, #8989, #9002)
// before anyone noticed, because none of them checked for an existing entry
// or a build-time invariant -- the array ended up with a duplicate. This
// check exists so the next such fix has one place to check first, instead
// of another blind text edit.

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const packageRoot = join(__dirname, '..');

// Packages intentionally left external with a documented reason. Adding an
// entry here is a deliberate decision, not a silent gap -- keep it short and
// specific.
const KNOWN_SAFE_EXTERNAL = {
  '@invoker/cli': 'never imported into the bundle; spawned as a separate subprocess via packages/app/src/cli-helper.ts, pointing at its own independently-built dist',
};

// Compiled dist is not enough for these: electron-builder's asar omits pnpm-nested
// deps (npm 0.0.13 owner-serve died on `Cannot find module 'form-data'` while
// loading @invoker/surfaces → @slack/bolt → axios). Bundle them into dist/main.js.
const MUST_BUNDLE_EVEN_IF_COMPILED = {
  '@invoker/surfaces': 'dynamically imported by in-app-planner; nested @slack/bolt dep form-data is omitted from the packaged asar unless this package is in noExternal',
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
const noExternalEntries = [...noExternalMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
const noExternal = new Set(noExternalEntries);

const failures = [];

const entryCounts = new Map();
for (const entry of noExternalEntries) {
  entryCounts.set(entry, (entryCounts.get(entry) ?? 0) + 1);
}
for (const [entry, count] of entryCounts) {
  if (count > 1) {
    failures.push(
      `${entry}: listed ${count} times in packages/app/tsup.config.ts's noExternal array. Harmless to `
      + `tsup itself, but a duplicate entry is a sign two separate fixes both added it without checking `
      + `for an existing one -- remove the repeat.`,
    );
  }
}

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
    if (name in MUST_BUNDLE_EVEN_IF_COMPILED && !noExternal.has(name)) {
      failures.push(
        `${name}: ${MUST_BUNDLE_EVEN_IF_COMPILED[name]} Add it to packages/app/tsup.config.ts's noExternal.`,
      );
    }
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

if (!noExternal.has('@slack/bolt')) {
  failures.push(
    '@slack/bolt: required in noExternal; @invoker/surfaces loads it and the packaged asar omits nested form-data',
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
