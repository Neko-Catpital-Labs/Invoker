import test from 'node:test';
import assert from 'node:assert/strict';

import { patchStrippedNodeBuiltinPrefixes } from './lib/patch-sea-builtin-prefix.mjs';

test('rewrites a bare require("sea") to require("node:sea")', () => {
  const before = 'var import_node_sea = require("sea");\nconsole.log(1);';
  const after = patchStrippedNodeBuiltinPrefixes(before);
  assert.equal(after, 'var import_node_sea = require("node:sea");\nconsole.log(1);');
});

test('rewrites a single-quoted bare require(\'sea\') the same way', () => {
  const before = "var x = require('sea');";
  const after = patchStrippedNodeBuiltinPrefixes(before);
  assert.equal(after, 'var x = require("node:sea");');
});

test('leaves an already-prefixed require("node:sea") unchanged', () => {
  const before = 'var import_node_sea = require("node:sea");';
  assert.equal(patchStrippedNodeBuiltinPrefixes(before), before);
});

test('leaves unrelated require calls and code untouched', () => {
  const before = [
    'var import_node_path = require("path");',
    'var import_seaworthy = require("seaworthy-thing");',
    'function f() { return "sea creature"; }',
  ].join('\n');
  assert.equal(patchStrippedNodeBuiltinPrefixes(before), before);
});
