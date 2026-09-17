#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const mode = process.argv[2] || 'cache';
const enabled = JSON.parse(readFileSync('scripts/bazel/enabled-packages.json', 'utf8'));
const targets = [];

if (mode === 'rbe') {
  targets.push('//scripts/bazel:rbe_smoke_test');
} else if (mode === 'quality') {
  if (enabled.quality) {
    targets.push('//:check_types', '//:check_deps', '//:check_comments');
  }
} else {
  for (const pkg of enabled.packages ?? []) {
    targets.push(`//packages/${pkg}:test`);
  }
}

if (targets.length === 0) {
  console.error(`no targets for mode=${mode}`);
  process.exit(1);
}
process.stdout.write(targets.join(' ') + '\n');
