import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Match = {
  file: string;
  line: number;
  rule: string;
  text: string;
};

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx)$/;
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

const FORBIDDEN_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: '@invoker/data-store import/reference', pattern: /@invoker\/data-store\b/ },
  { rule: 'SQLiteAdapter reference', pattern: /\bSQLiteAdapter\b/ },
  { rule: 'direct invoker.db reference', pattern: /\binvoker\.db\b/ },
];

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function preloadSourceFiles(): string[] {
  const appSourceDir = join(REPO_ROOT, 'packages', 'app', 'src');
  return readdirSync(appSourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^preload.*\.(ts|tsx|js|jsx)$/.test(entry.name))
    .map((entry) => join(appSourceDir, entry.name));
}

function findForbiddenStorageReferences(files: string[]): Match[] {
  const matches: Match[] = [];

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const { rule, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          matches.push({
            file: relative(REPO_ROOT, file),
            line: index + 1,
            rule,
            text: line.trim(),
          });
        }
      }
    }
  }

  return matches;
}

describe('renderer/preload storage boundary', () => {
  const uiSourceFiles = walkSourceFiles(join(REPO_ROOT, 'packages', 'ui', 'src'));
  const preloadFiles = preloadSourceFiles();
  const guardedFiles = [...uiSourceFiles, ...preloadFiles].sort();

  it('covers the renderer package and Electron preload entrypoints', () => {
    expect(guardedFiles.map((file) => relative(REPO_ROOT, file))).toContain('packages/ui/src/App.tsx');
    expect(guardedFiles.map((file) => basename(file))).toContain('preload.ts');
  });

  it('keeps SQLite and data-store access out of renderer/preload-facing code', () => {
    const matches = findForbiddenStorageReferences(guardedFiles);

    if (matches.length > 0) {
      const summary = matches
        .map((match) => `  ${match.file}:${match.line}  [${match.rule}] ${match.text}`)
        .join('\n');

      throw new Error(
        `Unexpected renderer/preload storage boundary violations:\n${summary}\n\n` +
          'Renderer and preload-facing code must get task graph state through the IPC bridge. ' +
          'Keep SQLite, @invoker/data-store, SQLiteAdapter, and invoker.db access in app main/server code.',
      );
    }

    expect(matches).toEqual([]);
  });
});
