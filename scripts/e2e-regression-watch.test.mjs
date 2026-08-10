import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { liveQueryHasNonTerminalWork, buildMarker } from './e2e-regression-watch.mjs';

describe('liveQueryHasNonTerminalWork', () => {
  it('detects non-terminal work from a matching marker in valid JSON', () => {
    const queryFn = () => JSON.stringify([
      { status: 'running', description: `filed via ${buildMarker('abc1234', 'build')}` },
    ]);
    assert.equal(
      liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn),
      true,
    );
  });

  it('returns false when no live workflow matches the marker', () => {
    const queryFn = () => JSON.stringify([
      { status: 'completed', description: `filed via ${buildMarker('abc1234', 'build')}` },
    ]);
    assert.equal(
      liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn),
      false,
    );
  });

  it('fails closed (assumes work exists) instead of throwing on truncated query output', () => {
    // Reproduces the live incident: query workflows --output json truncated
    // mid-string when the standalone headless exit path didn't wait for a
    // large stdout write to flush before calling process.exit().
    const truncated = JSON.stringify([
      { status: 'running', description: 'a'.repeat(50_000) },
    ]).slice(0, 30_000);
    const queryFn = () => truncated;

    assert.doesNotThrow(() => {
      const result = liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn);
      assert.equal(result, true, 'must fail closed, not crash the sweep or risk a duplicate fix PR');
    });
  });

  it('fails closed on a query function that throws outright', () => {
    const queryFn = () => { throw new Error('headless_query timed out after 60s'); };
    assert.doesNotThrow(() => {
      const result = liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn);
      assert.equal(result, true);
    });
  });

  it('fails closed on valid JSON that parses to null instead of an array or {items}', () => {
    const queryFn = () => 'null';
    assert.doesNotThrow(() => {
      const result = liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn);
      assert.equal(result, true);
    });
  });
});
