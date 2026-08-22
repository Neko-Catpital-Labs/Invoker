import { validateSingleReviewUnitFocus } from '../review-unit-rules.mjs';

// Shaped after PR #10147: a single-file test-only fix (declared Review Unit:
// proof) whose Summary references a file under packages/contracts/ (matches
// the "contract" prose pattern) and whose Review Claim calls out "stale"
// assertions (matches the "validation-policy" prose pattern). Neither usage
// declares real product work; a proof-lane PR describing the product code it
// tests should not be flagged for spanning multiple product review units.
const texts = [
  "The prompt is now built by packages/contracts/src/planning-surface.ts's planningHostContext.",
  "Approve updating one repro test's stale prompt-substring assertions to match already-shipped wording.",
];

const withProofUnit = validateSingleReviewUnitFocus({
  texts,
  context: 'PR body',
  declaredReviewUnit: 'proof',
});
if (withProofUnit.length !== 0) {
  console.error(`FAIL: proof-lane PR body flagged: ${JSON.stringify(withProofUnit)}`);
  process.exit(1);
}

// A behavior-lane PR declaring a product review unit must still be flagged
// when its prose spans multiple product review units -- this guard must not
// blanket-disable the check.
const withBehaviorUnit = validateSingleReviewUnitFocus({
  texts,
  context: 'PR body',
  declaredReviewUnit: 'validation-policy',
});
if (withBehaviorUnit.length === 0) {
  console.error('FAIL: behavior-lane PR body with multi-unit prose was not flagged');
  process.exit(1);
}

console.log('OK: proof-lane prose is exempt from the multi-review-unit prose scan; product-lane prose is still checked');
process.exit(0);
