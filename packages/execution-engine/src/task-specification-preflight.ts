import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskFreshnessSpec } from '@invoker/workflow-core';
import { buildRemotePathNormalizeFunction } from './remote-shell-fragments.js';

export type TaskFreshnessDecision =
  | { status: 'current' }
  | { status: 'stale'; snapshotCommit?: string; currentCommit: string; changedReferencedPaths: string[]; changedGuardedBehaviorIds: string[]; missingPathPreconditions: string[]; snapshotUnavailable?: boolean; message: string };

const REMOTE_REPORT_MARKER = '__INVOKER_TASK_FRESHNESS_STALE__';
const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort();
const staleMessage = (snapshot: string | undefined, current: string, details: string) =>
  `Stale task specification blocked before agent execution (snapshot=${snapshot ?? 'none'}, current=${current}): ${details}. Required action: replan/recreate from current repository state; do not reconstruct an absent baseline.`;

export function evaluateTaskFreshness(args: {
  snapshotCommit?: string; currentCommit: string; specification?: TaskFreshnessSpec;
  changedPaths: string[]; changedGuardedBehaviorIds: string[]; missingPathPreconditions: string[];
}): TaskFreshnessDecision {
  const spec = args.specification;
  if (!spec) return { status: 'current' };
  const differs = Boolean(args.snapshotCommit && args.snapshotCommit !== args.currentCommit);
  const changedReferencedPaths = differs ? uniqueSorted(args.changedPaths.filter(path => (spec.watchPaths ?? []).includes(path))) : [];
  const changedGuardedBehaviorIds = differs ? uniqueSorted(args.changedGuardedBehaviorIds.filter(id => (spec.guardedBehaviorIds ?? []).includes(id))) : [];
  const missingPathPreconditions = uniqueSorted(args.missingPathPreconditions);
  if (!changedReferencedPaths.length && !changedGuardedBehaviorIds.length && !missingPathPreconditions.length) return { status: 'current' };
  const details = [
    changedReferencedPaths.length && `changed watched paths: ${changedReferencedPaths.join(', ')}`,
    changedGuardedBehaviorIds.length && `changed guarded behaviors: ${changedGuardedBehaviorIds.join(', ')}`,
    missingPathPreconditions.length && `path preconditions failed: ${missingPathPreconditions.join(', ')}`,
  ].filter(Boolean).join('; ');
  return { status: 'stale', snapshotCommit: args.snapshotCommit, currentCommit: args.currentCommit, changedReferencedPaths, changedGuardedBehaviorIds, missingPathPreconditions, message: staleMessage(args.snapshotCommit, args.currentCommit, details) };
}

export async function inspectTaskFreshness(args: {
  cwd: string; snapshotCommit?: string; freshness?: TaskFreshnessSpec;
  runGit: (gitArgs: string[]) => Promise<string>; pathExists?: (absolutePath: string) => Promise<boolean>;
}): Promise<TaskFreshnessDecision> {
  const currentCommit = (await args.runGit(['rev-parse', 'HEAD'])).trim();
  if (!args.freshness) return { status: 'current' };
  const differs = Boolean(args.snapshotCommit && args.snapshotCommit !== currentCommit);
  if (differs) {
    try { await args.runGit(['cat-file', '-e', `${args.snapshotCommit!}^{commit}`]); }
    catch { return { status: 'stale', snapshotCommit: args.snapshotCommit, currentCommit, changedReferencedPaths: [], changedGuardedBehaviorIds: [], missingPathPreconditions: [], snapshotUnavailable: true, message: staleMessage(args.snapshotCommit, currentCommit, 'snapshot commit is unavailable') }; }
  }
  const changedPaths = differs ? (await args.runGit(['diff', '--name-only', args.snapshotCommit!, currentCommit, '--'])).split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
  const changedGuardedBehaviorIds: string[] = [];
  if (differs && (args.freshness.guardedBehaviorIds?.length ?? 0) && changedPaths.length) {
    const diff = await args.runGit(['diff', '--unified=0', args.snapshotCommit!, currentCommit, '--', ...changedPaths]);
    for (const id of args.freshness.guardedBehaviorIds ?? []) if (diff.includes(`guarded-behavior: ${id}`)) changedGuardedBehaviorIds.push(id);
  }
  const pathExists = args.pathExists ?? (async (path: string) => { try { await access(path); return true; } catch { return false; } });
  const missingPathPreconditions: string[] = [];
  for (const precondition of args.freshness.pathPreconditions ?? []) {
    const exists = await pathExists(resolve(args.cwd, precondition.path));
    if ((precondition.expected === 'present' && !exists) || (precondition.expected === 'absent' && exists)) missingPathPreconditions.push(`${precondition.path} expected ${precondition.expected}`);
  }
  return evaluateTaskFreshness({ snapshotCommit: args.snapshotCommit, currentCommit, specification: args.freshness, changedPaths, changedGuardedBehaviorIds, missingPathPreconditions });
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `\'"'"'`)}'`;
export interface RemoteTaskFreshnessReport { currentCommit: string; reasons: string[]; }

