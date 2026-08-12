#!/usr/bin/env node

import assert from 'node:assert/strict';
import { isActionsConcurrencyExhausted } from './gh-actions-concurrency-exhausted.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function createHarness(counts, initialState = undefined) {
  const path = 'fake-state.json';
  const states = new Map();
  const writes = [];
  if (initialState) {
    states.set(path, initialState);
  }

  return {
    path,
    writes,
    call(options = {}) {
      return isActionsConcurrencyExhausted({
        listQueuedRunCount: () => counts.shift(),
        debounceStatePath: path,
        threshold: 10,
        requiredConsecutivePolls: 3,
        readState: (statePath) => states.get(statePath) ?? { consecutiveExhausted: 0 },
        writeState: (statePath, state) => {
          writes.push({ statePath, state });
          states.set(statePath, state);
        },
        ...options,
      });
    },
    readState() {
      return states.get(path) ?? { consecutiveExhausted: 0 };
    },
  };
}

test('count below threshold never trips consecutiveExhausted above 0', () => {
  const harness = createHarness([0, 9, 4], { consecutiveExhausted: 2 });

  assert.equal(harness.call(), false);
  assert.equal(harness.call(), false);
  assert.equal(harness.call(), false);

  assert.deepEqual(harness.readState(), { consecutiveExhausted: 0 });
  assert.deepEqual(harness.writes.map((write) => write.state), [
    { consecutiveExhausted: 0 },
    { consecutiveExhausted: 0 },
    { consecutiveExhausted: 0 },
  ]);
});

test('threshold streak returns true only on requiredConsecutivePolls call', () => {
  const harness = createHarness([10, 11, 12]);

  assert.equal(harness.call(), false);
  assert.equal(harness.call(), false);
  assert.equal(harness.call(), true);

  assert.deepEqual(harness.writes.map((write) => write.state), [
    { consecutiveExhausted: 1 },
    { consecutiveExhausted: 2 },
    { consecutiveExhausted: 3 },
  ]);
});

test('below-threshold poll resets an in-progress streak back to 0', () => {
  const harness = createHarness([15, 15, 8, 15]);

  assert.equal(harness.call(), false);
  assert.equal(harness.call(), false);
  assert.equal(harness.call(), false);
  assert.equal(harness.call(), false);

  assert.deepEqual(harness.writes.map((write) => write.state), [
    { consecutiveExhausted: 1 },
    { consecutiveExhausted: 2 },
    { consecutiveExhausted: 0 },
    { consecutiveExhausted: 1 },
  ]);
});

test('state access is fully routed through injected fakes', () => {
  const calls = [];

  const result = isActionsConcurrencyExhausted({
    listQueuedRunCount: () => {
      calls.push(['listQueuedRunCount']);
      return 40;
    },
    debounceStatePath: 'injected-state.json',
    threshold: 40,
    requiredConsecutivePolls: 2,
    readState: (statePath) => {
      calls.push(['readState', statePath]);
      return { consecutiveExhausted: 1 };
    },
    writeState: (statePath, state) => {
      calls.push(['writeState', statePath, state]);
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [
    ['listQueuedRunCount'],
    ['readState', 'injected-state.json'],
    ['writeState', 'injected-state.json', { consecutiveExhausted: 2 }],
  ]);
});

console.log(`passed ${passed} tests`);
