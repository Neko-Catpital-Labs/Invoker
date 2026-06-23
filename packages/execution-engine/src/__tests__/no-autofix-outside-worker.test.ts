/**
 * Guard test: "no auto-fix inside Invoker except via the shared worker engine".
 *
 * The 2h stack collapses two competing auto-fix recovery engines into one shared
 * engine that lives in `@invoker/execution-engine`. The single sanctioned route
 * to submit/trigger an auto-fix is the `invoker:fix-with-agent` channel — the
 * same route the operator command `fix <taskId> --auto-fix` uses. Nothing else
 * is allowed to start an auto-fix.
 *
 * Without an automated guard, a future edit could add a direct auto-fix call
 * somewhere else and silently recreate a second recovery path. This test sweeps
 * every `packages/<pkg>/src` source file for auto-fix *trigger* signals and asserts
 * each hit lives inside the small, explicit allowlist below (the shared engine
 * plus the operator-facing fix command route). Any out-of-bounds hit fails the
 * build and names the offending file + line so the regression is actionable.
 *
 * This file itself is a test (`*.test.ts`, under `__tests__/`) and is therefore
 * excluded from the scan, so the signal strings it must reference do not
 * self-trigger.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Walk up from this test file until we find the monorepo root (has `packages/`). */
function findRepoRoot(start: string): string {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) {
      throw new Error('Could not locate monorepo root (no packages/ + pnpm-workspace.yaml ancestor)');
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(here);

/**
 * Auto-fix *trigger* signals. These specifically indicate an auto-fix being
 * submitted or started — not the manual operator fix path, and not the many
 * benign `autoFix` config/column/parser mentions across the tree.
 */
const SIGNALS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  // The CLI flag that turns a `fix` into an auto-fix.
  { name: 'cli-auto-fix-flag', regex: /--auto-fix/ },
  // The shared recovery worker's wakeup channel constant.
  { name: 'recovery-channel', regex: /AUTO_FIX_RECOVERY_CHANNEL/ },
  // The auto-fix-on-failure entrypoint (definition or call).
  { name: 'auto-fix-on-failure', regex: /\bautoFixOnFailure\s*\(/ },
  // Submitting a fix with auto-fix turned on (e.g. `{ autoFix: true }`).
  { name: 'auto-fix-submission', regex: /\bautoFix\s*:\s*true\b/ },
];

/**
 * The ONLY files allowed to host an auto-fix trigger:
 *  - the shared worker engine in `@invoker/execution-engine`, and
 *  - the operator-facing fix command route in `@invoker/app`
 *    (`fix <taskId> --auto-fix` + its sanctioned `invoker:fix-with-agent`
 *    submission and inline auto-fix-on-failure orchestration), plus the app's
 *    thin re-export shim of the shared engine.
 *
 * Paths are repo-root-relative, posix-style. Keep this list SMALL and explicit:
 * adding an entry is a deliberate decision to sanction a new auto-fix site.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // Shared worker engine (the single auto-fix engine). When the cutover moves
  // the actual trigger into `worker-runtime.ts`, add that file here deliberately.
  'packages/execution-engine/src/auto-fix-recovery.ts',
  'packages/execution-engine/src/auto-fix-intents.ts',
  // App-side re-export shim of the shared engine.
  'packages/app/src/auto-fix-recovery.ts',
  // Operator-facing fix command route.
  'packages/app/src/headless.ts',
  'packages/app/src/main.ts',
  'packages/app/src/workflow-actions.ts',
]);

interface Violation {
  relPath: string;
  line: number;
  signal: string;
  text: string;
}

interface SourceFile {
  relPath: string;
  content: string;
}

/** Repo-root-relative, forward-slash path (stable across OSes / matches allowlist). */
function toRelPosix(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join('/');
}

function isScannableFile(name: string): boolean {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false;
  if (name.endsWith('.d.ts')) return false;
  if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) return false;
  if (name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')) return false;
  return true;
}

const SKIP_DIRS = new Set(['__tests__', '__mocks__', 'node_modules', 'dist', 'build', '.turbo']);

/** Collect every scannable source file under each `packages/<pkg>/src` as { relPath, content }. */
function collectRepoSources(): SourceFile[] {
  const files: SourceFile[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');

  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src');
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    walk(srcDir, files);
  }
  return files;
}

function walk(dir: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(abs, out);
    } else if (st.isFile() && isScannableFile(entry)) {
      out.push({ relPath: toRelPosix(abs), content: readFileSync(abs, 'utf8') });
    }
  }
}

