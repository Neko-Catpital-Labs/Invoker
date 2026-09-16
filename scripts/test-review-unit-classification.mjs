import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  classifyReviewUnitsForPath,
  parseFileListItems,
  reviewUnitsForChangedFiles,
  validateReviewUnitChangedFiles,
  validateSingleReviewUnitFiles,
} from './review-unit-rules.mjs';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.match(
  rootPackage.scripts.test,
  /node scripts\/test-review-unit-classification\.mjs && (?:node (?:--test )?scripts\/[\w.-]+\.m?js && )*bash scripts\/workspace-test\.sh/,
  'root test must run review-unit classification before the workspace test contract',
);

const neutralManifests = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.typecheck.json',
  'packages/slack-manager/package.json',
  'packages/slack-manager/tsconfig.json',
  'packages/slack-manager/tsconfig.tsup.json',
];
for (const path of neutralManifests) {
  assert.deepEqual(
    classifyReviewUnitsForPath(path),
    [],
    `dependency/build manifest should be review-neutral: ${path}`,
  );
}

const stillToolingPolicy = [
  'run.sh',
  'scripts/create-pr.mjs',
  'scripts/review-unit-rules.mjs',
  '.github/workflows/ci.yml',
  'skills/make-pr/SKILL.md',
  'skills/chat-submit/SKILL.md',
  'skills/chat-submit/scripts/check-contract.sh',
  'skills/plan-to-invoker/SKILL.md',
  'skills/plan-to-invoker/references/local-vs-remote-mcp.md',
  'skills/workflow-chain-submit/SKILL.md',
  'skills/land-stack/SKILL.md',
  'skills/visual-proof/SKILL.md',
  'skills/prove-it/SKILL.md',
  'scripts/bootstrap.sh',
  'scripts/test-bootstrap.sh',
];
for (const path of stillToolingPolicy) {
  assert.deepEqual(
    classifyReviewUnitsForPath(path),
    ['tooling-policy'],
    `genuine policy/automation path should stay tooling-policy: ${path}`,
  );
}

const newPackageFiles = [
  'packages/slack-manager/package.json',
  'packages/slack-manager/src/index.ts',
  'packages/slack-manager/tsconfig.json',
  'pnpm-lock.yaml',
  'tsconfig.typecheck.json',
];
assert.deepEqual(
  reviewUnitsForChangedFiles(newPackageFiles),
  [],
  'adding a package must not be forced into tooling-policy by its own manifests',
);
assert.deepEqual(
  validateReviewUnitChangedFiles({ declaredReviewUnit: 'routing', changedFiles: newPackageFiles, context: 'test' }),
  [],
  'a new-package PR may declare its source review unit without colliding with its manifests',
);

const depBumpFiles = ['package.json', 'pnpm-lock.yaml'];
assert.deepEqual(
  reviewUnitsForChangedFiles(depBumpFiles),
  [],
  'a manifest-only change carries no review unit of its own',
);

const activationSurfaceCommandDispatchFiles = [
  'packages/app/src/api-server.ts',
  'packages/app/src/workflow-actions.ts',
  'packages/app/src/web/web-invoker-dispatch.ts',
];
for (const path of activationSurfaceCommandDispatchFiles) {
  assert.deepEqual(
    classifyReviewUnitsForPath(path),
    ['activation-surface'],
    `command-dispatch file should classify as activation-surface: ${path}`,
  );
}

const webTransportFiles = [
  'packages/app/src/web/web-bridge-server.ts',
  'packages/app/src/web/start-web-surface.ts',
  'packages/app/src/web/task-graph-snapshot.ts',
];
for (const path of webTransportFiles) {
  assert.deepEqual(
    classifyReviewUnitsForPath(path),
    ['routing'],
    `HTTP transport file under packages/app/src/web/ should stay routing: ${path}`,
  );
}

assert.deepEqual(
  parseFileListItems('- packages/app/src/main.ts\n- scripts/one.mjs\nAdd policy contracts\n'),
  ['packages/app/src/main.ts', 'scripts/one.mjs'],
  'a Files list keeps path entries and drops prose lines',
);
assert.deepEqual(parseFileListItems(''), [], 'an empty Files section lists no files');

assert.deepEqual(
  validateSingleReviewUnitFiles({ files: ['packages/execution-engine/src/ssh-executor.ts'], context: 'Task "x"' }),
  [],
  'files in one review unit pass',
);
assert.deepEqual(
  validateSingleReviewUnitFiles({ files: [], context: 'Task "x"' }),
  [],
  'no files means the caller reports unchecked, not a failure',
);
const mixedFiles = validateSingleReviewUnitFiles({
  files: ['packages/execution-engine/src/ssh-executor.ts', 'packages/ui/src/app.tsx'],
  context: 'Task "x"',
});
assert.equal(mixedFiles.length, 1, 'files from two review units fail');
assert.match(mixedFiles[0], /lists files from routing, activation-surface; split into one review unit per task\./);

const lintScript = new URL('../skills/plan-to-invoker/scripts/lint-review-units.mjs', import.meta.url).pathname;
function lintPlan(planPath) {
  const result = spawnSync(process.execPath, [lintScript, planPath], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const spanningFixture = new URL('../skills/plan-to-invoker/fixtures/negative/anti-pattern-g-monolithic-prompt-edit-bridge.yaml', import.meta.url).pathname;
const spanning = lintPlan(spanningFixture);
assert.equal(spanning.status, 1, `a task whose Files span review units must fail:\n${spanning.stdout}${spanning.stderr}`);
assert.match(spanning.stderr, /lists files from .*; split into one review unit per task\./);

const tempDir = mkdtempSync(join(tmpdir(), 'review-unit-files-'));
try {
  const onePlan = join(tempDir, 'one-unit.yaml');
  writeFileSync(onePlan, [
    'name: one unit',
    'onFinish: pull_request',
    'tasks:',
    '  - id: implement',
    '    description: |',
    '      Files:',
    '      - packages/execution-engine/src/ssh-executor.ts',
    '      - packages/execution-engine/src/__tests__/ssh-executor.test.ts',
    '      Change types:',
    '      - packages/execution-engine/src/ssh-executor.ts: modify',
    '    prompt: do the work',
    '',
  ].join('\n'));
  const one = lintPlan(onePlan);
  assert.equal(one.status, 0, `one review unit must pass:\n${one.stdout}${one.stderr}`);

  const noFilesPlan = join(tempDir, 'no-files.yaml');
  writeFileSync(noFilesPlan, [
    'name: no files',
    'onFinish: pull_request',
    'tasks:',
    '  - id: implement',
    '    description: |',
    '      Review claim: something.',
    '    prompt: do the work',
    '',
  ].join('\n'));
  const noFiles = lintPlan(noFilesPlan);
  assert.equal(noFiles.status, 0, 'a task with no Files list does not fail');
  assert.match(noFiles.stderr, /UNCHECKED: Task "implement" lists no Files:, so its review unit was not checked/);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const bazelOverlayFiles = [
  'packages/contracts/BUILD.bazel',
  'packages/ui/BUILD.bazel',
  'packages/execution-engine/BUILD.bazel',
  'MODULE.bazel',
  'scripts/bazel/generate-package-build.mjs',
];
for (const path of bazelOverlayFiles) {
  assert.deepEqual(
    classifyReviewUnitsForPath(path),
    ['tooling-policy'],
    `Bazel overlay file should classify as tooling-policy: ${path}`,
  );
}

console.log('review-unit classification: all assertions passed');
