import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const APP_SRC = path.resolve(__dirname, '..');

const FORBIDDEN_PATTERNS = [
  {
    name: 'scheduleAutoFix',
    pattern: /\bscheduleAutoFix\b/g,
  },
  {
    name: 'wireHeadlessAutoFix',
    pattern: /\bwireHeadlessAutoFix\b/g,
  },
  {
    name: 'failed-delta cancellation auto-fix gate',
    pattern: /\bshouldSkipAutoFixForError\b/g,
  },
  {
    name: 'auto-fix intent de-duplication helper',
    pattern: /\blistOpenFixIntentsForTask\b/g,
  },
  {
    name: 'autoFixOnFailure caller',
    pattern: /\bautoFixOnFailure\s*\(/g,
  },
  {
    name: 'in-app source=auto-fix branch',
    pattern: /source\s*:\s*['"]ipc['"]\s*\|\s*['"]auto-fix['"]|source\s*===\s*['"]auto-fix['"]/g,
  },
  {
    name: 'fix-with-agent auto-fix dispatch',
    pattern: /executeFixWithAgentMutation[\s\S]{0,160}['"]auto-fix['"]|runWorkflowMutation\([\s\S]{0,500}['"]invoker:fix-with-agent['"][\s\S]{0,500}['"]auto-fix['"]/g,
  },
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...listSourceFiles(entryPath));
      continue;
    }
    if (entryPath.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

function lineForIndex(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function isAllowedMatch(filePath: string, patternName: string): boolean {
  return path.basename(filePath) === 'workflow-actions.ts'
    && patternName === 'autoFixOnFailure caller';
}

describe('no auto-fix triggers outside the worker', () => {
  it('keeps app production sources from starting automatic fixes', () => {
    const violations: string[] = [];
    for (const filePath of listSourceFiles(APP_SRC)) {
      const source = readFileSync(filePath, 'utf8');
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          if (isAllowedMatch(filePath, name)) continue;
          const relativePath = path.relative(path.resolve(__dirname, '../../..'), filePath);
          violations.push(`${relativePath}:${lineForIndex(source, match.index ?? 0)} ${name}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
