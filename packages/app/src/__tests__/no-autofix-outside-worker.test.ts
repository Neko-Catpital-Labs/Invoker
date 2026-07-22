/**
 * Guard: "no auto-fix inside Invoker except via the shared worker engine."
 *
 * The 2h stack collapses two competing auto-fix recovery engines into one. The
 * danger is regression by drift: a future edit could add a direct auto-fix
 * trigger somewhere new and silently recreate a second recovery path.
 *
 * This test is a deterministic source sweep. It walks every package's `src`
 * tree, looks for auto-fix *trigger* signals, and fails the build if any hit
 * lands outside the small allowlist of sanctioned sites:
 *   1. the shared worker engine in `@invoker/execution-engine`, and
 *   2. the operator-facing `fix ... --auto-fix` command route in `@invoker/app`.
 *
 * Any other hit names the offending file/line so the regression is actionable.
 *
 * Note on the scan-by-identifier choice: we match the `AUTO_FIX_RECOVERY_CHANNEL`
 * *identifier* rather than its raw string value (`'auto-fix-recovery'`), because
 * that value coincidentally collides with an unrelated observability id
 * (`RECOVERY_WORKER_ID`). Matching the identifier tracks real usage of the
 * channel constant and avoids false positives.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** A source file the scanner inspects. `path` is a repo-relative, POSIX path. */
interface SourceFile {
  path: string;
  content: string;
}

/** A single auto-fix trigger hit found in a source file. */
interface TriggerHit {
  path: string;
  line: number;
  signal: string;
  text: string;
}

/**
 * Auto-fix *trigger* signals. Each matches a way auto-fix can be submitted or
 * triggered. They are intentionally narrow (call sites / flag tokens / the
 * channel identifier) so plumbing, type declarations, and method *definitions*
 * do not trip the guard.
 */
