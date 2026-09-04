import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyWorkflowToWorkerKind,
  listCodexSessionFiles,
  summarizeCodexSessionFile,
  summarizeWorkerSpend,
} from '../spend-attribution.js';
import { E2E_AUTOFIX_WORKER_KIND } from '../workers/e2e-autofix-worker.js';
import { PR_ADMIN_BYPASS_LAND_WORKER_KIND } from '../workers/pr-maintenance-workers.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spend-attribution-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeSession(
  dir: string,
  fileName: string,
  opts: { cwd: string; totalTokens: number; timestamp: string },
): string {
  const path = join(dir, fileName);
  const lines = [
    JSON.stringify({ timestamp: opts.timestamp, type: 'session_meta', payload: { cwd: opts.cwd } }),
    JSON.stringify({
      timestamp: opts.timestamp,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: opts.totalTokens } } },
    }),
  ];
  writeFileSync(path, lines.join('\n'));
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('summarizeCodexSessionFile', () => {
  it('extracts workflowId and total tokens from a real session shape', () => {
    const dir = makeTempDir();
    const path = writeSession(dir, 'rollout-2026-09-04T00-00-00-abc.jsonl', {
      cwd: '/home/invoker/.worktrees/experiment-wf-123-4-fix-ci-g1.t2.a-abc12345',
      totalTokens: 5000,
      timestamp: '2026-09-04T00:00:00.000Z',
    });

    const summary = summarizeCodexSessionFile(path);

    expect(summary.workflowId).toBe('wf-123-4');
    expect(summary.totalTokens).toBe(5000);
    expect(summary.startedAtMs).toBe(Date.parse('2026-09-04T00:00:00.000Z'));
  });

  it('returns undefined fields, not a throw, for an unreadable file', () => {
    const summary = summarizeCodexSessionFile('/nonexistent/rollout-x.jsonl');

    expect(summary.workflowId).toBeUndefined();
    expect(summary.totalTokens).toBeUndefined();
  });

  it('returns undefined fields for a file with malformed JSON lines', () => {
    const dir = makeTempDir();
    const path = join(dir, 'rollout-bad.jsonl');
    writeFileSync(path, 'not json\n{"broken\n');

    const summary = summarizeCodexSessionFile(path);

    expect(summary.workflowId).toBeUndefined();
    expect(summary.totalTokens).toBeUndefined();
  });
});

describe('listCodexSessionFiles', () => {
  it('finds rollout files nested under YYYY/MM/DD', () => {
    const root = makeTempDir();
    const day = join(root, '2026', '09', '04');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-09-04T00-00-00-abc.jsonl'), '');
    writeFileSync(join(root, 'not-a-session.txt'), '');

    const files = listCodexSessionFiles(root);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('rollout-2026-09-04T00-00-00-abc.jsonl');
  });

  it('returns an empty list for a missing directory', () => {
    expect(listCodexSessionFiles('/nonexistent/session/dir')).toEqual([]);
  });
});

describe('classifyWorkflowToWorkerKind', () => {
  it('maps an admin-bypass-repair workflow name to the admin-bypass-land worker kind', () => {
    expect(classifyWorkflowToWorkerKind({ name: 'repair-pr-123-abc12345' })).toBe(
      PR_ADMIN_BYPASS_LAND_WORKER_KIND,
    );
  });

  it('maps an e2e-repair workflow description marker to the e2e-autofix worker kind', () => {
    expect(
      classifyWorkflowToWorkerKind({
        description: 'invoker-ci-regression-watch: first-bad-sha=abc123; job=e2e-proof / shard 2',
      }),
    ).toBe(E2E_AUTOFIX_WORKER_KIND);
  });

  it('classifies an unrelated workflow as unattributed', () => {
    expect(classifyWorkflowToWorkerKind({ name: 'some-other-workflow', description: 'nothing special' }))
      .toBeUndefined();
  });
});

describe('summarizeWorkerSpend', () => {
  it('attributes in-window tokens to the correct worker kind and drops out-of-window sessions', () => {
    const dir = makeTempDir();
    const inWindow = writeSession(dir, 'rollout-in.jsonl', {
      cwd: '/x/experiment-wf-1-1-fix-ci-g1.t1.a-abc',
      totalTokens: 1000,
      timestamp: '2026-09-04T01:00:00.000Z',
    });
    const outOfWindow = writeSession(dir, 'rollout-out.jsonl', {
      cwd: '/x/experiment-wf-2-1-fix-ci-g1.t1.a-abc',
      totalTokens: 9000,
      timestamp: '2026-09-04T00:00:00.000Z',
    });

    const workflows: Record<string, { description: string }> = {
      'wf-1-1': { description: 'invoker-ci-regression-watch: first-bad-sha=abc' },
      'wf-2-1': { description: 'invoker-ci-regression-watch: first-bad-sha=def' },
    };

    const nowMs = Date.parse('2026-09-04T01:05:00.000Z');
    const result = summarizeWorkerSpend(
      [inWindow, outOfWindow],
      (id) => workflows[id],
      { nowMs, windowMs: 30 * 60_000 },
    );

    expect(result.tokensByWorkerKind.get(E2E_AUTOFIX_WORKER_KIND)).toBe(1000);
  });

  it('does not attribute spend from an unclassifiable workflow', () => {
    const dir = makeTempDir();
    const path = writeSession(dir, 'rollout-unrelated.jsonl', {
      cwd: '/x/experiment-wf-9-1-plan-g1.t1.a-abc',
      totalTokens: 500,
      timestamp: '2026-09-04T01:00:00.000Z',
    });

    const result = summarizeWorkerSpend(
      [path],
      () => ({ name: 'some-other-workflow' }),
      { nowMs: Date.parse('2026-09-04T01:05:00.000Z'), windowMs: 30 * 60_000 },
    );

    expect(result.tokensByWorkerKind.size).toBe(0);
  });
});
