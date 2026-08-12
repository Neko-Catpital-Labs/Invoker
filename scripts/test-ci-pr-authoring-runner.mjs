#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const entries = workflow.jobs?.['required-fast-extra']?.strategy?.matrix?.include ?? [];
const prAuthoring = entries.find((entry) => entry.name === 'PR Authoring Guardrails');

assert(prAuthoring, 'required-fast-extra must include PR Authoring Guardrails');
assert.equal(
  prAuthoring.runner_label,
  'Runner_1',
  'PR Authoring Guardrails must avoid the disk-constrained Runner_2_4_core pool',
);

console.log('OK: PR Authoring Guardrails uses Runner_1');
