#!/usr/bin/env node
import { classifyReviewUnitsForPath } from '../review-unit-rules.mjs';

const path = 'packages/app/src/web/web-invoker-dispatch.ts';
const result = classifyReviewUnitsForPath(path);

console.log(JSON.stringify(result));

if (JSON.stringify(result) !== '["activation-surface"]') {
  process.exit(1);
}