const TRIGGER_SIGNALS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // The auto-fix-on-failure entrypoint being *invoked* (or defined).
  { name: 'autoFixOnFailure()', pattern: /\bautoFixOnFailure\s*\(/ },
  // A direct fix submission call on a task executor: `executor.fixWithAgent(...)`.
  // The method *definition* (`async fixWithAgent(`) has no leading dot and is
  // intentionally not matched.
  { name: '.fixWithAgent()', pattern: /\.fixWithAgent\s*\(/ },
  // The auto-fix CLI flag as a standalone quoted token.
  { name: "'--auto-fix' flag", pattern: /['"]--auto-fix['"]/ },
  // Usage of the shared recovery channel constant.
  { name: 'AUTO_FIX_RECOVERY_CHANNEL', pattern: /\bAUTO_FIX_RECOVERY_CHANNEL\b/ },
  // An automatic (worker-initiated) fix intent, marked by `{ autoFix: true }`.
  // Only the event-driven worker engine may construct one; the app must never
  // build an automatic fix — it publishes a task-failed event and lets the
  // recovery worker react (incident 2026-07-12: main.ts scheduled fixes directly).
  { name: 'autoFix: true marker', pattern: /\bautoFix:\s*true\b/ },
  // Passing 'auto-fix' as a fix *source* argument, e.g.
  // `executeFixWithAgentMutation(taskId, agent, 'auto-fix')`. The type union
  // `'ipc' | 'auto-fix'` and `source === 'auto-fix'` comparisons do not match.
  { name: "'auto-fix' source arg", pattern: /['"]auto-fix['"]\s*\)/ },
];
 

/**
 * The ONLY files permitted to contain auto-fix trigger signals. Two categories:
 *
 *  (A) the shared auto-fix worker engine in `@invoker/execution-engine`,
 *  (B) the shared fix action / operator-facing `fix ... --auto-fix` command
 *      route in `@invoker/app`.
 *
 * Adding an entry here is a deliberate act: it either declares a sanctioned
 * auto-fix site or documents an unreachable legacy file that still needs its
 * own cleanup slice. Anything not listed here that trips a signal fails the
 * build.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // (A) shared worker engine — now extracted into @invoker/execution-engine
  'packages/execution-engine/src/auto-fix-recovery.ts',
  'packages/execution-engine/src/worker-runtime.ts',
  'packages/execution-engine/src/auto-fix-intents.ts',
  'packages/execution-engine/src/workers/ci-failure-worker.ts',
  // (B) shared fix action + operator command route in @invoker/app
  // (`workers/auto-fix-recovery.ts` is the thin re-export shim for the engine).
  'packages/app/src/workers/auto-fix-recovery.ts',
  'packages/app/src/workflow-actions.ts',
  'packages/app/src/headless.ts',
  'packages/execution-engine/src/review-gate-ci-repair.ts',
]);

/** Locate the monorepo root by walking up to the `pnpm-workspace.yaml` marker. */
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

/** Recursively collect `.ts` source files, excluding tests and declarations. */
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
      // Tests legitimately call auto-fix entrypoints; never scan them.
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectTsFiles(root, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push({
      path: relative(root, abs).split(sep).join('/'),
      content: readFileSync(abs, 'utf8'),
    });
  }
}

/** Read every package's `src` TypeScript source file under the repo root. */
function collectRepoSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const packagesDir = join(root, 'packages');
  let pkgs: Dirent[];
  try {
    pkgs = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    collectTsFiles(root, join(packagesDir, pkg.name, 'src'), out);
  }
  return out;
}

/** Return every trigger-signal hit across the given files. */
function scanForAutoFixTriggers(files: ReadonlyArray<SourceFile>): TriggerHit[] {
  const hits: TriggerHit[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i];
      for (const signal of TRIGGER_SIGNALS) {
        if (signal.pattern.test(text)) {
          hits.push({ path: file.path, line: i + 1, signal: signal.name, text: text.trim() });
        }
      }
    }
  }
  return hits;
}

/** Trigger hits that fall outside the sanctioned allowlist — i.e. violations. */
function findAutoFixViolations(
  files: ReadonlyArray<SourceFile>,
  allowlist: ReadonlySet<string>,
): TriggerHit[] {
  return scanForAutoFixTriggers(files).filter((hit) => !allowlist.has(hit.path));
}

const REPO_ROOT = findRepoRoot();

describe('no auto-fix outside the shared worker engine', () => {
  it('finds no auto-fix trigger outside the allowlisted engine/command sites', () => {
    const files = collectRepoSourceFiles(REPO_ROOT);
    // Sanity: the sweep actually walked a real tree.
    expect(files.length).toBeGreaterThan(50);

    const violations = findAutoFixViolations(files, ALLOWLIST);
    const report = violations
      .map((v) => `  ${v.path}:${v.line}  [${v.signal}]  ${v.text}`)
      .join('\n');

    expect(
      violations,
      `Auto-fix triggered outside the shared worker engine / operator command route.\n` +
        `Each site below must move into an allowlisted module, or be added to the ` +
        `ALLOWLIST in this test if it is a newly sanctioned auto-fix site:\n${report}`,
    ).toEqual([]);
  });

  it('keeps the allowlist honest: every allowlisted file exists and trips a signal', () => {
    const files = collectRepoSourceFiles(REPO_ROOT);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const hitPaths = new Set(scanForAutoFixTriggers(files).map((h) => h.path));

    for (const allowed of ALLOWLIST) {
      // Allowlisted file must still exist (catches stale entries after renames).
      expect(byPath.has(allowed), `Allowlisted file no longer exists: ${allowed}`).toBe(true);
    }
    // At least the core engine + action route must still carry signals; if the
    // whole allowlist goes quiet, the signals likely drifted and the guard is
    // no longer watching anything real.
    const allowlistHits = [...hitPaths].filter((p) => ALLOWLIST.has(p));
    expect(allowlistHits.length).toBeGreaterThan(0);
  });

  it('FAILS when a direct auto-fix call is added outside the allowlist', () => {
    // Synthetic regression: a new file sneaks in an automatic auto-fix trigger.
    const planted: SourceFile = {
      path: 'packages/app/src/sneaky-recovery.ts',
      content: [
        'export async function lurk(taskId: string, deps: unknown) {',
        '  await autoFixOnFailure(taskId, deps);',
        '}',
      ].join('\n'),
    };

    const violations = findAutoFixViolations([planted], ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('packages/app/src/sneaky-recovery.ts');
    expect(violations[0]?.signal).toBe('autoFixOnFailure()');
  });

  it('does NOT flag the same call inside an allowlisted module', () => {
    // Identical trigger, but located in a sanctioned file → permitted.
    const sanctioned: SourceFile = {
      path: 'packages/app/src/workflow-actions.ts',
      content: 'await autoFixOnFailure(taskId, deps);',
    };
    expect(findAutoFixViolations([sanctioned], ALLOWLIST)).toEqual([]);
  });

  it('detects each distinct trigger signal outside the allowlist', () => {
    const cases: ReadonlyArray<{ content: string; signal: string }> = [
      { content: "executor.fixWithAgent(taskId, out);", signal: '.fixWithAgent()' },
      { content: "const f = '--auto-fix';", signal: "'--auto-fix' flag" },
      { content: 'bus.publish(AUTO_FIX_RECOVERY_CHANNEL);', signal: 'AUTO_FIX_RECOVERY_CHANNEL' },
      { content: 'await autoFixOnFailure(taskId);', signal: 'autoFixOnFailure()' },
      { content: 'enqueue(wf, buildFixWithAgentMutationArgs(t, a, { autoFix: true }));', signal: 'autoFix: true marker' },
      { content: "await executeFixWithAgentMutation(taskId, agent, 'auto-fix');", signal: "'auto-fix' source arg" },
    ];
    for (const c of cases) {
      const file: SourceFile = { path: 'packages/app/src/rogue.ts', content: c.content };
      const violations = findAutoFixViolations([file], ALLOWLIST);
      expect(violations.map((v) => v.signal)).toContain(c.signal);
    }
  });

  it('catches the incident-2026-07-12 pattern: app scheduling an automatic fix', () => {
    // The removed main.ts scheduleAutoFix built an automatic fix intent and
    // enqueued it directly on a failed-task delta — bypassing the worker.
    const planted: SourceFile = {
      path: 'packages/app/src/main.ts',
      content: [
        'const scheduleAutoFix = (taskId: string): void => {',
        "  void runWorkflowMutation(wf, 'normal', 'invoker:fix-with-agent',",
        "    buildFixWithAgentMutationArgs(taskId, agent, { autoFix: true }));",
        '};',
      ].join('\n'),
    };
    const violations = findAutoFixViolations([planted], ALLOWLIST);
    expect(violations.map((v) => v.signal)).toContain('autoFix: true marker');
  });

  it('does NOT flag the retained executeFixWithAgentMutation source type/compare', () => {
    // main.ts still hosts the shared command handler whose source union and
    // comparison mention 'auto-fix' but never construct an automatic fix.
    const retained: SourceFile = {
      path: 'packages/app/src/main.ts',
      content: [
        "  source: 'ipc' | 'auto-fix' = 'ipc',",
        "  context: source === 'auto-fix' ? 'ipc.fix-with-agent.auto-fix' : 'ipc.fix-with-agent',",
      ].join('\n'),
    };
    expect(findAutoFixViolations([retained], ALLOWLIST)).toEqual([]);
  });
});
