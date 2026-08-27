import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const repro = String.raw`
import json

from scripts.mergify_admin_requeue import CheckContext, PrSnapshot, classify_pr

head_sha = "0123456789abcdef0123456789abcdef01234567"
checks = {
    "lint": CheckContext(
        name="lint",
        state="success",
        details_url="https://example.invalid/lint",
        head_sha=head_sha,
        completed_at="2026-08-27T00:00:00Z",
    ),
    "test": CheckContext(
        name="test",
        state="failure",
        details_url="https://example.invalid/test",
        head_sha=head_sha,
        completed_at="2026-08-27T00:00:00Z",
    ),
}
pr = PrSnapshot(
    number=1,
    title="Observed failed CI without Mergify configuration",
    body="",
    url="https://example.invalid/pull/1",
    state="OPEN",
    is_draft=False,
    base_ref_name="main",
    head_ref_name="admin-bypass/no-mergify-repair",
    head_ref_oid=head_sha,
    merge_state_status="CLEAN",
    mergeable="MERGEABLE",
    labels=frozenset({"admin-bypass"}),
    checks=checks,
    review_threads=(),
    latest_mergify=None,
)

blockers = classify_pr(pr, required_checks=(), trunk="main")
print(json.dumps([[blocker.kind, blocker.key] for blocker in blockers]))
`;

describe('admin-bypass observed CI without Mergify configuration', () => {
  it.fails('classifies an observed failed check when required_checks is empty', () => {
    const result = spawnSync('python3', ['-c', repro], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const diagnostics = [
      `python3 exit status: ${String(result.status)}`,
      `python3 error: ${result.error?.message ?? '<none>'}`,
      `python3 stderr:\n${result.stderr || '<empty>'}`,
    ].join('\n');

    expect(result.status, diagnostics).toBe(0);

    let blockers: unknown;
    try {
      blockers = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Could not parse Python stdout as JSON: ${String(error)}\n${diagnostics}`);
    }
    expect(blockers, diagnostics).toEqual([['failed_check', 'test']]);
  });
});
