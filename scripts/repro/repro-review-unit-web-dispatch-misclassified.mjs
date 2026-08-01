import { classifyReviewUnitsForPath } from '../review-unit-rules.mjs';

const path = 'packages/app/src/web/web-invoker-dispatch.ts';
const result = classifyReviewUnitsForPath(path);
console.log(path, '->', JSON.stringify(result));
if (JSON.stringify(result) !== JSON.stringify(['activation-surface'])) {
  console.error(`FAIL: expected ["activation-surface"], got ${JSON.stringify(result)}`);
  process.exit(1);
}
process.exit(0);
