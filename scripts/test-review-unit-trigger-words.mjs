import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  blankPathLikeTokens,
  detectReviewUnitTriggers,
  detectReviewUnits,
  validateReviewUnitFocus,
  validateSingleReviewUnitFocus,
} from './review-unit-rules.mjs';

const canonical = readFileSync(new URL('./review-unit-rules.mjs', import.meta.url));
const vendored = readFileSync(new URL('../skills/plan-to-invoker/scripts/vendor/review-unit-rules.mjs', import.meta.url));
assert.ok(canonical.equals(vendored), 'vendored review-unit-rules.mjs must be byte-identical to scripts/review-unit-rules.mjs');

const pathOnlyTexts = ['Wake the routing worker after scripts/submit-workflow-chain.sh finishes.'];
assert.deepEqual(
  [...detectReviewUnits(pathOnlyTexts[0])],
  ['routing'],
  'a file path must not count as a write-path keyword',
);
assert.deepEqual(validateSingleReviewUnitFocus({ texts: pathOnlyTexts, context: 'PR body' }), []);
assert.deepEqual(validateReviewUnitFocus({ declaredReviewUnit: 'routing', texts: pathOnlyTexts, context: 'PR body' }), []);

for (const [pathToken, unit] of [
  ['`scripts/submit-workflow-chain.sh`', 'write-path'],
  ['(scripts/submit-workflow-chain.sh).', 'write-path'],
  ['scripts/submit', 'write-path'],
  ['skills/workflow-chain-submit/', 'write-path'],
  ['skills/chat-submit/SKILL.md,', 'write-path'],
  ['submit-workflow-chain.sh', 'write-path'],
  ['https://github.com/Neko-Catpital-Labs/Invoker/blob/master/scripts/submit-workflow-chain.sh', 'write-path'],
  ['packages/contracts', 'contract'],
]) {
  assert.equal(detectReviewUnits(`Covers ${pathToken} only.`).has(unit), false, `path token must be blanked: ${pathToken}`);
}

const proseTexts = ['Submit the chain and route the wakeup to the worker.'];
const proseErrors = validateSingleReviewUnitFocus({ texts: proseTexts, context: 'PR body' });
assert.equal(proseErrors.length, 1);
assert.match(proseErrors[0], /mentions multiple review units \(write-path, routing\); split into one conceptual unit per diff\/task\./);
assert.match(proseErrors[0], /Matched words: write-path \[submit\]; routing \[route, wakeup\]\.$/);

const mismatchErrors = validateReviewUnitFocus({
  declaredReviewUnit: 'routing',
  texts: ['Submit the chain from scripts/route-worker.mjs.'],
  context: 'PR body',
});
assert.deepEqual(mismatchErrors, [
  'PR body Review Unit "routing" does not match the described write-path work. Matched words: write-path [submit].',
]);

const docsErrors = validateSingleReviewUnitFocus({ texts: ['Update the docs and submit the chain.'], context: 'plan' });
assert.deepEqual(docsErrors, [
  'plan mixes docs language with product-unit language; split docs from implementation policy. Matched words: write-path [submit]; docs [docs].',
]);

assert.equal(detectReviewUnits('Keep submit/enqueue ordering intact.').has('write-path'), true, 'slash-joined prose words still count');
assert.equal(detectReviewUnits('Submit it after scripts/x.sh runs.').has('write-path'), true, 'prose next to a path still counts');
assert.equal(
  detectReviewUnits('Create scripts/x.sh mutation intent handling.').has('write-path'),
  false,
  'blanking a path must not join the surrounding words into a new multi-word keyword',
);
assert.equal(blankPathLikeTokens('run scripts/x.sh now').includes('scripts'), false);
assert.deepEqual(
  Object.fromEntries(detectReviewUnitTriggers('Submits it, then submitted it again, and lists the queue.')),
  { 'read-path': ['lists'], 'write-path': ['submits', 'submitted'] },
);

const dir = mkdtempSync(join(tmpdir(), 'review-unit-trigger-words-'));
function checkBody(bodyText, declaredUnit) {
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
  const pathBody = checkBody(
    '## Summary\nRoute the wakeup after scripts/submit-workflow-chain.sh exits.\n\n## Review Claim\nOne routing change.\n',
    'routing',
  );
  assert.equal(pathBody.exitCode, 0, `a body naming scripts/submit-workflow-chain.sh must pass:\n${pathBody.stdout}`);

  const proseBody = checkBody(
    '## Summary\nSubmit the chain and route the wakeup.\n\n## Review Claim\nOne routing change.\n',
    'routing',
  );
  assert.equal(proseBody.exitCode, 1, 'a body using submit in prose must still be flagged');
  assert.match(proseBody.stdout, /mentions multiple review units \(write-path, routing\).*Matched words: write-path \[submit\]/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('review-unit trigger-word tests passed');
