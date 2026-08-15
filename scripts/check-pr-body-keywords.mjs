#!/usr/bin/env node
// Pre-flight check for scripts/validate-pr-body.mjs's review-unit keyword
// scan, run BEFORE drafting is considered done, not discovered by trial and
// error against the full validator. Calls the same exported validators the
// real check uses (validateSingleReviewUnitFocus, validateReviewUnitFocus)
// instead of re-deriving the product-vs-non-product unit distinction, so
// this can never drift out of sync with what CI actually enforces.
import { readFileSync } from 'node:fs';
import {
  validateSingleReviewUnitFocus,
  validateReviewUnitFocus,
  VALID_REVIEW_UNITS,
} from './review-unit-rules.mjs';

function parseArgs(argv) {
  const args = { bodyFile: null, declaredUnit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--body-file') args.bodyFile = argv[++i];
    else if (argv[i] === '--declared-unit') args.declaredUnit = argv[++i];
  }
  return args;
}

function main() {
  const { bodyFile, declaredUnit } = parseArgs(process.argv.slice(2));
  if (!bodyFile || !declaredUnit) {
    console.error('Usage: node scripts/check-pr-body-keywords.mjs --body-file <path> --declared-unit <unit>');
    console.error(`Valid units: ${VALID_REVIEW_UNITS.join(', ')}`);
    process.exit(2);
  }
  if (!VALID_REVIEW_UNITS.includes(declaredUnit)) {
    console.error(`Unknown declared unit "${declaredUnit}". Valid units: ${VALID_REVIEW_UNITS.join(', ')}`);
    process.exit(2);
  }

  const text = readFileSync(bodyFile, 'utf8');
  const errors = [...new Set([
    ...validateSingleReviewUnitFocus({ texts: [text], context: 'PR body' }),
    ...validateReviewUnitFocus({ declaredReviewUnit: declaredUnit, texts: [text], context: 'PR body' }),
  ])];

  if (errors.length === 0) {
    console.log(`OK: no review-unit keyword conflicts with declared unit "${declaredUnit}".`);
    process.exit(0);
  }

  console.log(`Prose conflicts with declared unit "${declaredUnit}":`);
  for (const err of errors) {
    console.log(`  - ${err}`);
  }
  console.log('\nReword the flagged language before running the full validator, or the same');
  console.log('trial-and-error loop this check exists to short-circuit will happen anyway.');
  process.exit(1);
}

main();
