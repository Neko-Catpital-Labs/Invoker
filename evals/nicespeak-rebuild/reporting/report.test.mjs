import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeDiff,
  diffSimilarity,
  pathSetFromDiff,
  pathSetJaccard,
  pathHighlights,
  mapEvalPrsFromGhList,
  parseNumstat,
  interventionFor,
} from './report.mjs';

describe('canonical git-diff similarity', () => {
  it('ignores hunk offsets and index hashes', () => {
    const a = `diff --git a/foo.js b/foo.js
index abcdef0..1234567 100644
--- a/foo.js
+++ b/foo.js
@@ -1,2 +1,2 @@
-const x = 1
+const x = 2
`;
    const b = `diff --git a/foo.js b/foo.js
index deadbeef..cafebabe 100644
--- a/foo.js
+++ b/foo.js
@@ -10,2 +10,2 @@
-const x = 1
+const x = 2
`;
    assert.equal(canonicalizeDiff(a), canonicalizeDiff(b));
    assert.equal(diffSimilarity(a, b), 1);
  });

  it('returns null for missing inputs instead of inventing zero', () => {
    assert.equal(diffSimilarity(null, 'x'), null);
    assert.equal(diffSimilarity('x', null), null);
  });

  it('scores divergent content below one', () => {
    const a = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
+one
`;
    const b = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
+two
`;
    assert.ok(diffSimilarity(a, b) < 1);
  });
});

describe('path set Jaccard', () => {
  it('returns null for missing inputs instead of inventing zero', () => {
    assert.equal(pathSetJaccard(null, new Set(['a'])), null);
    assert.equal(pathSetJaccard(new Set(['a']), null), null);
    assert.equal(pathHighlights(null, new Set(['a'])), null);
  });

  it('scores identical path sets as one', () => {
    const a = pathSetFromDiff(`diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
+x
`);
    const b = pathSetFromDiff(`diff --git a/foo.js b/foo.js
--- a/foo.js
+++ b/foo.js
+y
`);
    assert.equal(pathSetJaccard(a, b), 1);
  });

  it('scores disjoint path sets as zero', () => {
    const a = new Set(['a.js']);
    const b = new Set(['b.js']);
    assert.equal(pathSetJaccard(a, b), 0);
    const hl = pathHighlights(a, b);
    assert.deepEqual(hl.onlyA, ['a.js']);
    assert.deepEqual(hl.onlyB, ['b.js']);
    assert.deepEqual(hl.shared, []);
  });
});

describe('mapEvalPrsFromGhList', () => {
  it('maps eval branches to lineage/feature without duplicating the NN prefix', () => {
    const mapped = mapEvalPrsFromGhList([
      {
        number: 1,
        title: 'nicespeak-eval/codex/01-repo-bootstrap',
        headRefName: 'eval/codex/feature-01-01-repo-bootstrap',
        url: 'https://github.com/Neko-Catpital-Labs/nicespeak_invoker/pull/1',
      },
      {
        number: 15,
        title: 'nicespeak-eval/qwen/01-repo-bootstrap',
        headRefName: 'eval/qwen/feature-01-01-repo-bootstrap',
        url: 'https://github.com/Neko-Catpital-Labs/nicespeak_invoker/pull/15',
      },
      {
        number: 99,
        title: 'unrelated',
        headRefName: 'stack/someone/other',
        url: 'https://example.com/99',
      },
    ]);
    assert.equal(mapped.codex['01-repo-bootstrap'].number, 1);
    assert.equal(mapped.qwen['01-repo-bootstrap'].number, 15);
    assert.equal(mapped.claude, undefined);
  });
});

describe('parseNumstat', () => {
  it('sums additions and deletions', () => {
    const parsed = parseNumstat('10\t2\tfoo.js\n3\t0\tbar.js\n');
    assert.equal(parsed.filesChanged, 2);
    assert.equal(parsed.additions, 13);
    assert.equal(parsed.deletions, 2);
  });

  it('returns null for missing input', () => {
    assert.equal(parseNumstat(null), null);
  });
});

describe('interventionFor', () => {
  it('flags qwen 09 human hotfix and leaves others null', () => {
    const hit = interventionFor('qwen', '09-slack-web-adapter');
    assert.equal(hit.kind, 'human_hotfix');
    assert.equal(interventionFor('codex', '09-slack-web-adapter'), null);
    assert.equal(interventionFor('qwen', '01-repo-bootstrap'), null);
  });
});
