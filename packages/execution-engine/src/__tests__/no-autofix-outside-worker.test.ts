/**
 * Guard: "no recovery action inside Invoker except through a registered worker."
 *
 * The 2h stack collapsed two competing auto-fix recovery engines into one and
 * locked that down with a source sweep: it failed the build if auto-fix was
 * triggered anywhere except the single hard-coded auto-fix engine path. The 2i
 * stack then introduced the worker registry (exported from
 * `@invoker/execution-engine`), so auto-fix is no longer *the* engine — it is
 * one worker registered among others, and future workers are declared the same
 * way.
 *
 * This test generalizes the 2h guard to match that registry model. The
 * invariant is no longer "auto-fix only via the single engine" but "a recovery
 * action only runs through a *registered* worker." Concretely:
 *
 *   - It walks every package's `src` tree and looks for recovery-action *trigger*
 *     signals (a fix being submitted/triggered).
 *   - The allowlist of sanctioned sites is **derived from the worker registry
 *     and its built-in entries** rather than a single hard-coded auto-fix path:
 *     the actual built-in registry is constructed here and each registered
 *     worker contributes its declared recovery-action modules. A registered
 *     worker that declares no modules fails the build, and removing a worker
 *     from the registry prunes its sites from the allowlist.
 *   - Any trigger hit outside the derived allowlist is a violation, named by
 *     file/line so the regression is actionable.
 *
 * The guard is assertion-only: it reads source and fails on violation. It never
 * runs a recovery action and changes no product behavior.
 *
 * Note on the scan-by-identifier choice: we match the `AUTO_FIX_RECOVERY_CHANNEL`
 * *identifier* rather than the raw channel *string* (`'invoker:fix-with-agent'`),
 * because that string is also the routing key threaded through every dispatcher
 * and would flood the scan with plumbing. Matching the identifier tracks real
 * usage of a recovery-channel constant and avoids false positives.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  AUTO_FIX_WORKER_KIND,
  createWorkerRegistry,
  registerAutoFixWorker,
  type WorkerRegistry,
} from '../worker-registry.js';

/** A source file the scanner inspects. `path` is a repo-relative, POSIX path. */
interface SourceFile {
  path: string;
  content: string;
}

/** A single recovery-action trigger hit found in a source file. */
interface TriggerHit {
  path: string;
  line: number;
  signal: string;
  text: string;
}

/**
 * Recovery-action *trigger* signals. Each matches a way a failed task is driven
 * back toward recovery (an auto-fix being submitted or triggered). They are
 * intentionally narrow (call sites / flag tokens / the channel identifier) so
 * plumbing, type declarations, and method *definitions* do not trip the guard.
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
  // Usage of a shared recovery channel constant by identifier (see header note).
  { name: 'AUTO_FIX_RECOVERY_CHANNEL', pattern: /\bAUTO_FIX_RECOVERY_CHANNEL\b/ },
];

/**
 * Sanctioned recovery-action modules, declared per worker *kind*. This is the
 * bridge from the runtime registry (which knows kinds, not source paths) to the
 * source tree: each registered worker names the modules that make up its
 * recovery surface — its engine, the command vocabulary it speaks, and the
 * action it drives.
 *
 * The allowlist is NOT this map; it is {@link deriveSanctionedSites} applied to
 * the *actual* built-in registry. A kind listed here but not registered never
 * contributes a site; a registered kind missing here fails the build. Adding an
 * entry is a deliberate act that declares a new sanctioned recovery site.
 */
const WORKER_RECOVERY_MODULES: Readonly<Record<string, readonly string[]>> = {
  [AUTO_FIX_WORKER_KIND]: [
    // The worker engine: builds the recovery worker and its scan/submit policy.
    'packages/execution-engine/src/auto-fix-recovery.ts',
    // The worker's command vocabulary: the `--auto-fix` flag and intent matching.
    'packages/execution-engine/src/auto-fix-intents.ts',
    // The recovery action this worker drives via its fix-with-agent intents.
    'packages/app/src/workflow-actions.ts',
  ],
};

