import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildRemotePathNormalizeFunction } from './remote-shell-fragments.js';

export interface TaskFreshnessAnchor {
  kind: 'path' | 'symbol';
  value: string;
  clause: string;
}

export interface TaskFreshnessSpecification {
  referencedPaths: string[];
  guardedBehaviorIds: string[];
  anchors: TaskFreshnessAnchor[];
}

export type TaskFreshnessDecision =
  | { status: 'current' }
  | {
      status: 'stale';
      snapshotCommit?: string;
      currentCommit: string;
      changedReferencedPaths: string[];
      changedGuardedBehaviorIds: string[];
      missingAnchors: TaskFreshnessAnchor[];
      snapshotUnavailable?: boolean;
      message: string;
    };

const REPO_PATH_PATTERN = /(?:^|[\s`'"(])((?:\.github|corpus|docs|engine|packages|scripts|tests)\/[A-Za-z0-9_@./-]+)/g;
const BACKTICK_TOKEN_PATTERN = /`([^`]+)`/g;
const ANCHOR_CLAUSE_PATTERN = /\b(?:already exists?|existing|do not create|must not create|without creating)\b/i;
const CREATE_PATH_PATTERN = /\b(?:create|creating)\b/i;
const PATH_INTENT_MARKER_PATTERN = /\b(?:do not create|must not create|without creating|create|creating|existing)\b/gi;
const GUARDED_MARKER_PATTERN = /guarded-behavior:\s*([A-Za-z0-9][\w-]*)/gi;
const GUARDED_PROSE_PATTERN = /guarded behavior(?:\s+(?:id|marker))?\s*(?:`|"|')?([A-Za-z0-9][\w-]*)/gi;
const REMOTE_REPORT_MARKER = '__INVOKER_TASK_FRESHNESS_STALE__';
const SENTENCE_BOUNDARY_PATTERN = /\r?\n|(?<=[.!?]["')\]]*)\s+/;

type PathIntent = 'existing' | 'create' | 'reference';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function normalizedRepoPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(REPO_PATH_PATTERN)) {
    const value = match[1]?.replace(/[),.;:]+$/, '');
    if (value && !value.split('/').includes('..')) paths.push(value);
  }
  return uniqueSorted(paths);
}

function pathIntent(text: string): PathIntent {
  if (ANCHOR_CLAUSE_PATTERN.test(text)) return 'existing';
  if (CREATE_PATH_PATTERN.test(text)) return 'create';
  return 'reference';
}

function pathIntentRegions(clause: string): Array<{ text: string; intent: PathIntent }> {
  const boundaries = new Set<number>([0, clause.length]);
  for (let index = 0; index < clause.length; index += 1) {
    if (clause[index] === ';') boundaries.add(index + 1);
  }
  for (const match of clause.matchAll(PATH_INTENT_MARKER_PATTERN)) {
    const markerIndex = match.index;
    if (markerIndex === 0) continue;
    let cursor = markerIndex - 1;
    while (cursor >= 0 && /\s/.test(clause[cursor]!)) cursor -= 1;
    if (clause[cursor] === ',') {
      boundaries.add(markerIndex);
      continue;
    }
    const precedingWordEnd = cursor + 1;
    while (cursor >= 0 && /[A-Za-z]/.test(clause[cursor]!)) cursor -= 1;
    const precedingWord = clause.slice(cursor + 1, precedingWordEnd).toLowerCase();
    if (precedingWord === 'and' || precedingWord === 'but') boundaries.add(markerIndex);
  }
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const regions: Array<{ text: string; intent: PathIntent }> = [];
  for (let index = 1; index < sortedBoundaries.length; index += 1) {
    const text = clause.slice(sortedBoundaries[index - 1], sortedBoundaries[index]).trim();
    if (text) regions.push({ text, intent: pathIntent(text) });
  }
  return regions;
}

export function parseTaskFreshnessSpecification(text: string): TaskFreshnessSpecification {
  const referencedPaths = normalizedRepoPaths(text);
  const guardedBehaviorIds = uniqueSorted([
    ...[...text.matchAll(GUARDED_MARKER_PATTERN)].map(match => match[1]!),
    ...[...text.matchAll(GUARDED_PROSE_PATTERN)].map(match => match[1]!),
  ]);
  const anchors: TaskFreshnessAnchor[] = [];

  for (const rawClause of text.split(SENTENCE_BOUNDARY_PATTERN)) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const paths = normalizedRepoPaths(clause);
    for (const region of pathIntentRegions(clause)) {
      if (region.intent !== 'existing') continue;
      for (const value of normalizedRepoPaths(region.text)) {
        anchors.push({ kind: 'path', value, clause });
      }
    }
    if (!ANCHOR_CLAUSE_PATTERN.test(clause)) continue;
    for (const tokenMatch of clause.matchAll(BACKTICK_TOKEN_PATTERN)) {
      const value = tokenMatch[1]?.trim();
      if (!value || paths.includes(value) || !/^[A-Za-z_$][\w$]*$/.test(value)) continue;
      anchors.push({ kind: 'symbol', value, clause });
    }
  }

  const dedupedAnchors = new Map<string, TaskFreshnessAnchor>();
  for (const anchor of anchors) dedupedAnchors.set(`${anchor.kind}:${anchor.value}`, anchor);

  return {
    referencedPaths,
    guardedBehaviorIds,
    anchors: [...dedupedAnchors.values()].sort((left, right) =>
      `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)),
  };
}

export function evaluateTaskFreshness(args: {
  snapshotCommit?: string;
  currentCommit: string;
  specification: TaskFreshnessSpecification;
  changedPaths: string[];
  changedGuardedBehaviorIds: string[];
  missingAnchors: TaskFreshnessAnchor[];
}): TaskFreshnessDecision {
  const {
    snapshotCommit,
    currentCommit,
    specification,
    changedPaths,
    changedGuardedBehaviorIds,
    missingAnchors,
  } = args;
  const commitsDiffer = Boolean(snapshotCommit && snapshotCommit !== currentCommit);
  const referencedPathSet = new Set(specification.referencedPaths);
  const guardedIdSet = new Set(specification.guardedBehaviorIds);
  const changedReferencedPaths = commitsDiffer
    ? uniqueSorted(changedPaths.filter(path => referencedPathSet.has(path)))
    : [];
  const changedRelevantGuardIds = commitsDiffer
    ? uniqueSorted(changedGuardedBehaviorIds.filter(id => guardedIdSet.has(id)))
    : [];

  if (
    changedReferencedPaths.length === 0
    && changedRelevantGuardIds.length === 0
    && missingAnchors.length === 0
  ) {
    return { status: 'current' };
  }

  const mismatchDetails = [
    changedReferencedPaths.length > 0
      ? `changed referenced paths: ${changedReferencedPaths.join(', ')}`
      : undefined,
    changedRelevantGuardIds.length > 0
      ? `changed guarded behaviors: ${changedRelevantGuardIds.join(', ')}`
      : undefined,
    missingAnchors.length > 0
      ? `absent existing/do-not-create anchors: ${missingAnchors.map(anchor => `${anchor.kind}:${anchor.value}`).join(', ')}`
      : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    status: 'stale',
    snapshotCommit,
    currentCommit,
    changedReferencedPaths,
    changedGuardedBehaviorIds: changedRelevantGuardIds,
    missingAnchors,
    message:
      `Stale task specification blocked before agent execution `
      + `(snapshot=${snapshotCommit ?? 'none'}, current=${currentCommit}): ${mismatchDetails.join('; ')}. `
      + 'Required action: replan/recreate from current repository state; do not reconstruct an absent baseline.',
  };
}

export async function inspectTaskFreshness(args: {
  cwd: string;
  snapshotCommit?: string;
  taskText: string;
  runGit: (gitArgs: string[]) => Promise<string>;
  pathExists?: (absolutePath: string) => Promise<boolean>;
  symbolExists?: (symbol: string, commit: string) => Promise<boolean>;
}): Promise<TaskFreshnessDecision> {
  const specification = parseTaskFreshnessSpecification(args.taskText);
  const currentCommit = (await args.runGit(['rev-parse', 'HEAD'])).trim();
  const commitsDiffer = Boolean(args.snapshotCommit && args.snapshotCommit !== currentCommit);
  if (commitsDiffer) {
    try {
      await args.runGit(['cat-file', '-e', `${args.snapshotCommit!}^{commit}`]);
    } catch {
      return {
        status: 'stale',
        snapshotCommit: args.snapshotCommit,
        currentCommit,
        changedReferencedPaths: [],
        changedGuardedBehaviorIds: [],
        missingAnchors: [],
        snapshotUnavailable: true,
        message:
          `Stale task specification blocked before agent execution `
          + `(snapshot=${args.snapshotCommit}, current=${currentCommit}): snapshot commit is unavailable. `
          + 'Required action: replan/recreate from current repository state; do not reconstruct an absent baseline.',
      };
    }
  }
  const changedPaths = commitsDiffer
    ? (await args.runGit(['diff', '--name-only', args.snapshotCommit!, currentCommit, '--']))
      .split(/\r?\n/)
      .map(path => path.trim())
      .filter(Boolean)
    : [];

  const changedGuardedBehaviorIds: string[] = [];
  if (commitsDiffer && specification.guardedBehaviorIds.length > 0 && changedPaths.length > 0) {
    const diff = await args.runGit(['diff', '--unified=0', args.snapshotCommit!, currentCommit, '--', ...changedPaths]);
    for (const id of specification.guardedBehaviorIds) {
      const marker = `guarded-behavior: ${id}`;
      const ownerPaths = new Set<string>();
      for (const commit of [args.snapshotCommit!, currentCommit]) {
        try {
          const matches = await args.runGit(['grep', '-l', '-F', '-e', marker, commit, '--']);
          for (const rawPath of matches.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
            ownerPaths.add(rawPath.startsWith(`${commit}:`) ? rawPath.slice(commit.length + 1) : rawPath);
          }
        } catch {
          continue;
        }
      }
      if (diff.includes(marker) || changedPaths.some(path => ownerPaths.has(path))) {
        changedGuardedBehaviorIds.push(id);
      }
    }
  }

  const pathExists = args.pathExists ?? (async (absolutePath: string) => {
    try {
      await access(absolutePath);
      return true;
    } catch {
      return false;
    }
  });
  const symbolExists = args.symbolExists ?? (async (symbol: string, commit: string) => {
    try {
      await args.runGit(['grep', '-F', '-e', symbol, commit, '--']);
      return true;
    } catch {
      return false;
    }
  });
  const missingAnchors: TaskFreshnessAnchor[] = [];
  for (const anchor of specification.anchors) {
    const exists = anchor.kind === 'path'
      ? await pathExists(resolve(args.cwd, anchor.value))
      : await symbolExists(anchor.value, currentCommit);
    if (!exists) missingAnchors.push(anchor);
  }

  return evaluateTaskFreshness({
    snapshotCommit: args.snapshotCommit,
    currentCommit,
    specification,
    changedPaths,
    changedGuardedBehaviorIds,
    missingAnchors,
  });
}

export interface RemoteTaskFreshnessReport {
  currentCommit: string;
  reasons: string[];
}

export function buildRemoteTaskFreshnessScript(args: {
  cwd: string;
  snapshotCommit?: string;
  taskText: string;
}): string {
  const specification = parseTaskFreshnessSpecification(args.taskText);
  const lines = [
    'set -euo pipefail',
    buildRemotePathNormalizeFunction(),
    `CWD=$(normalize_remote_path ${shellQuote(args.cwd)})`,
    'cd "$CWD"',
    'CURRENT_COMMIT=$(git rev-parse HEAD)',
    'STALE_REASONS=""',
    'append_stale_reason() {',
    '  if [[ -n "$STALE_REASONS" ]]; then STALE_REASONS="$STALE_REASONS|$1"; else STALE_REASONS=$1; fi',
    '}',
  ];

  for (const anchor of specification.anchors) {
    if (anchor.kind === 'path') {
      lines.push(
        `if [[ ! -e ${shellQuote(anchor.value)} ]]; then append_stale_reason ${shellQuote(`anchor:path:${anchor.value}`)}; fi`,
      );
    } else {
      lines.push(
        `if ! git grep -F -q -e ${shellQuote(anchor.value)} "$CURRENT_COMMIT" --; then append_stale_reason ${shellQuote(`anchor:symbol:${anchor.value}`)}; fi`,
      );
    }
  }

  if (args.snapshotCommit) {
    lines.push(
      `SNAPSHOT_COMMIT=${shellQuote(args.snapshotCommit)}`,
      'if [[ "$SNAPSHOT_COMMIT" != "$CURRENT_COMMIT" ]]; then',
      '  if ! git cat-file -e "$SNAPSHOT_COMMIT^{commit}" 2>/dev/null; then',
      "    append_stale_reason 'snapshot-unavailable'",
      '  else',
      '    CHANGED_PATHS=$(git diff --name-only "$SNAPSHOT_COMMIT" "$CURRENT_COMMIT" --)',
    );
    for (const path of specification.referencedPaths) {
      lines.push(
        `    if printf '%s\n' "$CHANGED_PATHS" | grep -F -x -q -- ${shellQuote(path)}; then append_stale_reason ${shellQuote(`path:${path}`)}; fi`,
      );
    }
    if (specification.guardedBehaviorIds.length > 0) {
      lines.push('    GUARDED_DIFF=$(git diff --unified=0 "$SNAPSHOT_COMMIT" "$CURRENT_COMMIT" --)');
      for (const id of specification.guardedBehaviorIds) {
        lines.push(
          `    if printf '%s\n' "$GUARDED_DIFF" | grep -F -q -- ${shellQuote(`guarded-behavior: ${id}`)}; then append_stale_reason ${shellQuote(`guard:${id}`)}; fi`,
        );
      }
    }
    lines.push('  fi', 'fi');
  }

  lines.push(
    'if [[ -n "$STALE_REASONS" ]]; then',
    `  printf '%s\\t%s\\t%s\\n' ${shellQuote(REMOTE_REPORT_MARKER)} "$CURRENT_COMMIT" "$STALE_REASONS"`,
    'fi',
  );
  return `${lines.join('\n')}\n`;
}

export function parseRemoteTaskFreshnessReport(output: string): RemoteTaskFreshnessReport | undefined {
  const prefix = `${REMOTE_REPORT_MARKER}\t`;
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  if (!line) return undefined;
  const [, currentCommit = '', rawReasons = ''] = line.split('\t');
  const reasons = rawReasons.split('|').map(value => value.trim()).filter(Boolean);
  if (!currentCommit || reasons.length === 0) return undefined;
  return { currentCommit, reasons };
}

export function formatRemoteTaskFreshnessMessage(
  snapshotCommit: string | undefined,
  report: RemoteTaskFreshnessReport,
): string {
  return `Stale task specification blocked before agent execution `
    + `(snapshot=${snapshotCommit ?? 'none'}, current=${report.currentCommit}): ${report.reasons.join(', ')}. `
    + 'Required action: replan/recreate from current repository state; do not reconstruct an absent baseline.';
}