/**
 * Pure scanner: report every auto-fix trigger signal found in a NON-allowlisted
 * file. Exported shape is a plain function so tests can feed it both the real
 * repo and synthetic fixtures.
 */
function scanSourceForAutoFixTriggers(files: ReadonlyArray<SourceFile>): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (ALLOWLIST.has(file.relPath)) continue;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i];
      for (const signal of SIGNALS) {
        if (signal.regex.test(text)) {
          violations.push({ relPath: file.relPath, line: i + 1, signal: signal.name, text: text.trim() });
        }
      }
    }
  }
  return violations;
}

function formatViolations(violations: ReadonlyArray<Violation>): string {
  return violations
    .map((v) => `  - ${v.relPath}:${v.line} [${v.signal}] ${v.text}`)
    .join('\n');
}

describe('no auto-fix outside the shared worker engine', () => {
  it('finds no auto-fix trigger anywhere outside the allowlist', () => {
    const sources = collectRepoSources();
    // Sanity: we actually scanned a non-trivial number of files.
    expect(sources.length).toBeGreaterThan(50);

    const violations = scanSourceForAutoFixTriggers(sources);
    expect(
      violations,
      violations.length === 0
        ? ''
        : `Auto-fix trigger(s) found outside the sanctioned worker engine / fix command route.\n` +
            `Every auto-fix must go through the shared engine in @invoker/execution-engine ` +
            `or the operator fix command. Offending site(s):\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  it('the allowlist only names files that exist and still contain a signal', () => {
    // Keeps the allowlist honest: a stale entry (file deleted or signal removed)
    // is a silent hole, so fail if an allowlisted file no longer needs to be.
    for (const relPath of ALLOWLIST) {
      const abs = join(REPO_ROOT, relPath);
      expect(existsSync(abs), `Allowlisted file is missing: ${relPath}`).toBe(true);
      const content = readFileSync(abs, 'utf8');
      const hasSignal = SIGNALS.some((s) => s.regex.test(content));
      expect(hasSignal, `Allowlisted file no longer contains any auto-fix signal: ${relPath}`).toBe(true);
    }
  });

  it('FAILS when a direct auto-fix call is added outside the allowlist (regression fixture)', () => {
    // Demonstrates the guard would catch a regression, without touching the repo.
    const fixture: SourceFile = {
      relPath: 'packages/surfaces/src/sneaky-recovery.ts',
      content: [
        'export async function sneakyRecovery(taskId: string, deps: unknown) {',
        '  // A second recovery path slipped in outside the worker engine.',
        '  await autoFixOnFailure(taskId, deps);',
        '}',
      ].join('\n'),
    };

    const violations = scanSourceForAutoFixTriggers([fixture]);
    expect(violations).toHaveLength(1);
    expect(violations[0].relPath).toBe('packages/surfaces/src/sneaky-recovery.ts');
    expect(violations[0].line).toBe(3);
    expect(violations[0].signal).toBe('auto-fix-on-failure');
  });

  it('catches each trigger signal shape outside the allowlist', () => {
    const fixtures: SourceFile[] = [
      { relPath: 'packages/foo/src/a.ts', content: `spawn('fix', taskId, '--auto-fix');` },
      { relPath: 'packages/foo/src/b.ts', content: `bus.publish(AUTO_FIX_RECOVERY_CHANNEL);` },
      { relPath: 'packages/foo/src/c.ts', content: `await autoFixOnFailure(id, deps);` },
      { relPath: 'packages/foo/src/d.ts', content: `submitFix(taskId, { autoFix: true });` },
    ];
    const signals = scanSourceForAutoFixTriggers(fixtures).map((v) => v.signal);
    expect(new Set(signals)).toEqual(
      new Set(['cli-auto-fix-flag', 'recovery-channel', 'auto-fix-on-failure', 'auto-fix-submission']),
    );
  });

  it('does NOT flag the same call when it lives in an allowlisted file', () => {
    const fixture: SourceFile = {
      relPath: 'packages/execution-engine/src/auto-fix-recovery.ts',
      content: 'await autoFixOnFailure(taskId, deps);',
    };
    expect(scanSourceForAutoFixTriggers([fixture])).toEqual([]);
  });
});
