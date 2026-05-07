import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type AppPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const require = createRequire(import.meta.url);
const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(currentDir, '..', '..');
const mainSourcePath = join(packageRoot, 'src', 'main.ts');
const packageJsonPath = join(packageRoot, 'package.json');

const mainSource = readFileSync(mainSourcePath, 'utf-8');
const appPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as AppPackageJson;

function collectInvokerImports(sourceCode: string): string[] {
  const invokerImportPattern = /from\s+['"](@invoker\/[^'"]+)['"]/g;
  const imports = new Set<string>();

  for (const match of sourceCode.matchAll(invokerImportPattern)) {
    const specifier = match[1];
    if (specifier) {
      imports.add(specifier);
    }
  }

  return [...imports].sort();
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
    for (const specifier of invokerImports) {
      expect(declaredDependencies.has(specifier), `Missing dependency declaration for ${specifier}`).toBe(true);
    }
  });

  it('resolves every @invoker/* import from package root', () => {
    for (const specifier of invokerImports) {
      expect(
        () => require.resolve(specifier, { paths: [packageRoot] }),
        `Unresolvable workspace dependency: ${specifier}. Run pnpm install to refresh workspace links.`,
      ).not.toThrow();
    }
  });
});
