import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  detectReviewUnits,
  detectReviewUnitTriggerWords,
  validateChangeTypeItems,
  validateReviewUnitFocus,
  validateSingleReviewUnitFocus,
} from './review-unit-rules.mjs';

const context = 'PR body';
const pathOnlyBody = 'Routes the chain wrapper through scripts/submit-workflow-chain.sh.';

assert.ok(
  detectReviewUnits(pathOnlyBody).has('write-path'),
  'raw keyword matching sees "submit" inside the path, which is what flagged this body before path blanking',
);
assert.deepEqual(
  validateSingleReviewUnitFocus({ texts: [pathOnlyBody], context }),
  [],
  'a body naming scripts/submit-workflow-chain.sh with no other write-path keyword must not be flagged for multiple units',
);
assert.deepEqual(
  validateReviewUnitFocus({ declaredReviewUnit: 'routing', texts: [pathOnlyBody], context }),
  [],
  'a routing body naming scripts/submit-workflow-chain.sh must not be flagged for write-path',
);
assert.deepEqual(
  validateReviewUnitFocus({
    declaredReviewUnit: 'routing',
    texts: ['Routes the chain wrapper through submit-workflow-chain.sh.'],
    context,
  }),
  [],
  'a bare file name ending in an extension must not count as a unit keyword',
);
assert.deepEqual(
  validateReviewUnitFocus({
    declaredReviewUnit: 'routing',
    texts: ['Routes events (see `scripts/enqueue-wakeup.mjs`), then docs/submit notes.'],
    context,
  }),
  [],
  'path tokens wrapped in backticks, parentheses, or trailing punctuation must still be blanked',
);
assert.ok(
  !detectReviewUnitTriggerWords('Create scripts/x.mjs mutation intents and route them.').has('write-path'),
  'blanking a path must not join its neighbours into a multi-word keyword',
);

const proseSubmitErrors = validateSingleReviewUnitFocus({
  texts: ['Routes the plan and then we submit it.'],
  context,
});
assert.equal(proseSubmitErrors.length, 1, 'prose "submit" alongside routing prose must still be flagged');
assert.match(proseSubmitErrors[0], /mentions multiple review units \(write-path, routing\)/);
assert.match(proseSubmitErrors[0], /write-path: "submit"/, 'multiple-units message must name the write-path trigger word');
assert.match(proseSubmitErrors[0], /routing: "routes"/, 'multiple-units message must name the routing trigger word');

const mixedErrors = validateSingleReviewUnitFocus({
  texts: ['Submit the plan through scripts/submit-workflow-chain.sh and route it.'],
  context,
});
assert.equal(mixedErrors.length, 1, 'prose "submit" next to a submit path must still be flagged');
assert.match(mixedErrors[0], /write-path: "submit"; routing: "route"\.$/);
assert.doesNotMatch(mixedErrors[0], /submit-workflow-chain/, 'path tokens must never be reported as trigger words');

const mismatchErrors = validateReviewUnitFocus({
  declaredReviewUnit: 'routing',
  texts: ['Submits the plan.'],
  context,
});
assert.deepEqual(mismatchErrors, [
  'PR body Review Unit "routing" does not match the described write-path work. Trigger words: write-path: "submits".',
]);

const docsMixErrors = validateSingleReviewUnitFocus({
  texts: ['Update the docs and route wakeups.'],
  context,
});
assert.deepEqual(docsMixErrors, [
  'PR body mixes docs language with product-unit language; split docs from implementation policy. Trigger words: routing: "route", "wakeups"; docs: "docs".',
]);

assert.deepEqual(
  validateSingleReviewUnitFocus({
    texts: ['Routes the plan.', 'Submit it through scripts/separate-queue.sh.'],
    context,
  }),
  [],
  'a line excluded by an exclusion word inside a path must stay excluded',
);

assert.equal(
  validateChangeTypeItems('- scripts/enqueue-wakeup.sh: rewrite', context).length,
  1,
  'change types validation must keep matching keywords inside paths',
);

assert.equal(
  readFileSync(new URL('../skills/plan-to-invoker/scripts/vendor/review-unit-rules.mjs', import.meta.url), 'utf8'),
  readFileSync(new URL('./review-unit-rules.mjs', import.meta.url), 'utf8'),
  'vendored review-unit-rules.mjs must be byte-identical to scripts/review-unit-rules.mjs',
);

console.log('review-unit trigger words: ok');
