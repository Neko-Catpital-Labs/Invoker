#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const MAX_DEFAULT_PR_FACING_TIMEOUT_MINUTES = 5;

const PR_FACING_TIMEOUT_BUDGETS = new Map([
  ['quality-required', { maxMinutes: MAX_DEFAULT_PR_FACING_TIMEOUT_MINUTES }],
  [
    'ui-vitest',
    {
      maxMinutes: 10,
      runnerLabel: 'Runner_Vitest',
      runCommand: 'pnpm --filter @invoker/ui test',
    },
  ],
  ['quality-extra', { maxMinutes: MAX_DEFAULT_PR_FACING_TIMEOUT_MINUTES }],
]);

const MAX_PLAYWRIGHT_TIMEOUT_MINUTES = 30;

const EXEMPT_JOBS = new Set([
  'build-artifacts',
  'e2e-proof',
  'e2e-proof-aggregate',
  'required-fast',
  'required-fast-extra',
  'ssh',
  'optional-other',
  'docker',
  'scheduled-repros',
  'playwright',
  'playwright-nightly-perf',
  'reset-rulebook-repro',
]);

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const jobs = workflow.jobs ?? {};
const errors = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

for (const [jobName, budget] of PR_FACING_TIMEOUT_BUDGETS) {
  const job = jobs[jobName];
  assert(job, `Missing budgeted CI job ${jobName}`);
  if (!job) continue;
  const timeout = job['timeout-minutes'];
  assert(
    typeof timeout === 'number',
    `${jobName} must declare timeout-minutes (expected <= ${budget.maxMinutes})`,
  );
  assert(
    timeout <= budget.maxMinutes,
    `${jobName} timeout-minutes=${timeout} exceeds hard invariant of ${budget.maxMinutes} minutes`,
  );
  if (budget.runnerLabel) {
    assert(
      job['runs-on']?.labels === budget.runnerLabel,
      `${jobName} must stay on ${budget.runnerLabel} when using a ${budget.maxMinutes}-minute budget`,
    );
  }
  if (budget.runCommand) {
    const commands = (job.steps ?? []).map((step) => step?.run).filter(Boolean);
    assert(
      commands.includes(budget.runCommand),
      `${jobName} must stay scoped to ${budget.runCommand}`,
    );
  }
}

const playwright = jobs.playwright;
if (playwright) {
  const playwrightTimeout = playwright['timeout-minutes'];
  assert(
    typeof playwrightTimeout === 'number',
    'playwright must declare timeout-minutes',
  );
  assert(
    playwrightTimeout <= MAX_PLAYWRIGHT_TIMEOUT_MINUTES,
    `playwright timeout-minutes=${playwrightTimeout} exceeds hard invariant of ${MAX_PLAYWRIGHT_TIMEOUT_MINUTES} minutes`,
  );
  const shards = playwright.strategy?.matrix?.include ?? [];
  assert(shards.length >= 6, `playwright must use at least 6 shards (found ${shards.length})`);
  for (const shard of shards) {
    const files = String(shard.files ?? '').trim().split(/\s+/).filter(Boolean);
    assert(
      files.length > 0 && files.length <= 6,
      `playwright shard ${shard.name} has ${files.length} specs; keep <= 6 per shard`,
    );
  }
  const listed = shards.flatMap((shard) => String(shard.files).trim().split(/\s+/).filter(Boolean));
  assert(
    listed.includes('e2e/main-process-hitch-responsiveness.spec.ts'),
    'playwright shards must include e2e/main-process-hitch-responsiveness.spec.ts',
  );
  assert(
    listed.includes('e2e/dag-click-hitch-responsiveness.spec.ts'),
    'playwright shards must include e2e/dag-click-hitch-responsiveness.spec.ts',
  );
  assert(
    listed.includes('e2e/attention-click-hitch-responsiveness.spec.ts'),
    'playwright shards must include e2e/attention-click-hitch-responsiveness.spec.ts',
  );
}

for (const [jobName, job] of Object.entries(jobs)) {
  if (PR_FACING_TIMEOUT_BUDGETS.has(jobName) || EXEMPT_JOBS.has(jobName)) continue;
  const timeout = job?.['timeout-minutes'];
  if (typeof timeout === 'number' && timeout > MAX_DEFAULT_PR_FACING_TIMEOUT_MINUTES) {
    errors.push(
      `Unknown job ${jobName} has timeout-minutes=${timeout}. Add it to PR_FACING_TIMEOUT_BUDGETS (must be <= ${MAX_DEFAULT_PR_FACING_TIMEOUT_MINUTES} unless explicitly justified) or EXEMPT_JOBS.`,
    );
  }
}

if (errors.length > 0) {
  console.error('CI duration invariant failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `CI duration invariant ok: PR quality jobs <= ${MAX_DEFAULT_PR_FACING_TIMEOUT_MINUTES}m; UI Vitest <= 10m on Runner_Vitest; playwright <= ${MAX_PLAYWRIGHT_TIMEOUT_MINUTES}m; hitch e2e shards present.`,
);
