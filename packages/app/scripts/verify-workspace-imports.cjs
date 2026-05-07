#!/usr/bin/env node

const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const requireFromScript = createRequire(__filename);
const packageRoot = join(__dirname, '..');
const mainSourcePath = join(packageRoot, 'src', 'main.ts');
const packageJsonPath = join(packageRoot, 'package.json');

const mainSource = readFileSync(mainSourcePath, 'utf-8');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const declaredDependencies = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);

const invokerImportPattern = /from\s+['"](@invoker\/[^'"]+)['"]/g;
const imports = new Set();

for (const match of mainSource.matchAll(invokerImportPattern)) {
  if (match[1]) {
    imports.add(match[1]);
  }
}

for (const specifier of imports) {
  if (!declaredDependencies.has(specifier)) {
    throw new Error(`Missing package.json dependency for ${specifier} imported in src/main.ts`);
  }

  try {
    requireFromScript.resolve(specifier, { paths: [packageRoot] });
  } catch {
    throw new Error(
      `Unresolvable workspace dependency ${specifier}. Run "pnpm install" at repo root to refresh workspace links.`,
    );
  }
}
