#!/usr/bin/env node
// Standalone test for the CHANGELOG release roll in bump-version.mjs.
// Run: node scripts/test-bump-version-changelog.mjs
import assert from 'node:assert/strict';
import { applyChangelogRelease } from './bump-version.mjs';

// Renames the top Unreleased to the cut version and starts a fresh empty one.
{
  const input = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '- shipped thing',
    '',
    '## 0.0.4',
    '',
    '- older thing',
    '',
  ].join('\n');
  const out = applyChangelogRelease(input, '0.0.7');
  assert.match(out, /## Unreleased\n\n## 0\.0\.7\n\n- shipped thing/, 'Unreleased notes should move under ## 0.0.7');
  const fresh = out.slice(out.indexOf('## Unreleased') + '## Unreleased'.length, out.indexOf('## 0.0.7'));
  assert.equal(fresh.trim(), '', 'the fresh ## Unreleased must be empty');
  assert.equal((out.match(/^## Unreleased$/gm) || []).length, 1, 'exactly one ## Unreleased remains');
  assert.equal((out.match(/^## 0\.0\.4$/gm) || []).length, 1, 'older sections are left intact');
}

// Fails loudly when there is nothing staged to release.
{
  assert.throws(
    () => applyChangelogRelease('# Changelog\n\n## 0.0.4\n\n- old\n', '0.0.7'),
    /no "## Unreleased"/,
    'must throw when there is no Unreleased section to roll',
  );
}

console.log('ok bump-version changelog roll');
