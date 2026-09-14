import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/sum.mjs';

test('sum adds two numbers', () => {
  assert.equal(sum(2, 2), 4);
});
