#!/usr/bin/env node
// Checked-in registry of known-flaky quarantine targets. Each entry is either
// a vitest test-file glob (kind: 'vitest-file', the default) or a
// scripts/test-suites/**.sh relpath (kind: 'suite').
// CI reads this via computeVitestExcludeArgs() to skip flaky vitest files
// without editing test source; the do1 e2e worker reads it via
// computeSuiteExcludeList() to skip flaky suite scripts. `node
// scripts/flaky-test-registry.mjs quarantine|restore|list` is the manual
// entry point.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

export const REGISTRY_PATH = resolve(REPO_ROOT, 'scripts/flaky-test-registry.json');

const VALID_KINDS = new Set(['vitest-file', 'suite']);

export function readRegistry(registryText) {
  if (!registryText || !registryText.trim()) return {};
  const parsed = JSON.parse(registryText);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('flaky-test-registry.json must be a JSON object keyed by quarantine target.');
  }
  return parsed;
}

// vitest resolves --exclude relative to each package's own directory (the
// cwd it runs in, whether invoked via `pnpm --filter <pkg> test` or `pnpm -r
// test`), never the repo root. A repo-root-relative glob like
// "packages/ui/src/foo.test.ts" silently matches nothing and quarantines
// nothing -- confirmed live: it left the target test running. Requiring a
// double-star wildcard prefix on vitest-file targets keeps every such entry
// package-relative-safe by construction instead of relying on whoever adds
// an entry to remember this. Suite targets are shell script relpaths, not
// vitest globs, so the requirement does not apply to them.
export function quarantineInRegistry(registry, target, { reason, source, now, kind }) {
  if (!target || !target.trim()) {
    throw new Error('A quarantine target (test-file glob or suite path) is required.');
  }
  const resolvedKind = kind ?? 'vitest-file';
  if (!VALID_KINDS.has(resolvedKind)) {
    throw new Error(`Unknown kind "${resolvedKind}". Use "vitest-file" or "suite".`);
  }
  if (resolvedKind === 'vitest-file' && !target.startsWith('**/')) {
    throw new Error(
      `Test-file glob "${target}" must start with "**/" so it matches regardless of which package vitest runs from (e.g. "**/src/__tests__/foo.test.ts").`,
    );
  }
  return {
    ...registry,
    [target]: { reason: reason || 'unspecified', source: source || 'manual', quarantinedAt: now, kind: resolvedKind },
  };
}

export function restoreInRegistry(registry, target) {
  if (!(target in registry)) {
    throw new Error(`"${target}" is not currently quarantined.`);
  }
  const { [target]: _removed, ...rest } = registry;
  return rest;
}

/**
 * vitest's CLI `--exclude <glob>` is additive to (not a replacement of) its
 * own default excludes (node_modules, dist, etc.), so this only ever adds
 * exclusions on top of the normal run -- never widens what already runs.
 * Suite-kind entries are never vitest globs, so they are filtered out here.
 */
export function computeVitestExcludeArgs(registry) {
  return Object.entries(registry)
    .filter(([, entry]) => (entry.kind ?? 'vitest-file') === 'vitest-file')
    .flatMap(([testGlob]) => ['--exclude', testGlob]);
}

/**
 * Suite-kind entries as a list of scripts/test-suites/**.sh relpaths, ready
 * to join into run-all-tests.sh's INVOKER_TEST_ALL_EXCLUDE (comma or
 * space separated).
 */
export function computeSuiteExcludeList(registry) {
  return Object.entries(registry)
    .filter(([, entry]) => entry.kind === 'suite')
    .map(([suitePath]) => suitePath);
}

function readRegistryFile() {
  if (!existsSync(REGISTRY_PATH)) return {};
  return readRegistry(readFileSync(REGISTRY_PATH, 'utf8'));
}

function writeRegistryFile(registry) {
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

function main(argv) {
  const [command, target, ...rest] = argv;
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(readRegistryFile(), null, 2)}\n`);
    return;
  }
  if (command === 'exclude-args') {
    process.stdout.write(`${computeVitestExcludeArgs(readRegistryFile()).join(' ')}\n`);
    return;
  }
  if (command === 'exclude-suites-env') {
    process.stdout.write(`${computeSuiteExcludeList(readRegistryFile()).join(',')}\n`);
    return;
  }
  if (!command || !target) {
    process.stderr.write(
      'Usage: node scripts/flaky-test-registry.mjs <quarantine|restore|list|exclude-args|exclude-suites-env> "<test file glob or suite path>" [--reason "..."] [--source auto|manual] [--kind vitest-file|suite]\n',
    );
    process.exit(1);
  }
  const reasonIndex = rest.indexOf('--reason');
  const reason = reasonIndex !== -1 ? rest[reasonIndex + 1] : undefined;
  const sourceIndex = rest.indexOf('--source');
  const source = sourceIndex !== -1 ? rest[sourceIndex + 1] : undefined;
  const kindIndex = rest.indexOf('--kind');
  const kind = kindIndex !== -1 ? rest[kindIndex + 1] : undefined;

  if (command === 'quarantine') {
    const registry = quarantineInRegistry(readRegistryFile(), target, {
      reason,
      source,
      kind,
      now: new Date().toISOString(),
    });
    writeRegistryFile(registry);
    process.stdout.write(`Quarantined "${target}": ${reason || 'unspecified'}\n`);
    return;
  }
  if (command === 'restore') {
    writeRegistryFile(restoreInRegistry(readRegistryFile(), target));
    process.stdout.write(`Restored "${target}".\n`);
    return;
  }
  throw new Error(`Unknown command "${command}". Use quarantine, restore, list, exclude-args, or exclude-suites-env.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
