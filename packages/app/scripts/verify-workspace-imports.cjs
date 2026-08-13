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
const typeOnlyImports = new Map();

for (const match of mainSource.matchAll(invokerImportPattern)) {
  if (match[1]) {
    imports.add(match[1]);
    const lineStart = mainSource.lastIndexOf('\n', match.index) + 1;
    const importPrefix = mainSource.slice(lineStart, match.index);
    const typeOnly = /^\s*import\s+type\b/.test(importPrefix);
    typeOnlyImports.set(match[1], (typeOnlyImports.get(match[1]) ?? true) && typeOnly);
  }
}

for (const specifier of imports) {
  const [scope, name] = specifier.split('/');
  const packageName = `${scope}/${name}`;
  if (!declaredDependencies.has(packageName)) {
    throw new Error(`Missing package.json dependency for ${packageName} imported in src/main.ts`);
  }

  if (!typeOnlyImports.get(specifier)) {
    try {
      requireFromScript.resolve(specifier, { paths: [packageRoot] });
    } catch {
      throw new Error(
        `Unresolvable workspace dependency ${specifier}. Run "pnpm install" at repo root to refresh workspace links.`,
      );
    }
  }
}
