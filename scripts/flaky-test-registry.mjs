#!/usr/bin/env node
// Checked-in registry of known-flaky test files, quarantined by file glob.
// CI reads this via computeVitestExcludeArgs() to skip them without editing
// test source; `node scripts/flaky-test-registry.mjs quarantine|restore|list`
// is the manual entry point.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

export const REGISTRY_PATH = resolve(REPO_ROOT, 'scripts/flaky-test-registry.json');

export function readRegistry(registryText) {
  if (!registryText || !registryText.trim()) return {};
  const parsed = JSON.parse(registryText);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('flaky-test-registry.json must be a JSON object keyed by test-file glob.');
  }
  return parsed;
}

export function quarantineInRegistry(registry, testGlob, { reason, source, now }) {
  if (!testGlob || !testGlob.trim()) {
    throw new Error('A test-file glob is required to quarantine.');
  }
  return {
    ...registry,
    [testGlob]: { reason: reason || 'unspecified', source: source || 'manual', quarantinedAt: now },
  };
}

export function restoreInRegistry(registry, testGlob) {
  if (!(testGlob in registry)) {
    throw new Error(`"${testGlob}" is not currently quarantined.`);
  }
  const { [testGlob]: _removed, ...rest } = registry;
  return rest;
}

/**
 * vitest's CLI `--exclude <glob>` is additive to (not a replacement of) its
 * own default excludes (node_modules, dist, etc.), so this only ever adds
 * exclusions on top of the normal run -- never widens what already runs.
 */
export function computeVitestExcludeArgs(registry) {
  return Object.keys(registry).flatMap((testGlob) => ['--exclude', testGlob]);
}

function readRegistryFile() {
  if (!existsSync(REGISTRY_PATH)) return {};
  return readRegistry(readFileSync(REGISTRY_PATH, 'utf8'));
}

function writeRegistryFile(registry) {
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

function main(argv) {
  const [command, testGlob, ...rest] = argv;
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(readRegistryFile(), null, 2)}\n`);
    return;
  }
  if (command === 'exclude-args') {
    process.stdout.write(`${computeVitestExcludeArgs(readRegistryFile()).join(' ')}\n`);
    return;
  }
  if (!command || !testGlob) {
    process.stderr.write(
      'Usage: node scripts/flaky-test-registry.mjs <quarantine|restore|list|exclude-args> "<test file glob>" [--reason "..."] [--source auto|manual]\n',
    );
    process.exit(1);
  }
  const reasonIndex = rest.indexOf('--reason');
  const reason = reasonIndex !== -1 ? rest[reasonIndex + 1] : undefined;
  const sourceIndex = rest.indexOf('--source');
  const source = sourceIndex !== -1 ? rest[sourceIndex + 1] : undefined;

  if (command === 'quarantine') {
    const registry = quarantineInRegistry(readRegistryFile(), testGlob, {
      reason,
      source,
      now: new Date().toISOString(),
    });
    writeRegistryFile(registry);
    process.stdout.write(`Quarantined "${testGlob}": ${reason || 'unspecified'}\n`);
    return;
  }
  if (command === 'restore') {
    writeRegistryFile(restoreInRegistry(readRegistryFile(), testGlob));
    process.stdout.write(`Restored "${testGlob}".\n`);
    return;
  }
  throw new Error(`Unknown command "${command}". Use quarantine, restore, list, or exclude-args.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
