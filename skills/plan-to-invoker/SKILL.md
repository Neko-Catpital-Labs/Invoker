commit 37fa96068caa9b94559d52edf10a677a95178cf5
Author: EdbertChan <edbert@example.com>
Date:   Sun Jul 19 15:24:59 2026 -0700

    [Slack Plan Submission](3) Classify planner skill as tooling policy
    
    Co-authored-by: Cursor <cursoragent@cursor.com>
    Change-Id: I3da5ee803f604ce3a885e4dd004aac2eba9474cc

diff --git a/scripts/review-unit-rules.mjs b/scripts/review-unit-rules.mjs
index 6f9d647ba..50ea838d1 100644
--- a/scripts/review-unit-rules.mjs
+++ b/scripts/review-unit-rules.mjs
@@ -276,7 +276,7 @@ export function classifyReviewUnitsForPath(filePath) {
   ) return ['tooling-policy'];
   if (path.startsWith('packages/app/e2e/visual-proof/')) return ['activation-surface'];
   if (/(benchmark|performance|visual-proof)/.test(lowerPath)) return ['proof'];
-  if (path === 'skills/make-pr/SKILL.md') return ['tooling-policy'];
+  if (path === 'skills/make-pr/SKILL.md' || path === 'skills/plan-to-invoker/SKILL.md') return ['tooling-policy'];
   if (path.startsWith('docs/') || path.startsWith('skills/') || path.endsWith('.md')) return ['docs'];
   if (path.startsWith('.github/')) return ['tooling-policy'];
   if (
diff --git a/scripts/test-review-unit-classification.mjs b/scripts/test-review-unit-classification.mjs
index 31bbe6735..d48f8dd53 100644
--- a/scripts/test-review-unit-classification.mjs
+++ b/scripts/test-review-unit-classification.mjs
@@ -36,6 +36,7 @@ const stillToolingPolicy = [
   'scripts/review-unit-rules.mjs',
   '.github/workflows/ci.yml',
   'skills/make-pr/SKILL.md',
+  'skills/plan-to-invoker/SKILL.md',
 ];
 for (const path of stillToolingPolicy) {
   assert.deepEqual(