export function buildRemoteTaskFreshnessScript(args: { cwd: string; snapshotCommit?: string; freshness?: TaskFreshnessSpec }): string {
  const spec = args.freshness;
  if (!spec) return ': # no typed freshness metadata\n';
  const lines = ['set -euo pipefail', buildRemotePathNormalizeFunction(), `CWD=$(normalize_remote_path ${shellQuote(args.cwd)})`, 'cd "$CWD"', 'CURRENT_COMMIT=$(git rev-parse HEAD)', 'STALE_REASONS=""', 'append_stale_reason() { if [[ -n "$STALE_REASONS" ]]; then STALE_REASONS="$STALE_REASONS|$1"; else STALE_REASONS=$1; fi; }'];
  for (const p of spec.pathPreconditions ?? []) { const test = p.expected === 'present' ? '-e' : '! -e'; lines.push(`if [[ ${test} ${shellQuote(p.path)} ]]; then :; else append_stale_reason ${shellQuote(`path:${p.path}:expected-${p.expected}`)}; fi`); }
  if (args.snapshotCommit) {
    lines.push(`SNAPSHOT_COMMIT=${shellQuote(args.snapshotCommit)}`, 'if [[ "$SNAPSHOT_COMMIT" != "$CURRENT_COMMIT" ]]; then', '  if ! git cat-file -e "$SNAPSHOT_COMMIT^{commit}" 2>/dev/null; then append_stale_reason snapshot-unavailable; else', '    CHANGED_PATHS=$(git diff --name-only "$SNAPSHOT_COMMIT" "$CURRENT_COMMIT" --)');
    for (const path of spec.watchPaths ?? []) lines.push(`    if printf '%s\\n' "$CHANGED_PATHS" | grep -F -x -q -- ${shellQuote(path)}; then append_stale_reason ${shellQuote(`path:${path}`)}; fi`);
    if (spec.guardedBehaviorIds?.length) { lines.push('    GUARDED_DIFF=$(git diff --unified=0 "$SNAPSHOT_COMMIT" "$CURRENT_COMMIT" --)'); for (const id of spec.guardedBehaviorIds) lines.push(`    if printf '%s\\n' "$GUARDED_DIFF" | grep -F -q -- ${shellQuote(`guarded-behavior: ${id}`)}; then append_stale_reason ${shellQuote(`guard:${id}`)}; fi`); }
    lines.push('  fi', 'fi');
  }
  lines.push('if [[ -n "$STALE_REASONS" ]]; then', `  printf '%s\\t%s\\t%s\\n' ${shellQuote(REMOTE_REPORT_MARKER)} "$CURRENT_COMMIT" "$STALE_REASONS"`, 'fi');
  return `${lines.join('\n')}\n`;
}

export function parseRemoteTaskFreshnessReport(output: string): RemoteTaskFreshnessReport | undefined {
  const line = output.split(/\r?\n/).find(value => value.startsWith(`${REMOTE_REPORT_MARKER}\t`));
  if (!line) return undefined;
  const [, currentCommit = '', rawReasons = ''] = line.split('\t'); const reasons = rawReasons.split('|').filter(Boolean);
  return currentCommit && reasons.length ? { currentCommit, reasons } : undefined;
}
export const formatRemoteTaskFreshnessMessage = (snapshot: string | undefined, report: RemoteTaskFreshnessReport) => staleMessage(snapshot, report.currentCommit, report.reasons.join(', '));
