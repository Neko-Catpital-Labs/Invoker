import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  canonicalizeDiff,
  diffSimilarity,
  pathSetFromDiff,
  pathSetJaccard,
  pathHighlights,
  mapEvalPrsFromGhList,
  parseNumstat,
  interventionFor,
  loadCorrectnessReview,
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

describe('correctness review', () => {
  it('covers every feature and refuses false equivalence', () => {
    const review = loadCorrectnessReview();
    assert.equal(Object.keys(review.features).length, review.featureCount);
    assert.equal(review.equivalentFeatureCount, 0);
    assert.ok(Object.values(review.features).every((feature) => feature.equivalent === false));
  });

  it('keeps model totals consistent with per-feature verdicts', () => {
    const review = loadCorrectnessReview();
    for (const model of ['claude', 'codex', 'qwen']) {
      const actual = { pass: 0, needs_work: 0, fail: 0 };
      for (const feature of Object.values(review.features)) {
        actual[feature[model]] += 1;
      }
      assert.deepEqual(actual, review.modelTotals[model]);
    }
  });

  it('documents distinct failure causes for Qwen PRs 25 and 26', () => {
    const review = loadCorrectnessReview();
    assert.match(review.qwen2526.summary, /#25 and #26/);
    assert.ok(review.qwen2526.pr25.some((reason) => /reference|alias/i.test(reason)));
    assert.ok(review.qwen2526.pr26.some((reason) => /two workers|atomic/i.test(reason)));
  });

  it('records the live Chrome-to-Slack failure at each frozen PR head', () => {
    const review = loadCorrectnessReview();
    assert.match(review.liveChromeSlack.result, /No lineage completed/);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(review.liveChromeSlack.lineages)
          .map(([lineage, result]) => [lineage, [result.pr, result.head, result.stage]]),
      ),
      {
        claude: [24, '7f7936eb6a455bcbe43ae035e923aa9831f0fc4f', 'manifest load'],
        codex: [10, '8a86c42ecf0c0737a8da87035273087a534fc776', 'Slack Enter interception'],
        qwen: [30, 'e0e19a000f6b95874e4c24db63e84bdfa1ba0fea', 'manifest load'],
      },
    );
    assert.equal(review.features['10-chrome-review-ux'].claude, 'fail');
    for (const result of Object.values(review.liveChromeSlack.lineages)) {
      for (const evidencePath of result.evidence ?? []) {
        assert.equal(existsSync(new URL(`../${evidencePath}`, import.meta.url)), true, evidencePath);
      }
    }
  });

  it('defines one shared black-box command for every recommended slice', () => {
    const review = loadCorrectnessReview();
    const slices = review.equivalenceStrategy.slices;
    assert.equal(slices.length, 16);
    assert.equal(new Set(slices.map((slice) => slice.id)).size, slices.length);
    assert.ok(slices.every((slice) => slice.behavior && slice.goldenCommand));
    assert.ok(slices.every((slice) => slice.goldenCommand === `npm run conformance -- ${slice.id}`));
    assert.match(review.equivalenceStrategy.safetyInvariant, /same frozen parent/);
  });
});
