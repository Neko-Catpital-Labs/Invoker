import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type AppPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

interface InvokerImport {
  specifier: string;
  typeOnly: boolean;
}

const require = createRequire(import.meta.url);
const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(currentDir, '..', '..');
const mainSourcePath = join(packageRoot, 'src', 'main.ts');
const packageJsonPath = join(packageRoot, 'package.json');

const mainSource = readFileSync(mainSourcePath, 'utf-8');
const appPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as AppPackageJson;

function collectInvokerImports(sourceCode: string): InvokerImport[] {
  const invokerImportPattern = /from\s+['"](@invoker\/[^'"]+)['"]/g;
  const imports = new Map<string, InvokerImport>();

  for (const match of sourceCode.matchAll(invokerImportPattern)) {
    const specifier = match[1];
    if (specifier) {
      const lineStart = sourceCode.lastIndexOf('\n', match.index) + 1;
      const importPrefix = sourceCode.slice(lineStart, match.index);
      const typeOnly = /^\s*import\s+type\b/.test(importPrefix);
      const existing = imports.get(specifier);
      imports.set(specifier, {
        specifier,
        typeOnly: (existing?.typeOnly ?? true) && typeOnly,
      });
    }
  }

  return [...imports.values()].sort((a, b) => a.specifier.localeCompare(b.specifier));
}

/** package.json declares the package (`@invoker/cli`), never a subpath export (`@invoker/cli/bundled-skills`). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return parts.slice(0, 2).join('/');
}

describe('workspace import resolution', () => {
  const invokerImports = collectInvokerImports(mainSource);
  const declaredDependencies = new Set([
    ...Object.keys(appPackageJson.dependencies ?? {}),
    ...Object.keys(appPackageJson.devDependencies ?? {}),
  ]);

  it('tracks invoker imports in src/main.ts', () => {
    expect(invokerImports.length).toBeGreaterThan(0);
  });

  it('declares every @invoker/* import in package.json', () => {
    for (const { specifier } of invokerImports) {
      const packageName = packageNameOf(specifier);
      expect(declaredDependencies.has(packageName), `Missing dependency declaration for ${packageName} (imported as ${specifier})`).toBe(true);
    }
  });

  it('resolves every runtime @invoker/* import from package root', () => {
    for (const { specifier, typeOnly } of invokerImports) {
      if (typeOnly) continue;
      expect(
        () => require.resolve(specifier, { paths: [packageRoot] }),
        `Unresolvable workspace dependency: ${specifier}. Run pnpm install to refresh workspace links.`,
      ).not.toThrow();
    }
  });
});
