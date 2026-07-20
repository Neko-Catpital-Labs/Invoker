#!/usr/bin/env node
import assert from 'node:assert/strict';
import { extractChangelogSection } from './extract-changelog-section.mjs';

const sample = `# Changelog

## Unreleased

## 0.0.7

- First thing
- Second thing

## 0.0.6

- Older thing
`;

const notes = extractChangelogSection(sample, '0.0.7');
assert.match(notes, /^# Invoker 0\.0\.7\n/);
assert.match(notes, /- First thing/);
assert.match(notes, /- Second thing/);
assert.doesNotMatch(notes, /Older thing/);
assert.doesNotMatch(notes, /Unreleased/);

assert.throws(
  () => extractChangelogSection(sample, '9.9.9'),
  /no "## 9\.9\.9"/,
);

assert.throws(
  () => extractChangelogSection('# Changelog\n\n## 1.0.0\n\n', '1.0.0'),
  /empty/,
);

console.log('ok extract-changelog-section');
