import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'check-pr-body-keywords-'));

function run(bodyText, declaredUnit) {
  const bodyFile = join(dir, `body-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(bodyFile, bodyText);
  try {
    const stdout = execFileSync(
      'node',
      ['scripts/check-pr-body-keywords.mjs', '--body-file', bodyFile, '--declared-unit', declaredUnit],
      { encoding: 'utf8' },
    );
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout };
  }
}

try {
  // Reproduces the exact failure hit while drafting a real PR body: "stale"
  // trips validation-policy even though the declared unit is routing.
  const bad = run(
    '## Summary\nThis narrows the job and routes it onto a possibly-stale self-hosted runner.\n',
    'routing',
  );
  assert.equal(bad.exitCode, 1, 'a body with a conflicting keyword must exit non-zero');
  assert.match(bad.stdout, /mentions multiple review units/, 'must surface the real validator error text');

  // The reworded version that the real validator actually accepted.
  const good = run(
    '## Summary\nThis narrows the job to just the plan-to-invoker check and the real vitest run.\n',
    'routing',
  );
  assert.equal(good.exitCode, 0, 'a body with no conflicting keyword must exit zero');
  assert.match(good.stdout, /^OK:/, 'must report OK on a clean body');

  // Non-product units (e.g. tooling-policy) alongside the declared product
  // unit must NOT be flagged -- only PRODUCT_REVIEW_UNITS conflicts are real.
  const nonProductMix = run(
    '## Summary\nUpdates ci-regression-watch, a plan-to-invoker formula.\n',
    'routing',
  );
  assert.equal(nonProductMix.exitCode, 0, 'a non-product-unit keyword (tooling-policy) must not be flagged as a conflict');

  // Reproduces the exact false-positive hit while drafting a real PR body:
  // the real validator only scans Summary/Review Claim/Slice Rationale, but
  // this tool used to scan the whole file, so a Test Plan command mentioning
  // "delete" (a cleanup-unit keyword) wrongly flagged an activation-surface PR.
  const testPlanOnly = run(
    '## Summary\nAdds a headless CLI flag.\n\n'
      + '## Review Claim\nApproving one new flag.\n\n'
      + '## Slice Rationale\nStands alone.\n\n'
      + '## Test Plan\n<details>\n<summary>Test Plan</summary>\n\n'
      + "- [ ] `node scripts/test-delete-all.mjs`\n\n</details>\n",
    'activation-surface',
  );
  assert.equal(
    testPlanOnly.exitCode,
    0,
    'a conflicting keyword inside Test Plan (unscanned by the real validator) must not be flagged',
  );

  console.log('PASS: check-pr-body-keywords.mjs matches the real validator on all 4 cases');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
