import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { registerBuiltinWorkers } from '../builtin-workers.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { createWorkerRegistry } from '../worker-registry.js';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN_WORKERS_SOURCE = 'builtin-workers.ts';
const RECOVERY_ACTION_TRIGGER_PATTERN = /\bsubmitter\.submit\s*\(/g;

type SourceFiles = ReadonlyMap<string, string>;

interface RecoveryActionSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function toSourceRelativePath(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join('/');
}

function collectSourceFiles(dir: string = SOURCE_ROOT): Map<string, string> {
  const files = new Map<string, string>();

  for (const entry of readdirSync(dir)) {
    const absolutePath = resolve(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (entry !== '__tests__') {
        for (const [file, text] of collectSourceFiles(absolutePath)) {
          files.set(file, text);
        }
      }
      continue;
    }

    if (stats.isFile() && entry.endsWith('.ts')) {
      files.set(toSourceRelativePath(absolutePath), readFileSync(absolutePath, 'utf8'));
    }
  }

  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function importedRegisterFunctions(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  const importPattern = /import\s+\{\s*([^}]+?)\s*\}\s+from\s+'([^']+)'/g;
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(source)) !== null) {
    const namedImports = match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]);
    for (const name of namedImports) {
      if (/^register[A-Z].*Workers?$/.test(name)) {
        imports.set(name, match[2]);
      }
    }
  }

  return imports;
}

function sourcePathForModuleSpecifier(specifier: string): string {
  const relativeSpecifier = specifier.startsWith('./') ? specifier.slice(2) : specifier;
  return relativeSpecifier.replace(/\.js$/, '.ts');
}

function extractExportedWorkerKinds(source: string): Set<string> {
  const workerKinds = new Set<string>();
  const workerKindPattern = /export\s+const\s+\w+_WORKER_KIND\s*=\s*'([^']+)'/g;
  let match: RegExpExecArray | null;

  while ((match = workerKindPattern.exec(source)) !== null) {
    workerKinds.add(match[1]);
  }

  return workerKinds;
}

function localValueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+'(\.[^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

function resolveLocalImport(fromFile: string, specifier: string): string {
  const parts = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')).split('/') : [];
  for (const segment of specifier.replace(/\.js$/, '.ts').split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function registeredBuiltInWorkerSourceFiles(sourceFiles: SourceFiles): Set<string> {
  const builtinWorkers = sourceFiles.get(BUILTIN_WORKERS_SOURCE);
  expect(builtinWorkers).toBeDefined();

  const registeredKinds = new Set(
    registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>()).list().map((worker) => worker.kind),
  );
  const registerImports = importedRegisterFunctions(builtinWorkers ?? '');
  const allowedFiles = new Set<string>();

  for (const [registerFunction, moduleSpecifier] of registerImports) {
    const callPattern = new RegExp(`\\b${escapeRegExp(registerFunction)}\\(registry\\)`);
    if (!callPattern.test(builtinWorkers ?? '')) continue;

    const sourcePath = sourcePathForModuleSpecifier(moduleSpecifier);
    const source = sourceFiles.get(sourcePath);
    expect(source, `${sourcePath} imported by ${BUILTIN_WORKERS_SOURCE} must exist`).toBeDefined();

    const moduleWorkerKinds = extractExportedWorkerKinds(source ?? '');
    if ([...moduleWorkerKinds].some((kind) => registeredKinds.has(kind))) {
      allowedFiles.add(sourcePath);
    }
  }

  // Recovery helpers factored out of a registered worker (and imported by it)
  // are part of that worker's implementation, so follow value imports to keep
  // their submitter.submit() calls sanctioned. Files no worker reaches stay
  // unsanctioned and are still caught as violations.
  const queue = [...allowedFiles];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const source = sourceFiles.get(file);
    if (!source) continue;
    for (const specifier of localValueImportSpecifiers(source)) {
      const importedPath = resolveLocalImport(file, specifier);
      if (sourceFiles.has(importedPath) && !allowedFiles.has(importedPath)) {
        allowedFiles.add(importedPath);
        queue.push(importedPath);
      }
    }
  }

  return allowedFiles;
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function lineTextAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  const newline = source.indexOf('\n', index);
  const end = newline === -1 ? source.length : newline;
  return source.slice(start, end).trim();
}

function findRecoveryActionTriggerSites(sourceFiles: SourceFiles): RecoveryActionSite[] {
  const sites: RecoveryActionSite[] = [];

  for (const [file, source] of sourceFiles) {
    let match: RegExpExecArray | null;
    RECOVERY_ACTION_TRIGGER_PATTERN.lastIndex = 0;
    while ((match = RECOVERY_ACTION_TRIGGER_PATTERN.exec(source)) !== null) {
      sites.push({
        file,
        line: lineNumberAt(source, match.index),
        text: lineTextAt(source, match.index),
      });
    }
  }

  return sites;
}

function findUnsanctionedRecoveryActionSites(
  sourceFiles: SourceFiles,
  sanctionedWorkerSourceFiles: ReadonlySet<string>,
): RecoveryActionSite[] {
  return findRecoveryActionTriggerSites(sourceFiles)
    .filter((site) => !sanctionedWorkerSourceFiles.has(site.file));
}

function formatSite(site: RecoveryActionSite): string {
  return `${site.file}:${site.line}: ${site.text}`;
}

describe('recovery action worker guard', () => {
  it('derives sanctioned recovery-action source files from registered built-in workers', () => {
    const sourceFiles = collectSourceFiles();
    const sanctionedWorkerSourceFiles = registeredBuiltInWorkerSourceFiles(sourceFiles);
    const triggerFiles = new Set(findRecoveryActionTriggerSites(sourceFiles).map((site) => site.file));

    expect(sanctionedWorkerSourceFiles.size).toBeGreaterThan(1);
    expect([...triggerFiles].sort()).toEqual(
      [...triggerFiles].filter((file) => sanctionedWorkerSourceFiles.has(file)).sort(),
    );
  });

  it('keeps recovery action submissions inside registered worker implementations', () => {
    const sourceFiles = collectSourceFiles();
    const sanctionedWorkerSourceFiles = registeredBuiltInWorkerSourceFiles(sourceFiles);
    const violations = findUnsanctionedRecoveryActionSites(sourceFiles, sanctionedWorkerSourceFiles);

    expect(violations.map(formatSite)).toEqual([]);
  });

  it('reports a source-level violation when recovery is triggered outside a registered worker', () => {
    const sourceFiles = new Map<string, string>([
      [
        'not-a-worker.ts',
        [
          'export function triggerRecovery(submitter: { submit(...args: unknown[]): number }): number {',
          "  return submitter.submit('wf-1', 'normal', 'invoker:fix-with-agent', ['wf-1/task']);",
          '}',
        ].join('\n'),
      ],
    ]);

    const violations = findUnsanctionedRecoveryActionSites(sourceFiles, new Set(['workers/registered-worker.ts']));

    expect(violations.map(formatSite)).toEqual([
      "not-a-worker.ts:2: return submitter.submit('wf-1', 'normal', 'invoker:fix-with-agent', ['wf-1/task']);",
    ]);
  });
});
