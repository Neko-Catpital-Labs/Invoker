import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

type ForbiddenPattern = {
  name: string;
  pattern: RegExp;
  allowedFiles?: ReadonlySet<string>;
};

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...listSourceFiles(absolute));
      continue;
    }
    if (/\.[cm]?tsx?$/.test(entry)) {
      files.push(absolute);
    }
  }
  return files;
}

function relativeSourcePath(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

const forbiddenPatterns: ForbiddenPattern[] = [
  {
    name: 'legacy app/headless auto-fix scheduler',
    pattern: /\b(?:scheduleAutoFix|wireHeadlessAutoFix)\b/,
  },
  {
    name: 'failed-delta auto-fix trigger logging',
    pattern: /\b(?:delta-failed|delta-trigger-schedule|delta-skip)\b/,
  },
  {
    name: 'failed-delta cancellation gate',
    pattern: /\bshouldSkipAutoFixForError\b/,
    allowedFiles: new Set(['auto-fix-gating.ts']),
  },
  {
    name: 'failed task delta directly starts a fix',
    pattern: /changes\.status\s*={2,3}\s*['"]failed['"][\s\S]{0,1200}\b(?:autoFixOnFailure|fixWithAgentAction|runWorkflowMutation|invoker:fix-with-agent)\b/,
  },
  {
    name: 'fix-with-agent mutation enqueued as auto-fix',
    pattern: /runWorkflowMutation\s*\([\s\S]{0,1000}['"]invoker:fix-with-agent['"][\s\S]{0,1000}['"]auto-fix['"]/,
  },
];

describe('no auto-fix triggers outside the recovery worker', () => {
  it('keeps app code from starting automatic fixes from failure deltas', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const relative = relativeSourcePath(file);
      const source = readFileSync(file, 'utf8');
      for (const forbidden of forbiddenPatterns) {
        if (forbidden.allowedFiles?.has(relative)) continue;
        if (forbidden.pattern.test(source)) {
          violations.push(`${relative}: ${forbidden.name}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
