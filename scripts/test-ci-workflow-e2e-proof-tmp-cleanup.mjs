#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const jobs = workflow.jobs ?? {};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const job = jobs['e2e-proof'];
assert(job, 'ci.yml must define the e2e-proof job');
assert(
  job.container?.image === 'mcr.microsoft.com/playwright:v1.58.2-noble',
  'e2e-proof job must keep running inside the Playwright container, which is the reason its /tmp is '
    + 'container-local rather than the runner-mounted directory',
);

const reclaimStep = (job.steps ?? []).find((candidate) => candidate.name === 'Reclaim disk space');
assert(reclaimStep, 'e2e-proof job must include a "Reclaim disk space" step');
assert(
  String(reclaimStep.run ?? '').includes('$RUNNER_TEMP'),
  'e2e-proof "Reclaim disk space" step must target $RUNNER_TEMP, which the runner mounts into the '
    + 'container, instead of the container-local /tmp that never accumulates stale files across job runs',
);
assert(
  !String(reclaimStep.run ?? '').includes('find /tmp '),
  'e2e-proof "Reclaim disk space" step must not clean the container-local /tmp',
);

const runShardStep = (job.steps ?? []).find((candidate) => candidate.name === 'Run e2e proof shard');
assert(runShardStep, 'e2e-proof job must include a "Run e2e proof shard" step');
assert(
  runShardStep.env?.TMPDIR === undefined,
  'e2e-proof "Run e2e proof shard" step must not hardcode TMPDIR to a literal container path via env: '
    + '(it is not translated to the runner-mounted directory)',
);
assert(
  String(runShardStep.run ?? '').includes('TMPDIR="$RUNNER_TEMP/invoker-tmp"'),
  'e2e-proof "Run e2e proof shard" step must derive TMPDIR from $RUNNER_TEMP at runtime so test output '
    + 'lands in the runner-mounted directory that the Reclaim disk space step actually cleans',
);

console.log('CI e2e-proof job tmp cleanup policy is valid.');