/**
 * Derive the allowlist of sanctioned recovery-action sites from a worker
 * registry. The set of allowed modules is a function of the registry's entries:
 * only modules declared for an actually-registered worker are sanctioned.
 *
 * Fails fast if a registered worker declares no recovery-action modules — that
 * is the drift the guard exists to catch: a worker that can act on tasks must
 * say which sites are allowed to host its recovery action.
 */
function deriveSanctionedSites(registry: WorkerRegistry): {
  allowlist: Set<string>;
  byKind: Map<string, readonly string[]>;
} {
  const allowlist = new Set<string>();
  const byKind = new Map<string, readonly string[]>();
  for (const definition of registry.list()) {
    const modules = WORKER_RECOVERY_MODULES[definition.kind];
    if (!modules || modules.length === 0) {
      throw new Error(
        `Registered worker '${definition.kind}' declares no sanctioned ` +
          `recovery-action modules. Add its modules to WORKER_RECOVERY_MODULES ` +
          `in this guard so the allowlist tracks the registry.`,
      );
    }
    byKind.set(definition.kind, modules);
    for (const module of modules) allowlist.add(module);
  }
  return { allowlist, byKind };
}

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
      // Tests legitimately call recovery entrypoints; never scan them.
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
function scanForRecoveryTriggers(files: ReadonlyArray<SourceFile>): TriggerHit[] {
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
function findRecoveryViolations(
  files: ReadonlyArray<SourceFile>,
  allowlist: ReadonlySet<string>,
): TriggerHit[] {
  return scanForRecoveryTriggers(files).filter((hit) => !allowlist.has(hit.path));
}

const REPO_ROOT = findRepoRoot();

// The allowlist is derived once from the *actual* built-in worker registry, so
// the guard's sanctioned sites are exactly those backing registered workers.
const BUILT_IN_REGISTRY = registerAutoFixWorker(createWorkerRegistry());
const { allowlist: ALLOWLIST, byKind: SANCTIONED_BY_KIND } =
  deriveSanctionedSites(BUILT_IN_REGISTRY);

describe('no recovery action outside a registered worker', () => {
  it('finds no recovery-action trigger outside the registered-worker sites', () => {
    const files = collectRepoSourceFiles(REPO_ROOT);
    // Sanity: the sweep actually walked a real tree.
    expect(files.length).toBeGreaterThan(50);

    const violations = findRecoveryViolations(files, ALLOWLIST);
    const report = violations
      .map((v) => `  ${v.path}:${v.line}  [${v.signal}]  ${v.text}`)
      .join('\n');

    expect(
      violations,
      `Recovery action triggered outside a registered worker.\n` +
        `Each site below must move into a module owned by a registered worker, ` +
        `or — if it is a newly sanctioned site — be declared in ` +
        `WORKER_RECOVERY_MODULES for the worker that owns it:\n${report}`,
    ).toEqual([]);
  });

  it('derives the allowlist from the registry and its built-in entries', () => {
    // The registry actually has the built-in auto-fix worker...
    const registeredKinds = BUILT_IN_REGISTRY.list().map((d) => d.kind);
    expect(registeredKinds).toContain(AUTO_FIX_WORKER_KIND);

    // ...and the allowlist is exactly the union of declared modules for the
    // kinds the registry reports — not a free-floating hard-coded path list.
    const expected = new Set(
      registeredKinds.flatMap((kind) => SANCTIONED_BY_KIND.get(kind) ?? []),
    );
    expect(ALLOWLIST).toEqual(expected);

    // The auto-fix worker's recovery surface is what makes those sites legal.
    for (const module of WORKER_RECOVERY_MODULES[AUTO_FIX_WORKER_KIND]) {
      expect(ALLOWLIST.has(module)).toBe(true);
    }
  });

  it('fails the build when a registered worker declares no sanctioned modules', () => {
    // A worker registered with a kind the guard does not map must not silently
    // pass: it would be a recovery actor with no declared, reviewable sites.
    const registry = createWorkerRegistry();
    registry.register({
      kind: 'mystery-recovery',
      note: 'Hypothetical worker with no declared recovery-action modules.',
      factory: () => {
        throw new Error('not built in this guard');
      },
    });
    expect(() => deriveSanctionedSites(registry)).toThrow(/mystery-recovery/);
  });

  it('keeps the allowlist honest: every sanctioned file exists and trips a signal', () => {
    const files = collectRepoSourceFiles(REPO_ROOT);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const hitPaths = new Set(scanForRecoveryTriggers(files).map((h) => h.path));

    for (const allowed of ALLOWLIST) {
      // Sanctioned file must still exist (catches stale entries after renames).
      expect(byPath.has(allowed), `Sanctioned file no longer exists: ${allowed}`).toBe(true);
    }
    // At least one sanctioned site must still carry a real signal; if the whole
    // allowlist goes quiet, the signals likely drifted and the guard is no
    // longer watching anything real.
    const allowlistHits = [...hitPaths].filter((p) => ALLOWLIST.has(p));
    expect(allowlistHits.length).toBeGreaterThan(0);
  });

  it('FAILS when a recovery action is added outside any registered worker', () => {
    // Synthetic regression: a new file sneaks in an automatic recovery trigger.
    const planted: SourceFile = {
      path: 'packages/app/src/sneaky-recovery.ts',
      content: [
        'export async function lurk(taskId: string, deps: unknown) {',
        '  await autoFixOnFailure(taskId, deps);',
        '}',
      ].join('\n'),
    };

    const violations = findRecoveryViolations([planted], ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('packages/app/src/sneaky-recovery.ts');
    expect(violations[0]?.signal).toBe('autoFixOnFailure()');
  });

  it('does NOT flag the same call inside a registered-worker module', () => {
    // Identical trigger, but located in a sanctioned site → permitted.
    const sanctioned: SourceFile = {
      path: WORKER_RECOVERY_MODULES[AUTO_FIX_WORKER_KIND][2],
      content: 'await autoFixOnFailure(taskId, deps);',
    };
    expect(findRecoveryViolations([sanctioned], ALLOWLIST)).toEqual([]);
  });

  it('treats a site as sanctioned only while its worker is registered', () => {
    // The clinching difference from the 2h single-path guard: the allowlist is
    // the registry's shadow, not a constant. The exact same recovery action in
    // the exact same file is legal when its worker is registered and a
    // violation when no worker claims it.
    const recoverySite: SourceFile = {
      path: WORKER_RECOVERY_MODULES[AUTO_FIX_WORKER_KIND][2],
      content: 'await autoFixOnFailure(taskId, deps);',
    };

    const withAutoFix = deriveSanctionedSites(
      registerAutoFixWorker(createWorkerRegistry()),
    ).allowlist;
    expect(findRecoveryViolations([recoverySite], withAutoFix)).toEqual([]);

    const emptyRegistry = deriveSanctionedSites(createWorkerRegistry()).allowlist;
    expect(emptyRegistry.size).toBe(0);
    expect(findRecoveryViolations([recoverySite], emptyRegistry)).toHaveLength(1);
  });

  it('detects each distinct trigger signal outside the allowlist', () => {
    const cases: ReadonlyArray<{ content: string; signal: string }> = [
      { content: 'executor.fixWithAgent(taskId, out);', signal: '.fixWithAgent()' },
      { content: "const f = '--auto-fix';", signal: "'--auto-fix' flag" },
      { content: 'bus.publish(AUTO_FIX_RECOVERY_CHANNEL);', signal: 'AUTO_FIX_RECOVERY_CHANNEL' },
      { content: 'await autoFixOnFailure(taskId);', signal: 'autoFixOnFailure()' },
    ];
    for (const c of cases) {
      const file: SourceFile = { path: 'packages/app/src/rogue.ts', content: c.content };
      const violations = findRecoveryViolations([file], ALLOWLIST);
      expect(violations.map((v) => v.signal)).toContain(c.signal);
    }
  });
});
