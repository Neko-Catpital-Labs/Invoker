#!/usr/bin/env node
import assert from 'node:assert/strict';
import { collectAddedSilentCatchViolations } from './check-silent-catches.mjs';

const diff = (filePath, line) => [
  `diff --git a/${filePath} b/${filePath}`, `+++ b/${filePath}`, '@@ -0,0 +1 @@', `+${line}`, '',
].join('\n');

assert.equal(collectAddedSilentCatchViolations(diff('skills/example.mjs', 'try {} catch {}')).length, 1);
assert.equal(collectAddedSilentCatchViolations(diff('skills/example.mjs', 'try {} catch (error) { report(error); }')).length, 0);
assert.equal(collectAddedSilentCatchViolations(diff('skills/example.mjs', 'try {} catch { /* intentionally handled elsewhere */ }')).length, 1);
assert.equal(collectAddedSilentCatchViolations([
  'diff --git a/skills/example.mjs b/skills/example.mjs', '+++ b/skills/example.mjs', '@@ -0,0 +1,2 @@',
  '+try {} catch {', '+}', '',
].join('\n')).length, 1);
console.log('check-silent-catches tests passed');
