import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

interface SourceFile { path: string; content: string }
interface TriggerHit { path: string; line: number; signal: string; text: string }

const TRIGGER_SIGNALS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'REVIEW_COMMENTS_REPAIR_CHANNEL', pattern: /\bREVIEW_COMMENTS_REPAIR_CHANNEL\b/ },
  { name: 'PR_QUEUE_DEQUEUE_REPAIR_CHANNEL', pattern: /\bPR_QUEUE_DEQUEUE_REPAIR_CHANNEL\b/ },
  { name: "'invoker:repair-review-comments' channel", pattern: /['"]invoker:repair-review-comments['"]/ },
  { name: "'invoker:repair-queue-dequeue' channel", pattern: /['"]invoker:repair-queue-dequeue['"]/ },
];

const ALLOWLIST: Record<string, true> = {
  'packages/execution-engine/src/workers/review-comments-worker.ts': true,
  'packages/execution-engine/src/workers/pr-queue-land-worker.ts': true,
  'packages/app/src/pr-lifecycle-repair-command.ts': true,
  'packages/app/src/main.ts': true,
};

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 20; i += 1) {
    try {
      statSync(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate repo root (pnpm-workspace.yaml not found).');
}

function collectTsFiles(root: string, absDir: string, out: SourceFile[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectTsFiles(root, abs, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts')) continue;
    out.push({ path: relative(root, abs).split(sep).join('/'), content: readFileSync(abs, 'utf8') });
  }
}

function collectRepoSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  let pkgs: Dirent[];
  try {
    pkgs = readdirSync(join(root, 'packages'), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pkg of pkgs) {
    if (pkg.isDirectory()) collectTsFiles(root, join(root, 'packages', pkg.name, 'src'), out);
  }
  return out;
}

function scanForRepairTriggers(files: ReadonlyArray<SourceFile>): TriggerHit[] {
  const hits: TriggerHit[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const signal of TRIGGER_SIGNALS) {
        if (signal.pattern.test(lines[i])) {
          hits.push({ path: file.path, line: i + 1, signal: signal.name, text: lines[i].trim() });
        }
      }
    }
  }
  return hits;
}

function findViolations(files: ReadonlyArray<SourceFile>, allowlist: Record<string, true>): TriggerHit[] {
  return scanForRepairTriggers(files).filter((hit) => allowlist[hit.path] !== true);
}

const REPO_ROOT = findRepoRoot();

describe('PR lifecycle repair channels stay inside the worker engine', () => {
  it('finds no repair-channel reference outside the allowlisted worker engine / owner dispatcher', () => {
    const files = collectRepoSourceFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(50);

    const violations = findViolations(files, ALLOWLIST);
    const report = violations.map((v) => `  ${v.path}:${v.line}  [${v.signal}]  ${v.text}`).join('\n');
    expect(
      violations,
      `PR lifecycle repair channel referenced outside the sanctioned worker engine / owner dispatcher.\n` +
        `Move it into an allowlisted module, or add a newly sanctioned site to ALLOWLIST:\n${report}`,
    ).toEqual([]);
  });

  it('keeps the allowlist honest: every allowlisted file exists and trips a signal', () => {
    const files = collectRepoSourceFiles(REPO_ROOT);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const hitPaths = new Set(scanForRepairTriggers(files).map((h) => h.path));
    for (const allowed of Object.keys(ALLOWLIST)) {
      expect(byPath.has(allowed), `Allowlisted file no longer exists: ${allowed}`).toBe(true);
      expect(hitPaths.has(allowed), `Allowlisted file no longer references the repair channel: ${allowed}`).toBe(true);
    }
  });

  it('FAILS when a rogue file submits on a repair channel', () => {
    const planted: SourceFile = {
      path: 'packages/app/src/sneaky-repair.ts',
      content: "submitter.submit(wfId, 'normal', REVIEW_COMMENTS_REPAIR_CHANNEL, args);",
    };
    const violations = findViolations([planted], ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('packages/app/src/sneaky-repair.ts');
  });

  it('does NOT flag the same reference inside an allowlisted module', () => {
    const sanctioned: SourceFile = {
      path: 'packages/execution-engine/src/workers/review-comments-worker.ts',
      content: "options.submitter.submit(workflowId, 'normal', REVIEW_COMMENTS_REPAIR_CHANNEL, args);",
    };
    expect(findViolations([sanctioned], ALLOWLIST)).toEqual([]);
  });
});
